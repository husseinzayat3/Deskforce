import { Agent, TaskItem } from './types';
import { OFFICE_CONFIG, TaskRef, cleanPrompt, taskTitle } from './officeConfig';

export const FILE_PATH_PLACEHOLDER = 'relative/path/to/file';
export const PROJECT_NAME_PLACEHOLDER = 'short-name';

/** Prompt of the automatic final-review task; the detailed instructions are in its system prompt. */
export const REVIEW_TASK_PROMPT = 'Final review: check that the project fully delivers the original request, and complete or fix anything that is missing.';

const firstLine = (text: string) => text.split('\n')[0].trim();
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);

/**
 * A response as prose: file bodies and control tags removed.
 * Used wherever one agent's message is shown to another agent or put in a report.
 */
export const stripTags = (response: string) =>
  response
    .replace(/\[FILE:\s*([^\]\n]+?)\s*\][\s\S]*?\[\/FILE\]/gi, '(saved file: $1)')
    .replace(/\[ASSIGN:\s*[^\]|]+(?:\|\s*([^\]\n]*))?\]([\s\S]*?)\[\/ASSIGN\]/gi, (_match, title: string | undefined, desc: string) => `(delegated: ${title?.trim() || firstLine(desc.trim())})`)
    .replace(/\[(?:PROJECT|SCAFFOLD):[^\]\n]*\]/gi, '')
    .replace(/\[\/?(?:SUMMARY|QUESTION|PLAN)\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** Picks which file contents fit in the prompt: files the task mentions first, then the rest. */
const selectFileContents = (contents: Record<string, string>, taskText: string, budget: number) => {
  const text = taskText.toLowerCase();
  const mentioned = (file: string) => text.includes(file.toLowerCase()) || text.includes(file.split('/').pop()!.toLowerCase());
  const ordered = Object.keys(contents).sort((a, b) => Number(mentioned(b)) - Number(mentioned(a)) || a.localeCompare(b));

  const shown: string[] = [];
  let used = 0;
  for (const file of ordered) {
    const body = contents[file];
    if (body.length > OFFICE_CONFIG.MAX_FILE_CHARS || used + body.length > budget) continue;
    shown.push(`--- ${file} ---\n${body.trimEnd()}`);
    used += body.length;
  }
  return shown;
};

export interface PromptContext {
  agent: Agent;
  task: TaskItem;
  rootTask: TaskItem;
  /** Task this one was delegated from, if any. */
  parent?: TaskRef;
  /** Every task of the same project, including this one. */
  tree: TaskRef[];
  /** Project folder; empty while the project is still unnamed. */
  slug: string;
  namesProject: boolean;
  isReview: boolean;
  /** Colleagues this agent may delegate to. Empty when it may not delegate. */
  colleagues: Agent[];
  existingFiles: string[];
  fileContents: Record<string, string>;
  /** Earlier requests on the same project and how they ended, oldest first. */
  projectHistory: { request: string; outcome: string }[];
  /** What this employee's role is responsible for. */
  roleInstructions: string;
  /** Whether the agent may stop and ask the user a question. */
  canAsk: boolean;
  /** Plan agreed in a meeting about this piece of work, if one was held. */
  meetingPlan?: string;
  /** 'tools': the model works by calling functions. 'tags': it writes everything into one tagged message. */
  mode: 'tools' | 'tags';
  /** Whether the agent can search the web and read pages (tools mode only). */
  webAccess: boolean;
  /** Whether the agent can run the project's checks (tools mode only). */
  canRunChecks: boolean;
  /** Files the client gave with the request, as paths inside the project. */
  attachments: string[];
  /** The company handbook, and notes colleagues saved during earlier projects. */
  handbook: string;
  notes: string[];
  /** The manager who assigned this task can be asked questions (tools mode only). */
  canAskManager: boolean;
  /** This is a manager looking at what the team delivered. */
  isFollowUp: boolean;
  /** 'plan': only write the plan for the client to approve; nothing is carried out yet. */
  phase?: 'plan';
}

/** File contents shown up front in tools mode; anything else is read on demand. */
const TOOLS_FILE_CONTEXT_CHARS = 6000;

/**
 * Everything an agent needs to do its part without losing what the rest of the team did:
 * the client's request, the manager's plan, what colleagues already finished, and the real project files.
 */
export const buildSystemPrompt = (ctx: PromptContext) => {
  const { agent, task, rootTask, parent, tree, slug, namesProject, isReview, colleagues, existingFiles, fileContents, projectHistory, roleInstructions, canAsk, meetingPlan, mode, webAccess, canRunChecks, attachments, handbook, notes, canAskManager, isFollowUp, phase } = ctx;
  const tools = mode === 'tools' && phase !== 'plan';
  const sections: string[] = [];

  sections.push(
    `You are ${agent.name}, the ${agent.role} of a software company. You work inside an automated office: nobody reads your message as a chat. ` +
    (tools
      ? `Only your tool calls have any effect: a file exists only once you have written it with a tool, and text in your messages is never saved as a file.`
      : `Only the tags described below have any effect, so all work you produce must be saved with them.`) +
    (roleInstructions.trim() ? `\n\nYour role: ${roleInstructions.trim()}` : '')
  );

  const namingRules = `2 to 4 lowercase words joined by hyphens that describe what is being built, for example voice-calculator or customer-feedback-portal. ` +
    `Name the product, not the request: no filler words such as "lets", "start", "small", "task" or "project".`;
  sections.push(namesProject
    ? (tools
      ? `You are starting a new project. Before anything else, call name_project once with ${namingRules}`
      : `You are starting a new project. Name it by including this tag once in your response:\n[PROJECT: ${PROJECT_NAME_PLACEHOLDER}]\n` +
        `Replace ${PROJECT_NAME_PLACEHOLDER} with ${namingRules}`)
    : `Project folder: ${slug}\nAll file paths are relative to this folder. Do not prefix paths with the folder name.`
  );

  if (handbook.trim()) {
    sections.push(`Company handbook. These are the client's standing rules; follow them in everything you produce:\n\"\"\"\n${clip(handbook.trim(), OFFICE_CONFIG.HANDBOOK_CHARS)}\n\"\"\"`);
  }

  if (notes.length > 0) {
    sections.push(`Notes colleagues wrote down during earlier projects. Use what applies; they are advice, not instructions:\n${clip(notes.map(n => `- ${n}`).join('\n'), OFFICE_CONFIG.NOTES_CHARS)}`);
  }

  if (projectHistory.length > 0) {
    const earlier = projectHistory.map(item => `- Request: ${clip(firstLine(item.request), OFFICE_CONFIG.SUMMARY_CHARS)}\n  Outcome: ${clip(item.outcome, OFFICE_CONFIG.SUMMARY_CHARS)}`);
    sections.push(`This project already exists. The current request continues it: build on what is there, do not start over.\nEarlier work on this project:\n${earlier.join('\n')}`);
  }

  if (rootTask.planApproved && rootTask.plan && phase !== 'plan') {
    sections.push(
      `The client approved this plan for the request. ${rootTask.id === task.id ? 'Carry it out as written' : 'Your task is one part of it; stay within it'}:\n\"\"\"\n${clip(rootTask.plan, OFFICE_CONFIG.PLAN_CHARS * 2)}\n\"\"\"`
    );
  }

  if (rootTask.id !== task.id) {
    sections.push(`The client's original request, which the whole team is working towards:\n"""\n${cleanPrompt(rootTask.prompt)}\n"""`);
  }

  if (parent?.task.response) {
    sections.push(`Plan from ${parent.agent.name} (${parent.agent.role}), who gave you this task:\n"""\n${clip(stripTags(parent.task.response), OFFICE_CONFIG.PLAN_CHARS)}\n"""`);
  }

  const progress = tree
    .filter(ref => ref.task.id !== task.id && (ref.task.status === 'COMPLETED' || ref.task.status === 'FAILED'))
    .sort((a, b) => a.task.timestamp - b.task.timestamp)
    .slice(-OFFICE_CONFIG.MAX_PROGRESS_ITEMS)
    .map(ref => {
      const title = taskTitle(ref.task);
      if (ref.task.status === 'FAILED') return `- ${ref.agent.name} (${ref.agent.role}) FAILED: ${title}`;
      const summary = clip(ref.task.summary || stripTags(ref.task.response || ''), OFFICE_CONFIG.SUMMARY_CHARS);
      const files = ref.task.files?.length ? ` [files: ${ref.task.files.join(', ')}]` : ' [no files saved]';
      return `- ${ref.agent.name} (${ref.agent.role}) — ${title}\n  Result: ${summary}${files}`;
    });
  if (progress.length > 0) {
    sections.push(`What the team has finished on this project so far:\n${progress.join('\n')}`);
  }

  if (existingFiles.length > 0) {
    const listed = existingFiles.slice(0, OFFICE_CONFIG.MAX_FILES_IN_PROMPT).map(f => `- ${f}`).join('\n');
    const budget = tools ? TOOLS_FILE_CONTEXT_CHARS : isReview ? OFFICE_CONFIG.REVIEW_FILE_CONTEXT_CHARS : OFFICE_CONFIG.FILE_CONTEXT_CHARS;
    const shown = selectFileContents(fileContents, task.prompt, budget);
    const complete = shown.length === Object.keys(fileContents).length;
    sections.push(
      `Files that exist in the project right now:\n${listed}` +
      (shown.length > 0 ? `\n\n${tools && !complete ? 'Current contents of some of them' : 'Their current contents'} (this is the real state of the project, including your colleagues' work):\n${shown.join('\n\n')}` : '') +
      (tools && !complete ? `\n\nRead any other file you need with read_file before relying on it or changing it.` : '')
    );
  } else if (!namesProject) {
    sections.push('The project folder is empty so far.');
  }

  if (attachments.length > 0) {
    sections.push(`The client attached these files to the request. They are in the project folder; use them:\n${attachments.slice(0, 40).map(f => `- ${f}`).join('\n')}${attachments.length > 40 ? `\n- …and ${attachments.length - 40} more` : ''}`);
  }

  if (meetingPlan) {
    sections.push(`Before this task you met the colleagues working on the same files. This is the plan you agreed on, so keep to it:\n"""\n${meetingPlan}\n"""`);
  }

  if (task.clarifications) {
    sections.push(`You asked the client for clarification on this task. The questions and their answers:\n"""\n${task.clarifications.trim()}\n"""\nUse the answers and do the task now.`);
  }

  if (task.feedback) {
    sections.push(
      `You already did this task once and the client sent it back. Their feedback:\n"""\n${task.feedback}\n"""` +
      (task.response ? `\n\nWhat you answered last time:\n"""\n${clip(stripTags(task.response), OFFICE_CONFIG.PLAN_CHARS)}\n"""` : '') +
      `\n\nDo the task again so that it satisfies the feedback. The files from your first attempt are still in the project: change them rather than starting from nothing.`
    );
  }

  if (phase === 'plan') {
    const roster = colleagues.map(a => `- ${a.name} (Role: ${a.role}, ID: ${a.id})`).join('\n');
    if (task.plan && task.planNote) {
      sections.push(`You already proposed this plan:\n\"\"\"\n${clip(task.plan, OFFICE_CONFIG.PLAN_CHARS * 2)}\n\"\"\"\nThe client did not approve it and said:\n\"\"\"\n${task.planNote}\n\"\"\"\nWrite a new plan that takes this into account.`);
    }
    sections.push(
      `Do not do any of the work yet. The client wants to see and approve a plan first, so write only the plan.\n\n` +
      (roster
        ? `You may plan to hand parts to these colleagues (at most ${OFFICE_CONFIG.MAX_SUBTASKS_PER_TASK} parts, different files for different people). Do small jobs yourself:\n${roster}\n\n`
        : `You will do all of the work yourself.\n\n`) +
      `Answer in exactly this format:\n` +
      `[PLAN]\nThe plan for the client, in plain words: what will be built, the main files, the approach, and anything you are assuming. Keep it under 200 words.\n[/PLAN]\n` +
      `Then one line for each step of the work, in the order it will be done:\n` +
      `[STEP: who | size] what is done in this step\n` +
      `"who" is the ID of the colleague doing it, or "me". "size" is S (one small file), M (a few files) or L (a large part of the project).`
    );
    return sections.join('\n\n');
  }

  if (isFollowUp) {
    sections.push(
      `The colleagues you delegated to have finished. Their results are listed above, and the files are in the project. ` +
      `Check that their work fits together and delivers what you planned. Fix small gaps yourself. ` +
      (colleagues.length > 0 ? `If a larger piece is missing or wrong, you may delegate once more; this is the last round. ` : '') +
      `If everything is in order, change nothing and say so in your summary.`
    );
  }

  if (tools) {
    sections.push(
      `How to work:\n` +
      `- Deliver finished, working output: no placeholders, no "TODO", no omitted parts.\n` +
      `- Create a file, or replace one completely, with write_file. Change part of an existing file with edit_file, which keeps everything else as it is. Never drop work a colleague already did.\n` +
      `- Read a file before you edit it, and stay consistent with the existing files: same names, imports and structure.\n` +
      `- File naming: give every file a specific name that says what it contains, and follow the conventions and folder layout of its language or framework (for example lib/screens/calculator_screen.dart). Put documents in a docs/ folder with hyphenated names. Never use generic names such as file.txt, output.md or notes.txt.\n` +
      (canRunChecks
        ? `- You can call run_checks to check the syntax of the project's files and run its tests. Use it after writing code, and fix what it reports. There is no package manager: code may only depend on what is already installed.\n`
        : `- Nothing is run for you: there is no project generator, package manager, compiler or test runner. Write every file the project needs yourself, including its configuration files (for example pubspec.yaml or package.json), and never ask anyone to run a command.\n`) +
      (webAccess
        ? `- For anything that depends on the outside world (prices, versions, how an API works today), look it up with web_search instead of relying on memory. Never invent figures. In documents, give the source and date of facts you looked up.`
        : `- You cannot look anything up. Do not present prices, versions or other changing facts as current: mark them as needing to be checked.`)
    );

    if (isReview) {
      sections.push(
        `This is the final review of the whole project. Read the project files and compare them with the client's original request. ` +
        `If anything is missing, incomplete, inconsistent or would not run, fix it now. Leave files that are already correct untouched. ` +
        `In your summary, give the final assessment for the client: what was delivered, how to run or use it, and any known gaps.`
      );
    }

    if (colleagues.length > 0) {
      const roster = colleagues.map(a => `- ${a.name} (Role: ${a.role}, ID: ${a.id})`).join('\n');
      sections.push(
        `You can hand parts of this work to these colleagues with the delegate tool:\n${roster}\n\n` +
        `Delegation rules:\n` +
        `- Do the planning and any shared setup yourself first, such as the project's configuration files, and write them before you delegate.\n` +
        `- If the work is small, do it yourself instead of delegating.\n` +
        `- At most ${OFFICE_CONFIG.MAX_SUBTASKS_PER_TASK} assignments, each one different.\n` +
        `- Each assignment must stand on its own: say exactly which files to create or change and what "done" means. Your colleague sees your messages, the client's request and the project files, nothing else.\n` +
        `- Give different colleagues different files, so they do not overwrite each other.\n` +
        `- Do not create assignments that only review, research or test without producing files. A final review of the whole project happens automatically.\n` +
        `- Delegated work starts after you finish, so do not wait for it.`
      );
    } else {
      sections.push('You cannot delegate this task. Do all of the work yourself.');
    }

    if (canAskManager && parent) {
      sections.push(
        `If something in your assignment is unclear, or you need a decision that ${parent.agent.name} should make (naming, structure, which of two approaches), call ask_manager. ` +
        `You get the answer straight away and carry on. Prefer it to guessing, and to asking the client.`
      );
    }

    sections.push(
      `If you learn something that will matter in future projects (a convention the client asked for, a mistake to avoid, a decision that should be repeated), record it with save_note in one sentence. Only lasting lessons, not what you did in this task.`
    );

    if (canAsk) {
      sections.push(
        `If the task cannot be done properly without information that only the client has (not something you can reasonably decide yourself), call ask_client instead of guessing. ` +
        `The task then waits and comes back to you with the answer. Ask at most one question, and only when a wrong guess would waste the work. Otherwise decide, state your assumption in your summary, and carry on.`
      );
    }

    sections.push(`When the work is done, reply with a summary and no tool call (2 to 4 sentences: what you did, which files you wrote, anything still open). That reply ends the task.`);
    return sections.join('\n\n');
  }

  sections.push(
    `How to work:\n` +
    `- Deliver finished, working output. Write every file in full: no placeholders, no "TODO", no "rest of the code here", no omitted parts.\n` +
    `- To change an existing file, write the whole file again with your change applied and everything else kept. Never drop work a colleague already did.\n` +
    `- Stay consistent with the existing files: same names, imports and structure.\n` +
    `- Code or text that appears in your message outside a [FILE] tag is lost.\n` +
    `- Nothing is run for you: there is no project generator, package manager, compiler or test runner. Write every file the project needs yourself, including its configuration files (for example pubspec.yaml or package.json), and never ask anyone to run a command.\n` +
    `- You cannot look anything up. Do not present prices, versions or other changing facts as current: mark them as needing to be checked.`
  );

  if (isReview) {
    sections.push(
      `This is the final review of the whole project. Compare the project files with the client's original request. ` +
      `If anything is missing, incomplete, inconsistent or would not run, fix it now by writing the complete corrected files. Leave files that are already correct untouched. ` +
      `In your summary, give the final assessment for the client: what was delivered, how to run or use it, and any known gaps.`
    );
  }

  if (colleagues.length > 0) {
    const roster = colleagues.map(a => `- ${a.name} (Role: ${a.role}, ID: ${a.id})`).join('\n');
    sections.push(
      `You can delegate parts of this work to these colleagues:\n${roster}\n\n` +
      `Delegation rules:\n` +
      `- Do the planning and any shared setup yourself first, such as the project's configuration files.\n` +
      `- If the work is small, do it yourself instead of delegating.\n` +
      `- At most ${OFFICE_CONFIG.MAX_SUBTASKS_PER_TASK} assignments, each one different.\n` +
      `- Each assignment must stand on its own: say exactly which files to create or change and what "done" means. Your colleague sees your message, the client's request and the project files, nothing else.\n` +
      `- Give different colleagues different files, so they do not overwrite each other.\n` +
      `- Do not create assignments that only review, research or test without producing files. A final review of the whole project happens automatically.\n\n` +
      `Append your assignments at the end of your message in this EXACT format. The title is a short name for the task, 3 to 7 words, shown on the task board:\n[ASSIGN: their_id | Short title] task description [/ASSIGN]`
    );
  } else {
    sections.push('You cannot delegate this task. Do all of the work yourself.');
  }

  sections.push(
    `To create or change a file, use this EXACT format once per file. Replace the path with the file's real relative path (sub-folders are allowed, for example lib/main.dart) and put only the file's contents between the tags:\n` +
    `[FILE: ${FILE_PATH_PLACEHOLDER}]\nfile contents\n[/FILE]\n\n` +
    `File naming rules: give every file a specific name that says what it contains, and follow the conventions and folder layout of its language or framework (for example lib/screens/calculator_screen.dart). ` +
    `Put documents in a docs/ folder with hyphenated names (for example docs/architecture-overview.md). Never use generic names such as file.txt, output.md, document.txt, notes.txt or untitled. ` +
    `To update an existing file, reuse its exact path from the list above.`
  );

  if (canAsk) {
    sections.push(
      `If the task cannot be done properly without information that only the client has (not something you can reasonably decide yourself), ask instead of guessing. ` +
      `Respond with only this and nothing else, and the task will come back to you with the answer:\n[QUESTION] your question [/QUESTION]\n` +
      `Ask at most one question, and only when a wrong guess would waste the work. Otherwise decide, state your assumption in the summary, and carry on.`
    );
  }

  sections.push(
    `End your response with a summary in this EXACT format (2 to 4 sentences: what you did, which files you wrote, anything still open):\n[SUMMARY] your summary [/SUMMARY]`
  );

  return sections.join('\n\n');
};
