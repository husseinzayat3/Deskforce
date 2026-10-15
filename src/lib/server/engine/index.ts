import { TaskItem } from '../../types';
import { FINISHED_STATUSES, startOfMonth } from '../../officeConfig';
import * as store from '../store';
import { ensureSlack } from '../slack';
import { abortRunning, engine, holdOwnership, steerTask } from './state';
import { executeTask } from './runTask';
import { followUps, wrapUp } from './wrapUp';
import { monthStatus, runSchedules } from './schedules';

/**
 * The office engine: runs queued tasks on the server, so work carries on when no browser is open.
 * One engine runs per database, whatever the number of tabs or server processes.
 */

const TICK_MS = 1000;

const tick = () => {
  try {
    if (!holdOwnership()) return;

    // Only the process that runs the office talks to Slack
    ensureSlack();

    const now = Date.now();
    const monthKey = String(startOfMonth(now));

    // Nothing changed since a tick that found nothing to do: skip reading the whole office again
    const waiting = engine.running.size > 0
      || engine.verifying.size > 0
      || Array.from(engine.cooldown.values()).some(until => until > now)
      || store.hasDueTemplate(now);
    const startKey = `${store.getVersion()}:${monthKey}`;
    if (!waiting && engine.idleKey === startKey) return;

    const month = monthStatus(now);
    let agents = store.getState();
    if (runSchedules(agents, now, month.reached)) agents = store.getState();

    const roles = store.listRoles();
    const busy = new Set(engine.running.values());
    const tasksById = new Map(agents.flatMap(a => a.taskQueue).map(t => [t.id, t]));

    // After a restart nothing is really in flight: put interrupted work back in the queue
    for (const agent of agents) {
      for (const task of agent.taskQueue) {
        if (task.status === 'IN_PROGRESS' && !engine.running.has(task.id)) {
          store.transitionTask(task.id, 'IN_PROGRESS', 'PENDING');
          task.status = 'PENDING';
        }
      }
      if (agent.state === 'WORKING' && !busy.has(agent.id)) store.setAgentState(agent.id, 'IDLE');
    }

    // The monthly cap stops new work from starting; whatever is running finishes
    if (month.reached && store.getMeta('capNotified') !== monthKey) {
      store.setMeta('capNotified', monthKey);
      store.pushEvent(`Monthly cap of $${month.cap.toFixed(2)} reached. No new tasks will start until you raise it or the month ends.`, 'limit');
    }

    if (!store.isPaused() && !month.reached) {
      for (const agent of agents) {
        if (busy.has(agent.id) || (engine.cooldown.get(agent.id) || 0) > now) continue;

        // Oldest pending task first, leaving out those that wait for another task to finish
        const nextTask = agent.taskQueue
          .filter(t => {
            if (t.status !== 'PENDING') return false;
            const blocker = t.blockedBy ? tasksById.get(t.blockedBy) : undefined;
            return !blocker || FINISHED_STATUSES.has(blocker.status);
          })
          .reduce<TaskItem | undefined>((oldest, t) => (!oldest || t.timestamp <= oldest.timestamp ? t : oldest), undefined);
        if (nextTask) void executeTask(agent, nextTask, agents, roles);
      }
    }

    // A manager looks at its team's work before the project is reviewed and reported
    if (!followUps(agents)) wrapUp(agents);

    // Idle only if this tick changed nothing: a task it queued (a review, a fix) must be picked up by the next one
    engine.idleKey = `${store.getVersion()}:${monthKey}` === startKey ? startKey : undefined;
  } catch (e) {
    console.error('Office engine tick failed:', e);
  }
};

/** Starts the engine if it is not running yet. Safe to call on every request. */
export const ensureEngine = () => {
  if (engine.timer && engine.tick === tick) return;
  if (engine.timer) clearInterval(engine.timer);
  engine.tick = tick;
  engine.timer = setInterval(tick, TICK_MS);
  // Do not keep the process alive just for the engine
  engine.timer.unref?.();
};

export { abortRunning, monthStatus, steerTask };
