import { Agent, TaskItem } from '../../types';
import { OFFICE_CONFIG, TaskRef, taskTitle, cleanPrompt, getTree } from '../../officeConfig';
import { projectExists } from '../workspace';

/** Helpers for project folders, file names and commit messages. */

/** Something that looks like a file path or file name inside an assignment. */
const FILE_MENTION = /[\w./-]*[\w-]+\.[a-z][a-z0-9]{0,5}\b/gi;

/** Returns `base`, or `base-2`, `base-3`… when a project with that name already exists. */
export const claimProjectName = (base: string, taskId: string, agents: Agent[]) => {
  const taken = new Set<string>();
  agents.forEach(a => a.taskQueue.forEach(t => t.project && taken.add(t.project)));

  for (let n = 1; n <= 20; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!taken.has(candidate) && !projectExists(candidate)) return candidate;
  }
  return `${base}-${taskId.slice(0, 4)}`;
};

/** Models sometimes repeat the project folder in front of the path, which would nest the project inside itself. */
export const normalizeFilename = (filename: string, slug: string) => {
  let cleaned = filename.trim().replace(/^[`'"]+|[`'"]+$/g, '').replace(/\\/g, '/').replace(/^\.?\/+/, '');
  for (const prefix of [`workspace/projects/${slug}/`, `projects/${slug}/`, `${slug}/`]) {
    if (cleaned.startsWith(prefix)) cleaned = cleaned.slice(prefix.length);
  }
  return cleaned;
};

/** Earlier requests on the same project and how they ended, oldest first. */
export const projectHistoryOf = (rootTask: TaskItem, agents: Agent[], taskIndex: Map<string, TaskRef>) => {
  if (!rootTask.project) return [];
  return agents
    .flatMap(a => a.taskQueue)
    .filter(t => !t.parentId && t.id !== rootTask.id && t.project === rootTask.project && t.status === 'COMPLETED' && t.timestamp < rootTask.timestamp)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-OFFICE_CONFIG.MAX_HISTORY_ITEMS)
    .map(t => {
      const review = getTree(t.id, taskIndex).find(ref => ref.task.kind === 'REVIEW' && ref.task.status === 'COMPLETED');
      return { request: cleanPrompt(t.prompt), outcome: review?.task.summary || t.summary || 'No summary was recorded.' };
    });
};

/** Files an assignment says it will touch, lower-cased. */
export const filesMentioned = (description: string) =>
  new Set((description.match(FILE_MENTION) || []).map(f => f.toLowerCase().replace(/^\.?\//, '')).filter(f => !/^\d+\.\d+$/.test(f)));

/** First line of a commit message for a task. */
export const commitTitle = (task: TaskItem) => (task.kind === 'REVIEW' && !task.title ? 'Final review' : taskTitle(task)).slice(0, 72);
