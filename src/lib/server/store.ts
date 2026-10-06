import { getDb } from '../db';
import { Agent, AgentState, APIProvider, AgentRole, TaskItem, TaskStatus } from '../types';

/**
 * The office state in SQLite. The server is the only writer: the engine and the API route
 * go through these functions, and browsers only read what they return.
 */

const UNFINISHED: TaskStatus[] = ['AWAITING_APPROVAL', 'PENDING', 'IN_PROGRESS'];
const MAX_EVENTS = 100;

const newId = () => Math.random().toString(36).slice(2, 11);

const safeParseArray = (value: string): string[] | undefined => {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const toTask = (t: any): TaskItem => ({
  id: t.id,
  prompt: t.prompt,
  title: t.title || undefined,
  response: t.status === 'FAILED' ? undefined : t.answer || undefined,
  status: t.status,
  timestamp: t.createdAt,
  assignedBy: t.assignedBy,
  parentId: t.parentId || undefined,
  summary: t.summary || undefined,
  files: t.files ? safeParseArray(t.files) : undefined,
  tokens: t.tokens ?? undefined,
  reviewStatus: t.reviewStatus || undefined,
  reviewNote: t.reviewNote || undefined,
  project: t.project || undefined,
  cost: t.cost ?? undefined,
  model: t.model || undefined,
  kind: t.kind || undefined,
  report: t.report || undefined,
  feedback: t.feedback || undefined,
  budget: t.budget ?? undefined,
  completedAt: t.completedAt ?? undefined,
  error: t.status === 'FAILED' ? t.answer || undefined : undefined,
});

// --- meta -------------------------------------------------------------------

export const getMeta = (key: string): string | undefined =>
  (getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;

export const setMeta = (key: string, value: string) => {
  getDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
};

/** Changes whenever the office state does, so browsers can skip downloading a state they already have. */
export const getVersion = () => getMeta('version') || '0';

const bump = () => {
  getDb().prepare(`
    INSERT INTO meta (key, value) VALUES ('version', '1')
    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
  `).run();
};

export const isPaused = () => getMeta('paused') === '1';

export const setPaused = (paused: boolean) => {
  setMeta('paused', paused ? '1' : '0');
  bump();
};

// --- events -----------------------------------------------------------------

export interface OfficeEvent {
  id: number;
  message: string;
  at: number;
}

export const pushEvent = (message: string) => {
  const db = getDb();
  db.prepare('INSERT INTO events (message, at) VALUES (?, ?)').run(message, Date.now());
  db.prepare('DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?').run(MAX_EVENTS);
};

export const latestEventId = () =>
  ((getDb().prepare('SELECT MAX(id) AS id FROM events').get() as { id: number | null }).id) || 0;

export const listEvents = (afterId: number) =>
  getDb().prepare('SELECT id, message, at FROM events WHERE id > ? ORDER BY id').all(afterId) as OfficeEvent[];

// --- agents -----------------------------------------------------------------

/** Every employee with their tasks, newest task first. */
export const getState = (): Agent[] => {
  const db = getDb();
  const agents = db.prepare('SELECT * FROM agents').all() as any[];
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY createdAt DESC, rowid DESC').all() as any[];

  return agents.map(agent => {
    const taskQueue = tasks.filter(t => t.agentId === agent.id).map(toTask);
    return {
      ...agent,
      currentTask: taskQueue.find(t => t.status === 'IN_PROGRESS')?.prompt ?? null,
      taskQueue,
    };
  });
};

export const createAgent = (data: { name: string; role: AgentRole; api: APIProvider; avatar: string }) => {
  const id = newId();
  // Positions are only kept for older databases; the browser decides where employees stand
  getDb().prepare(`
    INSERT INTO agents (id, name, avatar, role, api, state, x, y, targetX, targetY)
    VALUES (?, ?, ?, ?, ?, 'IDLE', 0, 0, 0, 0)
  `).run(id, data.name, data.avatar, data.role, data.api);
  bump();
  return id;
};

/** Tasks are deleted with the agent (ON DELETE CASCADE). */
export const deleteAgent = (agentId: string) => {
  getDb().prepare('DELETE FROM agents WHERE id = ?').run(agentId);
  bump();
};

export const setAgentState = (agentId: string, state: Extract<AgentState, 'IDLE' | 'WORKING'>) => {
  const changed = getDb().prepare('UPDATE agents SET state = ? WHERE id = ? AND state != ?').run(state, agentId, state).changes;
  if (changed) bump();
};

export const addAgentTokens = (agentId: string, tokens: number) => {
  getDb().prepare('UPDATE agents SET tokensUsed = tokensUsed + ? WHERE id = ?').run(tokens, agentId);
  bump();
};

// --- tasks ------------------------------------------------------------------

export const getTask = (taskId: string): (TaskItem & { agentId: string }) | undefined => {
  const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
  return row ? { ...toTask(row), agentId: row.agentId } : undefined;
};

export const createTask = (
  agentId: string,
  prompt: string,
  assignedBy: string,
  options: Pick<TaskItem, 'parentId' | 'kind' | 'reviewStatus' | 'reviewNote' | 'title' | 'project' | 'budget'> & { status?: TaskStatus } = {}
) => {
  const id = newId();
  getDb().prepare(`
    INSERT INTO tasks (id, agentId, prompt, assignedBy, status, createdAt, parentId, kind, reviewStatus, reviewNote, title, project, budget)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, agentId, prompt, assignedBy, options.status || 'PENDING', Date.now(), options.parentId || null, options.kind || null,
    options.reviewStatus || null, options.reviewNote || null, options.title || null, options.project || null, options.budget ?? null
  );
  bump();
  return id;
};

/** Columns that map one-to-one onto task fields. `response`/`error` share the `answer` column and are handled apart. */
const PATCHABLE = ['status', 'summary', 'tokens', 'cost', 'model', 'kind', 'report', 'project', 'reviewStatus', 'reviewNote', 'feedback', 'completedAt'] as const;

export const updateTask = (taskId: string, patch: Partial<TaskItem>) => {
  const sets: string[] = [];
  const values: unknown[] = [];

  for (const column of PATCHABLE) {
    if (column in patch) {
      sets.push(`${column} = ?`);
      values.push(patch[column] ?? null);
    }
  }
  if ('files' in patch) {
    sets.push('files = ?');
    values.push(patch.files?.length ? JSON.stringify(patch.files) : null);
  }
  if (patch.error !== undefined || patch.response !== undefined) {
    sets.push('answer = ?');
    values.push(patch.error ?? patch.response);
  }
  if (sets.length === 0) return;

  getDb().prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values, taskId);
  bump();
};

/** Moves a task from one status to another only if it is still in the first. True when this call made the change. */
export const transitionTask = (taskId: string, from: TaskStatus, to: TaskStatus, patch: Partial<TaskItem> = {}) => {
  const changed = getDb().prepare('UPDATE tasks SET status = ? WHERE id = ? AND status = ?').run(to, taskId, from).changes === 1;
  if (!changed) return false;
  bump();
  updateTask(taskId, patch);
  return true;
};

/** Halt: every task that has not finished is cancelled, including the ones a model is working on right now. */
export const cancelUnfinishedTasks = () => {
  const db = getDb();
  db.prepare(`UPDATE tasks SET status = 'CANCELLED' WHERE status IN (${UNFINISHED.map(() => '?').join(', ')})`).run(...UNFINISHED);
  db.prepare(`UPDATE agents SET state = 'IDLE'`).run();
  bump();
};
