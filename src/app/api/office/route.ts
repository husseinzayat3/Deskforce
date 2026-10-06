import { NextRequest, NextResponse } from 'next/server';
import { ensureEngine } from '../../../lib/server/engine';
import * as store from '../../../lib/server/store';
import { AgentRole, APIProvider } from '../../../lib/types';
import { OFFICE_CONFIG, getRoot, indexTasks } from '../../../lib/officeConfig';
import { projectExists, safeProject } from '../../../lib/server/workspace';

export const dynamic = 'force-dynamic';

const ROLES: AgentRole[] = ['CEO', 'Tech Lead', 'Junior Dev', 'HR', 'Designer'];
const PROVIDERS: APIProvider[] = ['OpenAI', 'Grok', 'Ollama'];
const MAX_NAME_CHARS = 60;
const MAX_PROMPT_CHARS = 20_000;

const MAX_NOTE_CHARS = 4000;

const badRequest = (error: string) => NextResponse.json({ error }, { status: 400 });

/** A task of a finished project is running again, so the project's report is out of date: drop it until the work is done. */
const reopenProject = (taskId: string) => {
  const root = getRoot(taskId, indexTasks(store.getState()))?.task;
  if (root?.report) store.updateTask(root.id, { report: undefined });
};

/**
 * The office as the browser sees it. When the caller already has the current version,
 * the (large) list of agents and tasks is left out.
 */
const snapshot = (knownVersion: string | null, afterEvent: number | null) => {
  const version = store.getVersion();
  return {
    version,
    paused: store.isPaused(),
    // A first request only learns where the event stream stands, so old notifications are not replayed
    events: afterEvent === null ? [] : store.listEvents(afterEvent),
    lastEventId: store.latestEventId(),
    ...(knownVersion === version ? {} : { agents: store.getState() }),
  };
};

/** GET /api/office?version=<known>&afterEvent=<id> */
export async function GET(req: NextRequest) {
  try {
    ensureEngine();
    const params = new URL(req.url).searchParams;
    const afterEvent = params.get('afterEvent');
    return NextResponse.json(snapshot(params.get('version'), afterEvent === null ? null : Number(afterEvent) || 0));
  } catch (error: any) {
    console.error('Office GET error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * POST /api/office
 *  { action: 'hire', name, role, api, avatar }
 *  { action: 'remove', agentId }
 *  { action: 'assign', agentId, prompt, budget?, project? }   budget in USD; project continues an existing one
 *  { action: 'retry', taskId }       a failed or cancelled task
 *  { action: 'revise', taskId, note } send a finished task back with feedback
 *  { action: 'cancel', taskId }      a task that has not started
 *  { action: 'approve', taskId }     a task waiting for approval
 *  { action: 'halt' }                cancel everything unfinished
 *  { action: 'pause', paused }
 */
export async function POST(req: NextRequest) {
  try {
    ensureEngine();
    const body = await req.json();

    switch (body.action) {
      case 'hire': {
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, MAX_NAME_CHARS) : '';
        if (!name) return badRequest('Missing name');
        if (!ROLES.includes(body.role)) return badRequest('Unknown role');
        if (!PROVIDERS.includes(body.api)) return badRequest('Unknown API provider');
        const avatar = typeof body.avatar === 'string' && /^\/avatars\/[a-z0-9_-]+\.png$/i.test(body.avatar) ? body.avatar : '/avatars/robot.png';
        store.createAgent({ name, role: body.role, api: body.api, avatar });
        break;
      }
      case 'remove':
        if (typeof body.agentId !== 'string') return badRequest('Missing agentId');
        store.deleteAgent(body.agentId);
        break;
      case 'assign': {
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, MAX_PROMPT_CHARS) : '';
        if (!prompt) return badRequest('Missing prompt');
        const agents = store.getState();
        if (!agents.some(a => a.id === body.agentId)) return badRequest('Unknown employee');

        let budget: number | undefined;
        if (body.budget !== undefined && body.budget !== null && body.budget !== '') {
          budget = Number(body.budget);
          if (!(budget > 0) || budget > OFFICE_CONFIG.MAX_TASK_BUDGET_USD) {
            return badRequest(`Budget must be between $0.01 and $${OFFICE_CONFIG.MAX_TASK_BUDGET_USD}`);
          }
        }

        // Continuing a project: only one that an earlier task created
        let project: string | undefined;
        if (body.project !== undefined) {
          const known = safeProject(body.project);
          if (!known || !projectExists(known) || !agents.some(a => a.taskQueue.some(t => t.project === known))) {
            return badRequest('Unknown project');
          }
          project = known;
        }

        store.createTask(body.agentId, prompt, 'User', { budget, project });
        break;
      }
      case 'retry': {
        if (typeof body.taskId !== 'string') return badRequest('Missing taskId');
        const reset = { response: '', reviewNote: undefined };
        const retried = store.transitionTask(body.taskId, 'FAILED', 'PENDING', reset) || store.transitionTask(body.taskId, 'CANCELLED', 'PENDING', reset);
        if (!retried) return badRequest('Only failed or cancelled tasks can be retried');
        reopenProject(body.taskId);
        break;
      }
      case 'revise': {
        if (typeof body.taskId !== 'string') return badRequest('Missing taskId');
        const note = typeof body.note === 'string' ? body.note.trim().slice(0, MAX_NOTE_CHARS) : '';
        if (!note) return badRequest('Say what should be changed');
        if (!store.transitionTask(body.taskId, 'COMPLETED', 'PENDING', { reviewStatus: 'CHANGES_REQUESTED', feedback: note })) {
          return badRequest('Only finished tasks can be sent back');
        }
        reopenProject(body.taskId);
        break;
      }
      case 'cancel': {
        if (typeof body.taskId !== 'string') return badRequest('Missing taskId');
        const cancelled = store.transitionTask(body.taskId, 'PENDING', 'CANCELLED') || store.transitionTask(body.taskId, 'AWAITING_APPROVAL', 'CANCELLED');
        if (!cancelled) return badRequest('Only tasks that have not started can be cancelled');
        break;
      }
      case 'approve':
        if (typeof body.taskId !== 'string') return badRequest('Missing taskId');
        if (!store.transitionTask(body.taskId, 'AWAITING_APPROVAL', 'PENDING', { reviewStatus: 'APPROVED' })) {
          return badRequest('This task is not waiting for approval');
        }
        break;
      case 'halt':
        store.cancelUnfinishedTasks();
        break;
      case 'pause':
        store.setPaused(Boolean(body.paused));
        break;
      default:
        return badRequest(`Unknown action: ${body.action}`);
    }

    return NextResponse.json(snapshot(null, null));
  } catch (error: any) {
    console.error('Office POST error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
