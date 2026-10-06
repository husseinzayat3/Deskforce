import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const WORKSPACE_DIR = path.join(process.cwd(), 'workspace');
const PROJECTS_DIR = path.join(WORKSPACE_DIR, 'projects');
const IGNORED_DIRS = new Set(['.dart_tool', 'build', 'node_modules', '.git', '.idea', 'ios', 'android', 'macos', 'linux', 'windows', 'web', '.gradle']);

/** Project folder names are generated client-side but re-validated here. */
const safeProject = (project: unknown): string | null => {
  if (typeof project !== 'string') return null;
  return /^[a-z0-9][a-z0-9-]{0,60}$/.test(project) ? project : null;
};

/**
 * Resolve a relative path inside the project dir.
 * Rejects absolute paths and anything that escapes the sandbox.
 */
const resolveInside = (baseDir: string, relPath: string): string | null => {
  const cleaned = relPath.trim().replace(/^[`'"]+|[`'"]+$/g, '').replace(/\\/g, '/').replace(/^\.?\/+/, '');
  if (!cleaned || path.isAbsolute(cleaned) || cleaned.split('/').includes('..')) return null;
  const full = path.resolve(baseDir, cleaned);
  return full.startsWith(baseDir + path.sep) ? full : null;
};

/** LLMs often wrap file bodies in markdown code fences — strip them. */
const stripFences = (content: string) => {
  const trimmed = content.replace(/^\s*\n/, '').replace(/\s+$/, '');
  const fenced = trimmed.match(/^```[\w+-]*\s*\n([\s\S]*?)\n```$/);
  return (fenced ? fenced[1] : trimmed) + '\n';
};

const listFiles = (dir: string, base = dir, out: string[] = []): string[] => {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) listFiles(full, base, out);
    } else {
      out.push(path.relative(base, full));
    }
  }
  return out.sort();
};

/** GET /api/workspace?project=slug  → list of files in the project */
export async function GET(req: NextRequest) {
  const project = safeProject(new URL(req.url).searchParams.get('project'));
  if (!project) return NextResponse.json({ error: 'Invalid project' }, { status: 400 });
  const projectDir = path.join(PROJECTS_DIR, project);
  return NextResponse.json({ project, path: projectDir, files: listFiles(projectDir) });
}

/**
 * POST /api/workspace
 *  { action: 'write', project, filename, content }
 *  { action: 'scaffold', project, kind: 'flutter' | 'node' }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const project = safeProject(body.project);
    if (!project) return NextResponse.json({ error: 'Invalid project' }, { status: 400 });

    const projectDir = path.join(PROJECTS_DIR, project);
    fs.mkdirSync(projectDir, { recursive: true });

    if (body.action === 'scaffold') {
      return await scaffold(projectDir, project, body.kind);
    }

    const { filename, content } = body;
    if (!filename || typeof content !== 'string') {
      return NextResponse.json({ error: 'Missing filename or content' }, { status: 400 });
    }

    const filePath = resolveInside(projectDir, filename);
    if (!filePath) return NextResponse.json({ error: `Unsafe path: ${filename}` }, { status: 400 });

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, stripFences(content), 'utf-8');

    return NextResponse.json({ success: true, path: path.relative(projectDir, filePath) });
  } catch (error: any) {
    console.error('Workspace API Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * Whitelisted project generators. Agents can only pick a `kind`;
 * the command and arguments are fixed here, never taken from model output.
 */
const scaffoldLocks = new Map<string, Promise<unknown>>();

async function scaffold(projectDir: string, project: string, kind: string) {
  const inFlight = scaffoldLocks.get(project);
  if (inFlight) await inFlight.catch(() => undefined);

  const marker = path.join(projectDir, '.scaffolded');
  if (fs.existsSync(marker)) {
    return NextResponse.json({ success: true, skipped: true, message: 'Project already scaffolded' });
  }

  const run = doScaffold(projectDir, project, kind, marker);
  scaffoldLocks.set(project, run);
  try {
    return await run;
  } finally {
    scaffoldLocks.delete(project);
  }
}

async function doScaffold(projectDir: string, project: string, kind: string, marker: string) {
  try {
    if (kind === 'flutter') {
      const packageName = project.replace(/-[a-z0-9]{4}$/, '').replace(/-/g, '_').replace(/^[^a-z]+/, '') || 'app';
      await execFileAsync('flutter', ['create', '--project-name', packageName, '--org', 'com.myoffice', '.'], {
        cwd: projectDir,
        timeout: 180_000,
      });
    } else if (kind === 'node') {
      await execFileAsync('npm', ['init', '-y'], { cwd: projectDir, timeout: 60_000 });
    } else {
      return NextResponse.json({ error: `Unknown scaffold kind: ${kind}` }, { status: 400 });
    }
    fs.writeFileSync(marker, new Date().toISOString());
    return NextResponse.json({ success: true, kind });
  } catch (e: any) {
    return NextResponse.json({ error: `Scaffold failed: ${e.message}` }, { status: 500 });
  }
}
