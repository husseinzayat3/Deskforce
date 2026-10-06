import { NextRequest, NextResponse } from 'next/server';
import { listProjectFiles, projectExists, safeProject, zipProject } from '../../../lib/server/workspace';

/**
 * GET /api/workspace?project=slug             → whether the project exists, and its files
 * GET /api/workspace?project=slug&download=1  → the whole project as a .zip
 *
 * Read-only: files are written by the office engine on the server, never by the browser.
 */
export async function GET(req: NextRequest) {
  const params = new URL(req.url).searchParams;
  const project = safeProject(params.get('project'));
  if (!project) return NextResponse.json({ error: 'Invalid project' }, { status: 400 });
  const exists = projectExists(project);

  if (params.has('download')) {
    if (!exists) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    const zip = zipProject(project);
    return new NextResponse(new Uint8Array(zip), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${project}.zip"`,
        'Content-Length': String(zip.length),
      },
    });
  }

  return NextResponse.json({ project, exists, files: listProjectFiles(project) });
}
