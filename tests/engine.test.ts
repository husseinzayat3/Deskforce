import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import git from 'isomorphic-git';
import { startFakeProvider, type FakeProvider, type FakeRequest, type FakeReply } from './helpers/fakeProvider';

/**
 * The engine end to end: tasks go through the real queue, prompts, tools, files, git history
 * and reports, with a fake provider standing in for the model. Each test hires its own
 * employees, so the tests share one office without getting in each other's way.
 */

const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-engine-test-')));
process.env.OFFICE_DATA_DIR = dataDir;
process.env.OFFICE_WEB_ACCESS = 'off';
process.env.OFFICE_PLAN_FIRST = 'off';
process.env.OFFICE_ALLOW_CHECKS = 'off';
for (const name of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GROK_API_KEY', 'SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN']) delete process.env[name];

let fake: FakeProvider;
let store: typeof import('../src/lib/server/store');
let actions: typeof import('../src/lib/server/actions');
let engine: typeof import('../src/lib/server/engine');

/** What each employee "says", by name. Anything not scripted answers "Done.". */
const scripts = new Map<string, (request: FakeRequest) => FakeReply>();
const speaker = (request: FakeRequest) => request.system.match(/You are ([^,]+), the /)?.[1] || '';

before(async () => {
  fake = await startFakeProvider(request => (scripts.get(speaker(request)) || (() => ({ text: 'Done.' })))(request));
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_BASE_URL = `${fake.url}/v1`;
  store = await import('../src/lib/server/store');
  actions = await import('../src/lib/server/actions');
  engine = await import('../src/lib/server/engine');
  engine.ensureEngine();
});

after(async () => {
  engine.abortRunning();
  await fake.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const hire = (name: string, role: string, api: 'OpenAI' | 'Grok' = 'OpenAI') =>
  store.createAgent({ name, role, api, model: api === 'OpenAI' ? 'gpt-4o-mini' : 'grok-3', avatar: '/avatars/robot.png' });

const task = (id: string) => {
  const found = store.getTask(id);
  assert.ok(found, `task ${id} exists`);
  return found;
};

/** Waits for something the engine does on its own, one tick at a time. */
const waitFor = async <T>(what: string, check: () => T | undefined | false, timeoutMs = 20_000): Promise<T> => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > until) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};

const treeOf = (rootId: string) => store.getState().flatMap(a => a.taskQueue.map(t => ({ ...t, agentName: a.name })))
  .filter(t => t.id === rootId || isBelow(t.id, rootId));
const isBelow = (taskId: string, rootId: string): boolean => {
  const parent = store.getTask(taskId)?.parentId;
  return !!parent && (parent === rootId || isBelow(parent, rootId));
};

const projectFile = (project: string, file: string) => path.join(dataDir, 'projects', project, file);

test('one employee names the project, writes a file, commits it and gets a report', async () => {
  const ada = hire('Ada', 'CEO');
  scripts.set('Ada', request => request.toolRounds === 0
    ? { toolCalls: [
      { name: 'name_project', input: { name: 'bakery-page' } },
      { name: 'write_file', input: { path: 'index.html', content: '<h1>Crumb & Co</h1>' } },
    ] }
    : { text: 'Built the bakery page.' });

  const id = store.createTask(ada, 'Build a landing page for a bakery', 'User');
  const done = await waitFor('the task and its report', () => {
    const t = task(id);
    return t.status === 'COMPLETED' && t.report ? t : undefined;
  });

  assert.equal(done.project, 'bakery-page');
  assert.equal(done.summary, 'Built the bakery page.');
  assert.equal(fs.readFileSync(projectFile('bakery-page', 'index.html'), 'utf-8').trim(), '<h1>Crumb & Co</h1>');
  assert.ok(done.tokens && done.tokens > 0, 'tokens are counted');
  assert.ok(done.cost && done.cost > 0, 'cost is estimated');

  // The work is one commit in the employee's name
  assert.ok(done.commit, 'the task has a commit');
  const [commit] = await git.log({ fs, dir: path.join(dataDir, 'projects', 'bakery-page'), ref: done.commit, depth: 1 });
  assert.equal(commit.commit.author.name, 'Ada');

  // One person worked on it: no review, straight to the report
  assert.equal(treeOf(id).filter(t => t.kind === 'REVIEW').length, 0);
  assert.ok(fs.existsSync(projectFile('bakery-page', 'REPORT.md')), 'the report is saved in the project');
});

test('delegated work runs after the manager, then a follow-up and a final review come before the report', async () => {
  const bob = hire('Bob', 'CEO');
  const jim = hire('Jim', 'Junior Dev');
  scripts.set('Bob', request => {
    if (/Final review|Your team has finished/.test(request.allText)) return { text: 'Checked: all good.' };
    return request.toolRounds === 0
      ? { toolCalls: [
        { name: 'name_project', input: { name: 'todo-app' } },
        { name: 'delegate', input: { employee_id: jim, title: 'Write the app script', description: 'Create app.js with the to-do logic.' } },
      ] }
      : { text: 'Planned and delegated.' };
  });
  scripts.set('Jim', request => request.toolRounds === 0
    ? { toolCalls: [{ name: 'write_file', input: { path: 'app.js', content: 'export const todos = [];' } }] }
    : { text: 'Wrote app.js.' });

  const id = store.createTask(bob, 'Build a small to-do app', 'User');
  await waitFor('the report', () => task(id).report);

  const tree = treeOf(id);
  const delegated = tree.find(t => t.agentName === 'Jim');
  assert.ok(delegated, 'Jim got a task');
  assert.equal(delegated.parentId, id);
  assert.equal(delegated.title, 'Write the app script');
  assert.equal(delegated.status, 'COMPLETED');
  assert.ok(tree.some(t => t.kind === 'FOLLOWUP' && t.status === 'COMPLETED'), 'Bob followed up on the team');
  assert.ok(tree.some(t => t.kind === 'REVIEW' && t.status === 'COMPLETED'), 'the project was reviewed');
  assert.equal(fs.readFileSync(projectFile('todo-app', 'app.js'), 'utf-8').trim(), 'export const todos = [];');

  // Jim was told about his manager and worked in the manager's project
  const jimRequest = fake.requests.find(r => speaker(r) === 'Jim');
  assert.match(jimRequest!.allText, /Create app\.js with the to-do logic\./);
});

test('nobody can hand work to someone more senior', async () => {
  const carol = hire('Carol', 'CEO');
  const dee = hire('Dee', 'Designer');
  const lu = hire('Lu', 'Junior Dev');
  scripts.set('Dee', request => request.toolRounds === 0
    ? { toolCalls: [{ name: 'delegate', input: { employee_id: carol, title: 'Do my work', description: 'Please design everything.' } }] }
    : { text: 'Did it myself.' });

  const id = store.createTask(dee, 'Design a logo', 'User');
  await waitFor('the task', () => task(id).status === 'COMPLETED');

  assert.equal(store.getState().find(a => a.id === carol)!.taskQueue.length, 0, 'the CEO got nothing');
  // The model is told the ID is not one it may use, and offered only more junior colleagues
  const answer = fake.requests.filter(r => speaker(r) === 'Dee').find(r => r.toolRounds === 1)!.allText;
  assert.match(answer, /No colleague has the ID/);
  assert.ok(answer.includes(lu), 'the junior is offered');
  assert.ok(!new RegExp(`Valid IDs:[^\\n]*${carol}`).test(answer), 'the CEO is not offered');
});

test('a question for the client pauses the task until it is answered', async () => {
  const quin = hire('Quin', 'CEO');
  scripts.set('Quin', request => {
    if (/A: Blue/.test(request.allText)) {
      return request.toolRounds === 0
        ? { toolCalls: [{ name: 'name_project', input: { name: 'blue-site' } }, { name: 'write_file', input: { path: 'style.css', content: 'body { color: blue; }' } }] }
        : { text: 'Used blue.' };
    }
    return { toolCalls: [{ name: 'ask_client', input: { question: 'Which colour should the site be?' } }] };
  });

  const id = store.createTask(quin, 'Make a one-page site', 'User');
  const waiting = await waitFor('the question', () => (task(id).status === 'WAITING_FOR_INPUT' ? task(id) : undefined));
  assert.equal(waiting.question, 'Which colour should the site be?');

  assert.equal(actions.answerQuestion(id, 'Blue'), null);
  const done = await waitFor('the task', () => (task(id).status === 'COMPLETED' ? task(id) : undefined));
  assert.match(done.clarifications || '', /Q: Which colour should the site be\?\nA: Blue/);
  assert.equal(fs.readFileSync(projectFile('blue-site', 'style.css'), 'utf-8').trim(), 'body { color: blue; }');
});

test('with plan first, nothing is built until the plan is approved', async () => {
  const pat = hire('Pat', 'CEO');
  let built = false;
  scripts.set('Pat', request => {
    if (/\[STEP/.test(request.system)) return { text: '[PLAN]\nA single page with the menu.\n[/PLAN]\n[STEP: me | S] Write index.html' };
    if (request.toolRounds === 0) {
      built = true;
      return { toolCalls: [{ name: 'name_project', input: { name: 'menu-page' } }, { name: 'write_file', input: { path: 'index.html', content: 'menu' } }] };
    }
    return { text: 'Built as planned.' };
  });

  const id = store.createTask(pat, 'A page with our menu', 'User', { needsPlan: true });
  const proposed = await waitFor('the plan', () => (task(id).status === 'PLAN_REVIEW' ? task(id) : undefined));
  assert.match(proposed.plan || '', /A single page with the menu\./);
  assert.match(proposed.plan || '', /Pat \(CEO\): Write index\.html — small/);
  assert.equal(typeof proposed.planEstimate, 'number', 'the plan has a cost estimate');
  assert.equal(built, false, 'nothing was built while the plan waited');

  assert.equal(actions.approvePlan(id), null);
  await waitFor('the task', () => task(id).status === 'COMPLETED');
  assert.equal(built, true);
});

test('work handed down after the budget is used up waits for approval', async () => {
  const bud = hire('Bud', 'CEO');
  const kim = hire('Kim', 'Junior Dev');
  // A million tokens on gpt-4o-mini is far over a budget of one hundredth of a cent
  scripts.set('Bud', request => request.toolRounds === 0
    ? { toolCalls: [{ name: 'delegate', input: { employee_id: kim, title: 'Write the styles', description: 'Create style.css.' } }], usage: { input: 1_000_000, output: 1000 } }
    : { text: 'Delegated.' });

  const id = store.createTask(bud, 'Style the site', 'User', { budget: 0.0001 });
  const held = await waitFor('the held-back task', () => treeOf(id).find(t => t.agentName === 'Kim' && t.status === 'AWAITING_APPROVAL'));
  assert.match(held.reviewNote || '', /Budget of \$0\.00 reached/);
});

test('a task interrupted by a restart goes back in the queue and runs', async () => {
  const rae = hire('Rae', 'CEO');
  scripts.set('Rae', () => ({ text: 'Finished after the restart.' }));
  store.setPaused(true);
  const id = store.createTask(rae, 'Write a short note', 'User');
  // As the database looks after a crash in the middle of the task
  assert.ok(store.transitionTask(id, 'PENDING', 'IN_PROGRESS'));
  store.setPaused(false);
  const done = await waitFor('the task', () => (task(id).status === 'COMPLETED' ? task(id) : undefined));
  assert.equal(done.summary, 'Finished after the restart.');
});

test('a model without tool calling works through tags in its text', async () => {
  // Grok has no key in this test, so it answers with mock text: an echo of the prompt, tags included
  const tia = hire('Tia', 'CEO', 'Grok');
  const id = store.createTask(tia, 'Save these notes.\n[PROJECT: tag-notes]\n[FILE: notes.md]\nRemember the milk.\n[/FILE]', 'User');
  const done = await waitFor('the task', () => (task(id).status === 'COMPLETED' ? task(id) : undefined));
  assert.equal(done.project, 'tag-notes');
  assert.equal(fs.readFileSync(projectFile('tag-notes', 'notes.md'), 'utf-8').trim(), 'Remember the milk.');
});

test('the review is told where the files do not fit together, and the report keeps what is still wrong', async () => {
  const una = hire('Una', 'CEO');
  const ivo = hire('Ivo', 'Junior Dev');
  scripts.set('Una', request => {
    // The follow-up and the review change nothing, so the problem is still there for the report
    if (/Final review|Your team has finished/.test(request.allText)) return { text: 'Looks complete.' };
    return request.toolRounds === 0
      ? { toolCalls: [
        { name: 'name_project', input: { name: 'studio-site' } },
        { name: 'write_file', input: { path: 'styles/main.css', content: 'body { color: teal; }' } },
        { name: 'delegate', input: { employee_id: ivo, title: 'Write the pages', description: 'Create index.html and pricing.html.' } },
      ] }
      : { text: 'Styles done, pages delegated.' };
  });
  scripts.set('Ivo', request => request.toolRounds === 0
    ? { toolCalls: [
      { name: 'write_file', input: { path: 'index.html', content: '<html><body><h1>Studio</h1></body></html>' } },
      { name: 'write_file', input: { path: 'pricing.html', content: '<html><body><h1>Prices</h1></body></html>' } },
    ] }
    : { text: 'Pages written.' });

  const id = store.createTask(una, 'Build a two-page studio site', 'User');
  const done = await waitFor('the report', () => (task(id).report ? task(id) : undefined));

  const review = fake.requests.find(r => speaker(r) === 'Una' && /This is the final review/.test(r.system));
  assert.ok(review, 'the review ran');
  assert.match(review.system, /List everything the client's request and the approved plan ask for/);
  assert.match(review.system, /marked ✓ \(delivered\) or ✗ \(still missing\)/);
  assert.match(review.system, /index\.html does not use any stylesheet, although the project has styles\/main\.css\./);
  assert.match(review.system, /No page links to pricing\.html/);
  // The manager's follow-up saw the same problems first
  assert.ok(fake.requests.some(r => speaker(r) === 'Una' && /Your team has finished/.test(r.allText) && /does not use any stylesheet/.test(r.system)));
  // Nobody fixed them, so the client is told
  assert.match(done.report || '', /## Found by the automatic check/);
  assert.match(done.report || '', /pricing\.html does not use any stylesheet/);
});

test('replacing a file and losing what it defined is pointed out to the model', async () => {
  const wes = hire('Wes', 'CEO');
  scripts.set('Wes', request => {
    if (request.toolRounds === 0) {
      return { toolCalls: [
        { name: 'name_project', input: { name: 'tracker-lib' } },
        { name: 'write_file', input: { path: 'tracker.py', content: 'def load():\n    pass\n\n\ndef add_expense(x):\n    pass\n' } },
      ] };
    }
    if (request.toolRounds === 2) return { toolCalls: [{ name: 'write_file', input: { path: 'tracker.py', content: 'def main():\n    load()\n' } }] };
    return { text: 'Rewrote the tracker.' };
  });

  const id = store.createTask(wes, 'Write a small expense tracker module', 'User');
  await waitFor('the task', () => task(id).status === 'COMPLETED');
  const afterRewrite = fake.requests.find(r => speaker(r) === 'Wes' && r.toolRounds === 3);
  assert.ok(afterRewrite, 'the model was called again after the rewrite');
  assert.match(afterRewrite.allText, /The previous version defined load, add_expense, which this version no longer has\./);
});

test('work sent back with "Request changes" gets its own round of checks and fixes', async () => {
  process.env.OFFICE_ALLOW_CHECKS = 'on';
  try {
    const zoe = hire('Zoe', 'CEO');
    let version = 0;
    scripts.set('Zoe', request => {
      // Fixing failed checks: write valid JSON
      if (/checks failed/.test(request.allText)) {
        return request.toolRounds === 0 ? { toolCalls: [{ name: 'write_file', input: { path: 'data.json', content: '{"ok": true}' } }] } : { text: 'Fixed the JSON.' };
      }
      if (request.toolRounds > 0) return { text: 'Wrote the data.' };
      version += 1;
      return { toolCalls: [
        ...(version === 1 ? [{ name: 'name_project', input: { name: 'json-data' } }] : []),
        // Every delivery, the first one and the revision, has broken JSON
        { name: 'write_file', input: { path: 'data.json', content: '{"ok": tru' } },
      ] };
    });

    const id = store.createTask(zoe, 'Write data.json', 'User');
    await waitFor('the first report', () => task(id).report);
    const fixesOf = () => store.getState().flatMap(a => a.taskQueue).filter(t => t.parentId === id && t.title === 'Fix failing checks');
    assert.equal(fixesOf().length, 1, 'the first delivery got a fix round');
    assert.equal(task(id).checkPassed, true);

    assert.equal(actions.reviseTask(id, 'Add a second field.'), null);
    await waitFor('the second report', () => task(id).status === 'COMPLETED' && task(id).report && task(id).checkRuns === 2);
    assert.equal(fixesOf().length, 2, 'the revision got a fix round of its own');
    assert.equal(task(id).checkPassed, true);
  } finally {
    process.env.OFFICE_ALLOW_CHECKS = 'off';
  }
});

test('the monthly cap stops new work from starting, and raising it lets it run', async () => {
  const cy = hire('Cy', 'CEO');
  scripts.set('Cy', () => ({ text: 'Ran once the cap was raised.' }));
  // Earlier tests already spent more than this
  store.setMonthlyCap(0.000001);
  const id = store.createTask(cy, 'Write a haiku', 'User');

  await waitFor('the notice', () => store.listEvents(0).some(e => /Monthly cap of \$0\.00 reached/.test(e.message)));
  await new Promise(resolve => setTimeout(resolve, 2500));
  assert.equal(task(id).status, 'PENDING', 'nothing started while the cap was reached');

  store.setMonthlyCap(0);
  await waitFor('the task', () => task(id).status === 'COMPLETED');
});
