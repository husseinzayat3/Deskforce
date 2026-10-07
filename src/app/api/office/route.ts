import { NextRequest, NextResponse } from 'next/server';
import { abortRunning, ensureEngine, monthStatus } from '../../../lib/server/engine';
import { liveSnapshot } from '../../../lib/server/live';
import { refuseForeignRequest, refuseUnknownHost } from '../../../lib/server/guard';
import { nextRunTime } from '../../../lib/schedule';
import * as store from '../../../lib/server/store';
import { Agent, APIProvider } from '../../../lib/types';
import { OFFICE_CONFIG, getRoot, indexTasks } from '../../../lib/officeConfig';
import { projectExists, safeProject } from '../../../lib/server/workspace';
import { PROJECTS_DIR } from '../../../lib/server/paths';

export const dynamic = 'force-dynamic';

const PROVIDERS: APIProvider[] = ['OpenAI', 'Grok', 'Anthropic', 'Gemini', 'Ollama'];
const MAX_MODEL_CHARS = 100;
const MAX_ROLE_CHARS = 40;
const MAX_INSTRUCTIONS_CHARS = 4000;
const MAX_RANK = 9;
const MAX_MONTHLY_CAP_USD = 100_000;
const MAX_NAME_CHARS = 60;
const MAX_PROMPT_CHARS = 20_000;

const MAX_NOTE_CHARS = 4000;

/** Longest response sent with the office overview; the full text is fetched per task when it is opened. */
const OVERVIEW_RESPONSE_CHARS = 1500;

/** Employees with their tasks, without the long texts that would make every update heavy. */
const overview = (agents: Agent[]): Agent[] => agents.map(agent => ({
  ...agent,
  taskQueue: agent.taskQueue.map(({ report, ...task }) => ({
    ...task,
    hasReport: Boolean(report),
    ...(task.response && task.response.length > OVERVIEW_RESPONSE_CHARS
      ? { response: `${task.response.slice(0, OVERVIEW_RESPONSE_CHARS)}…`, clipped: true }
      : {}),
  })),
}));

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
    projectsDir: PROJECTS_DIR,
    // What the models are writing right now, and this month's spending: both change without a new version
    live: liveSnapshot(),
    month: monthStatus(),
    // A first request only learns where the event stream stands, so old notifications are not replayed
    events: afterEvent === null ? [] : store.listEvents(afterEvent),
    lastEventId: store.latestEventId(),
    ...(knownVersion === version ? {} : { agents: overview(store.getState()), roles: store.listRoles(), templates: store.listTemplates() }),
  };
};

/**
 * GET /api/office?version=<known>&afterEvent=<id>   the office overview
 * GET /api/office?task=<id>                         one task in full (whole response and report)
 */
