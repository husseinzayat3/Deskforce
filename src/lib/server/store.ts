import { getDb } from '../db';
import { Agent, AgentState, APIProvider, AgentRole, Role, TaskItem, TaskStatus, Template } from '../types';
import { DEFAULT_ROLES } from '../officeConfig';

/**
 * The office state in SQLite. The server is the only writer: the engine and the API route
 * go through these functions, and browsers only read what they return.
 */

const UNFINISHED: TaskStatus[] = ['AWAITING_APPROVAL', 'WAITING_FOR_INPUT', 'PENDING', 'IN_PROGRESS'];
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
  commit: t.commitId || undefined,
  question: t.question || undefined,
  clarifications: t.clarifications || undefined,
  participants: t.participants ? safeParseArray(t.participants) : undefined,
  blockedBy: t.blockedBy || undefined,
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

/** 0 removes the cap. */
export const setMonthlyCap = (usd: number) => {
  setMeta('monthlyCap', String(usd));
  bump();
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

export const createAgent = (data: { name: string; role: AgentRole; api: APIProvider; avatar: string; model?: string }) => {
  const id = newId();
  // Positions are only kept for older databases; the browser decides where employees stand
  getDb().prepare(`
    INSERT INTO agents (id, name, avatar, role, api, model, state, x, y, targetX, targetY)
    VALUES (?, ?, ?, ?, ?, ?, 'IDLE', 0, 0, 0, 0)
  `).run(id, data.name, data.avatar, data.role, data.api, data.model || null);
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

/** The task whose files are held by this commit. */
export const getTaskByCommit = (commitId: string): (TaskItem & { agentId: string }) | undefined => {
  const row = getDb().prepare('SELECT * FROM tasks WHERE commitId = ?').get(commitId) as any;
  return row ? { ...toTask(row), agentId: row.agentId } : undefined;
};

export const createTask = (
  agentId: string,
  prompt: string,
  assignedBy: string,
  options: Pick<TaskItem, 'parentId' | 'kind' | 'reviewStatus' | 'reviewNote' | 'title' | 'project' | 'budget' | 'participants' | 'blockedBy'> & { status?: TaskStatus } = {}
) => {
  const id = newId();
  getDb().prepare(`
    INSERT INTO tasks (id, agentId, prompt, assignedBy, status, createdAt, parentId, kind, reviewStatus, reviewNote, title, project, budget, participants, blockedBy)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, agentId, prompt, assignedBy, options.status || 'PENDING', Date.now(), options.parentId || null, options.kind || null,
    options.reviewStatus || null, options.reviewNote || null, options.title || null, options.project || null, options.budget ?? null,
    options.participants?.length ? JSON.stringify(options.participants) : null, options.blockedBy || null
  );
  bump();
  return id;
};

/** Columns that map one-to-one onto task fields. `response`/`error` share the `answer` column and are handled apart. */
const PATCHABLE = ['status', 'summary', 'tokens', 'cost', 'model', 'kind', 'report', 'project', 'reviewStatus', 'reviewNote', 'feedback', 'completedAt', 'question', 'clarifications', 'blockedBy'] as const;

export const updateTask = (taskId: string, patch: Partial<TaskItem>) => {
  const sets: string[] = [];
  const values: unknown[] = [];

  for (const column of PATCHABLE) {
    if (column in patch) {
      sets.push(`${column} = ?`);
      values.push(patch[column] ?? null);
    }
  }
  if ('commit' in patch) {
    sets.push('commitId = ?');
    values.push(patch.commit ?? null);
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

/** Estimated USD spent on tasks that finished (or, for older records, were created) since `since`. */
export const spendSince = (since: number) =>
  (getDb().prepare('SELECT COALESCE(SUM(cost), 0) AS total FROM tasks WHERE COALESCE(completedAt, createdAt) >= ?').get(since) as { total: number }).total;

// --- roles ------------------------------------------------------------------

/** Most senior first. A new office gets the default set. */
export const listRoles = (): Role[] => {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) AS n FROM roles').get() as { n: number }).n;
  if (count === 0) {
    const insert = db.prepare('INSERT INTO roles (name, rank, instructions) VALUES (?, ?, ?)');
    for (const role of DEFAULT_ROLES) insert.run(role.name, role.rank, role.instructions);
  }
  return db.prepare('SELECT name, rank, instructions FROM roles ORDER BY rank, name').all() as Role[];
};

export const saveRole = (role: Role) => {
  getDb().prepare(`
    INSERT INTO roles (name, rank, instructions) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET rank = excluded.rank, instructions = excluded.instructions
  `).run(role.name, role.rank, role.instructions);
  bump();
};

export const deleteRole = (name: string) => {
  getDb().prepare('DELETE FROM roles WHERE name = ?').run(name);
  bump();
};

// --- templates --------------------------------------------------------------

const toTemplate = (t: any): Template => ({
  id: t.id,
  name: t.name,
  prompt: t.prompt,
  agentId: t.agentId || undefined,
  budget: t.budget ?? undefined,
  project: t.project || undefined,
  schedule: t.schedule,
  weekday: t.weekday,
  minuteOfDay: t.minuteOfDay,
  nextRunAt: t.nextRunAt ?? undefined,
  lastRunAt: t.lastRunAt ?? undefined,
});

export const listTemplates = (): Template[] =>
  (getDb().prepare('SELECT * FROM templates ORDER BY name').all() as any[]).map(toTemplate);

/** Creates the template, or replaces the one with the same id. Returns its id. */
export const saveTemplate = (template: Omit<Template, 'id' | 'lastRunAt'> & { id?: string }) => {
  const id = template.id || newId();
  getDb().prepare(`
    INSERT INTO templates (id, name, prompt, agentId, budget, project, schedule, weekday, minuteOfDay, nextRunAt)
    VALUES (@id, @name, @prompt, @agentId, @budget, @project, @schedule, @weekday, @minuteOfDay, @nextRunAt)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, prompt = excluded.prompt, agentId = excluded.agentId, budget = excluded.budget, project = excluded.project,
      schedule = excluded.schedule, weekday = excluded.weekday, minuteOfDay = excluded.minuteOfDay, nextRunAt = excluded.nextRunAt
  `).run({
    id,
    name: template.name,
    prompt: template.prompt,
    agentId: template.agentId || null,
    budget: template.budget ?? null,
    project: template.project || null,
    schedule: template.schedule,
    weekday: template.weekday,
    minuteOfDay: template.minuteOfDay,
    nextRunAt: template.nextRunAt ?? null,
  });
  bump();
  return id;
};

/** True when a scheduled template is due. Cheap enough to ask every second. */
export const hasDueTemplate = (now: number) =>
  Boolean(getDb().prepare("SELECT 1 FROM templates WHERE schedule != 'none' AND nextRunAt IS NOT NULL AND nextRunAt <= ? LIMIT 1").get(now));

export const markTemplateRun = (id: string, lastRunAt: number, nextRunAt: number | undefined) => {
  getDb().prepare('UPDATE templates SET lastRunAt = ?, nextRunAt = ? WHERE id = ?').run(lastRunAt, nextRunAt ?? null, id);
  bump();
};

export const deleteTemplate = (id: string) => {
  getDb().prepare('DELETE FROM templates WHERE id = ?').run(id);
  bump();
};
