import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages';
import { APIProvider } from '../types';
import { estimateCost } from '../officeConfig';
import { getSetting } from './settings';
import { errorMessage } from '../errors';

const DEFAULT_MAX_TOKENS = 4000;
/** Upper bound on a single model call, whatever the caller asks for. */
const MAX_TOKENS_LIMIT = 16000;
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

/** How many times a Claude turn paused by its own web tools is resumed. */
const MAX_PAUSE_RESUMES = 4;

/** Ollama's default context window is small enough to silently cut off the project context. */
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || 8192;

const GEMINI_BASE_URL = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');

/** Claude models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const ANTHROPIC_FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Claude models whose web tools filter results themselves; older models use the basic versions. */
const ANTHROPIC_FILTERING_WEB = /^claude-(fable-5|opus-5|sonnet-5|opus-4-[678]|sonnet-4-6)/;

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** A function the model may call. `parameters` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Set when the model's arguments could not be read; the call is answered with this error. */
  invalid?: string;
}

export interface ToolResult {
  id: string;
  name: string;
  output: string;
  isError?: boolean;
}

export interface ImagePart {
  /** For example "image/png". */
  mediaType: string;
  /** Base64 of the image bytes. */
  data: string;
}

/**
 * One turn of a conversation, in a form every provider can be given.
 * An assistant turn's `raw` is the provider's own form of it; it is sent back as-is so the
 * model's thinking and tool calls stay intact.
 */
export type Turn =
  | { role: 'user'; text: string; images?: ImagePart[] }
  | { role: 'assistant'; text: string; toolCalls?: ToolCall[]; raw?: unknown }
  | { role: 'tool'; results: ToolResult[] };

type OnText = (delta: string) => void;

interface CallIO {
  onText: OnText;
  /** Called whenever the provider sends anything, so a silent connection can be told from a busy one. */
  beat: () => void;
  /** Aborts the request: the task was halted, or the provider went silent. */
  signal: AbortSignal;
}

interface StepInput {
  system: string;
  turns: Turn[];
  tools: ToolSpec[];
  maxTokens: number;
  /** Let the model use the provider's own web search (Claude only). */
  nativeWeb: boolean;
  /**
   * Set for a conversation that will be sent again with more turns (a tool loop): the provider is
   * asked to cache it, so each further step pays a fraction for what was already sent. The value
   * identifies the conversation.
   */
  cacheKey?: string;
}

interface StepOutput {
  text: string;
  toolCalls: ToolCall[];
  raw?: unknown;
  /** Input billed at the full price: what was neither read from nor written to the cache. */
  inputTokens: number;
  outputTokens: number;
  /** Input the provider had cached from an earlier step, billed at a fraction. */
  cacheReadTokens?: number;
  /** Input written to the cache by this step (Claude bills this slightly above the full price). */
  cacheWriteTokens?: number;
  /** The model stopped because it ran out of room, not because it was done. */
  truncated: boolean;
  /** Model that actually answered, when the provider reports one different from the request. */
  model?: string;
}

type Adapter = (input: StepInput, io: CallIO) => Promise<StepOutput>;

/** The model cannot call functions; the caller should fall back to the tag format. */
export class ToolsUnsupportedError extends Error {}

/** Rough token count for providers that do not report usage on a stream. */
const estimateTokens = (text: string) => Math.ceil(text.length / 4);

const textOf = (turns: Turn[]) => turns.map(t => ('text' in t ? t.text : t.results.map(r => r.output).join('\n'))).join('\n');

const newCallId = () => `call_${Math.random().toString(36).slice(2, 12)}`;

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

// --- OpenAI and compatible (Grok) ------------------------------------------------

