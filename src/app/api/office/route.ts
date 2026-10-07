import { NextRequest, NextResponse } from 'next/server';
import { abortRunning, ensureEngine, monthStatus } from '../../../lib/server/engine';
import { liveSnapshot } from '../../../lib/server/live';
import { refuseForeignRequest, refuseUnknownHost } from '../../../lib/server/guard';
import { nextRunTime } from '../../../lib/schedule';
import * as store from '../../../lib/server/store';
import { Agent, APIProvider, Attachment, OfficeFile } from '../../../lib/types';
import { FINISHED_STATUSES, OFFICE_CONFIG, getRoot, getTree, indexTasks, startOfMonth } from '../../../lib/officeConfig';
import { ATTACHMENT_LIMITS, deleteProject, discardAttachments, projectExists, safeProject, stageAttachments } from '../../../lib/server/workspace';
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
  if (root) store.updateTask(root.id, { report: undefined, checkRuns: 0, checkPassed: undefined, checkOutput: undefined });
};

const AVATAR = /^\/avatars\/[a-z0-9_-]+\.png$/i;
const clean = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** The office without its history or its keys, to be saved as a file and loaded into another office. */
const exportOffice = (): OfficeFile => {
  const agents = store.getState();
  return {
    format: 'my-office',
    version: 1,
    exportedAt: new Date().toISOString(),
    roles: store.listRoles(),
    employees: agents.map(a => ({ name: a.name, role: a.role, api: a.api, model: a.model || undefined, avatar: a.avatar })),
    templates: store.listTemplates().map(t => ({
      name: t.name, prompt: t.prompt, budget: t.budget, schedule: t.schedule, weekday: t.weekday, minuteOfDay: t.minuteOfDay,
      employee: agents.find(a => a.id === t.agentId)?.name,
    })),
  };
};

