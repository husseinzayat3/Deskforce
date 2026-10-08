import { NextRequest, NextResponse } from 'next/server';
import { listProjectFiles, listProjects, previewEntry, projectExists, safeProject, viewProjectFile, zipProject } from '../../../lib/server/workspace';
import { commitChanges, projectHistory, undoCommit } from '../../../lib/server/git';
import { startPreview } from '../../../lib/server/preview';
import { checksAllowed, runChecks } from '../../../lib/server/checks';
import { refuseForeignRequest, refuseUnknownHost } from '../../../lib/server/guard';
import * as store from '../../../lib/server/store';
import { getRoot, indexTasks } from '../../../lib/officeConfig';

export const dynamic = 'force-dynamic';

const COMMIT_ID = /^[0-9a-f]{40}$/;

/**
 * GET /api/workspace?projects=1                 → every project folder
 * GET /api/workspace?project=slug               → files, history, and whether it can be previewed
 * GET /api/workspace?project=slug&file=path     → one file as text
 * GET /api/workspace?project=slug&commit=id     → what one commit changed
 * GET /api/workspace?project=slug&download=1    → the whole project as a .zip
 *
 * Files are written by the office engine on the server, never by the browser.
 */
export async function GET(req: NextRequest) {
  const refusal = refuseUnknownHost(req);
  if (refusal) return refusal;

  try {
    const params = new URL(req.url).searchParams;
    if (params.has('projects')) return NextResponse.json({ projects: listProjects() });
    const project = safeProject(params.get('project'));
    if (!project) return NextResponse.json({ error: 'Invalid project' }, { status: 400 });
    if (!projectExists(project)) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    if (params.has('download')) {
      const zip = zipProject(project);
      return new NextResponse(new Uint8Array(zip), {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${project}.zip"`,
          'Content-Length': String(zip.length),
        },
      });
    }

    const file = params.get('file');
    if (file !== null) {
      const view = viewProjectFile(project, file);
      return view ? NextResponse.json(view) : NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    const commit = params.get('commit');
    if (commit !== null) {
      if (!COMMIT_ID.test(commit)) return NextResponse.json({ error: 'Invalid commit' }, { status: 400 });
      return NextResponse.json(await commitChanges(project, commit));
    }

    return NextResponse.json({
      project,
      files: listProjectFiles(project),
      history: await projectHistory(project),
      canPreview: Boolean(previewEntry(project)),
      canCheck: checksAllowed(),
    });
  } catch (error: any) {
    console.error('Workspace GET error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * POST /api/workspace
 *  { action: 'undo', project, commit }   put the files one task changed back as they were
 *  { action: 'preview', project }        serve the project's web page and return its address
 *  { action: 'check', project }          check the files and run the tests (only when allowed in the settings)
 */
export async function POST(req: NextRequest) {
  const refusal = refuseForeignRequest(req);
  if (refusal) return refusal;

  try {
    const body = await req.json();
    const project = safeProject(body.project);
    if (!project || !projectExists(project)) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    if (body.action === 'undo') {
      if (typeof body.commit !== 'string' || !COMMIT_ID.test(body.commit)) return NextResponse.json({ error: 'Invalid commit' }, { status: 400 });
      const result = await undoCommit(project, body.commit);

      // The task no longer stands as it was reported: say so on it, and have the project's report rewritten
      const task = result.restored.length > 0 ? store.getTaskByCommit(body.commit) : undefined;
      if (task) {
        const note = `Undone by you on ${new Date().toLocaleString()}: ${result.restored.join(', ')} put back as before.`;
        store.updateTask(task.id, { reviewNote: task.reviewNote ? `${task.reviewNote}\n${note}` : note });
        const root = getRoot(task.id, indexTasks(store.getState()))?.task;
        if (root) store.updateTask(root.id, { report: undefined, checkRuns: 0, checkPassed: undefined, checkOutput: undefined });
      }
      return NextResponse.json(result);
    }

    if (body.action === 'check') {
      if (!checksAllowed()) return NextResponse.json({ error: 'Running checks is turned off. Turn it on in the settings first.' }, { status: 400 });
      return NextResponse.json(await runChecks(project));
    }

    if (body.action === 'preview') {
      const url = await startPreview(project);
      return url
        ? NextResponse.json({ url })
        : NextResponse.json({ error: 'This project has no web page (index.html) to preview.' }, { status: 400 });
    }

    return NextResponse.json({ error: `Unknown action: ${body.action}` }, { status: 400 });
  } catch (error: any) {
    console.error('Workspace POST error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
