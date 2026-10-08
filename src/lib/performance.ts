import { Agent, TaskItem } from './types';
import { indexTasks, getRoot, getTree } from './officeConfig';

/** How one employee, or one model, has done so far. */
export interface Performance {
  /** Employee name, or model name. */
  name: string;
  /** Tasks that ran to an end: completed or failed. */
  tasks: number;
  /** Share of those that completed, 0–1. */
  successRate: number;
  /**
   * Share of completed tasks whose work had to be touched again, 0–1: the user sent it back,
   * it had to be retried, it ended with problems, or a later review rewrote a file it wrote.
   */
  fixRate: number;
  /** Average estimated cost per task in USD; undefined when no task has a known cost. */
  averageCost: number | undefined;
  /** Average time the model worked on a task, in milliseconds; undefined for tasks from before it was measured. */
  averageMs: number | undefined;
}

/** Tasks that check or coordinate other work are not anyone's own output. */
const isOwnWork = (task: TaskItem) => !task.kind;

const mean = (values: number[]) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : undefined);

const summarise = (name: string, tasks: { task: TaskItem; fixed: boolean }[]): Performance => {
  const completed = tasks.filter(({ task }) => task.status === 'COMPLETED');
  return {
    name,
    tasks: tasks.length,
    successRate: tasks.length ? completed.length / tasks.length : 0,
    fixRate: completed.length ? completed.filter(t => t.fixed).length / completed.length : 0,
    averageCost: mean(tasks.map(({ task }) => task.cost).filter((cost): cost is number => cost !== undefined)),
    averageMs: mean(tasks.map(({ task }) => task.durationMs).filter((ms): ms is number => Boolean(ms))),
  };
};

/**
 * Performance per employee and per model, from the tasks still in the office.
 * Deleted tasks are not counted.
 */
export const measurePerformance = (agents: Agent[]): { employees: Performance[]; models: Performance[] } => {
  const index = indexTasks(agents);

  const judged = agents.flatMap(agent =>
    agent.taskQueue
      .filter(task => isOwnWork(task) && (task.status === 'COMPLETED' || task.status === 'FAILED'))
      .map(task => {
        // A review, follow-up or fix that came later in the same project and rewrote one of this task's files
        const rootId = getRoot(task.id, index)?.task.id || task.id;
        const corrected = Boolean(task.files?.length) && getTree(rootId, index).some(ref =>
          ref.task.kind !== undefined && ref.task.kind !== 'MEETING' && ref.task.status === 'COMPLETED' &&
          (ref.task.completedAt || 0) > (task.completedAt || 0) &&
          (ref.task.files || []).some(file => task.files!.includes(file))
        );
        const fixed = Boolean(task.revisions || task.retries || task.feedback || task.reviewNote) || corrected;
        return { agent, task, fixed };
      })
  );

  const group = (key: (entry: typeof judged[number]) => string | undefined) => {
    const groups = new Map<string, typeof judged>();
    for (const entry of judged) {
      const name = key(entry);
      if (!name) continue;
      groups.set(name, [...(groups.get(name) || []), entry]);
    }
    return Array.from(groups, ([name, entries]) => summarise(name, entries)).sort((a, b) => b.tasks - a.tasks || a.name.localeCompare(b.name));
  };

  return {
    // A comparison runs on a borrowed model, so it says nothing about the employee
    employees: group(entry => (entry.task.compareId ? undefined : entry.agent.name)),
    models: group(entry => (entry.task.model && entry.task.model !== 'mock' ? entry.task.model : undefined)),
  };
};

export const formatDuration = (ms: number | undefined) => {
  if (!ms) return '–';
  if (ms < 1000) return '<1s';
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
};
