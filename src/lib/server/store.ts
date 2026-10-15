import { getDb } from '../db';
import { Agent, AgentState, APIProvider, AgentRole, EventKind, Note, Role, TaskItem, TaskStatus, Template } from '../types';
import { DEFAULT_ROLES } from '../officeConfig';
import { DEFAULT_LAYOUT, OfficeLayout, sanitizeLayout } from '../layout';

/**
 * The office state in SQLite. The server is the only writer: the engine and the API route
 * go through these functions, and browsers only read what they return.
 */

const UNFINISHED: TaskStatus[] = ['AWAITING_APPROVAL', 'WAITING_FOR_INPUT', 'PLAN_REVIEW', 'PENDING', 'IN_PROGRESS'];
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

/** A row of the tasks table as SQLite returns it: absent values are null, flags are 0 or 1. */
interface TaskRow {
  id: string;
  agentId: string;
  prompt: string;
  assignedBy: string;
  status: TaskStatus;
  /** The response, or the error of a failed task. */
  answer: string | null;
  createdAt: number;
  completedAt: number | null;
  parentId: string | null;
  summary: string | null;
  files: string | null;
  tokens: number | null;
  reviewStatus: TaskItem['reviewStatus'] | null;
  reviewNote: string | null;
  project: string | null;
  cost: number | null;
  model: string | null;
  kind: TaskItem['kind'] | null;
  report: string | null;
  title: string | null;
  feedback: string | null;
  budget: number | null;
  commitId: string | null;
  question: string | null;
  clarifications: string | null;
  participants: string | null;
  blockedBy: string | null;
  archived: number | null;
  attachments: string | null;
  checkRuns: number | null;
  checkPassed: number | null;
  checkOutput: string | null;
  needsPlan: number | null;
  cachedTokens: number | null;
  durationMs: number | null;
  retries: number | null;
  revisions: number | null;
  compareId: string | null;
  apiOverride: APIProvider | null;
  modelOverride: string | null;
  plan: string | null;
  planApproved: number | null;
  planEstimate: number | null;
  planNote: string | null;
}

type AgentRow = Omit<Agent, 'model' | 'currentTask' | 'taskQueue' | 'helpRequestedFrom'> & { model: string | null };

interface TemplateRow {
  id: string;
  name: string;
  prompt: string;
  agentId: string | null;
  budget: number | null;
  project: string | null;
  schedule: Template['schedule'];
  weekday: number;
  minuteOfDay: number;
  nextRunAt: number | null;
  lastRunAt: number | null;
}

interface NoteRow {
  id: string;
  text: string;
  author: string;
  project: string | null;
  at: number;
}

