/**
 * Finds places where a project's files do not fit together: a page that links a file that is
 * not there, pages that ignore the project's stylesheet or that nothing links to, imports of
 * files or functions that do not exist. These are what goes wrong when several employees each
 * write part of a project, and what a model reviewing the result tends to overlook.
 *
 * It only reads text and never runs anything, so it is cheap enough to do on every review.
 */

import path from 'path';

/** The most problems reported at once; past that, the reviewer has enough to fix. */
const MAX_PROBLEMS = 20;

const isExternal = (ref: string) => /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\{\{|\$\{)/i.test(ref);

/** A reference from `file` to `ref`, resolved to a project path; null for links that leave the project. */
const resolve = (file: string, ref: string) => {
  const clean = ref.split(/[?#]/)[0].trim();
  if (!clean || isExternal(clean)) return null;
  const joined = clean.startsWith('/') ? clean.slice(1) : path.posix.join(path.posix.dirname(file), clean);
  const normal = path.posix.normalize(joined);
  return normal.startsWith('..') ? null : normal;
};

const exists = (files: Record<string, string>, target: string) =>
  target in files || target.replace(/\/$/, '') + '/index.html' in files || Object.keys(files).some(f => f.startsWith(target.replace(/\/?$/, '/')));

const htmlRefs = (html: string) => {
  const refs: { attr: string; tag: string; value: string }[] = [];
  const tag = /<(a|link|script|img|source|iframe)\b[^>]*>/gi;
  let match;
  while ((match = tag.exec(html)) !== null) {
    const attrs = match[0];
    for (const attr of ['href', 'src']) {
      const value = attrs.match(new RegExp(`\\b${attr}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1];
      if (value !== undefined) refs.push({ attr, tag: match[1].toLowerCase(), value });
    }
  }
  return refs;
};

const pythonDefinitions = (source: string) =>
  new Set(Array.from(source.matchAll(/^(?:async\s+)?(?:def|class)\s+(\w+)|^(\w+)\s*(?::[^=\n]*)?=/gm)).map(m => m[1] || m[2]));

export const findProjectProblems = (files: Record<string, string>): string[] => {
  const problems: string[] = [];
  const add = (problem: string) => problems.length < MAX_PROBLEMS && !problems.includes(problem) && problems.push(problem);

  const pages = Object.keys(files).filter(f => /\.html?$/i.test(f)).sort();
  const stylesheets = Object.keys(files).filter(f => f.endsWith('.css'));

  // Pages: links to missing files, and the project's stylesheet left unused
  const linkedPages = new Set<string>();
  for (const page of pages) {
    const html = files[page];
    let usesStylesheet = /<style[\s>]/i.test(html);
    for (const ref of htmlRefs(html)) {
      const target = resolve(page, ref.value);
      if (!target) continue;
      if (/\.html?$/i.test(target)) linkedPages.add(target);
      if (ref.tag === 'link' && /\.css$/i.test(target)) usesStylesheet = true;
      if (!exists(files, target)) add(`${page} links to ${ref.value}, which is not in the project.`);
    }
    if (!usesStylesheet && stylesheets.length > 0) {
      add(`${page} does not use any stylesheet, although the project has ${stylesheets.join(', ')}.`);
    }
  }

  // A site of several pages needs a way between them
  if (pages.length > 1) {
    const entry = pages.find(p => /(^|\/)index\.html?$/i.test(p)) || pages.find(p => /(^|\/)home\.html?$/i.test(p)) || pages[0];
    for (const page of pages) {
      if (page !== entry && !linkedPages.has(page)) add(`No page links to ${page}, so visitors cannot reach it.`);
    }
  }

  // Stylesheets: url(...) to missing files
  for (const sheet of stylesheets) {
    for (const match of files[sheet].matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
      const target = resolve(sheet, match[1]);
      if (target && !exists(files, target)) add(`${sheet} refers to ${match[1]}, which is not in the project.`);
    }
  }

  // JavaScript and TypeScript: relative imports of missing files
  for (const file of Object.keys(files).filter(f => /\.(m?js|jsx|tsx?)$/.test(f))) {
    for (const match of files[file].matchAll(/(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = resolve(file, match[1]);
      if (!target) continue;
      const candidates = [target, ...['.js', '.mjs', '.ts', '.tsx', '.jsx'].map(ext => target + ext), target + '/index.js', target + '/index.ts'];
      if (!candidates.some(c => c in files)) add(`${file} imports ${match[1]}, which is not in the project.`);
    }
  }

  // Python: names imported from the project's own modules that those modules do not define
  const pythonFiles = Object.keys(files).filter(f => f.endsWith('.py'));
  const moduleFile = (name: string) => {
    const relative = name.replace(/\./g, '/');
    return pythonFiles.find(f => f === `${relative}.py` || f === `${relative}/__init__.py` || f.endsWith(`/${relative}.py`));
  };
  for (const file of pythonFiles) {
    for (const match of files[file].matchAll(/^\s*from\s+([\w.]+)\s+import\s+\(?([\w\s,]+)\)?/gm)) {
      const source = moduleFile(match[1]);
      if (!source) continue;
      const defined = pythonDefinitions(files[source]);
      for (const name of match[2].split(',').map(n => n.trim().split(/\s+as\s+/)[0]).filter(n => /^\w+$/.test(n))) {
        if (!defined.has(name)) add(`${file} imports ${name} from ${source}, which does not define it.`);
      }
    }
  }

  // Python scripts whose entry point runs before the functions below it are defined
  for (const file of pythonFiles) {
    const source = files[file];
    const entry = source.search(/^if\s+__name__\s*==\s*["']__main__["']\s*:/m);
    if (entry < 0) continue;
    const later = Array.from(source.slice(entry).matchAll(/^(?:async\s+)?(?:def|class)\s+(\w+)/gm)).map(m => m[1]);
    if (later.length > 0) {
      add(`${file} runs its entry point (if __name__ == "__main__") before defining ${later.join(', ')}, so running it fails; move that block to the end of the file.`);
    }
  }

  return problems;
};

/** Functions and classes a file defines, for noticing when a rewrite drops some. */
export const definedNames = (file: string, source: string): Set<string> => {
  if (file.endsWith('.py')) return new Set(Array.from(source.matchAll(/^\s*(?:async\s+)?(?:def|class)\s+(\w+)/gm)).map(m => m[1]));
  if (/\.(m?js|jsx|tsx?)$/.test(file)) {
    return new Set(Array.from(source.matchAll(/(?:^|\s)(?:function\*?|class)\s+(\w+)|(?:^|\s)(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/gm)).map(m => m[1] || m[2]));
  }
  return new Set();
};

/**
 * What a model should hear when it replaced a file and the new version lost parts of the old
 * one. Empty when nothing looks lost.
 */
export const describeLostWork = (file: string, before: string, after: string): string => {
  const lost = Array.from(definedNames(file, before)).filter(name => !definedNames(file, after).has(name));
  const linesBefore = before.split('\n').length;
  const linesAfter = after.split('\n').length;
  const shrank = before.length >= 400 && after.length < before.length * 0.4;
  if (lost.length === 0 && !shrank) return '';
  return [
    `Note: this replaced the whole of ${file}.`,
    lost.length > 0 ? `The previous version defined ${lost.join(', ')}, which this version no longer has.` : '',
    shrank ? `It went from ${linesBefore} lines to ${linesAfter}.` : '',
    'If you were not asked to remove that, put it back (read_file shows the current file; edit_file changes part of it).',
  ].filter(Boolean).join(' ');
};