/** Adds what an office file contains to this office. Nothing that exists is removed or renamed. */
const importOffice = (file: unknown) => {
  const office = file as Partial<OfficeFile> | null;
  if (!office || office.format !== 'my-office' || office.version !== 1) throw new Error('This is not an office file.');
  const counts = { roles: 0, employees: 0, templates: 0 };

  for (const role of Array.isArray(office.roles) ? office.roles.slice(0, 50) : []) {
    const name = clean(role?.name, MAX_ROLE_CHARS);
    const rank = Math.round(Number(role?.rank));
    if (!name || !(rank >= 0 && rank <= MAX_RANK)) continue;
    store.saveRole({ name, rank, instructions: clean(role?.instructions, MAX_INSTRUCTIONS_CHARS) });
    counts.roles += 1;
  }

  const roles = store.listRoles();
  for (const employee of Array.isArray(office.employees) ? office.employees.slice(0, 100) : []) {
    const name = clean(employee?.name, MAX_NAME_CHARS);
    const existing = store.getState();
    if (!name || existing.some(a => a.name.toLowerCase() === name.toLowerCase())) continue;
    if (!roles.some(r => r.name === employee.role) || !PROVIDERS.includes(employee.api)) continue;
    store.createAgent({
      name,
      role: employee.role,
      api: employee.api,
      model: clean(employee.model, MAX_MODEL_CHARS),
      avatar: AVATAR.test(String(employee.avatar)) ? employee.avatar : '/avatars/robot.png',
    });
    counts.employees += 1;
  }

  const agents = store.getState();
  const known = new Set(store.listTemplates().map(t => t.name.toLowerCase()));
  for (const template of Array.isArray(office.templates) ? office.templates.slice(0, 200) : []) {
    const name = clean(template?.name, MAX_NAME_CHARS);
    const prompt = clean(template?.prompt, MAX_PROMPT_CHARS);
    if (!name || !prompt || known.has(name.toLowerCase())) continue;
    const agentId = agents.find(a => a.name === template.employee)?.id;
    // A schedule needs someone to do the work; without them the template is kept for running by hand
    const schedule = agentId && (template.schedule === 'daily' || template.schedule === 'weekly') ? template.schedule : 'none';
    const draft = {
      name, prompt, agentId, schedule,
      budget: Number(template.budget) > 0 ? Math.min(Number(template.budget), OFFICE_CONFIG.MAX_TASK_BUDGET_USD) : undefined,
      weekday: Math.min(6, Math.max(0, Math.round(Number(template.weekday)) || 0)),
      minuteOfDay: Math.min(1439, Math.max(0, Math.round(Number(template.minuteOfDay)) || 0)),
    } as const;
    store.saveTemplate({ ...draft, nextRunAt: nextRunTime(draft, Date.now()) });
    known.add(name.toLowerCase());
    counts.templates += 1;
  }
  return counts;
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
 * GET /api/office?events=1&afterEvent=<id>          only the notifications since then
 * GET /api/office?export=1                          the office as a file (roles, employees, templates)
 */
export async function GET(req: NextRequest) {
  const refusal = refuseUnknownHost(req);
  if (refusal) return refusal;

  try {
    ensureEngine();
    const params = new URL(req.url).searchParams;
    if (params.has('export')) {
      return new NextResponse(JSON.stringify(exportOffice(), null, 2), {
        headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="my-office.json"' },
      });
    }
    const taskId = params.get('task');
    if (taskId !== null) {
      const task = store.getTask(taskId);
      return task ? NextResponse.json(task) : NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    const afterEvent = params.get('afterEvent');
    // Just the notifications, for the desktop shell
    if (params.has('events')) {
      return NextResponse.json({ events: afterEvent === null ? [] : store.listEvents(Number(afterEvent) || 0), lastEventId: store.latestEventId() });
    }
    return NextResponse.json(snapshot(params.get('version'), afterEvent === null ? null : Number(afterEvent) || 0));
  } catch (error: any) {
    console.error('Office GET error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * POST /api/office
 *  { action: 'hire', name, role, api, model?, avatar }
 *  { action: 'editAgent', agentId, name?, role?, api?, model?, avatar? }   change an employee, keeping their history
 *  { action: 'archive', taskId, archived }        hide a finished task from the board, or show it again
 *  { action: 'deleteTask', taskId, withProject? }  delete a finished task and its sub-tasks for good
 *  { action: 'import', office }                    add the roles, employees and templates of an office file
 *  { action: 'answer', taskId, text }           answer an employee's question
 *  { action: 'role', name, rank, instructions } create or change a role
 *  { action: 'removeRole', name }
 *  { action: 'template', id?, name, prompt, agentId?, budget?, project?, schedule, weekday, minuteOfDay }
 *  { action: 'removeTemplate', id }
 *  { action: 'runTemplate', id, agentId? }      assign a saved task now
 *  { action: 'cap', amount }                    monthly spending cap in USD, 0 for none
 *  { action: 'remove', agentId }
 *  { action: 'assign', agentId, prompt, budget?, project?, attachments?, attachedFolder? }
 *      budget in USD; project continues an existing one; attachments are { path, data (base64) }
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
      case 'editAgent': {
        const agent = store.getState().find(a => a.id === body.agentId);
        if (!agent) return badRequest('Unknown employee');
        const patch: Parameters<typeof store.updateAgent>[1] = {};
        if (body.name !== undefined) {
          patch.name = clean(body.name, MAX_NAME_CHARS);
          if (!patch.name) return badRequest('Missing name');
        }
        if (body.role !== undefined) {
          if (!store.listRoles().some(r => r.name === body.role)) return badRequest('Unknown role');
          patch.role = body.role;
        }
        if (body.api !== undefined) {
          if (!PROVIDERS.includes(body.api)) return badRequest('Unknown API provider');
          patch.api = body.api;
        }
        if (body.model !== undefined) patch.model = clean(body.model, MAX_MODEL_CHARS);
        if (body.avatar !== undefined) {
          if (!AVATAR.test(String(body.avatar))) return badRequest('Unknown avatar');
          patch.avatar = body.avatar;
        }
        // Takes effect with the employee's next task; one that is running finishes as it started
        store.updateAgent(agent.id, patch);
        break;
      }
      case 'archive': {
        const task = typeof body.taskId === 'string' ? store.getTask(body.taskId) : undefined;
        if (!task || task.parentId) return badRequest('Only tasks you assigned can be archived');
        store.updateTask(task.id, { archived: Boolean(body.archived) });
        break;
      }
      case 'deleteTask': {
        const task = typeof body.taskId === 'string' ? store.getTask(body.taskId) : undefined;
        if (!task || task.parentId) return badRequest('Only tasks you assigned can be deleted');
        const agents = store.getState();
        const tree = getTree(task.id, indexTasks(agents)).map(ref => ref.task);
        if (tree.some(t => !FINISHED_STATUSES.has(t.status))) return badRequest('This task is still going. Cancel or halt it first.');

        store.deleteTasks(tree.map(t => t.id), startOfMonth(Date.now()));
        discardAttachments(task.id);
        // The folder goes too when asked, unless another task still works in the same project
        if (body.withProject && task.project && safeProject(task.project)) {
          const shared = agents.some(a => a.taskQueue.some(t => !t.parentId && t.id !== task.id && t.project === task.project));
          if (shared) store.pushEvent(`The files of ${task.project} were kept: another task uses the same project.`);
          else deleteProject(task.project);
        }
        break;
      }
      case 'import': {
        let counts;
        try {
          counts = importOffice(body.office);
        } catch (e: any) {
          return badRequest(e.message);
        }
        store.pushEvent(`Imported ${counts.roles} role${counts.roles === 1 ? '' : 's'}, ${counts.employees} employee${counts.employees === 1 ? '' : 's'} and ${counts.templates} template${counts.templates === 1 ? '' : 's'}.`);
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

        const attachments: Attachment[] = Array.isArray(body.attachments) ? body.attachments : [];
        if (attachments.length > ATTACHMENT_LIMITS.files) return badRequest(`At most ${ATTACHMENT_LIMITS.files} files can be attached.`);

        const taskId = store.createTask(body.agentId, prompt, 'User', { budget, project, status: attachments.length ? 'AWAITING_APPROVAL' : 'PENDING' });
        if (attachments.length) {
          // Held back until the files are stored, so the engine cannot start the task without them
          try {
            const paths = stageAttachments(taskId, attachments, Boolean(body.attachedFolder));
            store.updateTask(taskId, { attachments: paths, status: 'PENDING' });
          } catch (e: any) {
            discardAttachments(taskId);
            store.deleteTasks([taskId], startOfMonth(Date.now()));
            return badRequest(e.message);
          }
        }
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