const openAiCompatible = (client: OpenAI, model: string, tokenParam: 'max_tokens' | 'max_completion_tokens', cacheKeys = false): Adapter => async ({ system, turns, tools, maxTokens, cacheKey }, { onText, beat, signal }) => {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  if (system) messages.push({ role: 'system', content: system });
  for (const turn of turns) {
    if (turn.role === 'user') {
      messages.push({
        role: 'user',
        content: turn.images?.length
          ? [{ type: 'text' as const, text: turn.text }, ...turn.images.map(image => ({ type: 'image_url' as const, image_url: { url: `data:${image.mediaType};base64,${image.data}` } }))]
          : turn.text,
      });
    } else if (turn.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: turn.text || null,
        ...(turn.toolCalls?.length
          ? { tool_calls: turn.toolCalls.map(call => ({ id: call.id, type: 'function' as const, function: { name: call.name, arguments: JSON.stringify(call.input) } })) }
          : {}),
      });
    } else {
      for (const result of turn.results) messages.push({ role: 'tool', tool_call_id: result.id, content: result.output });
    }
  }

  const stream = await client.chat.completions.create({
    messages,
    model,
    ...(tokenParam === 'max_tokens' ? { max_tokens: maxTokens } : { max_completion_tokens: maxTokens }),
    stream: true,
    stream_options: { include_usage: true },
    ...(tools.length ? { tools: tools.map(tool => ({ type: 'function' as const, function: tool })) } : {}),
    // These providers cache a repeated prompt start by themselves; the key keeps a conversation's steps together
    ...(cacheKeys && cacheKey ? { prompt_cache_key: cacheKey } : {}),
  }, { signal });

  let text = '';
  let finishReason: string | null = null;
  let usage: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | undefined;
  // Tool calls arrive in pieces, keyed by their position
  const pending = new Map<number, { id: string; name: string; args: string }>();

  for await (const chunk of stream) {
    beat();
    const choice = chunk.choices?.[0];
    if (choice?.delta?.content) {
      text += choice.delta.content;
      onText(choice.delta.content);
    }
    for (const piece of choice?.delta?.tool_calls || []) {
      const call = pending.get(piece.index) || { id: '', name: '', args: '' };
      if (piece.id) call.id = piece.id;
      if (piece.function?.name) call.name += piece.function.name;
      if (piece.function?.arguments) call.args += piece.function.arguments;
      pending.set(piece.index, call);
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  }

  const toolCalls: ToolCall[] = Array.from(pending.entries()).sort((a, b) => a[0] - b[0]).map(([, call]) => {
    try {
      return { id: call.id || newCallId(), name: call.name, input: call.args ? JSON.parse(call.args) : {} };
    } catch {
      return { id: call.id || newCallId(), name: call.name, input: {}, invalid: 'The arguments were not valid JSON.' };
    }
  });

  const cached = usage?.prompt_tokens_details?.cached_tokens || 0;

  return {
    text,
    toolCalls,
    inputTokens: Math.max(0, (usage?.prompt_tokens ?? estimateTokens(system + textOf(turns))) - cached),
    outputTokens: usage?.completion_tokens ?? estimateTokens(text),
    cacheReadTokens: cached,
    truncated: finishReason === 'length',
  };
};

// --- Anthropic ------------------------------------------------------------------

