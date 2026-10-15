import http from 'http';
import type { AddressInfo } from 'net';

/**
 * A stand-in for the AI providers, served on this computer. It answers in each provider's own
 * streaming format, so the real adapters in `llm.ts` parse its replies exactly as they would a
 * provider's, and tests decide what the "model" says without any network or key.
 */

export type Provider = 'openai' | 'anthropic' | 'gemini' | 'ollama';

export interface FakeRequest {
  provider: Provider;
  /** The system prompt, whatever field the provider carries it in. */
  system: string;
  /** The request body as the adapter sent it. */
  body: any;
  /** How many tool results the conversation already holds: 0 on a task's first step. */
  toolRounds: number;
  /** All text the request carries, for matching on. */
  allText: string;
}

export interface FakeReply {
  text?: string;
  toolCalls?: { name: string; input: Record<string, unknown> }[];
  usage?: { input: number; output: number };
  /** Simulates a model that stopped at its length limit. */
  truncated?: boolean;
}

export type Script = (request: FakeRequest) => FakeReply;

const textOfContent = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => (part && typeof part === 'object' ? (part as any).text || (part as any).content || '' : '')).map(textOfContent).join('\n');
  return '';
};

const describe = (provider: Provider, body: any): FakeRequest => {
  if (provider === 'anthropic') {
    const system = typeof body.system === 'string' ? body.system : (body.system || []).map((b: any) => b.text).join('\n');
    const toolRounds = (body.messages || []).filter((m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result')).length;
    return { provider, system, body, toolRounds, allText: [system, ...(body.messages || []).map((m: any) => textOfContent(m.content))].join('\n') };
  }
  if (provider === 'gemini') {
    const system = (body.systemInstruction?.parts || []).map((p: any) => p.text).join('\n');
    const contents = body.contents || [];
    const toolRounds = contents.filter((c: any) => (c.parts || []).some((p: any) => p.functionResponse)).length;
    return { provider, system, body, toolRounds, allText: [system, ...contents.flatMap((c: any) => (c.parts || []).map((p: any) => p.text || ''))].join('\n') };
  }
  // OpenAI and Ollama: chat messages with a system message first
  const messages = body.messages || [];
  const system = messages.filter((m: any) => m.role === 'system').map((m: any) => textOfContent(m.content)).join('\n');
  const toolRounds = messages.filter((m: any) => m.role === 'tool').length;
  return { provider, system, body, toolRounds, allText: messages.map((m: any) => textOfContent(m.content)).join('\n') };
};

/** Splits a string in a few pieces, as a provider streams it. */
const pieces = (text: string, count = 3) => {
  if (!text) return [];
  const size = Math.ceil(text.length / count);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
};

const sse = (res: http.ServerResponse, events: { event?: string; data: unknown }[]) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const { event, data } of events) {
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
  }
  res.end();
};

const replyOpenAI = (res: http.ServerResponse, model: string, reply: FakeReply) => {
  const base = { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 0, model };
  const events: { data: unknown }[] = [{ data: { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] } }];
  for (const piece of pieces(reply.text || '')) events.push({ data: { ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] } });
  (reply.toolCalls || []).forEach((call, index) => {
    events.push({ data: { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index, id: `call_${index}`, type: 'function', function: { name: call.name, arguments: '' } }] }, finish_reason: null }] } });
    // Arguments arrive in pieces, as they do from the real API
    for (const piece of pieces(JSON.stringify(call.input))) {
      events.push({ data: { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: piece } }] }, finish_reason: null }] } });
    }
  });
  const finish = reply.truncated ? 'length' : reply.toolCalls?.length ? 'tool_calls' : 'stop';
  events.push({ data: { ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] } });
  events.push({ data: { ...base, choices: [], usage: { prompt_tokens: reply.usage?.input ?? 100, completion_tokens: reply.usage?.output ?? 20, total_tokens: (reply.usage?.input ?? 100) + (reply.usage?.output ?? 20) } } });
  events.push({ data: '[DONE]' });
  sse(res, events);
};

