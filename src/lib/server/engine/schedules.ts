import { Agent } from '../../types';
import { FINISHED_STATUSES, startOfMonth, indexTasks, getTree } from '../../officeConfig';
import * as store from '../store';
import { projectExists } from '../workspace';
import { nextRunTime } from '../../schedule';

/** Spending this calendar month against the cap the user set (0 = no cap). */
export const monthStatus = (now = Date.now()) => {
  const cap = Number(store.getMeta('monthlyCap')) || 0;
  // Deleted tasks still count: what they cost was spent
  const spent = store.spendSince(startOfMonth(now)) + store.deletedSpend(startOfMonth(now));
  return { cap, spent, reached: cap > 0 && spent >= cap };
};

/** Assigns the tasks whose schedule has come due. Returns true when anything changed. */
export const runSchedules = (agents: Agent[], now: number, capReached: boolean) => {
  let changed = false;
  for (const template of store.listTemplates()) {
    if (template.schedule === 'none' || !template.nextRunAt || template.nextRunAt > now) continue;
    changed = true;

    const label = `Schedule: ${template.name}`;
    const agent = agents.find(a => a.id === template.agentId);
    const taskIndex = indexTasks(agents);
    // A run is still going while its task, or anything delegated from it, is unfinished
    const stillRunning = agents.some(a => a.taskQueue.some(t =>
      !t.parentId && t.assignedBy === label && getTree(t.id, taskIndex).some(ref => !FINISHED_STATUSES.has(ref.task.status))
    ));

    if (!agent) {
      store.pushEvent(`Scheduled task "${template.name}" was skipped: its employee is no longer in the office.`);
    } else if (stillRunning) {
      store.pushEvent(`Scheduled task "${template.name}" was skipped: its previous run has not finished.`);
    } else if (capReached) {
      store.pushEvent(`Scheduled task "${template.name}" was skipped: the monthly cap is reached.`);
    } else {
      // Keep working in the same project when it still exists; otherwise the run starts a new one
      const project = template.project && projectExists(template.project) ? template.project : undefined;
      // Nobody is watching a scheduled run, so it does not stop for a plan to be approved
      store.createTask(agent.id, template.prompt, label, { budget: template.budget, project });
      store.pushEvent(`Scheduled task started: ${template.name}`);
    }
    store.markTemplateRun(template.id, now, nextRunTime(template, now));
  }
  return changed;
};
