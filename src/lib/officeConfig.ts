import { Agent, Role, TaskItem, TaskStatus } from './types';

/**
 * Guardrails that keep agents productive and stop runaway token spend.
 * Tweak these to taste.
 */
export const OFFICE_CONFIG = {
  /** Root task = depth 0. Tasks at this depth may no longer delegate. */
  MAX_DELEGATION_DEPTH: 2,
  /** Max sub-tasks a single task may spawn. */
  MAX_SUBTASKS_PER_TASK: 4,
  /** Spending limit in USD for a whole task tree (root + all sub-tasks) when the user sets none. */
  DEFAULT_TASK_BUDGET_USD: 0.5,
  /** Highest limit the user may set for one task. */
  MAX_TASK_BUDGET_USD: 100,
  /** Earlier requests on the same project that a follow-up task is told about. */
  MAX_HISTORY_ITEMS: 5,
  /** Files with a missing closing tag that the model is asked to send again, per response. */
  MAX_FILE_REPAIRS: 3,
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

/** The roles a new office starts with. They can be edited, removed and added to in the app. */
export const DEFAULT_ROLES: Role[] = [
  { name: 'CEO', rank: 0, instructions: 'You own the outcome for the client. Break the request into a clear plan, decide what to delegate, and make sure the pieces fit together.' },
  { name: 'Tech Lead', rank: 1, instructions: 'You own the technical design. Decide the structure, set conventions the others follow, and do the hardest parts yourself.' },
  { name: 'Designer', rank: 2, instructions: 'You own how it looks and reads: layout, visual style, wording of the interface. Deliver concrete files, not descriptions.' },
  { name: 'HR', rank: 2, instructions: 'You own people-facing documents: guides, policies, onboarding material. Write plainly for the reader.' },
  { name: 'QA', rank: 2, instructions: 'You find what is broken or missing. Read the project files critically, write tests and checklists, and fix defects you find rather than only reporting them.' },
  { name: 'DevOps', rank: 2, instructions: 'You own how the project is built, configured and shipped: configuration files, containers, CI definitions, deployment notes.' },
  { name: 'Copywriter', rank: 3, instructions: 'You write the words: product copy, README text, announcements. Match the tone of the project and keep it concise.' },
  { name: 'Junior Dev', rank: 3, instructions: 'You implement well-scoped pieces exactly as specified, in complete working files.' },
];

/** Seniority of a role by name. Roles that no longer exist rank last, so they can never delegate upwards. */
export const rankOf = (roles: Role[], name: string) => roles.find(r => r.name === name)?.rank ?? Number.MAX_SAFE_INTEGER;

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

/** Local midnight on the first day of the month that `time` falls in. */
export const startOfMonth = (time: number) => {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
};

/** When a task's cost was incurred: when it finished, or for older records when it was created. */
export const spentAt = (task: TaskItem) => task.completedAt || task.timestamp;

/**
 * List prices in USD per 1 million tokens, used to estimate what each task cost.
 * Update these when a provider changes its prices, and add any model you switch to.
 */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'grok-3': { input: 3, output: 15 },
  'grok-3-mini': { input: 0.3, output: 0.5 },
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
};

/** Models offered in the hiring form. Any other model name can be typed in. */
export const MODEL_SUGGESTIONS: Record<string, string[]> = {
  OpenAI: ['gpt-4o-mini', 'gpt-4o'],
  Grok: ['grok-3', 'grok-3-mini'],
  Anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-fable-5-1'],
  Gemini: ['gemini-2.5-flash', 'gemini-2.5-pro'],
  Ollama: ['llama3'],
};

/**
 * Price of a model. Providers often report a dated or suffixed name for the model that answered
 * (for example "gpt-4o-mini-2024-07-18"), so a name that is not listed falls back to the longest
 * listed name it starts with.
 */
export const priceOf = (model: string) => {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  const base = Object.keys(MODEL_PRICING)
    .filter(name => model.startsWith(`${name}-`) || model.startsWith(`${name}@`))
    .sort((a, b) => b.length - a.length)[0];
  return base ? MODEL_PRICING[base] : undefined;
};

/** Estimated cost in USD, or undefined when the model has no known price. Local and mock models are free. */
export const estimateCost = (provider: string, model: string, inputTokens: number, outputTokens: number): number | undefined => {
  if (provider === 'Ollama' || model === 'mock') return 0;
  const price = priceOf(model);
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

const TITLE_WORDS = 8;
const MAX_TITLE_CHARS = 80;

/** A short title made from the start of a description, for delegations that came without one. */
export const titleFromDescription = (description: string) => {
  const words = cleanPrompt(description).split('\n')[0].trim().split(/\s+/);
  const title = words.slice(0, TITLE_WORDS).join(' ').replace(/[.,;:]+$/, '');
  return (words.length > TITLE_WORDS ? `${title}…` : title).slice(0, MAX_TITLE_CHARS);
};

/** What a task is called on the board and in reports. */
export const taskTitle = (task: TaskItem) => {
  if (task.kind === 'REVIEW') return 'Final review of the project';
  if (task.kind === 'MEETING') return task.title || 'Meeting';
  return task.title || cleanPrompt(task.prompt).split('\n')[0].trim();
};

/** Spending limit of a task tree in USD. */
export const budgetOf = (root: TaskItem) => root.budget ?? OFFICE_CONFIG.DEFAULT_TASK_BUDGET_USD;

/** What a tree has cost so far. Tasks on models without a known price count as free. */
export const spentOn = (tree: TaskRef[]) => tree.reduce((sum, ref) => sum + (ref.task.cost || 0), 0);

export const formatBudget = (usd: number) => `$${usd.toFixed(2)}`;
