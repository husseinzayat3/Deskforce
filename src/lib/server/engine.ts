import { Agent, TaskItem } from '../types';
import { OFFICE_CONFIG, ROLE_RANK, FINISHED_STATUSES, TaskRef, budgetOf, cleanPrompt, formatBudget, indexTasks, getAncestors, getRoot, getTree, projectOf, projectNameFromPrompt, slugifyProjectName, similarity, spentOn, stripGuardrailNote, titleFromDescription } from '../officeConfig';
import { buildSystemPrompt, FILE_PATH_PLACEHOLDER, PROJECT_NAME_PLACEHOLDER, REVIEW_TASK_PROMPT } from '../agentPrompt';
import { buildReport, buildTranscript, reportFilename, transcriptFilename } from '../report';
import * as store from './store';
import { runModel } from './llm';
import { listProjectFiles, projectExists, readProjectContents, scaffoldProject, writeProjectFile, ScaffoldKind } from './workspace';

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

interface EngineState {
  timer?: ReturnType<typeof setInterval>;
  /** The tick function the timer runs; replaced when this module is reloaded in development. */
  tick?: () => void;
  /** Task id → agent id, for every model call in flight. Survives module reloads. */
  running: Map<string, string>;
  /** Agent id → time before which the agent takes no new task. */
  cooldown: Map<string, number>;
}

const globalForEngine = globalThis as unknown as { __officeEngine?: EngineState };
const engine: EngineState = (globalForEngine.__officeEngine ??= { running: new Map(), cooldown: new Map() });

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

/**
 * Splits a response into its file blocks. A block counts as closed only when its [/FILE]
 * comes before the next [FILE: …], so one missing tag cannot swallow the file after it.
 */
