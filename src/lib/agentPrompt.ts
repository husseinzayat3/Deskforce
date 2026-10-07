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
}

/**
 * Everything an agent needs to do its part without losing what the rest of the team did:
 * the client's request, the manager's plan, what colleagues already finished, and the real project files.
 */
export const buildSystemPrompt = (ctx: PromptContext) => {
  const { agent, task, rootTask, parent, tree, slug, namesProject, isReview, colleagues, existingFiles, fileContents, projectHistory, roleInstructions, canAsk, meetingPlan } = ctx;
  const sections: string[] = [];

  sections.push(
    `You are ${agent.name}, the ${agent.role} of a software company. You work inside an automated office: nobody reads your message as a chat. ` +
    `Only the tags described below have any effect, so all work you produce must be saved with them.` +
    (roleInstructions.trim() ? `\n\nYour role: ${roleInstructions.trim()}` : '')
  );

  sections.push(namesProject
    ? `You are starting a new project. Name it by including this tag once in your response:\n[PROJECT: ${PROJECT_NAME_PLACEHOLDER}]\n` +
      `Replace ${PROJECT_NAME_PLACEHOLDER} with 2 to 4 lowercase words joined by hyphens that describe what is being built, for example voice-calculator or customer-feedback-portal. ` +
      `Name the product, not the request: no filler words such as "lets", "start", "small", "task" or "project".`
    : `Project folder: ${slug}\nAll file paths are relative to this folder. Do not prefix paths with the folder name.`
  );

  if (projectHistory.length > 0) {
    const earlier = projectHistory.map(item => `- Request: ${clip(firstLine(item.request), OFFICE_CONFIG.SUMMARY_CHARS)}\n  Outcome: ${clip(item.outcome, OFFICE_CONFIG.SUMMARY_CHARS)}`);
    sections.push(`This project already exists. The current request continues it: build on what is there, do not start over.\nEarlier work on this project:\n${earlier.join('\n')}`);
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
    const budget = isReview ? OFFICE_CONFIG.REVIEW_FILE_CONTEXT_CHARS : OFFICE_CONFIG.FILE_CONTEXT_CHARS;
    const shown = selectFileContents(fileContents, task.prompt, budget);
    sections.push(
      `Files that exist in the project right now:\n${listed}` +
      (shown.length > 0 ? `\n\nTheir current contents (this is the real state of the project, including your colleagues' work):\n${shown.join('\n\n')}` : '')
    );
  } else if (!namesProject) {
    sections.push('The project folder is empty so far.');
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

  sections.push(
    `How to work:\n` +
    `- Deliver finished, working output. Write every file in full: no placeholders, no "TODO", no "rest of the code here", no omitted parts.\n` +
    `- To change an existing file, write the whole file again with your change applied and everything else kept. Never drop work a colleague already did.\n` +
    `- Stay consistent with the existing files: same names, imports and structure.\n` +
    `- Code or text that appears in your message outside a [FILE] tag is lost.\n` +
    `- Nothing is run for you: there is no project generator, package manager, compiler or test runner. Write every file the project needs yourself, including its configuration files (for example pubspec.yaml or package.json), and never ask anyone to run a command.`
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
