import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startFakeProvider, type FakeProvider, type FakeReply } from './helpers/fakeProvider';

// Settings and provider addresses are read when the modules load, so everything is set first
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-llm-test-'));
process.env.OFFICE_DATA_DIR = dataDir;
let fake: FakeProvider;
let llm: typeof import('../src/lib/server/llm');

before(async () => {
  fake = await startFakeProvider();
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_BASE_URL = `${fake.url}/v1`;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_BASE_URL = fake.url;
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.GEMINI_BASE_URL = fake.url;
  process.env.OLLAMA_URL = fake.url;
  delete process.env.GROK_API_KEY;
  llm = await import('../src/lib/server/llm');
});

after(async () => {
  await fake.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const PROVIDERS = [
  { name: 'OpenAI', key: 'openai', model: 'gpt-4o-mini' },
  { name: 'Anthropic', key: 'anthropic', model: 'claude-haiku-4-5' },
  { name: 'Gemini', key: 'gemini', model: 'gemini-2.5-flash' },
  { name: 'Ollama', key: 'ollama', model: 'llama3' },
] as const;

const WRITE_FILE = {
  name: 'write_file',
  description: 'Writes a file',
  parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
};

const step = (provider: (typeof PROVIDERS)[number], reply: FakeReply, extra: Partial<Parameters<typeof llm.runStep>[0]> = {}) => {
  fake.setScript(() => reply);
  const streamed: string[] = [];
  return llm.runStep({
    provider: provider.name,
    model: provider.model,
    system: 'You are a test.',
    turns: [{ role: 'user', text: 'Say hello' }],
    onText: delta => streamed.push(delta),
    ...extra,
  }).then(result => ({ result, streamed: streamed.join(''), request: fake.requests[fake.requests.length - 1] }));
};

for (const provider of PROVIDERS) {
  test(`${provider.name}: streamed text is put together and passed on as it arrives`, async () => {
    const { result, streamed, request } = await step(provider, { text: 'Hello from the office, in pieces.', usage: { input: 1000, output: 200 } });
    assert.equal(request.provider, provider.key);
    assert.match(request.system, /You are a test\./);
    assert.equal(result.text, 'Hello from the office, in pieces.');
    assert.equal(streamed, 'Hello from the office, in pieces.');
    assert.deepEqual(result.toolCalls, []);
    assert.equal(result.truncated, false);
    assert.equal(result.inputTokens, 1000);
    assert.equal(result.outputTokens, 200);
  });

  test(`${provider.name}: tool calls are read, with arguments that arrive in pieces`, async () => {
    const input = { path: 'index.html', content: '<h1>Crumb & Co</h1>\n<p>"quoted" — and unicode ✓</p>' };
    const { result, request } = await step(provider, { toolCalls: [{ name: 'write_file', input }, { name: 'write_file', input: { path: 'b.css', content: 'body{}' } }] }, { tools: [WRITE_FILE] });
    assert.equal(result.toolCalls.length, 2);
    assert.equal(result.toolCalls[0].name, 'write_file');
    assert.deepEqual(result.toolCalls[0].input, input);
    assert.deepEqual(result.toolCalls[1].input, { path: 'b.css', content: 'body{}' });
    assert.ok(result.toolCalls.every(call => call.id), 'every call has an id to answer it by');
    // The tool was offered in the provider's own format
    assert.match(JSON.stringify(request.body), /write_file/);
  });

  test(`${provider.name}: a reply cut off at the length limit is flagged`, async () => {
    const { result } = await step(provider, { text: 'Half a sent', truncated: true });
    assert.equal(result.truncated, true);
  });

  test(`${provider.name}: tool results are sent back so the model can carry on`, async () => {
    const { request } = await step(provider, { text: 'Saved.' }, {
      tools: [WRITE_FILE],
      turns: [
        { role: 'user', text: 'Write the page' },
        { role: 'assistant', text: '', toolCalls: [{ id: 'call_a', name: 'write_file', input: { path: 'index.html', content: 'x' } }] },
        { role: 'tool', results: [{ id: 'call_a', name: 'write_file', output: 'Saved index.html' }] },
      ],
    });
    assert.equal(request.toolRounds, 1);
    assert.match(JSON.stringify(request.body), /Saved index\.html/);
  });
}

test('the cost is estimated from the list price of the model that answered', async () => {
  const { result } = await step(PROVIDERS[0], { text: 'ok', usage: { input: 1_000_000, output: 1_000_000 } });
  // gpt-4o-mini: $0.15 per million in, $0.60 per million out
  assert.ok(Math.abs((result.cost ?? -1) - 0.75) < 1e-9, String(result.cost));
});

test('Ollama counts as free', async () => {
  const { result } = await step(PROVIDERS[3], { text: 'ok', usage: { input: 5000, output: 5000 } });
  assert.equal(result.cost, 0);
});

test('a local model that cannot call tools is reported as such, so the office can switch to the tag format', async () => {
  fake.setScript(() => {
    throw new Error('registry.ollama.ai/library/llama3:latest does not support tools');
  });
  await assert.rejects(
    llm.runStep({ provider: 'Ollama', model: 'llama3', turns: [{ role: 'user', text: 'hi' }], tools: [WRITE_FILE] }),
    (error: unknown) => error instanceof llm.ToolsUnsupportedError,
  );
});

test('a provider without a key answers with mock text and costs nothing', async () => {
  const before = fake.requests.length;
  const result = await llm.runStep({ provider: 'Grok', model: 'grok-3', turns: [{ role: 'user', text: 'Build a page' }] });
  assert.match(result.text, /^\[Mock Grok Response\] Build a page/);
  assert.equal(result.cost, 0);
  assert.equal(llm.hasRealModel('Grok'), false);
  assert.equal(llm.hasRealModel('OpenAI'), true);
  assert.equal(fake.requests.length, before, 'nothing was sent anywhere');
});

test('an answer cut off at the length limit is asked to carry on, and the pieces are joined', async () => {
  let calls = 0;
  fake.setScript(() => (++calls === 1 ? { text: 'First half, ', truncated: true } : { text: 'second half.' }));
  const result = await llm.runModel({ provider: 'OpenAI', model: 'gpt-4o-mini', prompt: 'Write a long file' });
  assert.equal(result.response, 'First half, second half.');
  assert.equal(calls, 2);
  assert.match(fake.requests[fake.requests.length - 1].allText, /cut off by the length limit/);
});

test('a provider error is reported with the provider and status', async () => {
  fake.setScript(() => {
    throw new Error('model not found');
  });
  await assert.rejects(llm.runStep({ provider: 'Gemini', model: 'gemini-nope', turns: [{ role: 'user', text: 'hi' }] }), /Gemini \(gemini-nope\) failed: 500/);
});
