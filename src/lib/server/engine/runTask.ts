import { Agent, Role, TaskItem } from '../../types';
import { OFFICE_CONFIG, STEP_TOKENS, delegationDepth, estimateCost, rankOf, budgetOf, cleanPrompt, formatBudget, indexTasks, getAncestors, getRoot, getTree, projectOf, projectNameFromPrompt, slugifyProjectName, similarity, spentOn, stripGuardrailNote, titleFromDescription } from '../../officeConfig';
import { buildSystemPrompt, stripTags, FILE_PATH_PLACEHOLDER, PROJECT_NAME_PLACEHOLDER } from '../../agentPrompt';
import * as store from '../store';
import { ToolsUnsupportedError, addCost, defaultModel, hasRealModel, runModel, searchProviderFor, searchWeb } from '../llm';
import { AgentTool, runAgent } from '../agent';
import { applyEdit } from '../../edits';
import { fetchPage } from '../web';
import { checksAllowed, runChecks } from '../checks';
import { getSetting } from '../settings';
import { attachedImages, deleteProjectFile, installAttachments, listProjectFiles, projectExists, readProjectContents, viewProjectFile, writeProjectFile } from '../workspace';
import { authorFor, commitProject } from '../git';
import { appendLive } from '../live';
import { postToSlack, slackHome } from '../slack';
import { parseFileBlocks } from '../../fileBlocks';
import { errorMessage } from '../../errors';
import { begin, engine, finish, withoutTools } from './state';
import { claimProjectName, commitTitle, filesMentioned, normalizeFilename, projectHistoryOf } from './projects';
import { holdMeeting } from './meeting';

/** Runs one task: builds its prompt, lets the model work through tools or tags, and saves what it did. */

/** How long an employee waits after a rate-limit error before taking the next task. */
const RATE_LIMIT_COOLDOWN_MS = 60_000;

/** Delegations more alike than this (0–1 word overlap) count as the same task. */
const DUPLICATE_SIMILARITY = 0.8;

const PLACEHOLDER_FILENAMES = new Set([FILE_PATH_PLACEHOLDER, 'filename.ext']);

/** How many times one task may stop to ask the user something. */
const MAX_QUESTIONS_PER_TASK = 2;

const MAX_SEARCHES_PER_TASK = 6;
const MAX_FETCHES_PER_TASK = 8;
const MAX_CHECK_RUNS_PER_TASK = 3;
/** Longest file handed to a model in one read. */
const MAX_READ_CHARS = 60_000;

const text = (value: unknown) => (typeof value === 'string' ? value : '');

