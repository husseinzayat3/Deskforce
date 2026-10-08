import * as store from './store';
import { getRoot, indexTasks } from '../officeConfig';

/**
 * What the user can do to a task, whichever way they say it: a button in the app or a
 * message in a chat. Each returns null when done, or the reason it could not be done.
 */

const MAX_NOTE_CHARS = 4000;
const note = (value: unknown) => (typeof value === 'string' ? value.trim().slice(0, MAX_NOTE_CHARS) : '');

/** A task of a finished project is running again, so the project's report and checks are out of date. */
export const reopenProject = (taskId: string) => {
  const root = getRoot(taskId, indexTasks(store.getState()))?.task;
  if (root) store.updateTask(root.id, { report: undefined, checkRuns: 0, checkPassed: undefined, checkOutput: undefined });
};

export const retryTask = (taskId: string) => {
  // Only a task that failed counts as retried: one the user cancelled did nothing wrong
  const before = store.getTask(taskId);
  const reset = { response: '', reviewNote: undefined, ...(before?.status === 'FAILED' ? { retries: (before.retries || 0) + 1 } : {}) };
  const retried = store.transitionTask(taskId, 'FAILED', 'PENDING', reset) || store.transitionTask(taskId, 'CANCELLED', 'PENDING', reset);
  if (!retried) return 'Only failed or cancelled tasks can be retried';
  reopenProject(taskId);
  return null;
};

export const reviseTask = (taskId: string, feedback: unknown) => {
  const text = note(feedback);
  if (!text) return 'Say what should be changed';
  const revisions = (store.getTask(taskId)?.revisions || 0) + 1;
  if (!store.transitionTask(taskId, 'COMPLETED', 'PENDING', { reviewStatus: 'CHANGES_REQUESTED', feedback: text, revisions })) {
    return 'Only finished tasks can be sent back';
  }
  reopenProject(taskId);
  return null;
};

export const cancelTask = (taskId: string) => {
  const cancelled = store.transitionTask(taskId, 'PENDING', 'CANCELLED')
    || store.transitionTask(taskId, 'AWAITING_APPROVAL', 'CANCELLED')
    || store.transitionTask(taskId, 'WAITING_FOR_INPUT', 'CANCELLED')
    || store.transitionTask(taskId, 'PLAN_REVIEW', 'CANCELLED');
  return cancelled ? null : 'Only tasks that have not started can be cancelled';
};

/** Lets a task that a guardrail held back go ahead. */
export const approveTask = (taskId: string) =>
  store.transitionTask(taskId, 'AWAITING_APPROVAL', 'PENDING', { reviewStatus: 'APPROVED' }) ? null : 'This task is not waiting for approval';

/** Starts the work on a proposed plan; `edited` replaces the plan with the user's version. */
export const approvePlan = (taskId: string, edited?: unknown) => {
  const task = store.getTask(taskId);
  if (!task || task.status !== 'PLAN_REVIEW') return 'This task has no plan waiting for approval';
  const plan = typeof edited === 'string' ? edited.trim().slice(0, 20_000) : '';
  store.transitionTask(task.id, 'PLAN_REVIEW', 'PENDING', { planApproved: true, planNote: undefined, ...(plan ? { plan } : {}) });
  return null;
};

/** Back in the queue: the employee writes a new plan with the note in mind. */
export const rejectPlan = (taskId: string, why: unknown) => {
  const task = store.getTask(taskId);
  if (!task || task.status !== 'PLAN_REVIEW') return 'This task has no plan waiting for approval';
  const text = note(why);
  if (!text) return 'Say what the plan should do differently';
  store.transitionTask(task.id, 'PLAN_REVIEW', 'PENDING', { planNote: text });
  return null;
};

export const answerQuestion = (taskId: string, answer: unknown) => {
  const text = note(answer);
  if (!text) return 'Write an answer';
  const task = store.getTask(taskId);
  if (!task || task.status !== 'WAITING_FOR_INPUT') return 'This task is not waiting for an answer';
  store.transitionTask(taskId, 'WAITING_FOR_INPUT', 'PENDING', {
    clarifications: `${task.clarifications ? `${task.clarifications}\n` : ''}Q: ${task.question || ''}\nA: ${text}\n`,
    question: undefined,
  });
  return null;
};
