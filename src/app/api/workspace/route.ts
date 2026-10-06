import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createZip, ZipEntry } from '../../../lib/zip';

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

/** Left out of a download: caches and build output that the tools regenerate. */
const DOWNLOAD_IGNORED = new Set(['.dart_tool', 'build', 'node_modules', '.git', '.idea', '.gradle', 'Pods', 'ephemeral', '.scaffolded', '.DS_Store']);

/** Generated or bookkeeping files whose contents would only waste an agent's context. */
const NO_CONTENT_FILES = new Set(['pubspec.lock', 'package-lock.json', '.gitignore', 'analysis_options.yaml', 'REPORT.md', 'docs/task-transcript.md']);
/** Larger files are listed for agents by name only. */
const MAX_CONTENT_BYTES = 20_000;

/** Text contents of the project's own files, keyed by relative path. */
const readContents = (projectDir: string, files: string[]) => {
  const contents: Record<string, string> = {};
  for (const file of files) {
    if (NO_CONTENT_FILES.has(file) || file.endsWith('.iml')) continue;
    const full = path.join(projectDir, file);
    if (fs.statSync(full).size > MAX_CONTENT_BYTES) continue;
    const data = fs.readFileSync(full);
    if (data.includes(0)) continue; // binary
    contents[file] = data.toString('utf-8');
  }
  return contents;
};

/** Every file worth downloading, including the platform folders agents do not need to see. */
const collectForDownload = (dir: string, prefix: string, out: ZipEntry[] = []): ZipEntry[] => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (DOWNLOAD_IGNORED.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const name = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) collectForDownload(full, name, out);
    else if (entry.isFile()) out.push({ name, data: fs.readFileSync(full), mode: fs.statSync(full).mode & 0o777 });
  }
  return out;
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

/**
 * GET /api/workspace?project=slug             → whether the project exists, and its files
 * GET /api/workspace?project=slug&contents=1  → same, plus the text of each file
 * GET /api/workspace?project=slug&download=1  → the whole project as a .zip
 */
export async function GET(req: NextRequest) {
  const params = new URL(req.url).searchParams;
  const project = safeProject(params.get('project'));
  if (!project) return NextResponse.json({ error: 'Invalid project' }, { status: 400 });
  const projectDir = path.join(PROJECTS_DIR, project);
  const exists = fs.existsSync(projectDir);

  if (params.has('download')) {
    if (!exists) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    const zip = createZip(collectForDownload(projectDir, project));
    return new NextResponse(new Uint8Array(zip), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${project}.zip"`,
        'Content-Length': String(zip.length),
      },
    });
  }

  const files = listFiles(projectDir);
  return NextResponse.json({
    project,
    path: projectDir,
    exists,
    files,
    ...(params.has('contents') ? { contents: readContents(projectDir, files) } : {}),
  });
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
      // Drop the "-2" style suffix added when a project name was already taken
      const packageName = project.replace(/-\d+$/, '').replace(/-/g, '_').replace(/^[^a-z]+/, '') || 'app';
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
