import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { APIProvider } from '../types';
import { estimateCost } from '../officeConfig';
import { getSetting } from './settings';

const DEFAULT_MAX_TOKENS = 4000;
/** Upper bound on a single model call, whatever the caller asks for. */
const MAX_TOKENS_LIMIT = 8000;
/**
 * Models that think before answering spend those tokens out of the same allowance,
 * so they get more room than the visible answer needs.
 */
const THINKING_HEADROOM_TOKENS = 16000;

/** How many times a response that hit the length limit is asked to carry on. */
const MAX_CONTINUATIONS = 2;
const CONTINUE_PROMPT = 'Your previous message was cut off by the length limit. Continue exactly where it stopped, starting with the very next character. Do not repeat anything and do not add an introduction.';

/** A call is given up when the provider sends nothing at all for this long. */
const IDLE_TIMEOUT_MS = 5 * 60_000;

/** Ollama's default context window is small enough to silently cut off the project context. */
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || 8192;

const GEMINI_BASE_URL = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');

/** Claude models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const ANTHROPIC_FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

interface Completion {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** The model stopped because it ran out of room, not because it was done. */
  truncated: boolean;
  /** Model that actually answered, when the provider reports one different from the request. */
  model?: string;
}

type OnText = (delta: string) => void;

interface CallIO {
  onText: OnText;
  /** Called whenever the provider sends anything, so a silent connection can be told from a busy one. */
  beat: () => void;
  /** Aborts the request: the task was halted, or the provider went silent. */
  signal: AbortSignal;
}

type ModelCall = (messages: ChatMessage[], io: CallIO) => Promise<Completion>;

export interface ModelRequest {
  provider: APIProvider;
  /** Model to use. Empty = the provider's default from the settings. */
  model?: string;
  prompt: string;
  systemPrompt?: string;
  /** Earlier turns of the same conversation, placed before `prompt`. */
  history?: ChatMessage[];
  maxTokens?: number;
  /** Called with each piece of the answer as it is written. */
  onText?: OnText;
  /** Stops the call, for example when the user halts the office. */
  signal?: AbortSignal;
}

export interface ModelResult {
  response: string;
  /** Input + output tokens. */
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
  /** Estimated USD; undefined when the model has no known price. */
  cost: number | undefined;
  truncated: boolean;
}

/** Rough token count for providers that do not report usage on a stream. */
const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/** Yields the lines of a streamed HTTP response. */
async function* readLines(res: Response) {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) yield line;
  }
  if (buffer) yield buffer;
}

const openAiCompatible = (client: OpenAI, model: string, maxTokens: number): ModelCall => async (messages, { onText, beat, signal }) => {
  const stream = await client.chat.completions.create({
    messages,
    model,
    max_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  }, { signal });

  let text = '';
  let finishReason: string | null = null;
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;

  for await (const chunk of stream) {
    beat();
    const choice = chunk.choices[0];
    if (choice?.delta?.content) {
      text += choice.delta.content;
      onText(choice.delta.content);
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  }

  return {
    text,
    inputTokens: usage?.prompt_tokens ?? estimateTokens(messages.map(m => m.content).join('\n')),
    outputTokens: usage?.completion_tokens ?? estimateTokens(text),
    truncated: finishReason === 'length',
  };
};

const anthropic = (client: Anthropic, model: string, maxTokens: number): ModelCall => async (messages, { onText, beat, signal }) => {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const conversation = messages
    .filter((m): m is ChatMessage & { role: 'user' | 'assistant' } => m.role !== 'system')
    .map(m => ({ role: m.role, content: m.content }));

  const params = {
    model,
    max_tokens: Math.max(maxTokens, THINKING_HEADROOM_TOKENS),
    ...(system ? { system } : {}),
    messages: conversation,
  };

  try {
    // Where the model supports it, a request it declines for policy reasons is retried
    // by Anthropic on its default fallback model inside the same call.
    const message = ANTHROPIC_FALLBACK_MODELS.has(model)
      ? await client.beta.messages.stream({ ...params, betas: [ANTHROPIC_FALLBACK_BETA], fallbacks: 'default' }, { signal }).on('streamEvent', beat).on('text', onText).finalMessage()
      : await client.messages.stream(params, { signal }).on('streamEvent', beat).on('text', onText).finalMessage();

    if (message.stop_reason === 'refusal') {
      const category = message.stop_details?.category;
      throw new Error(`Claude declined this request${category ? ` (${category})` : ''}.`);
    }

    let text = '';
    for (const block of message.content) {
      if (block.type === 'text') text += block.text;
    }

    const usage = message.usage;
    return {
      text,
      inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0),
      outputTokens: usage.output_tokens,
      truncated: message.stop_reason === 'max_tokens',
      model: message.model,
    };
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof Anthropic.AuthenticationError) throw new Error('Anthropic rejected the API key. Check it in the settings.');
    if (error instanceof Anthropic.RateLimitError) throw new Error(`Anthropic rate limit reached (429): ${error.message}`);
    if (error instanceof Anthropic.APIConnectionError) throw new Error(`Cannot reach Anthropic: ${error.message}`);
    if (error instanceof Anthropic.APIError) throw new Error(`Anthropic error ${error.status}: ${error.message}`);
    throw error;
  }
};

