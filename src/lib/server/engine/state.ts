import { Agent } from '../../types';
import * as store from '../store';
import { endLive, startLive } from '../live';

/**
 * What the engine keeps in memory: the tasks in flight, who is cooling down after a rate limit,
 * and which server process runs the office.
 */

/** Another process is considered gone when it has not checked in for this long. */
const HEARTBEAT_STALE_MS = 10_000;

interface EngineState {
  timer?: ReturnType<typeof setInterval>;
  /** The tick function the timer runs; replaced when this module is reloaded in development. */
  tick?: () => void;
  /** Task id → agent id, for every model call in flight. Survives module reloads. */
  running: Map<string, string>;
  /** Agent id → time before which the agent takes no new task. */
  cooldown: Map<string, number>;
  /** Task id → the switch that stops its model call. */
  aborts: Map<string, AbortController>;
  /** Set after a tick that found nothing to do; while it still matches, ticks stay cheap. */
  idleKey?: string;
  /** Root tasks whose project checks are running right now. */
  verifying: Set<string>;
  /** Task id → messages the user sent to it while it runs. Only tasks that can take them are listed. */
  inbox: Map<string, string[]>;
}

const globalForEngine = globalThis as unknown as { __officeEngine?: EngineState };
export const engine: EngineState = (globalForEngine.__officeEngine ??= { running: new Map(), cooldown: new Map(), aborts: new Map(), verifying: new Set(), inbox: new Map() });
// An engine kept across a development reload may predate this field
engine.aborts ??= new Map();
engine.verifying ??= new Set();
engine.inbox ??= new Map();

/** Marks a task as running and returns the signal that stops its model calls. */
export const begin = (taskId: string, agentId: string) => {
  const controller = new AbortController();
  engine.running.set(taskId, agentId);
  engine.aborts.set(taskId, controller);
  store.setAgentState(agentId, 'WORKING');
  startLive(taskId);
  return controller.signal;
};

/**
 * Passes a message from the user to a task that is running. False when the task cannot take
 * one: it is not running, or its model works in a single answer with no steps in between.
 */
export const steerTask = (taskId: string, message: string) => {
  const waiting = engine.inbox.get(taskId);
  if (!waiting) return false;
  waiting.push(message);
  return true;
};

export const finish = (taskId: string, agentId: string) => {
  engine.inbox.delete(taskId);
  endLive(taskId);
  engine.aborts.delete(taskId);
  engine.running.delete(taskId);
  store.setAgentState(agentId, 'IDLE');
};

/**
 * Stops the model calls of running tasks, so a halted task stops costing money straight away.
 * With no argument every running task is stopped; otherwise only those of the given employee.
 */
export const abortRunning = (agentId?: string) => {
  engine.running.forEach((owner, taskId) => {
    if (!agentId || owner === agentId) engine.aborts.get(taskId)?.abort();
  });
};

/** True while this process is the one running the office. Checks in on every call. */
export const holdOwnership = () => {
  const now = Date.now();
  let owner: { pid: number; beat: number } | undefined;
  try {
    owner = JSON.parse(store.getMeta('engine') || 'null') || undefined;
  } catch {
    // unreadable entry: take over
  }
  if (owner && owner.pid !== process.pid && now - owner.beat < HEARTBEAT_STALE_MS) return false;
  store.setMeta('engine', JSON.stringify({ pid: process.pid, beat: now }));
  return true;
};

/** Provider and model pairs found unable to call tools; they use the tag format from then on. */
export const withoutTools = new Set<string>();