export async function GET(req: NextRequest) {
  const refusal = refuseUnknownHost(req);
  if (refusal) return refusal;

  try {
    ensureEngine();
    const params = new URL(req.url).searchParams;
    const taskId = params.get('task');
    if (taskId !== null) {
      const task = store.getTask(taskId);
      return task ? NextResponse.json(task) : NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    const afterEvent = params.get('afterEvent');
    return NextResponse.json(snapshot(params.get('version'), afterEvent === null ? null : Number(afterEvent) || 0));
  } catch (error: any) {
    console.error('Office GET error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * POST /api/office
 *  { action: 'hire', name, role, api, model?, avatar }
 *  { action: 'answer', taskId, text }           answer an employee's question
 *  { action: 'role', name, rank, instructions } create or change a role
 *  { action: 'removeRole', name }
 *  { action: 'template', id?, name, prompt, agentId?, budget?, project?, schedule, weekday, minuteOfDay }
 *  { action: 'removeTemplate', id }
 *  { action: 'runTemplate', id, agentId? }      assign a saved task now
 *  { action: 'cap', amount }                    monthly spending cap in USD, 0 for none
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
  const refusal = refuseForeignRequest(req);
  if (refusal) return refusal;

  try {
    ensureEngine();
    const body = await req.json();

    switch (body.action) {
      case 'hire': {
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, MAX_NAME_CHARS) : '';
        if (!name) return badRequest('Missing name');
        if (!store.listRoles().some(r => r.name === body.role)) return badRequest('Unknown role');
        if (!PROVIDERS.includes(body.api)) return badRequest('Unknown API provider');
        const avatar = typeof body.avatar === 'string' && /^\/avatars\/[a-z0-9_-]+\.png$/i.test(body.avatar) ? body.avatar : '/avatars/robot.png';
        const model = typeof body.model === 'string' ? body.model.trim().slice(0, MAX_MODEL_CHARS) : '';
        store.createAgent({ name, role: body.role, api: body.api, avatar, model });
        break;
      }
      case 'remove':
        if (typeof body.agentId !== 'string') return badRequest('Missing agentId');
        store.deleteAgent(body.agentId);
        abortRunning(body.agentId);
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
        const cancelled = store.transitionTask(body.taskId, 'PENDING', 'CANCELLED')
          || store.transitionTask(body.taskId, 'AWAITING_APPROVAL', 'CANCELLED')
          || store.transitionTask(body.taskId, 'WAITING_FOR_INPUT', 'CANCELLED');
        if (!cancelled) return badRequest('Only tasks that have not started can be cancelled');
        break;
      }
      case 'approve':
        if (typeof body.taskId !== 'string') return badRequest('Missing taskId');
        if (!store.transitionTask(body.taskId, 'AWAITING_APPROVAL', 'PENDING', { reviewStatus: 'APPROVED' })) {
          return badRequest('This task is not waiting for approval');
        }
        break;
      case 'answer': {
        if (typeof body.taskId !== 'string') return badRequest('Missing taskId');
        const text = typeof body.text === 'string' ? body.text.trim().slice(0, MAX_NOTE_CHARS) : '';
        if (!text) return badRequest('Write an answer');
        const task = store.getTask(body.taskId);
        if (!task || task.status !== 'WAITING_FOR_INPUT') return badRequest('This task is not waiting for an answer');
        store.transitionTask(body.taskId, 'WAITING_FOR_INPUT', 'PENDING', {
          clarifications: `${task.clarifications ? `${task.clarifications}\n` : ''}Q: ${task.question || ''}\nA: ${text}\n`,
          question: undefined,
        });
        break;
      }
      case 'role': {
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, MAX_ROLE_CHARS) : '';
        if (!name) return badRequest('Missing role name');
        const rank = Math.round(Number(body.rank));
        if (!(rank >= 0 && rank <= MAX_RANK)) return badRequest(`Level must be between 0 and ${MAX_RANK}`);
        const instructions = typeof body.instructions === 'string' ? body.instructions.trim().slice(0, MAX_INSTRUCTIONS_CHARS) : '';
        store.saveRole({ name, rank, instructions });
        break;
      }
      case 'removeRole': {
        if (typeof body.name !== 'string') return badRequest('Missing role name');
        if (store.getState().some(a => a.role === body.name)) return badRequest('This role is still held by an employee');
        if (store.listRoles().length <= 1) return badRequest('The office needs at least one role');
        store.deleteRole(body.name);
        break;
      }
      case 'template': {
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, MAX_NAME_CHARS) : '';
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, MAX_PROMPT_CHARS) : '';
        if (!name || !prompt) return badRequest('A template needs a name and a task');
        const schedule = body.schedule === 'daily' || body.schedule === 'weekly' ? body.schedule : 'none';
        const weekday = Math.min(6, Math.max(0, Math.round(Number(body.weekday)) || 0));
        const minuteOfDay = Math.min(1439, Math.max(0, Math.round(Number(body.minuteOfDay)) || 0));
        const agents = store.getState();
        const agentId = agents.some(a => a.id === body.agentId) ? body.agentId as string : undefined;
        if (schedule !== 'none' && !agentId) return badRequest('Choose who does the task when it runs on a schedule');
        const budget = Number(body.budget) > 0 ? Math.min(Number(body.budget), OFFICE_CONFIG.MAX_TASK_BUDGET_USD) : undefined;
        const project = safeProject(body.project) && agents.some(a => a.taskQueue.some(t => t.project === body.project)) ? body.project as string : undefined;
        const template = { name, prompt, agentId, budget, project, schedule, weekday, minuteOfDay } as const;
        store.saveTemplate({
          ...template,
          id: typeof body.id === 'string' && store.listTemplates().some(t => t.id === body.id) ? body.id : undefined,
          nextRunAt: nextRunTime(template, Date.now()),
        });
        break;
      }
      case 'removeTemplate':
        if (typeof body.id !== 'string') return badRequest('Missing template');
        store.deleteTemplate(body.id);
        break;
      case 'runTemplate': {
        const template = store.listTemplates().find(t => t.id === body.id);
        if (!template) return badRequest('Unknown template');
        const agents = store.getState();
        const agentId = agents.find(a => a.id === body.agentId)?.id || agents.find(a => a.id === template.agentId)?.id;
        if (!agentId) return badRequest('Choose an employee for this task');
        const project = template.project && projectExists(template.project) ? template.project : undefined;
        store.createTask(agentId, template.prompt, 'User', { budget: template.budget, project });
        break;
      }
      case 'cap': {
        const amount = Number(body.amount);
        if (!(amount >= 0 && amount <= MAX_MONTHLY_CAP_USD)) return badRequest(`The cap must be between $0 and $${MAX_MONTHLY_CAP_USD}`);
        store.setMonthlyCap(amount);
        break;
      }
      case 'halt':
        store.cancelUnfinishedTasks();
        // Stop the model calls too, so halted work stops costing money
        abortRunning();
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