const anthropic = (client: Anthropic, model: string): Adapter => async ({ system, turns, tools, maxTokens, nativeWeb, cacheKey }, { onText, beat, signal }) => {
  const messages: Anthropic.MessageParam[] = [];
  for (const turn of turns) {
    if (turn.role === 'user') {
      messages.push({
        role: 'user',
        content: turn.images?.length
          ? [
            ...turn.images.map(image => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: image.mediaType as Anthropic.Base64ImageSource['media_type'], data: image.data } })),
            { type: 'text' as const, text: turn.text },
          ]
          : turn.text,
      });
    } else if (turn.role === 'assistant') {
      // The original blocks go back unchanged: they carry the model's thinking and its tool calls
      messages.push({ role: 'assistant', content: (turn.raw as Anthropic.ContentBlockParam[] | undefined) ?? turn.text });
    } else {
      messages.push({
        role: 'user',
        content: turn.results.map(result => ({ type: 'tool_result' as const, tool_use_id: result.id, content: result.output, ...(result.isError ? { is_error: true } : {}) })),
      });
    }
  }

  const filtering = ANTHROPIC_FILTERING_WEB.test(model);
  const allTools: Anthropic.ToolUnion[] = tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters as Anthropic.Tool.InputSchema }));
  if (nativeWeb) {
    allTools.push(
      filtering ? { type: 'web_search_20260209', name: 'web_search', max_uses: 5 } : { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
      filtering ? { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 } : { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 5 },
    );
  }

  const params: Anthropic.MessageStreamParams = {
    model,
    max_tokens: Math.max(maxTokens, THINKING_HEADROOM_TOKENS),
    // In a loop: one marker after the tools and system prompt, which never change within a task, and the
    // request-level setting, which moves the cached part forward as the conversation grows.
    ...(system ? { system: cacheKey ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system } : {}),
    ...(cacheKey ? { cache_control: { type: 'ephemeral' } } : {}),
    ...(allTools.length ? { tools: allTools } : {}),
    messages,
  };

  try {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let message: Anthropic.Message | Anthropic.Beta.BetaMessage;

    for (let round = 0; ; round++) {
      // Where the model supports it, a request it declines for policy reasons is retried
      // by Anthropic on its default fallback model inside the same call.
      message = ANTHROPIC_FALLBACK_MODELS.has(model)
        // The same request on the beta endpoint, which takes the fallback chain; the two parameter
        // types differ only in fields this request does not set
        ? await client.beta.messages.stream({ ...params, betas: [ANTHROPIC_FALLBACK_BETA], fallbacks: 'default' } as BetaMessageStreamParams, { signal }).on('streamEvent', beat).on('text', onText).finalMessage()
        : await client.messages.stream(params, { signal }).on('streamEvent', beat).on('text', onText).finalMessage();

      const usage = message.usage;
      // `input_tokens` is only what was not cached
      inputTokens += usage.input_tokens;
      cacheReadTokens += usage.cache_read_input_tokens || 0;
      cacheWriteTokens += usage.cache_creation_input_tokens || 0;
      outputTokens += usage.output_tokens;

      // A long web search can pause the turn; sending it back lets the model carry on
      if (message.stop_reason !== 'pause_turn' || round >= MAX_PAUSE_RESUMES) break;
      params.messages = [...params.messages, { role: 'assistant', content: message.content as Anthropic.ContentBlockParam[] }];
    }

    if (message.stop_reason === 'refusal') {
      const category = message.stop_details?.category;
      throw new Error(`Claude declined this request${category ? ` (${category})` : ''}.`);
    }

    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const block of message.content) {
      if (block.type === 'text') text += block.text;
      if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: (block.input as Record<string, unknown>) || {} });
    }

    return {
      text,
      toolCalls,
      raw: message.content,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
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

// --- Gemini ---------------------------------------------------------------------

/** A part of Gemini's answer: text, a function call, or the model's thinking with its signature. */
interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  [other: string]: unknown;
}

/** One event of Gemini's stream. */
interface GeminiChunk {
  candidates?: {
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
    groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] };
  }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number };
}

