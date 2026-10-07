import { Agent, Role, TaskItem } from '../types';
import { OFFICE_CONFIG, FINISHED_STATUSES, TaskRef, rankOf, startOfMonth, taskTitle, budgetOf, cleanPrompt, formatBudget, indexTasks, getAncestors, getRoot, getTree, projectOf, projectNameFromPrompt, slugifyProjectName, similarity, spentOn, stripGuardrailNote, titleFromDescription } from '../officeConfig';
import { buildSystemPrompt, FILE_PATH_PLACEHOLDER, PROJECT_NAME_PLACEHOLDER, REVIEW_TASK_PROMPT } from '../agentPrompt';
import { buildReport, buildTranscript, reportFilename, transcriptFilename } from '../report';
import * as store from './store';
import { runModel } from './llm';
import { listProjectFiles, projectExists, projectPath, readProjectContents, writeProjectFile } from './workspace';
import { authorFor, commitProject } from './git';
import { appendLive, endLive, startLive } from './live';
import { nextRunTime } from '../schedule';
import { parseFileBlocks } from '../fileBlocks';

/**
 * The office engine: runs queued tasks on the server, so work carries on when no browser is open.
 * One engine runs per database, whatever the number of tabs or server processes.
 */

const TICK_MS = 1000;
/** Another process is considered gone when it has not checked in for this long. */
const HEARTBEAT_STALE_MS = 10_000;
/** How long an employee waits after a rate-limit error before taking the next task. */
const RATE_LIMIT_COOLDOWN_MS = 60_000;

/** Delegations more alike than this (0–1 word overlap) count as the same task. */
const DUPLICATE_SIMILARITY = 0.8;

const PLACEHOLDER_FILENAMES = new Set([FILE_PATH_PLACEHOLDER, 'filename.ext']);

/** How many times one task may stop to ask the user something. */
const MAX_QUESTIONS_PER_TASK = 2;

/** Something that looks like a file path or file name inside an assignment. */
const FILE_MENTION = /[\w./-]*[\w-]+\.[a-z][a-z0-9]{0,5}\b/gi;

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
}

const globalForEngine = globalThis as unknown as { __officeEngine?: EngineState };
const engine: EngineState = (globalForEngine.__officeEngine ??= { running: new Map(), cooldown: new Map(), aborts: new Map() });
// An engine kept across a development reload may predate this field
engine.aborts ??= new Map();

/** Marks a task as running and returns the signal that stops its model calls. */
const begin = (taskId: string, agentId: string) => {
  const controller = new AbortController();
  engine.running.set(taskId, agentId);
  engine.aborts.set(taskId, controller);
  store.setAgentState(agentId, 'WORKING');
  startLive(taskId);
  return controller.signal;
};