const replyAnthropic = (res: http.ServerResponse, model: string, reply: FakeReply) => {
  const events: { event: string; data: unknown }[] = [{
    event: 'message_start',
    data: { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: reply.usage?.input ?? 100, output_tokens: 1 } } },
  }];
  let index = 0;
  if (reply.text) {
    events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } });
    for (const piece of pieces(reply.text)) events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } } });
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
    index++;
  }
  for (const call of reply.toolCalls || []) {
    events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${index}`, name: call.name, input: {} } } });
    for (const piece of pieces(JSON.stringify(call.input))) events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: piece } } });
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
    index++;
  }
  const stop = reply.truncated ? 'max_tokens' : reply.toolCalls?.length ? 'tool_use' : 'end_turn';
  events.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: reply.usage?.output ?? 20 } } });
  events.push({ event: 'message_stop', data: { type: 'message_stop' } });
  sse(res, events);
};

const replyGemini = (res: http.ServerResponse, reply: FakeReply) => {
  const events: { data: unknown }[] = [];
  for (const piece of pieces(reply.text || '')) events.push({ data: { candidates: [{ content: { role: 'model', parts: [{ text: piece }] } }] } });
  for (const call of reply.toolCalls || []) events.push({ data: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: call.name, args: call.input } }] } }] } });
  events.push({
    data: {
      candidates: [{ content: { role: 'model', parts: [] }, finishReason: reply.truncated ? 'MAX_TOKENS' : 'STOP' }],
      usageMetadata: { promptTokenCount: reply.usage?.input ?? 100, candidatesTokenCount: reply.usage?.output ?? 20 },
    },
  });
  sse(res, events);
};

const replyOllama = (res: http.ServerResponse, model: string, reply: FakeReply) => {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  for (const piece of pieces(reply.text || '')) res.write(`${JSON.stringify({ model, message: { role: 'assistant', content: piece }, done: false })}\n`);
  if (reply.toolCalls?.length) {
    res.write(`${JSON.stringify({ model, message: { role: 'assistant', content: '', tool_calls: reply.toolCalls.map(call => ({ function: { name: call.name, arguments: call.input } })) }, done: false })}\n`);
  }
  res.write(`${JSON.stringify({ model, message: { role: 'assistant', content: '' }, done: true, done_reason: reply.truncated ? 'length' : 'stop', prompt_eval_count: reply.usage?.input ?? 100, eval_count: reply.usage?.output ?? 20 })}\n`);
  res.end();
};

export interface FakeProvider {
  /** For example http://127.0.0.1:51234 */
  url: string;
  /** Every request received, oldest first. */
  requests: FakeRequest[];
  /** Replaces the script that decides the answers. */
  setScript: (script: Script) => void;
  close: () => Promise<void>;
}

/** Starts the fake provider on a free port. Without a script, every request is answered "Done.". */
export const startFakeProvider = async (script: Script = () => ({ text: 'Done.' })): Promise<FakeProvider> => {
  let current = script;
  const requests: FakeRequest[] = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      let body: any = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        // left empty
      }
      const url = req.url || '';
      const provider: Provider | null = url.includes('/chat/completions') ? 'openai'
        : url.includes('/v1/messages') ? 'anthropic'
          : url.includes(':streamGenerateContent') ? 'gemini'
            : url.startsWith('/api/chat') ? 'ollama'
              : null;
      if (!provider) {
        res.writeHead(404).end();
        return;
      }
      const request = describe(provider, body);
      requests.push(request);
      let reply: FakeReply;
      try {
        reply = current(request);
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: e.message } }));
        return;
      }
      const model = body.model || decodeURIComponent(url.match(/models\/([^:]+):/)?.[1] || 'fake-model');
      if (provider === 'openai') replyOpenAI(res, model, reply);
      else if (provider === 'anthropic') replyAnthropic(res, model, reply);
      else if (provider === 'gemini') replyGemini(res, reply);
      else replyOllama(res, model, reply);
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setScript: next => (current = next),
    close: () => new Promise(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
};
