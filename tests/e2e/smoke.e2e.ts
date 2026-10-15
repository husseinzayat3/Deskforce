import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { chromium, type Browser, type Page } from 'playwright';

/**
 * The whole office in a real browser: hire someone, give them a task, approve the plan, and
 * find the result and its report. No provider has a key, so the employee answers with mock
 * text that echoes the request; tags in the request become the project and its file.
 */

const root = path.resolve(__dirname, '..', '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-e2e-'));
let server: ChildProcess;
let browser: Browser;
let page: Page;
let base = '';

const freePort = () => new Promise<number>((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address() as net.AddressInfo;
    probe.close(() => resolve(port));
  });
});

const waitForServer = async (url: string, timeoutMs: number) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`The office did not start at ${url}`);
};

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  // Blank keys win over a developer's .env.local, so this test can never call a paid model
  const noKeys = Object.fromEntries(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GROK_API_KEY', 'SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN'].map(name => [name, '']));
  server = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: root,
    env: { ...process.env, ...noKeys, OFFICE_DATA_DIR: dataDir, OFFICE_WEB_ACCESS: 'off', NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let log = '';
  server.stdout?.on('data', chunk => (log += chunk));
  server.stderr?.on('data', chunk => (log += chunk));
  try {
    await waitForServer(`${base}/api/office`, 180_000);
  } catch (e) {
    console.error(log);
    throw e;
  }
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(60_000);
});

after(async () => {
  await browser?.close();
  // The dev server starts helpers of its own: stop the whole group
  if (server?.pid) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      server.kill('SIGTERM');
    }
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Runs a test and keeps a screenshot of the page when it fails, for CI to upload. */
const withScreenshot = (name: string, body: () => Promise<void>) => async () => {
  try {
    await body();
  } catch (error) {
    fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
    await page?.screenshot({ path: path.join(root, 'test-results', `${name}.png`), fullPage: true }).catch(() => undefined);
    throw error;
  }
};

test('hire an employee, assign a task, approve the plan, and get the files and the report', withScreenshot('smoke', async () => {
  await page.goto(base);

  // Hire
  // The form is already open in an empty office
  const toggle = page.getByRole('button', { name: 'Hire new employee' });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await page.getByPlaceholder('Employee Name').fill('Eve');
  await page.getByLabel('Role', { exact: true }).selectOption('CEO');
  await page.getByLabel('AI provider', { exact: true }).selectOption('Anthropic');
  await page.getByRole('button', { name: 'Hire Employee' }).click();
  await page.getByText('Eve', { exact: true }).first().waitFor();

  // Assign, with a plan first
  await page.locator('button[title="Assign Task"]').first().click();
  await page.getByPlaceholder('Enter task prompt...').fill('Save a note. [PROJECT: e2e-notes] [FILE: notes.md]Remember the milk.[/FILE]');
  const planFirst = page.getByLabel('Show me a plan to approve before any work starts');
  if (!(await planFirst.isChecked())) await planFirst.check();
  await page.getByPlaceholder('Enter task prompt...').press('Enter');

  // Nothing is built until the plan is approved
  await page.getByRole('tab', { name: /Tasks/ }).click();
  await page.getByRole('button', { name: 'Approve plan' }).click();

  // The report appears when the work is done
  await page.locator('button[title="Download the report for this task"]').waitFor();

  // The file is in the project
  await page.locator('button[title="Browse this project\'s files and history"]').first().click();
  await page.getByText('notes.md', { exact: true }).click();
  await page.getByText('Remember the milk.').waitFor();

  assert.equal(fs.readFileSync(path.join(dataDir, 'projects', 'e2e-notes', 'notes.md'), 'utf-8').trim(), 'Remember the milk.');
  assert.ok(fs.existsSync(path.join(dataDir, 'projects', 'e2e-notes', 'REPORT.md')));
}));
