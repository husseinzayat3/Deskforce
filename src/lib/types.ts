export type AgentState = 'IDLE' | 'WORKING' | 'BREAK' | 'COFFEE' | 'TOILET' | 'WAITING_FOR_HELP';

export type APIProvider = 'OpenAI' | 'Grok' | 'Ollama';
export type AgentRole = 'CEO' | 'Tech Lead' | 'Junior Dev' | 'HR' | 'Designer';

/**
 * AWAITING_APPROVAL: a delegation proposed by an agent that the super admin
 * must approve before it is executed (prevents runaway token spend).
 */
export type TaskStatus = 'AWAITING_APPROVAL' | 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

/** REVIEW: the automatic final check of a whole project, queued once all of its sub-tasks are done. */
export type TaskKind = 'REVIEW';

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
}

export interface Agent {
  id: string;
  name: string;
  avatar: string;
  role: AgentRole;
  api: APIProvider;
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