const toTask = (t: TaskRow): TaskItem => ({
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
  archived: t.archived ? true : undefined,
  needsPlan: t.needsPlan ? true : undefined,
  cachedTokens: t.cachedTokens ?? undefined,
  durationMs: t.durationMs ?? undefined,
  retries: t.retries ?? undefined,
  revisions: t.revisions ?? undefined,
  compareId: t.compareId || undefined,
  apiOverride: t.apiOverride || undefined,
  modelOverride: t.modelOverride || undefined,
  plan: t.plan || undefined,
  planApproved: t.planApproved ? true : undefined,
  planEstimate: t.planEstimate ?? undefined,
  planNote: t.planNote || undefined,
  attachments: t.attachments ? safeParseArray(t.attachments) : undefined,
  checkRuns: t.checkRuns ?? undefined,
  checkPassed: t.checkPassed === null || t.checkPassed === undefined ? undefined : Boolean(t.checkPassed),
  checkOutput: t.checkOutput || undefined,
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
  kind: EventKind;
}

export const pushEvent = (message: string, kind: EventKind = 'info') => {
  const db = getDb();
  db.prepare('INSERT INTO events (message, at, kind) VALUES (?, ?, ?)').run(message, Date.now(), kind);
  db.prepare('DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?').run(MAX_EVENTS);
};

export const latestEventId = () =>
  ((getDb().prepare('SELECT MAX(id) AS id FROM events').get() as { id: number | null }).id) || 0;

export const listEvents = (afterId: number) =>
  getDb().prepare('SELECT id, message, at, kind FROM events WHERE id > ? ORDER BY id').all(afterId) as OfficeEvent[];

// --- agents -----------------------------------------------------------------

/** Every employee with their tasks, newest task first. */
export const getState = (): Agent[] => {
  const db = getDb();
  const agents = db.prepare('SELECT * FROM agents').all() as AgentRow[];
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY createdAt DESC, rowid DESC').all() as TaskRow[];

  return agents.map(agent => {
    const taskQueue = tasks.filter(t => t.agentId === agent.id).map(toTask);
    return {
      ...agent,
      model: agent.model ?? undefined,
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

/** Changes an employee in place, keeping their tasks and history. */
export const updateAgent = (agentId: string, patch: Partial<{ name: string; role: AgentRole; api: APIProvider; model: string; avatar: string }>) => {
  const columns = (['name', 'role', 'api', 'model', 'avatar'] as const).filter(column => column in patch);
  if (columns.length === 0) return;
  getDb().prepare(`UPDATE agents SET ${columns.map(c => `${c} = ?`).join(', ')} WHERE id = ?`).run(...columns.map(c => patch[c] || null), agentId);
  bump();
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
  const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
  return row ? { ...toTask(row), agentId: row.agentId } : undefined;
};

/** The task whose files are held by this commit. */
export const getTaskByCommit = (commitId: string): (TaskItem & { agentId: string }) | undefined => {
  const row = getDb().prepare('SELECT * FROM tasks WHERE commitId = ?').get(commitId) as TaskRow | undefined;
  return row ? { ...toTask(row), agentId: row.agentId } : undefined;
};

export const createTask = (
  agentId: string,
  prompt: string,
  assignedBy: string,
  options: Pick<TaskItem, 'parentId' | 'kind' | 'reviewStatus' | 'reviewNote' | 'title' | 'project' | 'budget' | 'participants' | 'blockedBy' | 'needsPlan' | 'compareId' | 'apiOverride' | 'modelOverride'> & { status?: TaskStatus } = {}
) => {
  const id = newId();
  getDb().prepare(`
    INSERT INTO tasks (id, agentId, prompt, assignedBy, status, createdAt, parentId, kind, reviewStatus, reviewNote, title, project, budget, participants, blockedBy, needsPlan, compareId, apiOverride, modelOverride)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, agentId, prompt, assignedBy, options.status || 'PENDING', Date.now(), options.parentId || null, options.kind || null,
    options.reviewStatus || null, options.reviewNote || null, options.title || null, options.project || null, options.budget ?? null,
    options.participants?.length ? JSON.stringify(options.participants) : null, options.blockedBy || null, options.needsPlan ? 1 : null,
    options.compareId || null, options.apiOverride || null, options.modelOverride || null
  );
  bump();
  return id;
};

/** Columns that map one-to-one onto task fields. `response`/`error` share the `answer` column and are handled apart. */
const PATCHABLE = ['status', 'summary', 'tokens', 'cost', 'model', 'kind', 'report', 'project', 'reviewStatus', 'reviewNote', 'feedback', 'completedAt', 'question', 'clarifications', 'blockedBy', 'checkRuns', 'checkOutput', 'plan', 'planEstimate', 'planNote', 'cachedTokens', 'durationMs', 'retries', 'revisions'] as const;

export const updateTask = (taskId: string, patch: Partial<TaskItem>) => {
  const sets: string[] = [];
  const values: unknown[] = [];

  for (const column of PATCHABLE) {
    if (column in patch) {
      sets.push(`${column} = ?`);
      values.push(patch[column] ?? null);
    }
  }
  if ('planApproved' in patch) {
    sets.push('planApproved = ?');
    values.push(patch.planApproved ? 1 : null);
  }
  if ('archived' in patch) {
    sets.push('archived = ?');
    values.push(patch.archived ? 1 : null);
  }
  if ('checkPassed' in patch) {
    sets.push('checkPassed = ?');
    values.push(patch.checkPassed === undefined ? null : Number(patch.checkPassed));
  }
  if ('attachments' in patch) {
    sets.push('attachments = ?');
    values.push(patch.attachments?.length ? JSON.stringify(patch.attachments) : null);
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

/**
 * Deletes tasks for good. Their cost stays counted in the month it was spent,
 * so deleting history does not make room under the monthly cap.
 */
export const deleteTasks = (taskIds: string[], monthStart: number) => {
  if (taskIds.length === 0) return;
  const db = getDb();
  const marks = taskIds.map(() => '?').join(', ');
  const spent = (db.prepare(`SELECT COALESCE(SUM(cost), 0) AS total FROM tasks WHERE id IN (${marks}) AND COALESCE(completedAt, createdAt) >= ?`).get(...taskIds, monthStart) as { total: number }).total;
  if (spent > 0) setMeta(`deletedSpend:${monthStart}`, String(deletedSpend(monthStart) + spent));
  db.prepare(`DELETE FROM tasks WHERE id IN (${marks})`).run(...taskIds);
  bump();
};

/** Cost of tasks that were deleted after being paid for in the month starting at `monthStart`. */
export const deletedSpend = (monthStart: number) => Number(getMeta(`deletedSpend:${monthStart}`)) || 0;

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

const toTemplate = (t: TemplateRow): Template => ({
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
  (getDb().prepare('SELECT * FROM templates ORDER BY name').all() as TemplateRow[]).map(toTemplate);

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

// --- company knowledge ------------------------------------------------------

export const MAX_HANDBOOK_CHARS = 8000;
export const MAX_NOTE_CHARS = 400;
/** Oldest notes are dropped beyond this, so the list every agent reads stays short. */
const MAX_NOTES = 40;

/** The handbook every agent is given: conventions, tone, preferred tools. */
export const getHandbook = () => getMeta('handbook') || '';

export const setHandbook = (text: string) => {
  setMeta('handbook', text.slice(0, MAX_HANDBOOK_CHARS));
  bump();
};

/** Newest first. */
export const listNotes = (): Note[] =>
  (getDb().prepare('SELECT id, text, author, project, at FROM notes ORDER BY at DESC, rowid DESC').all() as NoteRow[])
    .map(n => ({ id: n.id, text: n.text, author: n.author, project: n.project || undefined, at: n.at }));

export const addNote = (text: string, author: string, project?: string) => {
  const db = getDb();
  // The same lesson written down twice is still one lesson
  const lesson = text.slice(0, MAX_NOTE_CHARS).trim();
  if (db.prepare('SELECT 1 FROM notes WHERE lower(text) = lower(?)').get(lesson)) return;
  db.prepare('INSERT INTO notes (id, text, author, project, at) VALUES (?, ?, ?, ?, ?)').run(newId(), text.slice(0, MAX_NOTE_CHARS), author, project || null, Date.now());
  db.prepare('DELETE FROM notes WHERE id NOT IN (SELECT id FROM notes ORDER BY at DESC, rowid DESC LIMIT ?)').run(MAX_NOTES);
  bump();
};

export const deleteNote = (id: string) => {
  getDb().prepare('DELETE FROM notes WHERE id = ?').run(id);
  bump();
};

// --- office layout ----------------------------------------------------------

/** Where the desks and rooms are, the floorplan picture, and the uploaded avatars. */
export const getLayout = (): OfficeLayout => {
  const saved = getMeta('layout');
  if (!saved) return DEFAULT_LAYOUT;
  try {
    return sanitizeLayout(JSON.parse(saved));
  } catch {
    return DEFAULT_LAYOUT;
  }
};

export const setLayout = (layout: OfficeLayout) => {
  setMeta('layout', JSON.stringify(sanitizeLayout(layout)));
  bump();
};

/** Money spent outside of tasks (chat with the office, deleted tasks) in the month starting at `monthStart`. */
export const addOtherSpend = (monthStart: number, usd: number) => {
  if (usd > 0) setMeta(`deletedSpend:${monthStart}`, String(deletedSpend(monthStart) + usd));
};

// --- chat -------------------------------------------------------------------

/** Turns kept per conversation; older ones are dropped. */
const MAX_CHAT_TURNS = 60;

export const addChatTurn = (conversation: string, role: 'user' | 'assistant', text: string) => {
  const db = getDb();
  db.prepare('INSERT INTO chat (conversation, role, text, at) VALUES (?, ?, ?, ?)').run(conversation, role, text, Date.now());
  db.prepare('DELETE FROM chat WHERE conversation = ? AND id NOT IN (SELECT id FROM chat WHERE conversation = ? ORDER BY id DESC LIMIT ?)').run(conversation, conversation, MAX_CHAT_TURNS);
};

/** The last turns of a conversation, oldest first. */
export const recentChat = (conversation: string, limit: number) =>
  (getDb().prepare('SELECT role, text FROM chat WHERE conversation = ? ORDER BY id DESC LIMIT ?').all(conversation, limit) as { role: 'user' | 'assistant'; text: string }[]).reverse();