const finish = (taskId: string, agentId: string) => {
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
const holdOwnership = () => {
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

/** Returns `base`, or `base-2`, `base-3`… when a project with that name already exists. */
const claimProjectName = (base: string, taskId: string, agents: Agent[]) => {
  const taken = new Set<string>();
  agents.forEach(a => a.taskQueue.forEach(t => t.project && taken.add(t.project)));

  for (let n = 1; n <= 20; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!taken.has(candidate) && !projectExists(candidate)) return candidate;
  }
  return `${base}-${taskId.slice(0, 4)}`;
};

/** Models sometimes repeat the project folder in front of the path, which would nest the project inside itself. */
const normalizeFilename = (filename: string, slug: string) => {
  let cleaned = filename.trim().replace(/^[`'"]+|[`'"]+$/g, '').replace(/\\/g, '/').replace(/^\.?\/+/, '');
  for (const prefix of [`workspace/projects/${slug}/`, `projects/${slug}/`, `${slug}/`]) {
    if (cleaned.startsWith(prefix)) cleaned = cleaned.slice(prefix.length);
  }
  return cleaned;
};

/** Earlier requests on the same project and how they ended, oldest first. */
const projectHistoryOf = (rootTask: TaskItem, agents: Agent[], taskIndex: Map<string, TaskRef>) => {
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

/** Adds two cost estimates; unknown stays unknown. */
const addCost = (a: number | undefined, b: number | undefined) => (a === undefined || b === undefined ? undefined : a + b);

/** Files an assignment says it will touch, lower-cased. */
const filesMentioned = (description: string) =>
  new Set((description.match(FILE_MENTION) || []).map(f => f.toLowerCase().replace(/^\.?\//, '')).filter(f => !/^\d+\.\d+$/.test(f)));

/** First line of a commit message for a task. */
const commitTitle = (task: TaskItem) => (task.kind === 'REVIEW' ? 'Final review' : taskTitle(task)).slice(0, 72);

/**
 * A meeting: the participants were asked to change the same files, so before any of them starts
 * they agree who does what. The first proposes, the others answer in turn, and the last one
 * writes down the plan they will all follow.
 */
const holdMeeting = async (host: Agent, task: TaskItem, agents: Agent[], overBudget: boolean) => {
  // No money left for talking: the tasks that wait on the meeting still run one after the other
  if (overBudget) {
    store.transitionTask(task.id, 'PENDING', 'CANCELLED', { reviewNote: 'Skipped: the task budget was reached.' });
    return;
  }
  if (!store.transitionTask(task.id, 'PENDING', 'IN_PROGRESS')) return;
  const signal = begin(task.id, host.id);

  const wasCancelled = () => {
    const current = store.getTask(task.id);
    return !current || current.status === 'CANCELLED';
  };

  try {
    const guests = agents.filter(a => a.id !== host.id && task.participants?.includes(a.id));
    if (guests.length === 0) throw new Error('The other participants are no longer in the office.');
    const speakers = [host, ...guests];

    const rules = 'You are in a short meeting because you were asked to change the same files. Plain text only, no tags unless asked, and under 150 words.';
    const turns: { speaker: Agent; text: string }[] = [];
    let tokens = 0;
    let cost: number | undefined = 0;
    const models = new Set<string>();

    for (let index = 0; index < speakers.length; index++) {
      const speaker = speakers[index];
      const others = speakers.filter(a => a.id !== speaker.id).map(a => `${a.name}, the ${a.role}`).join(' and ');
      const isLast = index === speakers.length - 1;
      const instruction = index === 0
        ? 'Propose how to split the work so nobody overwrites anyone else: who changes which file or which part of it, and in what order.'
        : isLast
          ? 'Agree with what was said or adjust it, then give the final plan all of you will follow inside [PLAN] ... [/PLAN].'
          : 'Agree with the proposal or adjust it, briefly.';

      appendLive(task.id, `${index > 0 ? '\n\n' : ''}${speaker.name}: `);
      const turn = await runModel({
        provider: speaker.api,
        model: speaker.model,
        systemPrompt: `You are ${speaker.name}, the ${speaker.role}. You are meeting ${others}. ${rules}\n${instruction}`,
        prompt: `${task.prompt}${turns.length ? `\n\nSaid so far:\n${turns.map(t => `${t.speaker.name}: ${t.text}`).join('\n\n')}` : ''}`,
        maxTokens: 600,
        onText: delta => appendLive(task.id, delta),
        signal,
      });

      store.addAgentTokens(speaker.id, turn.tokens);
      tokens += turn.tokens;
      cost = addCost(cost, turn.cost);
      models.add(turn.model);
      turns.push({ speaker, text: turn.response.trim() });
    }

    if (wasCancelled()) return;

    const closing = turns[turns.length - 1].text;
    store.updateTask(task.id, {
      status: 'COMPLETED',
      completedAt: Date.now(),
      response: turns.map(t => `${t.speaker.name}: ${t.text}`).join('\n\n'),
      summary: closing.match(/\[PLAN\]([\s\S]*?)\[\/PLAN\]/i)?.[1].trim() || closing,
      tokens,
      cost,
      model: Array.from(models).join(' / '),
    });
  } catch (e: any) {
    if (!wasCancelled()) {
      // The tasks waiting on the meeting still run, one after the other
      store.updateTask(task.id, { status: 'FAILED', error: e?.message || 'Unknown error' });
    }
  } finally {
    finish(task.id, host.id);
  }
};

const executeTask = async (agent: Agent, task: TaskItem, agents: Agent[], roles: Role[]) => {
  const taskIndex = indexTasks(agents);
  const rootTask = getRoot(task.id, taskIndex)?.task || task;
  const isReview = task.kind === 'REVIEW';
  // A root task that has not run yet starts a new project, which the agent names in its response
  const namesProject = rootTask.id === task.id && !task.project;
  let slug = namesProject ? '' : projectOf(rootTask);
  const ancestors = getAncestors(task.id, taskIndex);
  const depth = ancestors.length;
  const tree = getTree(rootTask.id, taskIndex);
  const budget = budgetOf(rootTask);
  const spent = spentOn(tree);
  const overBudget = (extra = 0) => spent + extra >= budget;
  const budgetNote = (extra = 0) => `Budget of ${formatBudget(budget)} reached ($${(spent + extra).toFixed(4)} spent).`;

  if (task.kind === 'MEETING') return holdMeeting(agent, task, agents, overBudget());

  // Sub-tasks queued before the tree ran out of budget wait for approval instead of running
  if (task.parentId && !isReview && task.reviewStatus !== 'APPROVED' && overBudget()) {
    store.transitionTask(task.id, 'PENDING', 'AWAITING_APPROVAL', {
      reviewStatus: 'PENDING_REVIEW',
      reviewNote: budgetNote()
    });
    return;
  }

  // Claimed in the database, so the task runs once even if two server processes are up
  if (!store.transitionTask(task.id, 'PENDING', 'IN_PROGRESS')) return;
  const signal = begin(task.id, agent.id);

  /** True once the task was halted (or its agent removed) while the model was working. */
  const wasCancelled = () => {
    const current = store.getTask(task.id);
    return !current || current.status === 'CANCELLED';
  };

  try {
    // The real state of the project: what exists, and what is in it
    let existingFiles: string[] = [];
    let fileContents: Record<string, string> = {};
    if (slug && projectExists(slug)) {
      existingFiles = listProjectFiles(slug);
      fileContents = readProjectContents(slug, existingFiles);
    }

    // Only offer colleagues this agent is actually allowed to delegate to
    const canDelegate = !isReview && depth < OFFICE_CONFIG.MAX_DELEGATION_DEPTH;
    const colleagues = canDelegate
      ? agents.filter(a => a.id !== agent.id && rankOf(roles, a.role) > rankOf(roles, agent.role))
      : [];

    const canAsk = !isReview && (task.clarifications?.match(/^Q: /gm) || []).length < MAX_QUESTIONS_PER_TASK;
    // The plan from a meeting this employee took part in, if one was held for this piece of work
    const meetingPlan = tree
      .filter(ref => ref.task.kind === 'MEETING' && ref.task.status === 'COMPLETED' && ref.task.parentId === task.parentId && ref.task.participants?.includes(agent.id))
      .sort((a, b) => b.task.timestamp - a.task.timestamp)[0]?.task.summary;

    const systemPrompt = buildSystemPrompt({
      agent, task, rootTask, parent: ancestors[0], tree, slug, namesProject, isReview, colleagues, existingFiles, fileContents,
      projectHistory: projectHistoryOf(rootTask, agents, taskIndex),
      roleInstructions: roles.find(r => r.name === agent.role)?.instructions || '',
      canAsk,
      meetingPlan,
    });

    const prompt = stripGuardrailNote(task.prompt);
    const result = await runModel({
      provider: agent.api,
      model: agent.model,
      prompt,
      systemPrompt,
      maxTokens: isReview ? OFFICE_CONFIG.REVIEW_MAX_TOKENS : undefined,
      onText: delta => appendLive(task.id, delta),
      signal,
    });

    if (result.tokens) store.addAgentTokens(agent.id, result.tokens);

    if (!result.response) {
      throw new Error('The model returned an empty response.');
    }

    // Halted while the model was working: discard the result
    if (wasCancelled()) return;

    let response = result.response;
    let tokens = result.tokens;
    let cost = result.cost;

    // The agent needs something from the user before it can do the work: park the task until it is answered
    const question = canAsk ? response.match(/\[QUESTION\]([\s\S]*?)\[\/QUESTION\]/i)?.[1].trim() : undefined;
    if (question) {
      store.updateTask(task.id, {
        status: 'WAITING_FOR_INPUT',
        question,
        response,
        tokens: (task.tokens || 0) + tokens,
        cost: addCost(task.tokens ? task.cost : 0, cost),
        model: result.model,
      });
      store.pushEvent(`${agent.name} has a question for you.`);
      return;
    }

    const summary = response.match(/\[SUMMARY\]([\s\S]*?)\[\/SUMMARY\]/i)?.[1].trim();
    const problems: string[] = [];

    // A file that was cut off by the length limit is incomplete: ask once for just that file again
    const lostFiles: string[] = [];
    const blocks = parseFileBlocks(response, result.truncated);
    const saved = new Set(blocks.files.map(f => f.path));
    const toRepair = Array.from(new Set(blocks.unclosed)).filter(path => !saved.has(path) && !PLACEHOLDER_FILENAMES.has(path.toLowerCase()));
    for (const path of toRepair.slice(0, OFFICE_CONFIG.MAX_FILE_REPAIRS)) {
      try {
        const repair = await runModel({
          provider: agent.api,
          model: agent.model,
          systemPrompt,
          history: [{ role: 'user', content: prompt }, { role: 'assistant', content: result.response }],
          signal,
          prompt: `Your response was cut off in the middle of the file "${path}", so it could not be saved. Send that one file again, complete, in exactly this format and with nothing else:\n[FILE: ${path}]\nfile contents\n[/FILE]`,
        });
        if (repair.tokens) store.addAgentTokens(agent.id, repair.tokens);
        tokens += repair.tokens;
        cost = addCost(cost, repair.cost);

        const resent = parseFileBlocks(repair.response).files[0];
        if (resent) {
          // Saved under the path that was asked for, whatever the model called it this time
          blocks.files.push({ path, content: resent.content });
          response += `\n\n[FILE: ${path}]\n${resent.content}\n[/FILE]`;
          continue;
        }
      } catch (e) {
        // reported below like any other file that could not be saved
      }
      if (signal.aborted) break;
      lostFiles.push(path);
    }
    lostFiles.push(...toRepair.slice(OFFICE_CONFIG.MAX_FILE_REPAIRS));

    if (wasCancelled()) return;

    // The office may have changed while the model was working
    const currentAgents = store.getState();

    if (namesProject) {
      const proposed = slugifyProjectName(response.match(/\[PROJECT:\s*([^\]\n]+)\]/i)?.[1] || '');
      const base = proposed && proposed !== PROJECT_NAME_PLACEHOLDER ? proposed : projectNameFromPrompt(task.prompt);
      slug = claimProjectName(base, task.id, currentAgents);
      // Saved on the root task so its sub-tasks (and later restarts) find the same folder
      store.updateTask(task.id, { project: slug });
    }

    // Files that were already there before history was kept go in first, so this task's commit shows only its own changes
    await commitProject(slug, 'Files from before history was kept').catch(() => undefined);

    // Parse file creations (each path is validated to stay inside the project)
    const writtenFiles: string[] = [];
    for (const block of blocks.files) {
      const filename = normalizeFilename(block.path, slug);
      // Models sometimes echo the format example back verbatim
      if (!filename || PLACEHOLDER_FILENAMES.has(filename.toLowerCase())) continue;

      try {
        const written = writeProjectFile(slug, filename, block.content);
        if (!writtenFiles.includes(written)) writtenFiles.push(written);
      } catch (e: any) {
        problems.push(`${filename}: ${e.message}`);
      }
    }

    if (result.truncated) {
      problems.push('The response reached the length limit and may be incomplete.');
    }

    // One commit per task, in the agent's name: the project's history, and what "undo" takes back
    let commit: string | undefined;
    if (writtenFiles.length > 0) {
      try {
        commit = await commitProject(slug, `${commitTitle(task)}\n\nTask ${task.id}, by ${agent.name} (${agent.role})`, authorFor(agent.name));
      } catch (e: any) {
        problems.push(`History: the files were saved but could not be committed (${e.message}).`);
      }
    }

    if (wasCancelled()) return;

    // Work with a file missing is not done. What was written stays (and is in the history),
    // so a retry carries on from it instead of starting over.
    if (lostFiles.length > 0) {
      store.updateTask(task.id, {
        status: 'FAILED',
        error: `${lostFiles.length} file${lostFiles.length > 1 ? 's were' : ' was'} cut off and could not be saved: ${lostFiles.join(', ')}. ` +
          `${writtenFiles.length ? `The other ${writtenFiles.length} were saved. ` : ''}Retry to have the rest written.`,
        tokens: (task.tokens || 0) + tokens,
        cost: addCost(task.tokens ? task.cost : 0, cost),
        model: result.model,
        files: writtenFiles.length > 0 ? writtenFiles : undefined,
        commit,
      });
      store.pushEvent(`${agent.name}'s task is incomplete: ${lostFiles.length} file${lostFiles.length > 1 ? 's' : ''} could not be saved.`);
      return;
    }

    // Parse assignments (after the files are saved, so delegated work starts from the current project)
    if (canDelegate) {
      const currentTree = getTree(rootTask.id, indexTasks(currentAgents));
      const knownPrompts = currentTree.map(ref => ref.task.prompt);
      const assignments: { target: Agent; title: string; description: string; violation: string }[] = [];
      // [ASSIGN: id | Short title] description [/ASSIGN] — the title is optional
      const regex = /\[ASSIGN:\s*([a-zA-Z0-9_-]+)\s*(?:\|\s*([^\]\n]*?))?\s*\]([\s\S]*?)\[\/ASSIGN\]/gi;
      let match;
      while ((match = regex.exec(response)) !== null) {
        const targetId = match[1];
        const taskDesc = match[3].trim();
        const isDuplicate = (other: string) => similarity(other, taskDesc) > DUPLICATE_SIMILARITY;

        const targetAgent = currentAgents.find(a => a.id === targetId);
        // The same assignment repeated within one response is simply dropped
        if (!targetAgent || !taskDesc || assignments.some(a => isDuplicate(a.description))) continue;

        // Apply Guardrails
        let violation = '';
        if (assignments.length >= OFFICE_CONFIG.MAX_SUBTASKS_PER_TASK) violation = `Max subtasks ${OFFICE_CONFIG.MAX_SUBTASKS_PER_TASK} reached.`;
        else if (overBudget(cost || 0)) violation = budgetNote(cost || 0);
        else if (rankOf(roles, targetAgent.role) <= rankOf(roles, agent.role)) violation = `Cannot delegate to equal or higher rank (${targetAgent.role}).`;
        else if (knownPrompts.some(isDuplicate)) violation = `Duplicate task detected.`;

        assignments.push({ target: targetAgent, title: match[2]?.trim() || titleFromDescription(taskDesc), description: taskDesc, violation });
      }

      // Assignments to different people that name the same file would overwrite each other.
      // They meet first to agree on a split, then work one after the other.
      const runnable = assignments.filter(a => !a.violation);
      const clashing = runnable.filter(a => {
        const mine = filesMentioned(a.description);
        return runnable.some(b => b.target.id !== a.target.id && Array.from(filesMentioned(b.description)).some(f => mine.has(f)));
      });
      const shared = Array.from(new Set(clashing.flatMap(a => Array.from(filesMentioned(a.description))))).filter(f =>
        clashing.filter(a => filesMentioned(a.description).has(f)).length > 1
      );
      const attendees = Array.from(new Set(clashing.map(a => a.target.id)));

      let waitFor: string | undefined;
      if (attendees.length >= 2) {
        waitFor = store.createTask(
          attendees[0],
          `Files more than one of you was asked to change: ${shared.join(', ')}\n\nThe tasks:\n${clashing.map(a => `- ${a.target.name} (${a.target.role}): ${a.title} — ${a.description}`).join('\n')}`,
          agent.name,
          { parentId: task.id, kind: 'MEETING', title: `Meeting about ${shared.slice(0, 3).join(', ')}`, participants: attendees }
        );
      }

      for (const assignment of assignments) {
        const blockedBy = clashing.includes(assignment) ? waitFor : undefined;
        // Linked to the task that produced it so the board can nest it
        const id = store.createTask(assignment.target.id, `Task delegated from ${agent.name}:\n${assignment.description}`, agent.name, {
          parentId: task.id,
          title: assignment.title,
          status: assignment.violation ? 'AWAITING_APPROVAL' : 'PENDING',
          blockedBy,
          ...(assignment.violation ? { reviewStatus: 'PENDING_REVIEW' as const, reviewNote: assignment.violation } : {})
        });
        // The next task on the same files waits for this one
        if (blockedBy) waitFor = id;
      }
    }

    if (problems.length > 0) {
      store.pushEvent(`${agent.name}: ${problems.length} problem${problems.length > 1 ? 's' : ''} saving work — see the task details.`);
    }

    store.updateTask(task.id, {
      status: 'COMPLETED',
      completedAt: Date.now(),
      response,
      // A task that was sent back keeps what its first attempt used
      tokens: (task.tokens || 0) + tokens,
      cost: addCost(task.tokens ? task.cost : 0, cost),
      model: result.model,
      summary,
      files: writtenFiles.length > 0 ? writtenFiles : undefined,
      commit,
      question: undefined,
      reviewStatus: undefined,
      reviewNote: problems.length > 0 ? problems.join('\n') : undefined
    });
  } catch (e: any) {
    if (wasCancelled()) return;

    const message: string = e?.message || 'Unknown error';
    const isRateLimit = message.toLowerCase().includes('429') || message.toLowerCase().includes('rate limit');
    store.updateTask(task.id, { status: 'FAILED', error: message });
    store.pushEvent(`Task for ${agent.name} failed.${isRateLimit ? ' (Rate limit hit — pausing this employee for a minute)' : ''}`);

    // Do not hammer a provider that just asked us to slow down
    if (isRateLimit) engine.cooldown.set(agent.id, Date.now() + RATE_LIMIT_COOLDOWN_MS);
  } finally {
    finish(task.id, agent.id);
  }
};

/**
 * Wraps up finished projects: one final review once all delegated work is done, then the report.
 * Only for tasks the user assigned, and only for projects named under the current scheme.
 */
const wrapUp = (agents: Agent[]) => {
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

      const rootRef = { task: root, agent };
      const report = buildReport(rootRef, tree, projectPath(root.project));
      store.updateTask(root.id, { report });
      try {
        // Follow-up requests on the same project get their own numbered report
        const sequence = agents.flatMap(a => a.taskQueue).filter(t => !t.parentId && t.project === root.project && t.timestamp <= root.timestamp).length;
        writeProjectFile(root.project, reportFilename(sequence), report);
        writeProjectFile(root.project, transcriptFilename(sequence), buildTranscript(rootRef, tree));
        void commitProject(root.project, `Add the report for: ${commitTitle(root)}`).catch(() => undefined);
        store.pushEvent(`Report ready: ${root.project}`);
      } catch (e: any) {
        store.pushEvent(`Could not save the report files for ${root.project}: ${e.message}`);
      }
    }
  }
};

/** Spending this calendar month against the cap the user set (0 = no cap). */
export const monthStatus = (now = Date.now()) => {
  const cap = Number(store.getMeta('monthlyCap')) || 0;
  const spent = store.spendSince(startOfMonth(now));
  return { cap, spent, reached: cap > 0 && spent >= cap };
};

/** Assigns the tasks whose schedule has come due. Returns true when anything changed. */
const runSchedules = (agents: Agent[], now: number, capReached: boolean) => {
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
      store.createTask(agent.id, template.prompt, label, { budget: template.budget, project });
      store.pushEvent(`Scheduled task started: ${template.name}`);
    }
    store.markTemplateRun(template.id, now, nextRunTime(template, now));
  }
  return changed;
};

const tick = () => {
  try {
    if (!holdOwnership()) return;

    const now = Date.now();
    const monthKey = String(startOfMonth(now));

    // Nothing changed since a tick that found nothing to do: skip reading the whole office again
    const waiting = engine.running.size > 0
      || Array.from(engine.cooldown.values()).some(until => until > now)
      || store.hasDueTemplate(now);
    if (!waiting && engine.idleKey === `${store.getVersion()}:${monthKey}`) return;

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
      store.pushEvent(`Monthly cap of $${month.cap.toFixed(2)} reached. No new tasks will start until you raise it or the month ends.`);
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

    wrapUp(agents);

    // Anything this tick did changed the version, so the key only matches once the office is at rest
    engine.idleKey = `${store.getVersion()}:${monthKey}`;
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