const gemini = (apiKey: string, model: string, maxTokens: number): ModelCall => async (messages, { onText, beat, signal }) => {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const res = await fetch(`${GEMINI_BASE_URL}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    signal,
    body: JSON.stringify({
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: messages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: Math.max(maxTokens, THINKING_HEADROOM_TOKENS) },
    }),
  });

  if (!res.ok) {
    throw new Error(`Gemini (${model}) failed: ${res.status} ${(await res.text()).slice(0, 500)}`);
  }

  let text = '';
  let finishReason = '';
  let usage: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } = {};

  for await (const line of readLines(res)) {
    beat();
    if (!line.startsWith('data:')) continue;
    let chunk: any;
    try {
      chunk = JSON.parse(line.slice(5));
    } catch {
      continue;
    }
    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts || []) {
      if (typeof part.text === 'string' && !part.thought) {
        text += part.text;
        onText(part.text);
      }
    }
    if (candidate?.finishReason) finishReason = candidate.finishReason;
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
  }

  if (!text && finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
    throw new Error(`Gemini returned no answer (${finishReason}).`);
  }

  return {
    text,
    inputTokens: usage.promptTokenCount ?? estimateTokens(messages.map(m => m.content).join('\n')),
    outputTokens: (usage.candidatesTokenCount ?? estimateTokens(text)) + (usage.thoughtsTokenCount || 0),
    truncated: finishReason === 'MAX_TOKENS',
  };
};

const ollama = (url: string, model: string, maxTokens: number): ModelCall => async (messages, { onText, beat, signal }) => {
  let res: Response;
  try {
    res = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        options: { num_predict: maxTokens, num_ctx: OLLAMA_NUM_CTX }
      })
    });
  } catch (e: any) {
    if (signal.aborted) throw e;
    throw new Error(`Cannot reach Ollama at ${url}. Is it running? (${e.message})`);
  }

  if (!res.ok) {
    throw new Error(`Ollama (${model}) failed: ${res.status} ${await res.text()}`);
  }

  let text = '';
  let last: any = {};
  // One JSON object per line; the last one carries the totals
  for await (const line of readLines(res)) {
    beat();
    if (!line.trim()) continue;
    let chunk: any;
    try {
      chunk = JSON.parse(line);
    } catch {
      continue;
    }
    if (chunk.error) throw new Error(`Ollama (${model}) failed: ${chunk.error}`);
    if (chunk.message?.content) {
      text += chunk.message.content;
      onText(chunk.message.content);
    }
    if (chunk.done) last = chunk;
  }

  return {
    text,
    inputTokens: last.prompt_eval_count || 0,
    outputTokens: last.eval_count || 0,
    truncated: last.done_reason === 'length',
  };
};

/** Calls the model, and if the answer is cut off mid-way asks it to carry on, so files are not left half-written. */
const completeFully = async (call: ModelCall, messages: ChatMessage[], io: CallIO): Promise<Completion> => {
  const conversation = [...messages];
  const total: Completion = { text: '', inputTokens: 0, outputTokens: 0, truncated: false };

  for (let round = 0; round <= MAX_CONTINUATIONS; round++) {
    const part = await call(conversation, io);
    total.text += part.text;
    total.inputTokens += part.inputTokens;
    total.outputTokens += part.outputTokens;
    total.truncated = part.truncated;
    total.model = part.model || total.model;
    if (!part.truncated || !part.text) break;
    conversation.push({ role: 'assistant', content: part.text }, { role: 'user', content: CONTINUE_PROMPT });
  }

  return total;
};

/** The model an employee on this provider uses when none was chosen for them. */
export const defaultModel = (provider: APIProvider) => {
  switch (provider) {
    case 'OpenAI': return getSetting('openaiModel');
    case 'Grok': return getSetting('grokModel');
    case 'Anthropic': return getSetting('anthropicModel');
    case 'Gemini': return getSetting('geminiModel');
    case 'Ollama': return getSetting('ollamaModel');
  }
};

/** Runs one prompt on the employee's provider and model. Throws when the provider fails or cannot be reached. */
export const runModel = async ({ provider, model: requestedModel, prompt, systemPrompt, history, maxTokens, onText = () => undefined, signal }: ModelRequest): Promise<ModelResult> => {
  const limit = Math.min(Math.max(Math.floor(Number(maxTokens)) || DEFAULT_MAX_TOKENS, 1), MAX_TOKENS_LIMIT);

  const messages: ChatMessage[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  if (history) messages.push(...history);
  messages.push({ role: 'user', content: prompt });

  const model = requestedModel?.trim() || defaultModel(provider);
  if (!model) throw new Error(`Unknown API provider: ${provider}`);

  let call: ModelCall | null;

  if (provider === 'Grok') {
    const apiKey = getSetting('grokKey');
    call = apiKey ? openAiCompatible(new OpenAI({ apiKey, baseURL: 'https://api.x.ai/v1' }), model, limit) : null;
  } else if (provider === 'OpenAI') {
    const apiKey = getSetting('openaiKey');
    call = apiKey ? openAiCompatible(new OpenAI({ apiKey }), model, limit) : null;
  } else if (provider === 'Anthropic') {
    const apiKey = getSetting('anthropicKey');
    call = apiKey ? anthropic(new Anthropic({ apiKey }), model, limit) : null;
  } else if (provider === 'Gemini') {
    const apiKey = getSetting('geminiKey');
    call = apiKey ? gemini(apiKey, model, limit) : null;
  } else if (provider === 'Ollama') {
    call = ollama(getSetting('ollamaUrl').replace(/\/+$/, ''), model, limit);
  } else {
    throw new Error(`Unknown API provider: ${provider}`);
  }

  // No key configured: answer with a mock so the interface can be explored for free
  if (!call) {
    const response = `[Mock ${provider} Response] ${prompt}`;
    onText(response);
    return { response, tokens: 15, inputTokens: 10, outputTokens: 5, model: 'mock', cost: 0, truncated: false };
  }

  // One controller for both ways a call ends early: the caller stops it, or the provider goes silent
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (signal?.aborted) stop();
  signal?.addEventListener('abort', stop, { once: true });

  let timedOut = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const beat = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      timedOut = true;
      stop();
    }, IDLE_TIMEOUT_MS);
  };
  beat();

  let result: Completion;
  try {
    result = await completeFully(call, messages, { onText, beat, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new Error(`${provider} (${model}) sent nothing for ${IDLE_TIMEOUT_MS / 60_000} minutes, so the call was stopped.`);
    throw error;
  } finally {
    clearTimeout(idle);
    signal?.removeEventListener('abort', stop);
  }

  const answeredBy = result.model || model;
  return {
    response: result.text,
    tokens: result.inputTokens + result.outputTokens,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    model: answeredBy,
    cost: estimateCost(provider, answeredBy, result.inputTokens, result.outputTokens),
    truncated: result.truncated,
  };
};