export const executeTask = async (agent: Agent, task: TaskItem, agents: Agent[], roles: Role[]) => {
  const taskIndex = indexTasks(agents);
  const rootTask = getRoot(task.id, taskIndex)?.task || task;
  const isReview = task.kind === 'REVIEW';
  const isRoot = rootTask.id === task.id;
  let slug = isRoot && !task.project ? '' : projectOf(rootTask);
  const ancestors = getAncestors(task.id, taskIndex);
  const depth = delegationDepth(task.id, taskIndex);
  const isFollowUp = task.kind === 'FOLLOWUP';
  // Whoever handed this work down: for a follow-up, that is above the manager's own task
  const manager = ancestors.find(ref => ref.agent.id !== agent.id && ref.task.kind !== 'FOLLOWUP');
  const tree = getTree(rootTask.id, taskIndex);
  const budget = budgetOf(rootTask);
  const spent = spentOn(tree);
  const overBudget = (extra = 0) => spent + extra >= budget;
  const budgetNote = (extra = 0) => `Budget of ${formatBudget(budget)} reached ($${(spent + extra).toFixed(4)} spent).`;

  if (task.kind === 'MEETING') return holdMeeting(agent, task, agents, overBudget());

  // A comparison runs the request on the model being tried out, in this employee's name and role
  // (no model named = that provider's default, not the employee's own model)
  const worker: Agent = task.compareId && task.apiOverride ? { ...agent, api: task.apiOverride, model: task.modelOverride || '' } : agent;
  const startedAt = Date.now();

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
    // What the task produces, whichever way the model works
    let response = '';
    let summary: string | undefined;
    let tokens = 0;
    let cost: number | undefined = 0;
    let model = '';
    let cachedTokens = 0;
    let question: string | undefined;
    let changed = false;
    const writtenFiles: string[] = [];
    const lostFiles: string[] = [];
    const problems: string[] = [];
    const requested: { targetId: string; title?: string; description: string }[] = [];

    let prepared = false;
    /** Makes sure the project has a folder that is ready to be written to, and returns its name. */
    const projectReady = async (proposedName = '') => {
      if (!slug) {
        const name = slugifyProjectName(proposedName);
        const base = name && name !== PROJECT_NAME_PLACEHOLDER ? name : projectNameFromPrompt(task.prompt);
        slug = claimProjectName(base, task.id, store.getState());
        // Saved on the root task so its sub-tasks (and later restarts) find the same folder
        store.updateTask(task.id, { project: slug });
      }
      if (!prepared) {
        prepared = true;
        const attached = installAttachments(task.id, slug);
        // Whatever is not in the history yet goes in first, so this task's commit shows only its own changes
        await commitProject(slug, attached.length ? 'Files attached by the client' : 'Changes made outside a task').catch(() => undefined);
      }
      return slug;
    };

    const saveFile = async (requestedPath: string, content: string) => {
      const project = await projectReady();
      const filename = normalizeFilename(requestedPath, project);
      // Models sometimes echo the format example back verbatim
      if (!filename || PLACEHOLDER_FILENAMES.has(filename.toLowerCase())) throw new Error('That is a placeholder, not a real file path.');
      const written = writeProjectFile(project, filename, content);
      if (!writtenFiles.includes(written)) writtenFiles.push(written);
      changed = true;
      return written;
    };

    // An existing project is prepared now; attached files must be in place before the model starts
    if (slug || task.attachments?.length) await projectReady();
    const namesProject = !slug;

    // The real state of the project: what exists, and what is in it
    let existingFiles: string[] = [];
    let fileContents: Record<string, string> = {};
    if (slug && projectExists(slug)) {
      existingFiles = listProjectFiles(slug);
      fileContents = readProjectContents(slug, existingFiles);
    }

    // Only offer colleagues this agent is actually allowed to delegate to
    // A comparison is one model working alone, so the result says something about that model
    const canDelegate = !isReview && !task.compareId && depth < OFFICE_CONFIG.MAX_DELEGATION_DEPTH;
    const colleagues = canDelegate
      ? agents.filter(a => a.id !== agent.id && rankOf(roles, a.role) > rankOf(roles, agent.role))
      : [];

    const canAsk = !isReview && !task.compareId && (task.clarifications?.match(/^Q: /gm) || []).length < MAX_QUESTIONS_PER_TASK;
    // The plan from a meeting this employee took part in, if one was held for this piece of work
    const meetingPlan = tree
      .filter(ref => ref.task.kind === 'MEETING' && ref.task.status === 'COMPLETED' && ref.task.parentId === task.parentId && ref.task.participants?.includes(agent.id))
      .sort((a, b) => b.task.timestamp - a.task.timestamp)[0]?.task.summary;

    const modelKey = `${worker.api}:${worker.model || ''}`;
    const webOn = getSetting('webAccess') === 'on';
    const canSearch = webOn && (worker.api === 'Anthropic' || searchProviderFor(worker.api) !== null);
    const canRunChecks = checksAllowed();
    const images = isRoot && slug ? attachedImages(slug, rootTask.attachments) : [];

    const handbook = store.getHandbook();
    const notes = store.listNotes().map(n => `${n.text} (${n.author}${n.project ? `, ${n.project}` : ''})`);
    // The manager can be asked as long as they are still in the office
    const canAskManager = Boolean(manager && agents.some(a => a.id === manager.agent.id));

    const systemPromptFor = (mode: 'tools' | 'tags', phase?: 'plan') => buildSystemPrompt({
      handbook, notes, isFollowUp, phase,
      canAskManager: mode === 'tools' && canAskManager,
      agent, task, rootTask, parent: manager, tree, slug, namesProject, isReview, colleagues, existingFiles, fileContents,
      projectHistory: projectHistoryOf(rootTask, agents, taskIndex),
      roleInstructions: roles.find(r => r.name === agent.role)?.instructions || '',
      canAsk,
      meetingPlan,
      mode,
      webAccess: mode === 'tools' && canSearch,
      canRunChecks: mode === 'tools' && canRunChecks,
      attachments: rootTask.attachments || [],
    });

    const prompt = stripGuardrailNote(task.prompt);
    const onText = (delta: string) => appendLive(task.id, delta);

    // The user asked to see a plan first: propose one and wait. No work is done and nothing is written.
    if (isRoot && task.needsPlan && !task.planApproved) {
      const proposal = await runModel({ provider: worker.api, model: worker.model, prompt, systemPrompt: systemPromptFor('tags', 'plan'), images, maxTokens: 1500, onText, signal });
      if (proposal.tokens) store.addAgentTokens(agent.id, proposal.tokens);
      if (wasCancelled()) return;
      if (!proposal.response.trim()) throw new Error('The model returned an empty plan.');

      const SIZE_WORDS: Record<string, string> = { S: 'small', M: 'medium', L: 'large' };
      const steps: { who: Agent; size: string; what: string }[] = [];
      const stepPattern = /\[STEP:\s*([^|\]\n]+?)\s*\|\s*([SML])\s*\]\s*([^\n]+)/gi;
      let step;
      while ((step = stepPattern.exec(proposal.response)) !== null) {
        const name = step[1].trim().toLowerCase();
        const who = colleagues.find(a => a.id.toLowerCase() === name || a.name.toLowerCase() === name) || agent;
        steps.push({ who, size: step[2].toUpperCase(), what: step[3].trim() });
      }

      // A rough figure from the size of each step and the price of the model that will do it
      const delegated = steps.some(s => s.who.id !== agent.id);
      const planned = [...steps, ...(delegated ? [{ who: agent, size: 'M', what: 'review' }] : [])];
      let estimate: number | undefined = steps.length > 0 ? 0 : undefined;
      for (const item of planned) {
        const tokens = STEP_TOKENS[item.size];
        estimate = addCost(estimate, estimateCost(item.who.api, item.who.model || defaultModel(item.who.api), tokens * 0.85, tokens * 0.15));
      }

      const body = (proposal.response.match(/\[PLAN\]([\s\S]*?)\[\/PLAN\]/i)?.[1] || proposal.response.replace(stepPattern, '').replace(/\[\/?PLAN\]/gi, '')).trim();
      const whoDoesWhat = steps.map(s => `- ${s.who.name} (${s.who.role}): ${s.what} — ${SIZE_WORDS[s.size]}`).join('\n');

      store.updateTask(task.id, {
        status: 'PLAN_REVIEW',
        plan: `${body}${whoDoesWhat ? `\n\nWho does what:\n${whoDoesWhat}` : ''}`,
        planEstimate: estimate,
        planNote: undefined,
        tokens: (task.tokens || 0) + proposal.tokens,
        cost: addCost(task.tokens ? task.cost : 0, proposal.cost),
        model: proposal.model,
      });
      store.pushEvent(`${agent.name} has a plan for you to approve.`, 'question');
      return;
    }

    /** The model works by calling functions: files are read and written as it goes. */
    const workWithTools = async () => {
      const used = { searches: 0, fetches: 0, checks: 0, managerQuestions: 0, notes: 0, posts: 0 };
      // From here on the task takes messages from the user
      engine.inbox.set(task.id, []);
      const tools: AgentTool[] = [];
      const pathParam = { type: 'string', description: 'Path of the file inside the project, for example lib/main.dart' };

      if (namesProject) {
        tools.push({
          name: 'name_project',
          description: 'Names the new project. Call this once, before writing any file.',
          parameters: { type: 'object', properties: { name: { type: 'string', description: '2 to 4 lowercase words joined by hyphens, for example voice-calculator' } }, required: ['name'] },
          describe: input => `project named: ${text(input.name)}`,
          run: async input => ({ output: `The project folder is "${await projectReady(text(input.name))}".` }),
        });
      }

      tools.push(
        {
          name: 'list_files',
          description: 'Lists the files in the project.',
          parameters: { type: 'object', properties: {} },
          describe: () => 'listed the files',
          run: () => {
            const files = slug ? listProjectFiles(slug) : [];
            return { output: files.length ? files.join('\n') : 'The project has no files yet.' };
          },
        },
        {
          name: 'read_file',
          description: 'Returns the current contents of a file in the project.',
          parameters: { type: 'object', properties: { path: pathParam }, required: ['path'] },
          describe: input => `read file: ${text(input.path)}`,
          run: input => {
            const file = slug ? viewProjectFile(slug, normalizeFilename(text(input.path), slug)) : null;
            if (!file) throw new Error(`There is no file "${text(input.path)}". Use list_files to see what exists.`);
            if (file.text === undefined) throw new Error('That file is binary or too large to read as text.');
            return { output: file.text.length > MAX_READ_CHARS ? `${file.text.slice(0, MAX_READ_CHARS)}\n[cut: the file is longer]` : file.text || '(empty file)' };
          },
        },
        {
          name: 'write_file',
          description: 'Creates a file, or replaces it completely, with the given contents. Missing folders are created.',
          parameters: { type: 'object', properties: { path: pathParam, content: { type: 'string', description: 'The complete contents of the file' } }, required: ['path', 'content'] },
          describe: input => `saved file: ${text(input.path)}`,
          run: async input => {
            if (typeof input.content !== 'string') throw new Error('content is missing.');
            return { output: `Saved ${await saveFile(text(input.path), input.content)}.` };
          },
        },
        {
          name: 'edit_file',
          description: 'Replaces one passage of an existing file and keeps the rest. old_text must match the file exactly, including indentation, and must identify one place only.',
          parameters: {
            type: 'object',
            properties: {
              path: pathParam,
              old_text: { type: 'string', description: 'The exact text to replace' },
              new_text: { type: 'string', description: 'The text to put in its place' },
              replace_all: { type: 'boolean', description: 'Replace every occurrence instead of exactly one' },
            },
            required: ['path', 'old_text', 'new_text'],
          },
          describe: input => `edited file: ${text(input.path)}`,
          run: async input => {
            const filename = slug ? normalizeFilename(text(input.path), slug) : '';
            const file = slug ? viewProjectFile(slug, filename) : null;
            if (!file || file.text === undefined) throw new Error(`There is no text file "${text(input.path)}" to edit. Use write_file to create it.`);
            const updated = applyEdit(file.text, text(input.old_text), text(input.new_text), input.replace_all === true);
            return { output: `Edited ${await saveFile(filename, updated)}.` };
          },
        },
        {
          name: 'delete_file',
          description: 'Removes a file from the project.',
          parameters: { type: 'object', properties: { path: pathParam }, required: ['path'] },
          describe: input => `deleted file: ${text(input.path)}`,
          run: input => {
            if (!slug || !deleteProjectFile(slug, normalizeFilename(text(input.path), slug))) throw new Error(`There is no file "${text(input.path)}".`);
            changed = true;
            return { output: 'Deleted.' };
          },
        },
      );

      if (colleagues.length > 0) {
        tools.push({
          name: 'delegate',
          description: 'Hands a part of the work to a colleague. They start after you have finished.',
          parameters: {
            type: 'object',
            properties: {
              employee_id: { type: 'string', description: 'ID of the colleague, from the list you were given' },
              title: { type: 'string', description: 'Short name of the task, 3 to 7 words' },
              description: { type: 'string', description: 'What to do: which files to create or change, and what "done" means' },
            },
            required: ['employee_id', 'title', 'description'],
          },
          describe: input => `delegated: ${text(input.title) || titleFromDescription(text(input.description))}`,
          run: input => {
            const target = colleagues.find(a => a.id === text(input.employee_id));
            if (!target) throw new Error(`No colleague has the ID "${text(input.employee_id)}". Valid IDs: ${colleagues.map(a => `${a.id} (${a.name})`).join(', ')}.`);
            if (!text(input.description).trim()) throw new Error('description is missing.');
            if (requested.length >= OFFICE_CONFIG.MAX_SUBTASKS_PER_TASK) throw new Error(`You already delegated ${OFFICE_CONFIG.MAX_SUBTASKS_PER_TASK} tasks, which is the limit. Do the rest yourself.`);
            requested.push({ targetId: target.id, title: text(input.title).trim() || undefined, description: text(input.description).trim() });
            return { output: `Queued for ${target.name}. They start after you finish.` };
          },
        });
      }

      if (canAsk) {
        tools.push({
          name: 'ask_client',
          description: 'Asks the client one question and pauses the task until they answer. Only for information that nobody but the client has.',
          parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
          describe: () => 'asked the client a question',
          run: input => {
            if (!text(input.question).trim()) throw new Error('question is missing.');
            question = text(input.question).trim();
            return { output: 'The client has been asked. The task is paused until they answer.', stop: true };
          },
        });
      }

      // Claude searches with its provider's own tools; the others get these
      if (webOn && worker.api !== 'Anthropic') {
        if (canSearch) {
          tools.push({
            name: 'web_search',
            description: 'Looks something up on the web and returns an answer with its sources. Use it for current facts: prices, versions, documentation.',
            parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to find out, as a full question' } }, required: ['query'] },
            describe: input => `searched the web: ${text(input.query).slice(0, 80)}`,
            run: async input => {
              if (++used.searches > MAX_SEARCHES_PER_TASK) throw new Error('No more searches for this task. Work with what you have.');
              const found = await searchWeb(text(input.query), worker.api, signal);
              return { output: found.answer, tokens: found.tokens, cost: found.cost };
            },
          });
        }
        tools.push({
          name: 'fetch_url',
          description: 'Returns the text of a public web page.',
          parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
          describe: input => `read web page: ${text(input.url).slice(0, 100)}`,
          run: async input => {
            if (++used.fetches > MAX_FETCHES_PER_TASK) throw new Error('No more pages for this task. Work with what you have.');
            return { output: await fetchPage(text(input.url), signal) };
          },
        });
      }

      if (canAskManager && manager) {
        const boss = manager.agent;
        tools.push({
          name: 'ask_manager',
          description: `Asks ${boss.name}, who assigned this task, a question and returns the answer straight away. For anything unclear in the assignment or a decision that is theirs to make.`,
          parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
          describe: input => `asked ${boss.name}: ${text(input.question).slice(0, 120)}`,
          run: async input => {
            const asked = text(input.question).trim();
            if (!asked) throw new Error('question is missing.');
            if (++used.managerQuestions > OFFICE_CONFIG.MAX_MANAGER_QUESTIONS) throw new Error(`${boss.name} has no more time for questions on this task. Decide yourself and say what you assumed in your summary.`);

            // A short call in the manager's name, with what the manager knows about this piece of work
            const answer = await runModel({
              provider: boss.api,
              model: boss.model,
              signal,
              maxTokens: 500,
              systemPrompt:
                `You are ${boss.name}, the ${boss.role}. ${agent.name} (${agent.role}) is working on a task you assigned and has a question. ` +
                `Answer in a few sentences with a clear decision, so they can carry on. If only the client can answer, say exactly that.\n\n` +
                (handbook.trim() ? `Company handbook:\n${handbook.trim().slice(0, OFFICE_CONFIG.HANDBOOK_CHARS)}\n\n` : '') +
                `The client's request:\n${cleanPrompt(rootTask.prompt)}\n\n` +
                (rootTask.planApproved && rootTask.plan ? `The plan the client approved:\n${rootTask.plan}\n\n` : '') +
                (manager.task.response ? `What you wrote when you planned this work:\n${stripTags(manager.task.response).slice(0, OFFICE_CONFIG.PLAN_CHARS)}\n\n` : '') +
                `The task you gave ${agent.name}:\n${cleanPrompt(task.prompt)}\n\n` +
                `Files in the project now:\n${(slug ? listProjectFiles(slug) : []).slice(0, OFFICE_CONFIG.MAX_FILES_IN_PROMPT).join('\n') || '(none yet)'}`,
              prompt: asked,
            });
            if (answer.tokens) store.addAgentTokens(boss.id, answer.tokens);
            appendLive(task.id, `\n${boss.name}: ${answer.response.trim()}\n`);
            return { output: `${boss.name} answers: ${answer.response.trim() || '(no answer)'}`, tokens: answer.tokens, cost: answer.cost };
          },
        });
      }

      tools.push({
        name: 'save_note',
        description: 'Writes down one lasting lesson for future projects: a convention the client wants, a mistake to avoid, a decision worth repeating. Not for describing what you did.',
        parameters: { type: 'object', properties: { note: { type: 'string', description: 'One sentence' } }, required: ['note'] },
        describe: input => `noted for future projects: ${text(input.note).slice(0, 120)}`,
        run: input => {
          const lesson = text(input.note).replace(/\s+/g, ' ').trim();
          if (!lesson) throw new Error('note is missing.');
          if (++used.notes > OFFICE_CONFIG.MAX_NOTES_PER_TASK) throw new Error('Enough notes for one task.');
          store.addNote(lesson, agent.name, slug || undefined);
          return { output: 'Noted.' };
        },
      });

      // Connected to Slack, and the client has written there: progress can be reported to them
      if (slackHome()) {
        tools.push({
          name: 'post_to_slack',
          description: 'Posts a short message to the client in Slack: a milestone reached, or something they should know before the task is done. Not for questions; use ask_client for those.',
          parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
          describe: input => `posted to Slack: ${text(input.message).slice(0, 100)}`,
          run: async input => {
            const message = text(input.message).trim();
            if (!message) throw new Error('message is missing.');
            if (++used.posts > 3) throw new Error('Enough messages for one task. The client is told when the task is done.');
            await postToSlack(slackHome(), `${agent.name}: ${message}`);
            return { output: 'Posted.' };
          },
        });
      }

      if (canRunChecks) {
        tools.push({
          name: 'run_checks',
          description: "Checks the syntax of the project's files and runs its tests. Returns what passed and what failed.",
          parameters: { type: 'object', properties: {} },
          describe: () => 'ran the checks',
          run: async () => {
            if (!slug) throw new Error('There is nothing to check yet.');
            if (++used.checks > MAX_CHECK_RUNS_PER_TASK) throw new Error('No more check runs for this task.');
            return { output: (await runChecks(slug)).output };
          },
        });
      }

      const run = await runAgent({
        provider: worker.api,
        model: worker.model,
        system: systemPromptFor('tools'),
        prompt,
        images,
        tools,
        nativeWeb: canSearch && worker.api === 'Anthropic',
        cacheKey: `office-${task.id}`,
        overBudget: extra => overBudget(extra),
        inbox: () => (engine.inbox.get(task.id) || []).splice(0),
        onText,
        signal,
      });

      response = run.transcript;
      summary = run.finalText || undefined;
      tokens = run.tokens;
      cachedTokens = run.cachedTokens;
      cost = run.cost;
      model = run.model;
      problems.push(...run.problems);
      if (!run.transcript && !question) throw new Error('The model returned an empty response.');
    };

    /** The model writes one message with everything in it, marked up with tags. */
    const workWithTags = async () => {
      const systemPrompt = systemPromptFor('tags');
      const result = await runModel({
        provider: worker.api,
        model: worker.model,
        prompt,
        systemPrompt,
        images,
        maxTokens: isReview ? OFFICE_CONFIG.REVIEW_MAX_TOKENS : undefined,
        onText,
        signal,
      });
      if (!result.response) throw new Error('The model returned an empty response.');

      response = result.response;
      tokens = result.tokens;
      cost = result.cost;
      model = result.model;

      question = canAsk ? response.match(/\[QUESTION\]([\s\S]*?)\[\/QUESTION\]/i)?.[1].trim() : undefined;
      if (question) return;

      summary = response.match(/\[SUMMARY\]([\s\S]*?)\[\/SUMMARY\]/i)?.[1].trim();

      // A file that was cut off by the length limit is incomplete: ask once for just that file again
      const blocks = parseFileBlocks(response, result.truncated);
      const saved = new Set(blocks.files.map(f => f.path));
      const toRepair = Array.from(new Set(blocks.unclosed)).filter(path => !saved.has(path) && !PLACEHOLDER_FILENAMES.has(path.toLowerCase()));
      for (const path of toRepair.slice(0, OFFICE_CONFIG.MAX_FILE_REPAIRS)) {
        try {
          const repair = await runModel({
            provider: worker.api,
            model: worker.model,
            systemPrompt,
            history: [{ role: 'user', content: prompt }, { role: 'assistant', content: result.response }],
            signal,
            prompt: `Your response was cut off in the middle of the file "${path}", so it could not be saved. Send that one file again, complete, in exactly this format and with nothing else:\n[FILE: ${path}]\nfile contents\n[/FILE]`,
          });
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

      if (namesProject) await projectReady(response.match(/\[PROJECT:\s*([^\]\n]+)\]/i)?.[1] || '');

      for (const block of blocks.files) {
        try {
          await saveFile(block.path, block.content);
        } catch (e) {
          // An echoed format example is not a problem worth reporting
          if (!/placeholder/.test(errorMessage(e))) problems.push(`${block.path}: ${errorMessage(e)}`);
        }
      }

      if (result.truncated) problems.push('The response reached the length limit and may be incomplete.');

      // [ASSIGN: id | Short title] description [/ASSIGN] — the title is optional
      const regex = /\[ASSIGN:\s*([a-zA-Z0-9_-]+)\s*(?:\|\s*([^\]\n]*?))?\s*\]([\s\S]*?)\[\/ASSIGN\]/gi;
      let match;
      while ((match = regex.exec(response)) !== null) {
        requested.push({ targetId: match[1], title: match[2]?.trim() || undefined, description: match[3].trim() });
      }
    };

    if (hasRealModel(worker.api) && !withoutTools.has(modelKey)) {
      try {
        await workWithTools();
      } catch (e) {
        if (!(e instanceof ToolsUnsupportedError)) throw e;
        // Remembered, so the next task of this model goes straight to the tag format
        withoutTools.add(modelKey);
        await workWithTags();
      }
    } else {
      await workWithTags();
    }

    if (tokens) store.addAgentTokens(agent.id, tokens);

    // Halted while the model was working: discard the result
    if (wasCancelled()) return;

    // A task assigned by the user always ends up with a project, where its report goes
    if (isRoot && !question) await projectReady();

    // One commit per task, in the agent's name: the project's history, and what "undo" takes back
    let commit: string | undefined;
    if (changed && slug) {
      try {
        commit = await commitProject(slug, `${commitTitle(task)}\n\nTask ${task.id}, by ${agent.name} (${agent.role})`, authorFor(agent.name));
      } catch (e) {
        problems.push(`History: the files were saved but could not be committed (${errorMessage(e)}).`);
      }
    }

    const usage = {
      // A task that was sent back keeps what its first attempt used
      tokens: (task.tokens || 0) + tokens,
      cachedTokens: (task.cachedTokens || 0) + cachedTokens || undefined,
      cost: addCost(task.tokens ? task.cost : 0, cost),
      model,
      files: writtenFiles.length > 0 ? writtenFiles : undefined,
      commit,
    };

    // The agent needs something from the user before it can go on: park the task until it is answered
    if (question) {
      store.updateTask(task.id, { status: 'WAITING_FOR_INPUT', question, response, ...usage });
      store.pushEvent(`${agent.name} has a question for you.`, 'question');
      return;
    }

    // Work with a file missing is not done. What was written stays (and is in the history),
    // so a retry carries on from it instead of starting over.
    if (lostFiles.length > 0) {
      store.updateTask(task.id, {
        status: 'FAILED',
        error: `${lostFiles.length} file${lostFiles.length > 1 ? 's were' : ' was'} cut off and could not be saved: ${lostFiles.join(', ')}. ` +
          `${writtenFiles.length ? `The other ${writtenFiles.length} were saved. ` : ''}Retry to have the rest written.`,
        ...usage,
      });
      store.pushEvent(`${agent.name}'s task is incomplete: ${lostFiles.length} file${lostFiles.length > 1 ? 's' : ''} could not be saved.`, 'failed');
      return;
    }

    // Delegations start now, after the files are saved, so that work begins from the current project
    if (canDelegate && requested.length > 0) {
      const currentAgents = store.getState();
      const knownPrompts = getTree(rootTask.id, indexTasks(currentAgents)).map(ref => ref.task.prompt);
      const assignments: { target: Agent; title: string; description: string; violation: string }[] = [];

      for (const request of requested) {
        const isDuplicate = (other: string) => similarity(other, request.description) > DUPLICATE_SIMILARITY;
        const targetAgent = currentAgents.find(a => a.id === request.targetId);
        // The same assignment repeated within one response is simply dropped
        if (!targetAgent || !request.description || assignments.some(a => isDuplicate(a.description))) continue;

        // Apply Guardrails
        let violation = '';
        if (assignments.length >= OFFICE_CONFIG.MAX_SUBTASKS_PER_TASK) violation = `Max subtasks ${OFFICE_CONFIG.MAX_SUBTASKS_PER_TASK} reached.`;
        else if (overBudget(cost || 0)) violation = budgetNote(cost || 0);
        else if (rankOf(roles, targetAgent.role) <= rankOf(roles, agent.role)) violation = `Cannot delegate to equal or higher rank (${targetAgent.role}).`;
        else if (knownPrompts.some(isDuplicate)) violation = `Duplicate task detected.`;

        assignments.push({ target: targetAgent, title: request.title || titleFromDescription(request.description), description: request.description, violation });
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
      store.pushEvent(`${agent.name}: ${problems.length} problem${problems.length > 1 ? 's' : ''} with this task — see the task details.`);
    }

    store.updateTask(task.id, {
      status: 'COMPLETED',
      completedAt: Date.now(),
      response,
      summary,
      ...usage,
      question: undefined,
      reviewStatus: undefined,
      reviewNote: problems.length > 0 ? problems.join('\n') : undefined
    });
  } catch (e) {
    if (wasCancelled()) return;

    const message: string = errorMessage(e) || 'Unknown error';
    const isRateLimit = message.toLowerCase().includes('429') || message.toLowerCase().includes('rate limit');
    store.updateTask(task.id, { status: 'FAILED', error: message });
    store.pushEvent(`Task for ${agent.name} failed.${isRateLimit ? ' (Rate limit hit — pausing this employee for a minute)' : ''}`, 'failed');

    // Do not hammer a provider that just asked us to slow down
    if (isRateLimit) engine.cooldown.set(agent.id, Date.now() + RATE_LIMIT_COOLDOWN_MS);
  } finally {
    // Time the model spent on it, over every attempt
    if (store.getTask(task.id)) store.updateTask(task.id, { durationMs: (task.durationMs || 0) + (Date.now() - startedAt) });
    finish(task.id, agent.id);
  }
};
