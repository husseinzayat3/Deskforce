import { Agent, TaskItem } from './types';
import { OFFICE_CONFIG, TaskRef, cleanPrompt } from './officeConfig';

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
    .replace(/\[ASSIGN:\s*[^\]]+\]([\s\S]*?)\[\/ASSIGN\]/gi, (_match, desc: string) => `(delegated: ${firstLine(desc.trim())})`)
    .replace(/\[(?:PROJECT|SCAFFOLD):[^\]\n]*\]/gi, '')
    .replace(/\[\/?SUMMARY\]/gi, '')
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
}

/**
 * Everything an agent needs to do its part without losing what the rest of the team did:
 * the client's request, the manager's plan, what colleagues already finished, and the real project files.
 */
export const buildSystemPrompt = (ctx: PromptContext) => {
  const { agent, task, rootTask, parent, tree, slug, namesProject, isReview, colleagues, existingFiles, fileContents } = ctx;
  const sections: string[] = [];

  sections.push(
    `You are ${agent.name}, the ${agent.role} of a software company. You work inside an automated office: nobody reads your message as a chat. ` +
    `Only the tags described below have any effect, so all work you produce must be saved with them.`
  );

  sections.push(namesProject
    ? `You are starting a new project. Name it by including this tag once in your response:\n[PROJECT: ${PROJECT_NAME_PLACEHOLDER}]\n` +
      `Replace ${PROJECT_NAME_PLACEHOLDER} with 2 to 4 lowercase words joined by hyphens that describe what is being built, for example voice-calculator or customer-feedback-portal. ` +
      `Name the product, not the request: no filler words such as "lets", "start", "small", "task" or "project".`
    : `Project folder: ${slug}\nAll file paths are relative to this folder. Do not prefix paths with the folder name.`
  );

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
      const title = firstLine(cleanPrompt(ref.task.prompt));
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

  sections.push(
    `How to work:\n` +
    `- Deliver finished, working output. Write every file in full: no placeholders, no "TODO", no "rest of the code here", no omitted parts.\n` +
    `- To change an existing file, write the whole file again with your change applied and everything else kept. Never drop work a colleague already did.\n` +
    `- Stay consistent with the existing files: same names, imports and structure.\n` +
    `- Code or text that appears in your message outside a [FILE] tag is lost.`
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
      `- Do the planning and any shared setup yourself first, including [SCAFFOLD] when the project needs a skeleton.\n` +
      `- If the work is small, do it yourself instead of delegating.\n` +
      `- At most ${OFFICE_CONFIG.MAX_SUBTASKS_PER_TASK} assignments, each one different.\n` +
      `- Each assignment must stand on its own: say exactly which files to create or change and what "done" means. Your colleague sees your message, the client's request and the project files, nothing else.\n` +
      `- Give different colleagues different files, so they do not overwrite each other.\n` +
      `- Do not create assignments that only review, research or test without producing files. A final review of the whole project happens automatically.\n\n` +
      `Append your assignments at the end of your message in this EXACT format:\n[ASSIGN: their_id] task description [/ASSIGN]`
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

  if (!isReview) {
    sections.push(
      `If the project needs a Flutter or Node skeleton and does not have one yet (no pubspec.yaml or package.json in the file list), include one of these tags once. ` +
      `The skeleton is created before your files are written:\n[SCAFFOLD: flutter] or [SCAFFOLD: node]`
    );
  }

  sections.push(
    `End your response with a summary in this EXACT format (2 to 4 sentences: what you did, which files you wrote, anything still open):\n[SUMMARY] your summary [/SUMMARY]`
  );

  return sections.join('\n\n');
};
