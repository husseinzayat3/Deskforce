import { Agent } from '../../types';
import { OFFICE_CONFIG, FINISHED_STATUSES, budgetOf, indexTasks, getAncestors, getRoot, getTree, spentOn } from '../../officeConfig';
import { REVIEW_TASK_PROMPT } from '../../agentPrompt';
import { buildReport, buildTranscript, reportFilename, transcriptFilename } from '../../report';
import * as store from '../store';
import { checksAllowed, runChecks } from '../checks';
import { projectPath, writeProjectFile } from '../workspace';
import { commitProject } from '../git';
import { errorMessage } from '../../errors';
import { engine } from './state';
import { commitTitle } from './projects';

/** What happens once a team's work is in: follow-up rounds, the final review, checks and the report. */

/** Title of the task that repairs a project whose checks failed. */
const FIX_CHECKS_TITLE = 'Fix failing checks';

const FOLLOWUP_PROMPT = 'Your team has finished what you delegated. Check that their work fits together and delivers what you planned, and deal with anything that is missing.';

/**
 * Shows a manager what its team delivered. Once everything a task delegated has finished, its
 * owner gets a follow-up task: it reads the results, fixes gaps, and may delegate one more round.
 * Returns true when a follow-up was queued.
 */
export const followUps = (agents: Agent[]) => {
  if (OFFICE_CONFIG.FOLLOWUP_ROUNDS < 1) return false;
  const taskIndex = indexTasks(agents);
  const all = Array.from(taskIndex.values());
  let queued = false;

  for (const { task, agent } of all) {
    if (task.kind || task.status !== 'COMPLETED') continue;
    const children = all.filter(ref => ref.task.parentId === task.id);
    if (children.some(ref => ref.task.kind === 'FOLLOWUP')) continue;
    if (!children.some(ref => !ref.task.kind && ref.task.status === 'COMPLETED')) continue;

    // Everything underneath has to be over, however deep it went
    const below = all.filter(ref => getAncestors(ref.task.id, taskIndex).some(ancestor => ancestor.task.id === task.id));
    if (below.some(ref => !FINISHED_STATUSES.has(ref.task.status))) continue;

    // No more money, no more rounds
    const root = getRoot(task.id, taskIndex)?.task || task;
    if (spentOn(getTree(root.id, taskIndex)) >= budgetOf(root)) continue;

    store.createTask(agent.id, FOLLOWUP_PROMPT, 'Office', { parentId: task.id, kind: 'FOLLOWUP' });
    queued = true;
  }
  return queued;
};

/**
 * Wraps up finished projects: one final review once all delegated work is done, then the report.
 * Only for tasks the user assigned, and only for projects named under the current scheme.
 */
export const wrapUp = (agents: Agent[]) => {
  const taskIndex = indexTasks(agents);

  for (const agent of agents) {
    for (const root of agent.taskQueue) {
      if (root.parentId || root.status !== 'COMPLETED' || !root.project || root.report) continue;

      const tree = getTree(root.id, taskIndex);
      if (tree.some(ref => !FINISHED_STATUSES.has(ref.task.status))) continue;

      const subtasks = tree.filter(ref => ref.task.id !== root.id);

      // Several people worked on it: have the owner check the pieces fit together before reporting.
      // Work redone after a review (a retry or a revision) gets a fresh review.
      const work = subtasks.filter(ref => !ref.task.kind && ref.task.status === 'COMPLETED');
      const lastWork = Math.max(root.completedAt || 0, ...work.map(ref => ref.task.completedAt || 0));
      const reviewed = subtasks.some(ref => ref.task.kind === 'REVIEW' && ref.task.timestamp >= lastWork);
      if (work.length > 0 && !reviewed) {
        store.createTask(agent.id, REVIEW_TASK_PROMPT, 'Office', { parentId: root.id, kind: 'REVIEW' });
        continue;
      }

      // Optional: check the files and run the tests. A failure gets one round of fixing, then a second run.
      if (checksAllowed()) {
        if (engine.verifying.has(root.id)) continue;
        const runs = root.checkRuns || 0;
        const failed = root.checkPassed === false;
        const fixes = subtasks.filter(ref => ref.task.title === FIX_CHECKS_TITLE);
        // Checks stored by an earlier run of this task stay as they are once a fix was tried
        const fixedSince = fixes.some(ref => ref.task.status === 'COMPLETED');

        if (runs === 0 || (runs === 1 && failed && fixedSince)) {
          const project = root.project;
          engine.verifying.add(root.id);
          runChecks(project)
            .then(result => store.updateTask(root.id, { checkRuns: runs + 1, checkPassed: result.ran ? result.passed : undefined, checkOutput: result.output }))
            .catch(e => store.updateTask(root.id, { checkRuns: runs + 1, checkPassed: undefined, checkOutput: `The checks could not be run: ${e.message}` }))
            .finally(() => engine.verifying.delete(root.id));
          continue;
        }
        if (runs === 1 && failed && fixes.length === 0) {
          store.createTask(agent.id, `The project's checks failed. Fix the files so that they pass, changing as little as possible.\n\n${root.checkOutput || ''}`, 'Office', {
            parentId: root.id,
            kind: 'REVIEW',
            title: FIX_CHECKS_TITLE,
          });
          continue;
        }
      }

      const rootRef = { task: root, agent };
      const report = buildReport(rootRef, tree, projectPath(root.project));
      store.updateTask(root.id, { report });
      try {
        // Follow-up requests on the same project get their own numbered report
        const sequence = agents.flatMap(a => a.taskQueue).filter(t => !t.parentId && t.project === root.project && t.timestamp <= root.timestamp).length;
        writeProjectFile(root.project, reportFilename(sequence), report);
        writeProjectFile(root.project, transcriptFilename(sequence), buildTranscript(rootRef, tree));
        void commitProject(root.project, `Add the report for: ${commitTitle(root)}`).catch(() => undefined);
        store.pushEvent(`Report ready: ${root.project}`, 'report');
      } catch (e) {
        store.pushEvent(`Could not save the report files for ${root.project}: ${errorMessage(e)}`);
      }
    }
  }
};