const parseFileBlocks = (response: string) => {
  const files: { path: string; content: string }[] = [];
  const unclosed: string[] = [];
  const opening = /\[FILE:\s*([^\]\n]+?)\s*\]/gi;
  let match;
  while ((match = opening.exec(response)) !== null) {
    const rest = response.slice(opening.lastIndex);
    const close = rest.search(/\[\/FILE\]/i);
    const nextOpening = rest.search(/\[FILE:/i);
    if (close === -1 || (nextOpening !== -1 && nextOpening < close)) unclosed.push(match[1]);
    else files.push({ path: match[1], content: rest.slice(0, close).trim() });
  }
  return { files, unclosed };
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

const executeTask = async (agent: Agent, task: TaskItem, agents: Agent[]) => {
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
  engine.running.set(task.id, agent.id);
  store.setAgentState(agent.id, 'WORKING');

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
      ? agents.filter(a => a.id !== agent.id && ROLE_RANK[a.role] > ROLE_RANK[agent.role])
      : [];

    const systemPrompt = buildSystemPrompt({
      agent, task, rootTask, parent: ancestors[0], tree, slug, namesProject, isReview, colleagues, existingFiles, fileContents,
      projectHistory: projectHistoryOf(rootTask, agents, taskIndex)
    });

    const prompt = stripGuardrailNote(task.prompt);
    const result = await runModel({
      provider: agent.api,
      prompt,
      systemPrompt,
      maxTokens: isReview ? OFFICE_CONFIG.REVIEW_MAX_TOKENS : undefined
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
    const summary = response.match(/\[SUMMARY\]([\s\S]*?)\[\/SUMMARY\]/i)?.[1].trim();
    const problems: string[] = [];

    // A file without its closing tag cannot be saved: ask once for just that file again
    const blocks = parseFileBlocks(response);
    const saved = new Set(blocks.files.map(f => f.path));
    const toRepair = Array.from(new Set(blocks.unclosed)).filter(path => !saved.has(path) && !PLACEHOLDER_FILENAMES.has(path.toLowerCase()));
    for (const path of toRepair.slice(0, OFFICE_CONFIG.MAX_FILE_REPAIRS)) {
      try {
        const repair = await runModel({
          provider: agent.api,
          systemPrompt,
          history: [{ role: 'user', content: prompt }, { role: 'assistant', content: result.response }],
          prompt: `Your response contained the file "${path}" without a closing [/FILE] tag, so it could not be saved. Send that one file again, complete, in exactly this format and with nothing else:\n[FILE: ${path}]\nfile contents\n[/FILE]`,
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
      problems.push(`${path}: had no closing [/FILE] tag and could not be recovered.`);
    }
    for (const path of toRepair.slice(OFFICE_CONFIG.MAX_FILE_REPAIRS)) {
      problems.push(`${path}: had no closing [/FILE] tag and was not saved.`);
    }

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

    // Scaffold first, so the files below (and delegated work) land in a finished skeleton
    if (!isReview) {
      const kinds = new Set<ScaffoldKind>();
      const scaffoldRegex = /\[SCAFFOLD:\s*(flutter|node)\]/gi;
      let scaffoldMatch;
      while ((scaffoldMatch = scaffoldRegex.exec(response)) !== null) {
        kinds.add(scaffoldMatch[1].toLowerCase() as ScaffoldKind);
      }
      for (const kind of Array.from(kinds)) {
        try {
          await scaffoldProject(slug, kind);
        } catch (e: any) {
          problems.push(`Scaffold ${kind}: ${e.message}`);
        }
      }
    }

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

    if (wasCancelled()) return;

    // Parse assignments (after the files are saved, so delegated work starts from the current project)
    if (canDelegate) {
      const currentTree = getTree(rootTask.id, indexTasks(currentAgents));
      let spawned = 0;
      const knownPrompts = currentTree.map(ref => ref.task.prompt);
      const proposed: string[] = [];
      // [ASSIGN: id | Short title] description [/ASSIGN] — the title is optional
      const regex = /\[ASSIGN:\s*([a-zA-Z0-9_-]+)\s*(?:\|\s*([^\]\n]*?))?\s*\]([\s\S]*?)\[\/ASSIGN\]/gi;
      let match;
      while ((match = regex.exec(response)) !== null) {
        const targetId = match[1];
        const taskDesc = match[3].trim();
        const isDuplicate = (other: string) => similarity(other, taskDesc) > DUPLICATE_SIMILARITY;

        const targetAgent = currentAgents.find(a => a.id === targetId);
        // The same assignment repeated within one response is simply dropped
        if (!targetAgent || !taskDesc || proposed.some(isDuplicate)) continue;

        // Apply Guardrails
        let violation = '';
        if (spawned >= OFFICE_CONFIG.MAX_SUBTASKS_PER_TASK) violation = `Max subtasks ${OFFICE_CONFIG.MAX_SUBTASKS_PER_TASK} reached.`;
        else if (overBudget(cost || 0)) violation = budgetNote(cost || 0);
        else if (ROLE_RANK[targetAgent.role] <= ROLE_RANK[agent.role]) violation = `Cannot delegate to equal or higher rank (${targetAgent.role}).`;
        else if (knownPrompts.some(isDuplicate)) violation = `Duplicate task detected.`;

        proposed.push(taskDesc);
        spawned += 1;

        // Linked to the task that produced it so the board can nest it
        store.createTask(targetAgent.id, `Task delegated from ${agent.name}:\n${taskDesc}`, agent.name, {
          parentId: task.id,
          title: match[2]?.trim() || titleFromDescription(taskDesc),
          status: violation ? 'AWAITING_APPROVAL' : 'PENDING',
          ...(violation ? { reviewStatus: 'PENDING_REVIEW' as const, reviewNote: violation } : {})
        });
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
    engine.running.delete(task.id);
    store.setAgentState(agent.id, 'IDLE');
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
      const work = subtasks.filter(ref => ref.task.kind !== 'REVIEW' && ref.task.status === 'COMPLETED');
      const lastWork = Math.max(root.completedAt || 0, ...work.map(ref => ref.task.completedAt || 0));
      const reviewed = subtasks.some(ref => ref.task.kind === 'REVIEW' && ref.task.timestamp >= lastWork);
      if (work.length > 0 && !reviewed) {
        store.createTask(agent.id, REVIEW_TASK_PROMPT, 'Office', { parentId: root.id, kind: 'REVIEW' });
        continue;
      }

      const rootRef = { task: root, agent };
      const report = buildReport(rootRef, tree);
      store.updateTask(root.id, { report });
      try {
        // Follow-up requests on the same project get their own numbered report
        const sequence = agents.flatMap(a => a.taskQueue).filter(t => !t.parentId && t.project === root.project && t.timestamp <= root.timestamp).length;
        writeProjectFile(root.project, reportFilename(sequence), report);
        writeProjectFile(root.project, transcriptFilename(sequence), buildTranscript(rootRef, tree));
        store.pushEvent(`Report ready: ${root.project}`);
      } catch (e: any) {
        store.pushEvent(`Could not save the report files for ${root.project}: ${e.message}`);
      }
    }
  }
};

const tick = () => {
  try {
    if (!holdOwnership()) return;

    const agents = store.getState();
    const busy = new Set(engine.running.values());

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

    if (!store.isPaused()) {
      const now = Date.now();
      for (const agent of agents) {
        if (busy.has(agent.id) || (engine.cooldown.get(agent.id) || 0) > now) continue;

        // Oldest pending task first
        const nextTask = agent.taskQueue
          .filter(t => t.status === 'PENDING')
          .reduce<TaskItem | undefined>((oldest, t) => (!oldest || t.timestamp <= oldest.timestamp ? t : oldest), undefined);
        if (nextTask) void executeTask(agent, nextTask, agents);
      }
    }

    wrapUp(agents);
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
