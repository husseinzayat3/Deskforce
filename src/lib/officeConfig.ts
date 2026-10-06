import { Agent, AgentRole, TaskItem, TaskStatus } from './types';

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
  /** How much of a manager's plan is passed down to the people it delegates to. */
  PLAN_CHARS: 2000,
  /** How much of each finished task's summary is shared with the rest of the team. */
  SUMMARY_CHARS: 400,
  /** How many finished tasks of the same project are listed as team progress. */
  MAX_PROGRESS_ITEMS: 12,
  /** Characters of existing file contents shown to an agent (kept modest for small local models). */
  FILE_CONTEXT_CHARS: 12000,
  /** Same, for the final review, which has to see the whole project. */
  REVIEW_FILE_CONTEXT_CHARS: 30000,
  /** Longest single file shown in full; larger ones are listed by name only. */
  MAX_FILE_CHARS: 8000,
  /** Response length allowed for the final review, which may rewrite several files. */
  REVIEW_MAX_TOKENS: 8000,
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
const GUARDRAIL_NOTE = /\[GUARDRAIL:[^\]]*\]\s*/gi;
/** Older tasks carried the guardrail reason inside the prompt; it now lives in `reviewNote`. */
export const stripGuardrailNote = (prompt: string) => prompt.replace(GUARDRAIL_NOTE, '');
export const cleanPrompt = (prompt: string) => stripGuardrailNote(prompt).replace(DELEGATION_PREFIX, '').trim();

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

/** Words that say nothing about what is being built. */
const FILLER_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'for', 'to', 'with', 'from', 'by', 'at', 'as', 'is', 'be', 'it', 'that', 'this',
  'i', 'we', 'you', 'us', 'me', 'my', 'our', 'your', 'lets', 'let', 'please', 'can', 'could', 'would', 'should', 'want', 'need', 'like',
  'start', 'starting', 'begin', 'create', 'creating', 'build', 'building', 'develop', 'developing', 'make', 'making', 'write', 'writing',
  'implement', 'implementing', 'design', 'designing', 'work', 'working', 'team', 'new', 'small', 'simple', 'basic', 'quick', 'some',
  'task', 'project',
]);

const MAX_PROJECT_NAME_CHARS = 40;

const toWords = (text: string) => text.toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
const joinName = (words: string[]) => words.join('-').slice(0, MAX_PROJECT_NAME_CHARS).replace(/-+$/, '');

/** Turns a name proposed by an agent into a folder-safe one, e.g. "Voice Calculator" → "voice-calculator". */
export const slugifyProjectName = (name: string) => joinName(toWords(name).slice(0, 5));

/** Fallback when the agent proposes no name: the first few meaningful words of the task. */
export const projectNameFromPrompt = (prompt: string) =>
  joinName(toWords(cleanPrompt(prompt)).filter(w => !FILLER_WORDS.has(w)).slice(0, 4)) || 'project';

/** How project folders were named before agents named them; still used to find those older projects. */
export const legacyProjectSlug = (root: TaskItem) => {
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

/** Project folder of a task tree. Older trees have no stored name and fall back to the old scheme. */
export const projectOf = (root: TaskItem) => root.project || legacyProjectSlug(root);

/** Statuses after which a task will not change any more. */
export const FINISHED_STATUSES = new Set<TaskStatus>(['COMPLETED', 'FAILED', 'CANCELLED']);

/**
 * List prices in USD per 1 million tokens, used to estimate what each task cost.
 * Update these when a provider changes its prices, and add any model you switch to.
 */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'grok-3': { input: 3, output: 15 },
  'grok-3-mini': { input: 0.3, output: 0.5 },
};

/** Estimated cost in USD, or undefined when the model has no known price. Local and mock models are free. */
export const estimateCost = (provider: string, model: string, inputTokens: number, outputTokens: number): number | undefined => {
  if (provider === 'Ollama' || model === 'mock') return 0;
  const price = MODEL_PRICING[model];
  if (!price) return undefined;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
};

export const formatCost = (cost: number | undefined) => {
  if (cost === undefined) return 'cost unknown';
  if (cost === 0) return 'free';
  if (cost < 0.0001) return '<$0.0001';
  return `~$${cost < 1 ? cost.toFixed(4) : cost.toFixed(2)}`;
};

/** e.g. "1,084 tokens · ~$0.0041". Empty when the task has not used any tokens yet. */
export const formatUsage = (tokens: number | undefined, cost: number | undefined) =>
  tokens ? `${tokens.toLocaleString('en-US')} tokens · ${formatCost(cost)}` : '';

/** Tokens and estimated cost of several tasks together. Cost is undefined if any of them has no known price. */
export const sumUsage = (tasks: TaskItem[]) => {
  const used = tasks.filter(t => t.tokens);
  return {
    tokens: used.reduce((sum, t) => sum + (t.tokens || 0), 0),
    cost: used.some(t => t.cost === undefined) ? undefined : used.reduce((sum, t) => sum + (t.cost || 0), 0),
  };
};
