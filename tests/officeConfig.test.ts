import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ROLES, delegationDepth, indexTasks, estimateCost, priceOf, projectNameFromPrompt, rankOf, similarity, slugifyProjectName, taskTitle, titleFromDescription } from '../src/lib/officeConfig';
import { TaskItem } from '../src/lib/types';

const task = (patch: Partial<TaskItem>): TaskItem => ({ id: 't', prompt: '', status: 'PENDING', timestamp: 0, assignedBy: 'User', ...patch });

test('costs follow the price list', () => {
  assert.equal(estimateCost('OpenAI', 'gpt-4o-mini', 1_000_000, 1_000_000), 0.15 + 0.6);
  assert.equal(estimateCost('Ollama', 'llama3', 5000, 5000), 0);
  assert.equal(estimateCost('OpenAI', 'some-unknown-model', 1, 1), undefined);
});

test('a dated model name is priced as the model it is a snapshot of', () => {
  assert.deepEqual(priceOf('gpt-4o-mini-2024-07-18'), priceOf('gpt-4o-mini'));
  assert.deepEqual(priceOf('claude-haiku-4-5-20251001'), priceOf('claude-haiku-4-5'));
  // The longest listed name wins: this is a gpt-4o-mini, not a gpt-4o
  assert.notDeepEqual(priceOf('gpt-4o-mini-2024-07-18'), priceOf('gpt-4o'));
  assert.equal(priceOf('gpt-4omni'), undefined);
});

test('project names come from the meaningful words of the request', () => {
  assert.equal(projectNameFromPrompt("Let's start developing a small hello world app in Flutter"), 'hello-world-app-flutter');
  assert.equal(projectNameFromPrompt('please'), 'project');
  assert.equal(slugifyProjectName('  Voice_Calculator App!! '), 'voice-calculator-app');
});

test('near-identical assignments are recognised as duplicates', () => {
  assert.ok(similarity('Write the login screen in lib/login.dart', 'Write the login screen in lib/login.dart please') > 0.8);
  assert.ok(similarity('Write the login screen', 'Design the database schema') < 0.3);
});

test('task titles', () => {
  assert.equal(taskTitle(task({ title: 'Build login', prompt: 'Task delegated from Ada:\nLong description' })), 'Build login');
  assert.equal(taskTitle(task({ prompt: 'Task delegated from Ada:\nFirst line\nSecond' })), 'First line');
  assert.equal(taskTitle(task({ kind: 'REVIEW' })), 'Final review of the project');
  assert.equal(titleFromDescription('one two three four five six seven eight nine ten'), 'one two three four five six seven eight…');
});

test('unknown roles rank below every real one', () => {
  assert.equal(rankOf(DEFAULT_ROLES, 'CEO'), 0);
  assert.ok(rankOf(DEFAULT_ROLES, 'No such role') > rankOf(DEFAULT_ROLES, 'Junior Dev'));
});

test('a follow-up stands at the level of the task it follows up on', () => {
  const person = (id: string, taskQueue: TaskItem[]) => ({ id, name: id, avatar: '', role: 'CEO', api: 'Ollama' as const, state: 'IDLE' as const, x: 0, y: 0, targetX: 0, targetY: 0, tokensUsed: 0, currentTask: null, idleTicks: 0, workingTicks: 0, breaksTaken: 0, taskQueue });
  const index = indexTasks([
    person('boss', [task({ id: 'root' }), task({ id: 'follow', parentId: 'root', kind: 'FOLLOWUP' })]),
    person('dev', [task({ id: 'first', parentId: 'root' }), task({ id: 'second', parentId: 'follow' }), task({ id: 'deep', parentId: 'first' })]),
  ]);
  assert.equal(delegationDepth('root', index), 0);
  assert.equal(delegationDepth('follow', index), 0);
  assert.equal(delegationDepth('first', index), 1);
  // Work delegated in the second round is no deeper than work from the first
  assert.equal(delegationDepth('second', index), 1);
  assert.equal(delegationDepth('deep', index), 2);
});
