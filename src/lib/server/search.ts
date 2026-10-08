import fs from 'fs';
import path from 'path';
import { getDb } from '../db';
import { PROJECTS_DIR } from './paths';
import { listProjectFiles, safeProject } from './workspace';

export interface TaskHit {
  taskId: string;
  title: string;
  /** Which part of the task matched. */
  where: 'request' | 'response' | 'summary' | 'plan';
  snippet: string;
  status: string;
  project?: string;
}

export interface FileHit {
  project: string;
  path: string;
  /** 1-based line of the first match; 0 when the file name matched. */
  line: number;
  snippet: string;
  /** How many lines of the file match. */
  matches: number;
}

const MAX_TASK_HITS = 30;
const MAX_FILE_HITS = 40;
const MAX_FILE_BYTES = 400_000;
const SNIPPET_RADIUS = 60;

/** The text around a match, on one line. */
export const snippetAround = (text: string, query: string) => {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at === -1) return '';
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + query.length + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
};

const searchTasks = (query: string): TaskHit[] => {
  // LIKE treats % and _ as wildcards: escape them so the query is searched for as typed
  const like = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  const rows = getDb().prepare(`
    SELECT id, prompt, title, answer, summary, plan, status, project, parentId, kind
    FROM tasks
    WHERE prompt LIKE @like ESCAPE '\\' OR title LIKE @like ESCAPE '\\' OR answer LIKE @like ESCAPE '\\' OR summary LIKE @like ESCAPE '\\' OR plan LIKE @like ESCAPE '\\'
    ORDER BY createdAt DESC
    LIMIT ${MAX_TASK_HITS}
  `).all({ like }) as any[];

  const has = (text: string | null) => Boolean(text && text.toLowerCase().includes(query.toLowerCase()));
  return rows.map(row => {
    const request = String(row.prompt || '').replace(/^Task delegated from [^:]+:\s*/i, '');
    const [where, text]: [TaskHit['where'], string] =
      has(row.title) || has(request) ? ['request', has(request) ? request : row.title]
        : has(row.summary) ? ['summary', row.summary]
          : has(row.plan) ? ['plan', row.plan]
            : ['response', row.answer || ''];
    return {
      taskId: row.id,
      title: row.title || request.split('\n')[0].slice(0, 120) || (row.kind === 'REVIEW' ? 'Final review' : 'Task'),
      where,
      snippet: snippetAround(text, query),
      status: row.status,
      project: row.project || undefined,
    };
  });
};

const searchFiles = (query: string): FileHit[] => {
  const hits: FileHit[] = [];
  const needle = query.toLowerCase();
  if (!fs.existsSync(/* turbopackIgnore: true */ PROJECTS_DIR)) return hits;

  for (const entry of fs.readdirSync(/* turbopackIgnore: true */ PROJECTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !safeProject(entry.name)) continue;
    for (const file of listProjectFiles(entry.name)) {
      if (hits.length >= MAX_FILE_HITS) return hits;
      const full = path.join(/* turbopackIgnore: true */ PROJECTS_DIR, entry.name, file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(/* turbopackIgnore: true */ full);
      } catch {
        continue;
      }
      const nameMatches = file.toLowerCase().includes(needle);
      if (stat.size > MAX_FILE_BYTES) {
        if (nameMatches) hits.push({ project: entry.name, path: file, line: 0, snippet: 'File name', matches: 0 });
        continue;
      }
      const data = fs.readFileSync(/* turbopackIgnore: true */ full);
      const lines = data.includes(0) ? [] : data.toString('utf-8').split('\n');
      const matching = lines.map((text, index) => ({ text, index })).filter(line => line.text.toLowerCase().includes(needle));
      if (matching.length > 0) {
        hits.push({ project: entry.name, path: file, line: matching[0].index + 1, snippet: snippetAround(matching[0].text, query), matches: matching.length });
      } else if (nameMatches) {
        hits.push({ project: entry.name, path: file, line: 0, snippet: 'File name', matches: 0 });
      }
    }
  }
  return hits;
};

/** Looks for a piece of text in every task (request, plan, response, summary) and every project file. */
export const searchOffice = (query: string) => {
  const trimmed = query.trim();
  if (trimmed.length < 2) return { tasks: [], files: [] };
  return { tasks: searchTasks(trimmed), files: searchFiles(trimmed) };
};
