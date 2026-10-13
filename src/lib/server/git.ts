import fs from 'fs';
import path from 'path';
import git from 'isomorphic-git';
import { diffLines } from 'diff';
import { projectExists, projectPath, staysInside } from './workspace';

/**
 * Every project folder is a git repository, written with a JavaScript git implementation
 * (no `git` program is needed or run). Each finished task becomes one commit by the agent
 * that did it, which gives the project a history, a diff per task, and a way to undo one.
 */

const OFFICE_AUTHOR = { name: 'Office', email: 'office@deskforce.local' };
const IGNORED = /(^|\/)(node_modules|\.dart_tool|build|\.idea|\.gradle|\.DS_Store|\.scaffolded)(\/|$)/;
const MAX_HISTORY = 200;
/** Files larger than this are listed in a diff without their contents. */
const MAX_DIFF_BYTES = 200_000;
const MAX_DIFF_LINES = 1500;
const CONTEXT_LINES = 3;

export interface Author {
  name: string;
  email: string;
}

export interface Commit {
  id: string;
  message: string;
  author: string;
  time: number;
}

export interface DiffLine {
  type: 'context' | 'add' | 'remove' | 'gap';
  text: string;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  /** Empty for binary or very large files. */
  lines: DiffLine[];
}

/** An email address for an employee, so their commits are attributed to them. */
export const authorFor = (name: string): Author => ({
  name,
  email: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '') || 'agent'}@deskforce.local`,
});

// One writer per repository at a time
const queues = new Map<string, Promise<unknown>>();
const exclusive = <T>(project: string, work: () => Promise<T>): Promise<T> => {
  const run = (queues.get(project) || Promise.resolve()).catch(() => undefined).then(work);
  queues.set(project, run);
  return run;
};

const isRepository = (dir: string) => fs.existsSync(path.join(dir, '.git'));

/** Stages everything that changed and commits it. Returns the commit id, or undefined when nothing changed. */
const commitAll = async (dir: string, message: string, author: Author) => {
  if (!isRepository(dir)) await git.init({ fs, dir, defaultBranch: 'main' });

  const matrix = await git.statusMatrix({ fs, dir, filter: file => !IGNORED.test(file) });
  const changed = matrix.filter(([, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1));
  if (changed.length === 0) return undefined;

  for (const [filepath, , workdir] of changed) {
    if (workdir === 0) await git.remove({ fs, dir, filepath });
    else await git.add({ fs, dir, filepath });
  }
  return git.commit({ fs, dir, message, author });
};

/** Records the project's current files as one commit. Safe to call when nothing changed. */
export const commitProject = (project: string, message: string, author: Author = OFFICE_AUTHOR) =>
  exclusive(project, async () => {
    if (!projectExists(project)) return undefined;
    return commitAll(projectPath(project), message, author);
  });

/** Newest first. Empty for a project without history. */
export const projectHistory = async (project: string): Promise<Commit[]> => {
  const dir = projectPath(project);
  if (!isRepository(dir)) return [];
  try {
    const log = await git.log({ fs, dir, depth: MAX_HISTORY });
    return log.map(entry => ({
      id: entry.oid,
      message: entry.commit.message.trim(),
      author: entry.commit.author.name,
      time: entry.commit.author.timestamp * 1000,
    }));
  } catch {
    // a repository with no commit yet
    return [];
  }
};

type Blob = Uint8Array | undefined;

/** Files that differ between a commit and its parent, with both versions. */
const changedBlobs = async (dir: string, commitId: string) => {
  const { commit } = await git.readCommit({ fs, dir, oid: commitId });
  const parent = commit.parent[0];
  const changes: { path: string; before: Blob; after: Blob }[] = [];

  await git.walk({
    fs,
    dir,
    trees: parent ? [git.TREE({ ref: parent }), git.TREE({ ref: commitId })] : [git.TREE({ ref: commitId })],
    map: async (filepath, entries) => {
      if (filepath === '.') return;
      const [first, second] = entries as (typeof entries[number] | undefined)[];
      const before = parent ? first : undefined;
      const after = parent ? second : first;
      if ((await before?.type()) === 'tree' || (await after?.type()) === 'tree') return;
      if ((await before?.oid()) === (await after?.oid())) return;
      changes.push({
        path: filepath,
        before: (await before?.content()) || undefined,
        after: (await after?.content()) || undefined,
      });
    },
  });

  return { message: commit.message.trim(), changes: changes.sort((a, b) => a.path.localeCompare(b.path)) };
};

const isText = (blob: Blob) => !blob || (blob.length <= MAX_DIFF_BYTES && !blob.includes(0));
const decode = (blob: Blob) => (blob ? Buffer.from(blob).toString('utf-8') : '');

/** Changed lines with a little context around them; long unchanged stretches collapse into a gap. */
const lineDiff = (before: string, after: string) => {
  const all: DiffLine[] = [];
  for (const part of diffLines(before, after)) {
    const type: DiffLine['type'] = part.added ? 'add' : part.removed ? 'remove' : 'context';
    const texts = part.value.split('\n');
    if (texts[texts.length - 1] === '') texts.pop();
    for (const text of texts) all.push({ type, text });
  }

  const keep = new Array<boolean>(all.length).fill(false);
  all.forEach((line, index) => {
    if (line.type === 'context') return;
    for (let i = Math.max(0, index - CONTEXT_LINES); i <= Math.min(all.length - 1, index + CONTEXT_LINES); i++) keep[i] = true;
  });

  const lines: DiffLine[] = [];
  let skipped = 0;
  all.forEach((line, index) => {
    if (!keep[index]) {
      skipped += 1;
      return;
    }
    if (skipped > 0) lines.push({ type: 'gap', text: `${skipped} unchanged line${skipped > 1 ? 's' : ''}` });
    skipped = 0;
    lines.push(line);
  });

  return {
    lines: lines.slice(0, MAX_DIFF_LINES),
    additions: all.filter(l => l.type === 'add').length,
    deletions: all.filter(l => l.type === 'remove').length,
  };
};

/** What one commit changed, file by file. */
export const commitChanges = async (project: string, commitId: string): Promise<{ message: string; files: FileChange[] }> => {
  const { message, changes } = await changedBlobs(projectPath(project), commitId);
  return {
    message,
    files: changes.map(({ path: file, before, after }) => {
      const status: FileChange['status'] = !before ? 'added' : !after ? 'deleted' : 'modified';
      if (!isText(before) || !isText(after)) return { path: file, status, additions: 0, deletions: 0, lines: [] };
      return { path: file, status, ...lineDiff(decode(before), decode(after)) };
    }),
  };
};

/**
 * Takes back what one commit did: each file it touched goes back to how it was before.
 * A file that was changed again afterwards is left alone, so later work is never lost.
 */
export const undoCommit = (project: string, commitId: string) =>
  exclusive(project, async () => {
    const dir = projectPath(project);
    const { message, changes } = await changedBlobs(dir, commitId);
    const restored: string[] = [];
    const skipped: string[] = [];

    for (const { path: file, before, after } of changes) {
      const full = path.resolve(dir, file);
      if (!full.startsWith(dir + path.sep) || !staysInside(dir, full)) continue;

      const current: Blob = fs.existsSync(full) ? fs.readFileSync(full) : undefined;
      const untouched = current && after ? Buffer.compare(Buffer.from(current), Buffer.from(after)) === 0 : !current && !after;
      if (!untouched) {
        skipped.push(file);
        continue;
      }

      if (before) {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, Buffer.from(before));
      } else {
        fs.rmSync(full, { force: true });
      }
      restored.push(file);
    }

    const commit = restored.length > 0 ? await commitAll(dir, `Undo: ${message.split('\n')[0]}`, OFFICE_AUTHOR) : undefined;
    return { restored, skipped, commit };
  });
