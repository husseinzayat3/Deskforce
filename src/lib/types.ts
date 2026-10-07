export type AgentState = 'IDLE' | 'WORKING' | 'BREAK' | 'COFFEE' | 'TOILET' | 'WAITING_FOR_HELP' | 'MEETING';

export type APIProvider = 'OpenAI' | 'Grok' | 'Anthropic' | 'Gemini' | 'Ollama';

/** Name of a role. Roles are editable, so this is any string that matches an entry in the role list. */
export type AgentRole = string;

export interface Role {
  name: string;
  /** Seniority: 0 is the top. An employee may only delegate to roles with a higher number. */
  rank: number;
  /** What this role is responsible for and how it works; given to every employee with the role. */
  instructions: string;
}

/** A saved task. With a schedule it is assigned automatically at the given times. */
export interface Template {
  id: string;
  name: string;
  prompt: string;
  /** Who gets the task when it runs on a schedule. */
  agentId?: string;
  budget?: number;
  /** Continue this project instead of starting a new one each time. */
  project?: string;
  schedule: 'none' | 'daily' | 'weekly';
  /** 0 = Sunday … 6 = Saturday. Only for weekly schedules. */
  weekday: number;
  /** Local time of day, minutes after midnight. */
  minuteOfDay: number;
  nextRunAt?: number;
  lastRunAt?: number;
}

/**
 * AWAITING_APPROVAL: a delegation proposed by an agent that the super admin
 * must approve before it is executed (prevents runaway token spend).
 * WAITING_FOR_INPUT: the agent asked the user a question and will carry on once it is answered.
 */
export type TaskStatus = 'AWAITING_APPROVAL' | 'WAITING_FOR_INPUT' | 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

/**
 * REVIEW: the automatic final check of a whole project, queued once all of its sub-tasks are done.
 * MEETING: a short exchange between employees who were asked to change the same file.
 */
export type TaskKind = 'REVIEW' | 'MEETING';

export type ReviewStatus = 'PENDING_REVIEW' | 'APPROVED' | 'CHANGES_REQUESTED';

export interface TaskItem {
  id: string;
  prompt: string;
  /** Short name given by the manager who delegated the task. Tasks assigned by the user have none. */
  title?: string;
  response?: string;
  status: TaskStatus;
  timestamp: number;
  assignedBy: string;
  error?: string;
  parentId?: string;
  /** End-of-task documentation written by the agent for super-admin validation. */
  summary?: string;
  /** Workspace-relative paths of files this task wrote. */
  files?: string[];
  /** Tokens consumed by this task's LLM call (input + output). */
  tokens?: number;
  /** Estimated cost of this task in USD, from the model's list price. Missing when the price is unknown. */
  cost?: number;
  /** Model that produced the response. */
  model?: string;
  kind?: TaskKind;
  /** Markdown report for the whole task tree. Only set on tasks assigned by the user. */
  report?: string;
  reviewStatus?: ReviewStatus;
  reviewNote?: string;
  /** What the user asked to be changed when sending a finished task back. */
  feedback?: string;
  /** Spending limit in USD for the whole task tree. Only set on tasks assigned by the user. */
  budget?: number;
  /** When the task last finished successfully. */
  completedAt?: number;
  /** Folder under workspace/projects this task tree works in. Set on the root task once it is named. */
  project?: string;
  /** Git commit that holds the files this task wrote. */
  commit?: string;
  /** What the agent asked the user, while the task waits for the answer. */
  question?: string;
  /** Earlier questions of this task with the user's answers. */
  clarifications?: string;
  /** Employees taking part in a meeting. */
  participants?: string[];
  /** Task that has to finish before this one may start. */
  blockedBy?: string;
}

export interface Agent {
  id: string;
  name: string;
  avatar: string;
  role: AgentRole;
  api: APIProvider;
  /** Model this employee uses. Empty = the provider's default from the settings. */
  model?: string;
  state: AgentState;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  tokensUsed: number;
  currentTask: string | null;
  helpRequestedFrom?: string | null;
  idleTicks: number;
  workingTicks: number;
  breaksTaken: number;
  taskQueue: TaskItem[];
}
