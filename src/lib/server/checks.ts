import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { DATA_DIR } from './paths';
import { listProjectFiles, projectPath, readProjectFile } from './workspace';
import { getSetting } from './settings';

/**
 * Optional checks of a project's files, off unless the user turns them on in the settings.
 *
 * Syntax checks only read the files. Tests run code that a model wrote, on this computer.
 * The commands are fixed here (never taken from a model), run without the office's
 * environment (so no API keys), and on macOS inside a sandbox with no network and no
 * access to the user's private folders.
 */

const TIMEOUT_MS = 90_000;
const MAX_OUTPUT_CHARS = 6000;
const MAX_FILES_PER_CHECK = 200;

export interface CheckResult {
  /** False when there was nothing the office knows how to check. */
  ran: boolean;
  passed: boolean;
  output: string;
}

export const checksAllowed = () => getSetting('allowChecks') === 'on';

interface Step {
  label: string;
  command: string;
  args: string[];
}

const WINDOWS = process.platform === 'win32';
/** Windows installs Python under this name only. */
const PYTHON = WINDOWS ? 'python' : 'python3';

const PYTHON_SYNTAX = 'import ast, sys\nbad = 0\nfor p in sys.argv[1:]:\n    try:\n        ast.parse(open(p, encoding="utf-8").read(), p)\n    except SyntaxError as e:\n        bad = 1\n        print(f"{p}:{e.lineno}: {e.msg}")\nsys.exit(bad)';

/** The checks that apply to a project, decided from the kinds of files in it. */
const stepsFor = (files: string[]): Step[] => {
  const steps: Step[] = [];
  const pick = (pattern: RegExp) => files.filter(f => pattern.test(f)).slice(0, MAX_FILES_PER_CHECK);

  const python = pick(/\.py$/);
  if (python.length) {
    steps.push({ label: 'Python syntax', command: PYTHON, args: ['-c', PYTHON_SYNTAX, ...python] });
    if (python.some(f => /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(f))) {
      steps.push({ label: 'Python tests (unittest)', command: PYTHON, args: ['-B', '-m', 'unittest', 'discover', '-q'] });
    }
  }

  const scripts = pick(/\.(js|mjs|cjs)$/);
  for (const file of scripts) steps.push({ label: `JavaScript syntax: ${file}`, command: 'node', args: ['--check', file] });
  if (scripts.some(f => /\.test\.(js|mjs|cjs)$/.test(f) || /^tests?\//.test(f))) {
    steps.push({ label: 'JavaScript tests (node --test)', command: 'node', args: ['--test'] });
  }

  if (files.some(f => /\.dart$/.test(f))) {
    steps.push({ label: 'Dart syntax', command: 'dart', args: ['format', '--output=none', '.'] });
  }

  return steps;
};

/** A macOS sandbox profile: no network, writing only inside the project, no reading of private folders. */
const sandboxProfile = (projectDir: string) => {
  const home = os.homedir();
  const quote = (p: string) => `"${p.replace(/(["\\])/g, '\\$1')}"`;
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  const privateFolders = ['.ssh', '.aws', '.gnupg', '.config', '.netrc', '.npmrc', '.docker', '.kube', 'Documents', 'Desktop', 'Downloads', 'Pictures', 'Library/Keychains', 'Library/Application Support', 'Library/Mail', 'Library/Messages', 'Library/Cookies']
    .map(name => `(subpath ${quote(`${home}/${name}`)})`).join(' ');
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny file-write*)',
    `(allow file-write* (subpath ${quote(real(projectDir))}) (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/dev"))`,
    // The office's own data (database with API keys, other projects) and the user's private folders
    `(deny file-read* ${privateFolders} (subpath ${quote(real(DATA_DIR))}))`,
    `(allow file-read* (subpath ${quote(real(projectDir))}))`,
  ].join('\n');
};

const SANDBOX = '/usr/bin/sandbox-exec';
const sandboxed = () => process.platform === 'darwin' && fs.existsSync(SANDBOX);

const run = (step: Step, cwd: string) =>
  new Promise<{ ok: boolean; missing: boolean; output: string }>(resolve => {
    const useSandbox = sandboxed();
    const command = useSandbox ? SANDBOX : step.command;
    const args = useSandbox ? ['-p', sandboxProfile(cwd), step.command, ...step.args] : step.args;

    execFile(command, args, {
      cwd,
      timeout: TIMEOUT_MS,
      maxBuffer: 2_000_000,
      // A fresh environment: nothing from the office (API keys, settings) reaches the project's code
      env: {
        PATH: WINDOWS ? process.env.PATH || '' : `${process.env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
        // Windows programs do not start without it
        ...(WINDOWS && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: os.homedir(),
        LANG: 'en_US.UTF-8',
        TMPDIR: os.tmpdir(),
        PYTHONDONTWRITEBYTECODE: '1',
        CI: '1',
        NO_COLOR: '1',
      } as unknown as NodeJS.ProcessEnv,
    }, (error, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim();
      const code = (error as NodeJS.ErrnoException | null)?.code;
      // The tool itself is not installed: nothing to conclude about the project
      const missing = code === 'ENOENT' || (useSandbox && /No such file or directory|execvp\(\) of/.test(output) && /sandbox-exec/.test(output));
      if (error && (error as { killed?: boolean }).killed) return resolve({ ok: false, missing: false, output: `${output}\n(stopped after ${TIMEOUT_MS / 1000} seconds)`.trim() });
      resolve({ ok: !error, missing, output });
    });
  });

/** Runs every check that applies to the project and reports what passed and what failed. */
export const runChecks = async (project: string): Promise<CheckResult> => {
  const dir = projectPath(project);
  const files = listProjectFiles(project);
  const lines: string[] = [];
  let ran = false;
  let passed = true;

  // JSON is checked right here: it only needs reading
  for (const file of files.filter(f => f.endsWith('.json')).slice(0, MAX_FILES_PER_CHECK)) {
    const data = readProjectFile(project, file)?.data.toString('utf-8') ?? '';
    ran = true;
    try {
      JSON.parse(data);
    } catch (e: any) {
      passed = false;
      lines.push(`✗ JSON syntax: ${file}\n${e.message}`);
    }
  }

  const syntaxOk: string[] = [];
  for (const step of stepsFor(files)) {
    const result = await run(step, dir);
    if (result.missing) {
      lines.push(`– ${step.label}: skipped, "${step.command}" is not installed on this computer.`);
      continue;
    }
    ran = true;
    if (result.ok) {
      // Keep one line per kind of syntax check instead of one per file
      if (step.label.startsWith('JavaScript syntax')) syntaxOk.push(step.label);
      else lines.push(`✓ ${step.label}${/tests/.test(step.label) && result.output ? `\n${result.output}` : ''}`);
    } else {
      passed = false;
      lines.push(`✗ ${step.label}\n${result.output || '(no output)'}`);
    }
  }
  if (syntaxOk.length) lines.unshift(`✓ JavaScript syntax (${syntaxOk.length} file${syntaxOk.length > 1 ? 's' : ''})`);

  if (!ran) return { ran: false, passed: true, output: 'Nothing to check: the project has no Python, JavaScript, Dart or JSON files.' };

  const header = passed ? 'All checks passed.' : 'Some checks failed.';
  const note = sandboxed() ? '' : '\n(Run without a sandbox: this system has none.)';
  const body = lines.join('\n\n');
  return { ran, passed, output: `${header}\n\n${body.length > MAX_OUTPUT_CHARS ? `${body.slice(0, MAX_OUTPUT_CHARS)}\n…` : body}${note}` };
};
