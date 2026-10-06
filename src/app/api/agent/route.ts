import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { estimateCost } from '../../../lib/officeConfig';

const DEFAULT_MAX_TOKENS = 4000;
/** Upper bound on a single model call, whatever the caller asks for. */
const MAX_TOKENS_LIMIT = 8000;

/** How many times a response that hit the length limit is asked to carry on. */
const MAX_CONTINUATIONS = 2;
const CONTINUE_PROMPT = 'Your previous message was cut off by the length limit. Continue exactly where it stopped, starting with the very next character. Do not repeat anything and do not add an introduction.';

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const GROK_MODEL = process.env.GROK_MODEL || 'grok-3';
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3';
/** Ollama's default context window is small enough to silently cut off the project context. */
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || 8192;

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

interface Completion {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** The model stopped because it ran out of room, not because it was done. */
  truncated: boolean;
}

type ModelCall = (messages: ChatMessage[]) => Promise<Completion>;

/** A provider that could not be reached or answered with an error; reported as a failed task. */
class UpstreamError extends Error {}

const openAiCompatible = (client: OpenAI, model: string, maxTokens: number): ModelCall => async messages => {
  const completion = await client.chat.completions.create({ messages, model, max_tokens: maxTokens });
  const choice = completion.choices[0];
  return {
    text: choice.message.content || '',
    inputTokens: completion.usage?.prompt_tokens || 0,
    outputTokens: completion.usage?.completion_tokens || 0,
    truncated: choice.finish_reason === 'length',
  };
};

const ollama = (maxTokens: number): ModelCall => async messages => {
  let res: Response;
  try {
    res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages,
        stream: false,
        options: { num_predict: maxTokens, num_ctx: OLLAMA_NUM_CTX }
      })
    });
  } catch (e: any) {
    throw new UpstreamError(`Cannot reach Ollama at ${OLLAMA_URL}. Is it running? (${e.message})`);
  }

  if (!res.ok) {
    throw new UpstreamError(`Ollama (${OLLAMA_MODEL}) failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return {
    text: data.message?.content || '',
    inputTokens: data.prompt_eval_count || 0,
    outputTokens: data.eval_count || 0,
    truncated: data.done_reason === 'length',
  };
};

/** Calls the model, and if the answer is cut off mid-way asks it to carry on, so files are not left half-written. */
const completeFully = async (call: ModelCall, messages: ChatMessage[]): Promise<Completion> => {
  const conversation = [...messages];
  const total: Completion = { text: '', inputTokens: 0, outputTokens: 0, truncated: false };

  for (let round = 0; round <= MAX_CONTINUATIONS; round++) {
    const part = await call(conversation);
    total.text += part.text;
    total.inputTokens += part.inputTokens;
    total.outputTokens += part.outputTokens;
    total.truncated = part.truncated;
    if (!part.truncated || !part.text) break;
    conversation.push({ role: 'assistant', content: part.text }, { role: 'user', content: CONTINUE_PROMPT });
  }

  return total;
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { prompt, apiProvider, systemPrompt } = body;

    if (typeof prompt !== 'string' || !prompt.trim()) {
      return NextResponse.json({ error: 'Missing prompt' }, { status: 400 });
    }

    const maxTokens = Math.min(Math.max(Math.floor(Number(body.maxTokens)) || DEFAULT_MAX_TOKENS, 1), MAX_TOKENS_LIMIT);

    const messages: ChatMessage[] = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    let model: string;
    let call: ModelCall | null;

    if (apiProvider === 'Grok') {
      const apiKey = process.env.GROK_API_KEY;
      model = GROK_MODEL;
      call = apiKey ? openAiCompatible(new OpenAI({ apiKey, baseURL: 'https://api.x.ai/v1' }), model, maxTokens) : null;
    } else if (apiProvider === 'OpenAI') {
      const apiKey = process.env.OPENAI_API_KEY;
      model = OPENAI_MODEL;
      call = apiKey ? openAiCompatible(new OpenAI({ apiKey }), model, maxTokens) : null;
    } else if (apiProvider === 'Ollama') {
      model = OLLAMA_MODEL;
      call = ollama(maxTokens);
    } else {
      return NextResponse.json({ error: `Unknown API provider: ${apiProvider}` }, { status: 400 });
    }

    // No key configured: answer with a mock so the interface can be explored for free
    if (!call) {
      return NextResponse.json({ response: `[Mock ${apiProvider} Response] ${prompt}`, tokens: 15, inputTokens: 10, outputTokens: 5, model: 'mock', cost: 0, truncated: false });
    }

    const result = await completeFully(call, messages);

    return NextResponse.json({
      response: result.text,
      tokens: result.inputTokens + result.outputTokens,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      model,
      cost: estimateCost(apiProvider, model, result.inputTokens, result.outputTokens) ?? null,
      truncated: result.truncated,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error instanceof UpstreamError ? 502 : 500 });
  }
}
