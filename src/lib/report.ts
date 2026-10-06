import { TaskRef, cleanPrompt, formatCost, formatUsage, projectOf, sumUsage } from './officeConfig';
import { stripTags } from './agentPrompt';

export const REPORT_FILENAME = 'REPORT.md';
export const TRANSCRIPT_FILENAME = 'docs/task-transcript.md';

const STATUS_TEXT: Record<string, string> = {
  COMPLETED: 'Done',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

const firstLine = (text: string) => text.split('\n')[0].trim();

/** The tree as a flat list in reading order (each task followed by its sub-tasks), with its depth. */
const inOrder = (root: TaskRef, tree: TaskRef[]) => {
  const ordered: { ref: TaskRef; depth: number }[] = [];
  const visit = (ref: TaskRef, depth: number) => {
    ordered.push({ ref, depth });
    tree
      .filter(child => child.task.parentId === ref.task.id)
      .sort((a, b) => a.task.timestamp - b.task.timestamp)
      .forEach(child => visit(child, depth + 1));
  };
  visit(root, 0);
  return ordered;
};

const titleOf = (ref: TaskRef) => (ref.task.kind === 'REVIEW' ? 'Final review' : firstLine(cleanPrompt(ref.task.prompt)));

/** Markdown report for a finished task tree: the outcome, who did what, what it cost, and the files delivered. */
export const buildReport = (root: TaskRef, tree: TaskRef[]) => {
  const ordered = inOrder(root, tree);
  const total = sumUsage(tree.map(ref => ref.task));
  const review = tree.find(ref => ref.task.kind === 'REVIEW' && ref.task.status === 'COMPLETED');
  const outcomeSource = review || root;
  const outcome = outcomeSource.task.summary || stripTags(outcomeSource.task.response || '') || 'No summary was provided.';
  const files = Array.from(new Set(tree.flatMap(ref => ref.task.files || []))).sort();
  const problems = ordered.filter(({ ref }) => ref.task.status === 'FAILED' || ref.task.status === 'CANCELLED' || (ref.task.status === 'COMPLETED' && ref.task.reviewNote));

  const lines: string[] = [
    `# Task report: ${projectOf(root.task)}`,
    '',
    '## Request',
    '',
    cleanPrompt(root.task.prompt),
    '',
    '## Overview',
    '',
    `- **Assigned to:** ${root.agent.name} (${root.agent.role})`,
    `- **Project folder:** workspace/projects/${projectOf(root.task)}`,
    `- **Started:** ${new Date(root.task.timestamp).toLocaleString()}`,
    `- **Report created:** ${new Date().toLocaleString()}`,
    `- **Tasks:** ${tree.length} (${tree.filter(ref => ref.task.status === 'COMPLETED').length} done, ${tree.filter(ref => ref.task.status === 'FAILED').length} failed, ${tree.filter(ref => ref.task.status === 'CANCELLED').length} cancelled)`,
    `- **Tokens used:** ${total.tokens.toLocaleString('en-US')}`,
    `- **Estimated cost:** ${formatCost(total.cost)}${total.cost === undefined ? ' (at least one model has no known price)' : ''}`,
    '',
    `## Outcome${review ? ' (final review)' : ''}`,
    '',
    outcome,
    '',
    '## Work breakdown',
    '',
  ];

  for (const { ref, depth } of ordered) {
    const { task, agent } = ref;
    const indent = '  '.repeat(depth);
    const usage = formatUsage(task.tokens, task.cost);
    lines.push(`${indent}- **${titleOf(ref)}** — ${agent.name} (${agent.role}) — ${STATUS_TEXT[task.status] || task.status}${usage ? ` — ${usage}` : ''}${task.model ? ` — ${task.model}` : ''}`);
    if (task.summary && ref !== outcomeSource) lines.push(`${indent}  ${task.summary.replace(/\s*\n\s*/g, ' ')}`);
    if (task.files?.length) lines.push(`${indent}  Files: ${task.files.join(', ')}`);
  }

  lines.push('', '## Files delivered', '');
  lines.push(...(files.length > 0 ? files.map(f => `- ${f}`) : ['No files were saved.']));

  if (problems.length > 0) {
    lines.push('', '## Problems', '');
    for (const { ref } of problems) {
      const detail = ref.task.status === 'FAILED' ? ref.task.error : ref.task.status === 'CANCELLED' ? 'Cancelled before it ran.' : ref.task.reviewNote;
      lines.push(`- **${titleOf(ref)}** (${ref.agent.name}): ${(detail || 'Unknown problem').replace(/\s*\n\s*/g, '; ')}`);
    }
  }

  lines.push('', '_Costs are estimates based on list prices per token._', '');
  return lines.join('\n');
};

/** Everything the agents wrote, task by task, with file bodies replaced by their paths. */
export const buildTranscript = (root: TaskRef, tree: TaskRef[]) => {
  const lines: string[] = [`# Task transcript: ${projectOf(root.task)}`, ''];
  for (const { ref, depth } of inOrder(root, tree)) {
    const { task, agent } = ref;
    lines.push(
      `${'#'.repeat(Math.min(depth + 2, 6))} ${titleOf(ref)}`,
      '',
      `**${agent.name} (${agent.role})** — ${STATUS_TEXT[task.status] || task.status} — assigned by ${task.assignedBy}`,
      '',
      '**Task**',
      '',
      cleanPrompt(task.prompt),
      '',
      '**Response**',
      '',
      task.status === 'FAILED' ? `Failed: ${task.error || 'unknown error'}` : stripTags(task.response || '') || '(no response)',
      ''
    );
  }
  return lines.join('\n');
};
