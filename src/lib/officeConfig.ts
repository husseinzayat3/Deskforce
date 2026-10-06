import { Agent, AgentRole, TaskItem } from './types';

/**
 * Guardrails that keep agents productive and stop runaway token spend.
 * Tweak these to taste.
 */
export const OFFICE_CONFIG = {
  /** Root task = depth 0. Tasks at this depth may no longer delegate. */
  MAX_DELEGATION_DEPTH: 2,
  /** Max sub-tasks a single task may spawn. */
  MAX_SUBTASKS_PER_TASK: 4,
  /** Total tokens a whole task tree (root + all sub-tasks) may consume. */
  TASK_TREE_TOKEN_BUDGET: 60000,
  /** How much of a previous response is fed back as memory. */
  MEMORY_CHARS: 600,
  /** Max file paths listed in the prompt as "existing project files". */
  MAX_FILES_IN_PROMPT: 80,
};

/** Lower number = more senior. Agents may only delegate to strictly lower-ranked roles. */
export const ROLE_RANK: Record<AgentRole, number> = {
  CEO: 0,
  'Tech Lead': 1,
  Designer: 2,
  HR: 2,
  'Junior Dev': 3,
};

export interface TaskRef {
  task: TaskItem;
  agent: Agent;
}

/** Index every task across all agents by id. */
export const indexTasks = (agents: Agent[]) => {
  const map = new Map<string, TaskRef>();
  agents.forEach(agent => (agent.taskQueue || []).forEach(task => map.set(task.id, { task, agent })));
  return map;
};

/** Ancestors from immediate parent up to the root. */
export const getAncestors = (taskId: string, index: Map<string, TaskRef>): TaskRef[] => {
  const chain: TaskRef[] = [];
  const seen = new Set<string>([taskId]);
  let parentId = index.get(taskId)?.task.parentId;
  while (parentId && !seen.has(parentId)) {
    const ref = index.get(parentId);
    if (!ref) break;
    chain.push(ref);
    seen.add(parentId);
    parentId = ref.task.parentId;
  }
  return chain;
};

export const getRoot = (taskId: string, index: Map<string, TaskRef>): TaskRef | undefined => {
  const ancestors = getAncestors(taskId, index);
  return ancestors.length ? ancestors[ancestors.length - 1] : index.get(taskId);
};

/** All tasks in the tree rooted at rootId (including the root). */
export const getTree = (rootId: string, index: Map<string, TaskRef>): TaskRef[] =>
  Array.from(index.values()).filter(ref => getRoot(ref.task.id, index)?.task.id === rootId);

const DELEGATION_PREFIX = /^Task delegated from [^:]+:\s*/i;
export const cleanPrompt = (prompt: string) => prompt.replace(DELEGATION_PREFIX, '').trim();

/** Normalised text used to detect duplicate delegations. */
export const normalise = (text: string) =>
  cleanPrompt(text).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Jaccard similarity on word sets — cheap duplicate detection without extra LLM calls. */
export const similarity = (a: string, b: string) => {
  const wa = new Set(normalise(a).split(' ').filter(w => w.length > 2));
  const wb = new Set(normalise(b).split(' ').filter(w => w.length > 2));
  if (!wa.size || !wb.size) return 0;
  let inter = 0;
  wa.forEach(w => wb.has(w) && inter++);
  return inter / (wa.size + wb.size - inter);
};

/** Stable project folder name for a root task, e.g. "hello-world-flutter-app-x7k2". */
export const projectSlug = (root: TaskItem) => {
  const base = cleanPrompt(root.prompt)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 6)
    .join('-')
    .slice(0, 40) || 'project';
  return `${base}-${root.id.slice(0, 4)}`;
};
