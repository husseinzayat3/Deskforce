import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, measurePerformance } from '../src/lib/performance';
import { estimateCost } from '../src/lib/officeConfig';
import { Agent, TaskItem } from '../src/lib/types';

const task = (patch: Partial<TaskItem>): TaskItem => ({ id: Math.random().toString(36).slice(2), prompt: '', status: 'COMPLETED', timestamp: 0, assignedBy: 'User', ...patch });
const person = (name: string, taskQueue: TaskItem[]): Agent => ({ id: name, name, avatar: '', role: 'CEO', api: 'OpenAI', state: 'IDLE', x: 0, y: 0, targetX: 0, targetY: 0, tokensUsed: 0, currentTask: null, idleTicks: 0, workingTicks: 0, breaksTaken: 0, taskQueue });

test('success rate, average cost and time per employee', () => {
  const { employees } = measurePerformance([
    person('Ada', [
      task({ model: 'gpt-4o', cost: 0.1, durationMs: 10_000 }),
      task({ model: 'gpt-4o', cost: 0.3, durationMs: 30_000 }),
      task({ model: 'gpt-4o', status: 'FAILED', cost: 0.2 }),
      task({ status: 'CANCELLED', cost: 5 }),
      task({ status: 'PENDING' }),
    ]),
  ]);
  assert.equal(employees.length, 1);
  assert.equal(employees[0].tasks, 3);
  assert.ok(Math.abs(employees[0].successRate - 2 / 3) < 1e-9);
  assert.ok(Math.abs(employees[0].averageCost! - 0.2) < 1e-9);
  assert.equal(employees[0].averageMs, 20_000);
  assert.equal(employees[0].fixRate, 0);
});

test('work counts as fixed when it was sent back, retried, or rewritten by a later review', () => {
  const root = task({ id: 'root', files: ['index.html'], completedAt: 10 });
  const { employees } = measurePerformance([
    person('Ada', [root, task({ id: 'review', parentId: 'root', kind: 'REVIEW', files: ['lib/a.js'], completedAt: 50 })]),
    person('Cy', [
      task({ parentId: 'root', files: ['lib/a.js'], completedAt: 20 }),   // rewritten by the review
      task({ parentId: 'root', files: ['lib/b.js'], completedAt: 20 }),   // left alone
      task({ parentId: 'root', revisions: 1 }),                           // sent back by the user
      task({ parentId: 'root', retries: 1 }),                             // failed once
    ]),
  ]);
  const cy = employees.find(e => e.name === 'Cy')!;
  assert.equal(cy.tasks, 4);
  assert.equal(cy.fixRate, 0.75);
  // Reviews are not counted as the reviewer's own work, and the root's file was not touched
  const ada = employees.find(e => e.name === 'Ada')!;
  assert.equal(ada.tasks, 1);
  assert.equal(ada.fixRate, 0);
});

test('models are measured across employees; comparisons count for the model only', () => {
  const { employees, models } = measurePerformance([
    person('Ada', [task({ model: 'gpt-4o' }), task({ model: 'claude-opus-5-5', compareId: 'c1' }), task({ model: 'mock' })]),
    person('Cy', [task({ model: 'gpt-4o', status: 'FAILED' })]),
  ]);
  assert.deepEqual(models.map(m => [m.name, m.tasks, m.successRate]), [['gpt-4o', 2, 0.5], ['claude-opus-5-5', 1, 1]]);
  assert.equal(employees.find(e => e.name === 'Ada')!.tasks, 2);
});

test('cached input is billed at a fraction, and cache writes on Claude slightly more', () => {
  const full = estimateCost('Anthropic', 'claude-sonnet-5-5', 100_000, 0)!;
  assert.ok(Math.abs(estimateCost('Anthropic', 'claude-sonnet-5-5', 0, 0, { read: 100_000 })! - full * 0.1) < 1e-9);
  assert.ok(Math.abs(estimateCost('Anthropic', 'claude-sonnet-5-5', 0, 0, { write: 100_000 })! - full * 1.25) < 1e-9);
  assert.ok(Math.abs(estimateCost('Anthropic', 'claude-opus-5-5', 0, 0, { read: 100_000 })! - estimateCost('Anthropic', 'claude-opus-5-5', 100_000, 0)! * 0.05) < 1e-9);
  assert.ok(Math.abs(estimateCost('OpenAI', 'gpt-4o-mini', 0, 0, { read: 100_000 })! - estimateCost('OpenAI', 'gpt-4o-mini', 100_000, 0)! * 0.5) < 1e-9);
  assert.equal(estimateCost('Ollama', 'llama3', 1, 1, { read: 5 }), 0);
});

test('durations read naturally', () => {
  assert.equal(formatDuration(undefined), '–');
  assert.equal(formatDuration(42_400), '42s');
  assert.equal(formatDuration(125_000), '2m 05s');
});