const gemini = (apiKey: string, model: string, grounded = false): Adapter => async ({ system, turns, tools, maxTokens }, { onText, beat, signal }) => {
  const contents = turns.map(turn => {
    if (turn.role === 'user') {
      return { role: 'user', parts: [{ text: turn.text }, ...(turn.images || []).map(image => ({ inlineData: { mimeType: image.mediaType, data: image.data } }))] };
    }
    if (turn.role === 'assistant') {
      // The original parts go back unchanged: they carry the signatures Gemini needs to continue its reasoning
      return { role: 'model', parts: (turn.raw as unknown[]) ?? [{ text: turn.text }] };
    }
    return { role: 'user', parts: turn.results.map(result => ({ functionResponse: { name: result.name, response: { [result.isError ? 'error' : 'output']: result.output } } })) };
  });

  const res = await fetch(`${GEMINI_BASE_URL}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    signal,
    body: JSON.stringify({
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents,
      ...(grounded
        ? { tools: [{ google_search: {} }] }
        : tools.length ? { tools: [{ functionDeclarations: tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }] } : {}),
      generationConfig: { maxOutputTokens: Math.max(maxTokens, THINKING_HEADROOM_TOKENS) },
    }),
  });

  if (!res.ok) {
    throw new Error(`Gemini (${model}) failed: ${res.status} ${(await res.text()).slice(0, 500)}`);
  }

  let text = '';
  let finishReason = '';
  let usage: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number } = {};
  const parts: GeminiPart[] = [];
  const toolCalls: ToolCall[] = [];
  const sources = new Set<string>();

  for await (const line of readLines(res)) {
    beat();
    if (!line.startsWith('data:')) continue;
    let chunk: GeminiChunk;
    try {
      chunk = JSON.parse(line.slice(5));
    } catch {
      continue;
    }
    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts || []) {
      parts.push(part);
      if (typeof part.text === 'string' && !part.thought) {
        text += part.text;
        onText(part.text);
      }
      if (part.functionCall) {
        toolCalls.push({ id: part.functionCall.id || newCallId(), name: part.functionCall.name, input: part.functionCall.args || {} });
      }
    }
    for (const source of candidate?.groundingMetadata?.groundingChunks || []) {
      if (source.web?.uri) sources.add(`${source.web.title || 'source'}: ${source.web.uri}`);
    }
    if (candidate?.finishReason) finishReason = candidate.finishReason;
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
  }

  if (!text && toolCalls.length === 0 && finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
    throw new Error(`Gemini returned no answer (${finishReason}).`);
  }
  if (sources.size > 0) text += `\n\nSources:\n${Array.from(sources).map(s => `- ${s}`).join('\n')}`;

  return {
    text,
    toolCalls,
    raw: parts,
    // Gemini caches a repeated prompt start by itself and reports how much it reused
    inputTokens: Math.max(0, (usage.promptTokenCount ?? estimateTokens(system + textOf(turns))) - (usage.cachedContentTokenCount || 0)),
    cacheReadTokens: usage.cachedContentTokenCount || 0,
    outputTokens: (usage.candidatesTokenCount ?? estimateTokens(text)) + (usage.thoughtsTokenCount || 0),
    truncated: finishReason === 'MAX_TOKENS',
  };
};

// --- Ollama ---------------------------------------------------------------------

/** A message in Ollama's chat format. */
interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
}

/** One line of Ollama's stream; the last one carries the totals. */
interface OllamaChunk {
  error?: string;
  message?: { content?: string; tool_calls?: { function?: { name?: string; arguments?: string | Record<string, unknown> } }[] };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

const ollama = (url: string, model: string): Adapter => async ({ system, turns, tools, maxTokens }, { onText, beat, signal }) => {
  const messages: OllamaMessage[] = [];
  if (system) messages.push({ role: 'system', content: system });
  for (const turn of turns) {
    if (turn.role === 'user') {
      messages.push({ role: 'user', content: turn.text, ...(turn.images?.length ? { images: turn.images.map(image => image.data) } : {}) });
    } else if (turn.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: turn.text,
        ...(turn.toolCalls?.length ? { tool_calls: turn.toolCalls.map(call => ({ function: { name: call.name, arguments: call.input } })) } : {}),
      });
    } else {
      for (const result of turn.results) messages.push({ role: 'tool', tool_name: result.name, content: result.output });
    }
  }

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
        ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', function: tool })) } : {}),
        options: { num_predict: maxTokens, num_ctx: OLLAMA_NUM_CTX }
      })
    });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new Error(`Cannot reach Ollama at ${url}. Is it running? (${errorMessage(e)})`);
  }

  if (!res.ok) {
    const body = await res.text();
    if (tools.length && /does not support tools/i.test(body)) throw new ToolsUnsupportedError(`${model} cannot call tools.`);
    throw new Error(`Ollama (${model}) failed: ${res.status} ${body}`);
  }

  let text = '';
  let last: OllamaChunk = {};
  const toolCalls: ToolCall[] = [];
  // One JSON object per line; the last one carries the totals
  for await (const line of readLines(res)) {
    beat();
    if (!line.trim()) continue;
    let chunk: OllamaChunk;
    try {
      chunk = JSON.parse(line);
    } catch {
      continue;
    }
    if (chunk.error) {
      if (tools.length && /does not support tools/i.test(chunk.error)) throw new ToolsUnsupportedError(`${model} cannot call tools.`);
      throw new Error(`Ollama (${model}) failed: ${chunk.error}`);
    }
    if (chunk.message?.content) {
      text += chunk.message.content;
      onText(chunk.message.content);
    }
    for (const call of chunk.message?.tool_calls || []) {
      const args = call.function?.arguments;
      try {
        toolCalls.push({ id: newCallId(), name: call.function?.name || '', input: typeof args === 'string' ? JSON.parse(args || '{}') : args || {} });
      } catch {
        toolCalls.push({ id: newCallId(), name: call.function?.name || '', input: {}, invalid: 'The arguments were not valid JSON.' });
      }
    }
    if (chunk.done) last = chunk;
  }

  return {
    text,
    toolCalls,
    inputTokens: last.prompt_eval_count || 0,
    outputTokens: last.eval_count || 0,
    truncated: last.done_reason === 'length',
  };
};

// --- Public interface -----------------------------------------------------------

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

/** The adapter for a provider, or null when it has no key and answers with mock text. */
const adapterFor = (provider: APIProvider, model: string): Adapter | null => {
  if (provider === 'Grok') {
    const apiKey = getSetting('grokKey');
    return apiKey ? openAiCompatible(new OpenAI({ apiKey, baseURL: 'https://api.x.ai/v1' }), model, 'max_tokens') : null;
  }
  if (provider === 'OpenAI') {
    const apiKey = getSetting('openaiKey');
    return apiKey ? openAiCompatible(new OpenAI({ apiKey }), model, 'max_completion_tokens', true) : null;
  }
  if (provider === 'Anthropic') {
    const apiKey = getSetting('anthropicKey');
    return apiKey ? anthropic(new Anthropic({ apiKey }), model) : null;
  }
  if (provider === 'Gemini') {
    const apiKey = getSetting('geminiKey');
    return apiKey ? gemini(apiKey, model) : null;
  }
  if (provider === 'Ollama') return ollama(getSetting('ollamaUrl').replace(/\/+$/, ''), model);
  throw new Error(`Unknown API provider: ${provider}`);
};

/** False for a provider without a key: it answers with mock text and cannot use tools. */
export const hasRealModel = (provider: APIProvider) => provider === 'Ollama' || adapterFor(provider, 'x') !== null;

export interface StepRequest {
  provider: APIProvider;
  /** Model to use. Empty = the provider's default from the settings. */
  model?: string;
  system?: string;
  turns: Turn[];
  tools?: ToolSpec[];
  maxTokens?: number;
  nativeWeb?: boolean;
  /** Identifies a conversation that is sent step after step, so the provider can cache it. */
  cacheKey?: string;
  /** Called with each piece of the answer as it is written. */
  onText?: OnText;
  /** Stops the call, for example when the user halts the office. */
  signal?: AbortSignal;
}

export interface StepResult {
  text: string;
  toolCalls: ToolCall[];
  raw?: unknown;
  /** Input + output tokens, cached input included. */
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  /** Input read from the provider's cache, at a fraction of the price. */
  cachedTokens: number;
  model: string;
  /** Estimated USD; undefined when the model has no known price. */
  cost: number | undefined;
  truncated: boolean;
}

/** Runs `work` with a signal that fires when the caller stops it or the provider goes silent. */
const guarded = async <T>(label: string, signal: AbortSignal | undefined, work: (io: Pick<CallIO, 'beat' | 'signal'>) => Promise<T>) => {
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

  try {
    return await work({ beat, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new Error(`${label} sent nothing for ${IDLE_TIMEOUT_MS / 60_000} minutes, so the call was stopped.`);
    throw error;
  } finally {
    clearTimeout(idle);
    signal?.removeEventListener('abort', stop);
  }
};

/** One step of a conversation: the model answers with text, tool calls, or both. */
export const runStep = async ({ provider, model: requestedModel, system = '', turns, tools = [], maxTokens, nativeWeb = false, cacheKey, onText = () => undefined, signal }: StepRequest): Promise<StepResult> => {
  const limit = Math.min(Math.max(Math.floor(Number(maxTokens)) || DEFAULT_MAX_TOKENS, 1), MAX_TOKENS_LIMIT);
  const model = requestedModel?.trim() || defaultModel(provider);
  if (!model) throw new Error(`Unknown API provider: ${provider}`);

  const adapter = adapterFor(provider, model);

  // No key configured: answer with a mock so the interface can be explored for free
  if (!adapter) {
    const lastUser = [...turns].reverse().find(t => t.role === 'user');
    const text = `[Mock ${provider} Response] ${lastUser && 'text' in lastUser ? lastUser.text : ''}`;
    onText(text);
    return { text, toolCalls: [], tokens: 15, inputTokens: 10, outputTokens: 5, cachedTokens: 0, model: 'mock', cost: 0, truncated: false };
  }

  const output = await guarded(`${provider} (${model})`, signal, io =>
    adapter({ system, turns, tools, maxTokens: limit, nativeWeb: nativeWeb && provider === 'Anthropic', cacheKey }, { onText, ...io })
  );
  const answeredBy = output.model || model;
  const read = output.cacheReadTokens || 0;
  const written = output.cacheWriteTokens || 0;
  return {
    text: output.text,
    toolCalls: output.toolCalls,
    raw: output.raw,
    tokens: output.inputTokens + read + written + output.outputTokens,
    inputTokens: output.inputTokens,
    outputTokens: output.outputTokens,
    cachedTokens: read,
    model: answeredBy,
    cost: estimateCost(provider, answeredBy, output.inputTokens, output.outputTokens, { read, write: written }),
    truncated: output.truncated,
  };
};

export interface ModelRequest {
  provider: APIProvider;
  /** Model to use. Empty = the provider's default from the settings. */
  model?: string;
  prompt: string;
  systemPrompt?: string;
  /** Earlier turns of the same conversation, placed before `prompt`. */
  history?: ChatMessage[];
  /** Pictures shown to the model with the prompt. */
  images?: ImagePart[];
  maxTokens?: number;
  onText?: OnText;
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

/** Adds two cost estimates; unknown stays unknown. */
export const addCost = (a: number | undefined, b: number | undefined) => (a === undefined || b === undefined ? undefined : a + b);

/**
 * Runs one prompt and returns the text of the answer. If the answer is cut off mid-way the
 * model is asked to carry on, so files are not left half-written.
 */
export const runModel = async ({ provider, model, prompt, systemPrompt, history = [], images, maxTokens, onText, signal }: ModelRequest): Promise<ModelResult> => {
  const turns: Turn[] = [
    ...history.filter(m => m.role !== 'system').map(m => (m.role === 'assistant' ? { role: 'assistant' as const, text: m.content } : { role: 'user' as const, text: m.content })),
    { role: 'user', text: prompt, images },
  ];
  const total: ModelResult = { response: '', tokens: 0, inputTokens: 0, outputTokens: 0, model: '', cost: 0, truncated: false };

  for (let round = 0; round <= MAX_CONTINUATIONS; round++) {
    const part = await runStep({ provider, model, system: systemPrompt, turns, maxTokens, onText, signal });
    total.response += part.text;
    total.tokens += part.tokens;
    total.inputTokens += part.inputTokens;
    total.outputTokens += part.outputTokens;
    total.cost = addCost(total.cost, part.cost);
    total.model = part.model;
    total.truncated = part.truncated;
    if (!part.truncated || !part.text) break;
    turns.push({ role: 'assistant', text: part.text }, { role: 'user', text: CONTINUE_PROMPT });
  }

  return total;
};

// --- Web search -----------------------------------------------------------------

/** Models used to look things up on behalf of an employee whose own model cannot search. */
const SEARCH_MODELS = {
  Anthropic: process.env.ANTHROPIC_SEARCH_MODEL || 'claude-haiku-4-5',
  OpenAI: process.env.OPENAI_SEARCH_MODEL || 'gpt-4o-mini-search-preview',
  Gemini: process.env.GEMINI_SEARCH_MODEL || 'gemini-2.5-flash',
} as const;

type SearchProvider = keyof typeof SEARCH_MODELS;

const SEARCH_KEYS = { Anthropic: 'anthropicKey', OpenAI: 'openaiKey', Gemini: 'geminiKey' } as const;

const SEARCH_SYSTEM = 'You are a research assistant. Search the web and answer the question with current, specific facts and figures. Give the date of each figure when it matters, and end with the list of source URLs you used. If you cannot find something, say so instead of guessing.';

/** The provider that will run web searches: the employee's own when it can, else any with a key. */
export const searchProviderFor = (preferred: APIProvider): SearchProvider | null => {
  const available = (Object.keys(SEARCH_KEYS) as SearchProvider[]).filter(provider => getSetting(SEARCH_KEYS[provider]));
  return available.find(provider => provider === preferred) || available[0] || null;
};

/** Looks something up on the web and returns an answer with its sources. */
export const searchWeb = async (query: string, preferred: APIProvider, signal?: AbortSignal): Promise<{ answer: string; tokens: number; cost: number | undefined; model: string }> => {
  const provider = searchProviderFor(preferred);
  if (!provider) throw new Error('Web search needs an Anthropic, OpenAI or Gemini API key in the settings.');
  const model = SEARCH_MODELS[provider];
  const turns: Turn[] = [{ role: 'user', text: query }];

  const output: StepOutput = await guarded(`${provider} search`, signal, async io => {
    const call: CallIO = { onText: () => undefined, ...io };
    if (provider === 'Anthropic') {
      return anthropic(new Anthropic({ apiKey: getSetting('anthropicKey') }), model)({ system: SEARCH_SYSTEM, turns, tools: [], maxTokens: 2000, nativeWeb: true }, call);
    }
    if (provider === 'Gemini') {
      return gemini(getSetting('geminiKey'), model, true)({ system: SEARCH_SYSTEM, turns, tools: [], maxTokens: 2000, nativeWeb: false }, call);
    }
    // OpenAI's search models search on every request
    const client = new OpenAI({ apiKey: getSetting('openaiKey') });
    const completion = await client.chat.completions.create({
      model,
      web_search_options: {},
      messages: [{ role: 'system', content: SEARCH_SYSTEM }, { role: 'user', content: query }],
    }, { signal: io.signal });
    const message = completion.choices[0].message;
    const links = (message.annotations || []).filter(a => a.url_citation?.url).map(a => `- ${a.url_citation.title || 'source'}: ${a.url_citation.url}`);
    return {
      text: `${message.content || ''}${links.length ? `\n\nSources:\n${Array.from(new Set(links)).join('\n')}` : ''}`,
      toolCalls: [],
      inputTokens: completion.usage?.prompt_tokens || 0,
      outputTokens: completion.usage?.completion_tokens || 0,
      truncated: false,
    };
  });

  const answeredBy = output.model || model;
  return {
    answer: output.text || 'The search returned nothing.',
    tokens: output.inputTokens + output.outputTokens,
    cost: estimateCost(provider, answeredBy, output.inputTokens, output.outputTokens),
    model: answeredBy,
  };
};
