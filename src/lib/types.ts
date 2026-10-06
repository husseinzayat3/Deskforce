export type AgentState = 'IDLE' | 'WORKING' | 'BREAK' | 'COFFEE' | 'TOILET' | 'WAITING_FOR_HELP';

export type APIProvider = 'OpenAI' | 'Grok' | 'Ollama';
export type AgentRole = 'CEO' | 'Tech Lead' | 'Junior Dev' | 'HR' | 'Designer';

/**
 * AWAITING_APPROVAL: a delegation proposed by an agent that the super admin
 * must approve before it is executed (prevents runaway token spend).
 */
export type TaskStatus = 'AWAITING_APPROVAL' | 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export type ReviewStatus = 'PENDING_REVIEW' | 'APPROVED' | 'CHANGES_REQUESTED';

export interface TaskItem {
  id: string;
  prompt: string;
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
  /** Tokens consumed by this task's LLM call. */
  tokens?: number;
  reviewStatus?: ReviewStatus;
  reviewNote?: string;
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

export interface Task {
  id: string;
  description: string;
  assignedTo?: string;
  dependsOn?: string; // ID of another task
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED';
}
