import { Agent, TaskItem } from '../types';
import { FINISHED_STATUSES, OFFICE_CONFIG, formatCost, indexTasks, getTree, rankOf, startOfMonth, taskTitle } from '../officeConfig';
import * as store from './store';
import * as actions from './actions';
import { AgentTool, runAgent } from './agent';
import { ToolsUnsupportedError, Turn, hasRealModel } from './llm';
import { getSetting } from './settings';

/**
 * Talking to the office in words: the most senior employee answers, and runs the office
 * through the same actions the buttons in the app use. Slack (or anything else that can
 * deliver a message) is only the way the words arrive.
 */

const MAX_MESSAGE_CHARS = 4000;
const HISTORY_TURNS = 12;
const MAX_CHAT_STEPS = 8;

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const brief = (value: string, max = 160) => (value.length > max ? `${value.slice(0, max).trimEnd()}…` : value);

/** Whoever speaks for the office: the most senior employee, the longest-serving on a tie. */
const frontDesk = (agents: Agent[]) => {
  const roles = store.listRoles();
  return [...agents].sort((a, b) => rankOf(roles, a.role) - rankOf(roles, b.role))[0];
};

const describeTask = (task: TaskItem, agent: Agent) =>
  `[${task.id}] "${brief(taskTitle(task), 80)}" — ${agent.name}${task.project ? `, project ${task.project}` : ''}`;

/** The state of the office in a few lines: what needs the user, what is running, what just finished. */
export const officeStatus = () => {
  const agents = store.getState();
  if (agents.length === 0) return 'The office is empty: nobody has been hired yet.';
  const all = agents.flatMap(agent => agent.taskQueue.map(task => ({ task, agent })));
  const lines: string[] = [];

  const needsYou = all.filter(({ task }) => task.status === 'PLAN_REVIEW' || task.status === 'WAITING_FOR_INPUT' || task.status === 'AWAITING_APPROVAL');
  if (needsYou.length) {
    lines.push('Waiting for the client:');
    for (const { task, agent } of needsYou) {
      const what = task.status === 'PLAN_REVIEW'
        ? `plan to approve${task.planEstimate !== undefined ? ` (estimated ${formatCost(task.planEstimate)})` : ''}: ${brief(task.plan || '', 400)}`
        : task.status === 'WAITING_FOR_INPUT' ? `question: ${brief(task.question || '', 300)}`
          : `held back: ${brief(task.reviewNote || 'needs approval', 200)}`;
      lines.push(`- ${describeTask(task, agent)} — ${what}`);
    }
  }

  const running = all.filter(({ task }) => task.status === 'IN_PROGRESS');
  const queued = all.filter(({ task }) => task.status === 'PENDING').length;
  lines.push(running.length ? `Working now:\n${running.map(r => `- ${describeTask(r.task, r.agent)}`).join('\n')}` : 'Nobody is working right now.');
  if (queued) lines.push(`${queued} task${queued > 1 ? 's' : ''} in the queue.`);
  if (store.isPaused()) lines.push('The office is paused: no new task will start.');

  const recent = all
    .filter(({ task }) => !task.parentId && FINISHED_STATUSES.has(task.status))
    .sort((a, b) => (b.task.completedAt || b.task.timestamp) - (a.task.completedAt || a.task.timestamp))
    .slice(0, 5);
  if (recent.length) {
    lines.push('Recently finished:');
    for (const { task, agent } of recent) {
      lines.push(`- ${describeTask(task, agent)} — ${task.status.toLowerCase()}${task.hasReport || task.report ? ', report ready' : ''}${task.summary ? `: ${brief(task.summary)}` : ''}`);
    }
  }

  const monthStart = startOfMonth(Date.now());
  const spent = store.spendSince(monthStart) + store.deletedSpend(monthStart);
  const cap = Number(store.getMeta('monthlyCap')) || 0;
  lines.push(`Spent this month: $${spent.toFixed(2)}${cap ? ` of a $${cap.toFixed(2)} cap` : ''}.`);
  lines.push(`Team: ${agents.map(a => `${a.name} (${a.role})`).join(', ')}.`);
  return lines.join('\n');
};

/** Queues a task for an employee, the way assigning one in the app does. */
const startTask = (agents: Agent[], request: string, employeeName: string, planFirst?: boolean) => {
  const wanted = employeeName.toLowerCase();
  const employee = wanted ? agents.find(a => a.name.toLowerCase() === wanted) || agents.find(a => a.name.toLowerCase().includes(wanted)) : frontDesk(agents);
  if (!employee) throw new Error(`Nobody here is called "${employeeName}". The team: ${agents.map(a => a.name).join(', ')}.`);
  const needsPlan = planFirst ?? getSetting('planFirst') === 'on';
  const id = store.createTask(employee.id, request.slice(0, 20_000), 'User', { needsPlan });
  return `Task ${id} queued for ${employee.name}.${needsPlan ? ' They will propose a plan first, which the client has to approve.' : ''}`;
};

const done = (problem: string | null, success: string) => {
  if (problem) throw new Error(problem);
  return { output: success };
};

/** What the front desk can do on the client's behalf. */
const officeTools = (agents: Agent[]): AgentTool[] => {
  const taskParam = { task_id: { type: 'string', description: 'The id of the task, as shown in square brackets by office_status' } };
  return [
    {
      name: 'office_status',
      description: 'What is going on in the office: what waits for the client (plans, questions), what is running, what finished recently, and spending.',
      parameters: { type: 'object', properties: {} },
      describe: () => 'looked at the office',
      run: () => ({ output: officeStatus() }),
    },
    {
      name: 'start_task',
      description: 'Gives a piece of work to the office. Use this whenever the client asks for something to be built, written or researched; do not do the work in the chat.',
      parameters: {
        type: 'object',
        properties: {
          request: { type: 'string', description: 'What the client wants, in full, in their own words where possible' },
          employee: { type: 'string', description: 'Name of the employee to give it to. Leave empty to take it yourself and delegate.' },
          plan_first: { type: 'boolean', description: 'Whether a plan is proposed for approval before any work. Leave out to use the office default.' },
        },
        required: ['request'],
      },
      describe: input => `started a task: ${brief(text(input.request), 80)}`,
      run: input => {
        if (!text(input.request)) throw new Error('request is missing.');
        return { output: startTask(agents, text(input.request), text(input.employee), typeof input.plan_first === 'boolean' ? input.plan_first : undefined) };
      },
    },
    {
      name: 'task_details',
      description: 'Everything about one task: its state, plan or question, summary, files and cost.',
      parameters: { type: 'object', properties: taskParam, required: ['task_id'] },
      describe: input => `looked at task ${text(input.task_id)}`,
      run: input => {
        const task = store.getTask(text(input.task_id));
        if (!task) throw new Error('There is no task with that id. Call office_status to see the tasks.');
        const tree = getTree(task.id, indexTasks(store.getState()));
        return {
          output: [
            `Request: ${brief(task.prompt, 600)}`,
            `State: ${task.status}`,
            task.plan ? `Plan${task.planApproved ? ' (approved)' : ''}: ${brief(task.plan, 1200)}` : '',
            task.question ? `Question for the client: ${task.question}` : '',
            task.summary ? `Summary: ${brief(task.summary, 800)}` : '',
            task.error ? `Error: ${brief(task.error, 400)}` : '',
            task.files?.length ? `Files: ${task.files.join(', ')}` : '',
            task.project ? `Project folder: ${task.project}` : '',
            tree.length > 1 ? `Sub-tasks: ${tree.filter(ref => ref.task.id !== task.id).map(ref => `${ref.agent.name}: ${brief(taskTitle(ref.task), 50)} (${ref.task.status.toLowerCase()})`).join('; ')}` : '',
            `Cost so far: ${formatCost(tree.reduce((sum, ref) => sum + (ref.task.cost || 0), 0))}`,
          ].filter(Boolean).join('\n'),
        };
      },
    },
    {
      name: 'approve_plan',
      description: 'Approves the plan of a task so the work starts. Only when the client says to go ahead.',
      parameters: { type: 'object', properties: taskParam, required: ['task_id'] },
      describe: input => `approved the plan of ${text(input.task_id)}`,
      run: input => done(actions.approvePlan(text(input.task_id)), 'Approved. The work starts now.'),
    },
    {
      name: 'request_new_plan',
      description: 'Turns down the plan of a task and asks for another, with what the client wants changed.',
      parameters: { type: 'object', properties: { ...taskParam, note: { type: 'string', description: 'What the plan should do differently' } }, required: ['task_id', 'note'] },
      describe: input => `asked for a new plan for ${text(input.task_id)}`,
      run: input => done(actions.rejectPlan(text(input.task_id), input.note), 'A new plan will be proposed.'),
    },
    {
      name: 'answer_question',
      description: "Passes the client's answer to an employee who asked a question, so their task carries on.",
      parameters: { type: 'object', properties: { ...taskParam, answer: { type: 'string' } }, required: ['task_id', 'answer'] },
      describe: input => `answered the question of ${text(input.task_id)}`,
      run: input => done(actions.answerQuestion(text(input.task_id), input.answer), 'Answer passed on. The task carries on.'),
    },
    {
      name: 'release_task',
      description: 'Lets a task go ahead that was held back by a limit (budget, too many sub-tasks). Only when the client agrees.',
      parameters: { type: 'object', properties: taskParam, required: ['task_id'] },
      describe: input => `released ${text(input.task_id)}`,
      run: input => done(actions.approveTask(text(input.task_id)), 'Released.'),
    },
    {
      name: 'request_changes',
      description: 'Sends a finished task back to be redone with the client\'s feedback.',
      parameters: { type: 'object', properties: { ...taskParam, feedback: { type: 'string' } }, required: ['task_id', 'feedback'] },
      describe: input => `sent ${text(input.task_id)} back for changes`,
      run: input => done(actions.reviseTask(text(input.task_id), input.feedback), 'Sent back. It will be redone.'),
    },
    {
      name: 'retry_task',
      description: 'Puts a failed or cancelled task back in the queue.',
      parameters: { type: 'object', properties: taskParam, required: ['task_id'] },
      describe: input => `retried ${text(input.task_id)}`,
      run: input => done(actions.retryTask(text(input.task_id)), 'Back in the queue.'),
    },
    {
      name: 'cancel_task',
      description: 'Cancels a task that has not started (queued, or waiting for the client).',
      parameters: { type: 'object', properties: taskParam, required: ['task_id'] },
      describe: input => `cancelled ${text(input.task_id)}`,
      run: input => done(actions.cancelTask(text(input.task_id)), 'Cancelled.'),
    },
    {
      name: 'pause_office',
      description: 'Pauses the office (no new task starts; running ones finish) or resumes it.',
      parameters: { type: 'object', properties: { paused: { type: 'boolean' } }, required: ['paused'] },
      describe: input => (input.paused ? 'paused the office' : 'resumed the office'),
      run: input => {
        store.setPaused(input.paused === true);
        return { output: input.paused ? 'Paused.' : 'Resumed.' };
      },
    },
  ];
};

/** For a front desk whose model cannot call tools: a few plain commands, and everything else is a new task. */
const answerWithoutTools = (agents: Agent[], message: string) => {
  if (/^(status|what'?s (up|going on)|\?)\b/i.test(message)) return officeStatus();
  const waiting = agents.flatMap(a => a.taskQueue).filter(t => t.status === 'PLAN_REVIEW');
  if (/^(approve|go ahead|yes)\b/i.test(message)) {
    if (waiting.length !== 1) return waiting.length ? `There are ${waiting.length} plans waiting. Approve them in the app.` : 'No plan is waiting for approval.';
    actions.approvePlan(waiting[0].id);
    return 'Approved. The work starts now.';
  }
  return `${startTask(agents, message, '')}\n(Say "status" to see how things stand.)`;
};

// One message at a time per conversation, in the order they arrived
const queues = new Map<string, Promise<unknown>>();

/** Answers one message from the client and does what it asks. Returns the reply. */
export const chatWithOffice = (conversation: string, message: string, signal?: AbortSignal): Promise<string> => {
  const turn = (queues.get(conversation) || Promise.resolve()).catch(() => undefined).then(async () => {
    const said = message.trim().slice(0, MAX_MESSAGE_CHARS);
    if (!said) return 'Say what you need.';

    const agents = store.getState();
    const host = frontDesk(agents);
    if (!host) return 'The office is empty. Hire someone in the app first; the most senior employee will answer here.';

    const history: Turn[] = store.recentChat(conversation, HISTORY_TURNS).map(t => ({ role: t.role, text: t.text }));
    store.addChatTurn(conversation, 'user', said);

    let reply: string;
    try {
      if (!hasRealModel(host.api)) {
        reply = answerWithoutTools(agents, said);
      } else {
        const handbook = store.getHandbook().trim();
        const run = await runAgent({
          provider: host.api,
          model: host.model,
          system:
            `You are ${host.name}, the ${host.role} of a small software company. The client is talking to you in a chat. ` +
            `You run the office for them through your tools; you never do the work yourself in the chat.\n\n` +
            `- When the client wants something built, written or looked into, call start_task with their request in full.\n` +
            `- When they ask how things are, call office_status and tell them what matters, shortest first: what waits for them.\n` +
            `- Approve a plan, answer a question, release, cancel or send back a task only when the client tells you to. If it is not clear which task they mean, ask.\n` +
            `- A plan shows an estimated cost: mention it when you present a plan.\n` +
            `- Reply in a few plain sentences, without markdown tables or headings. Say what you did and what, if anything, you need from them.` +
            (handbook ? `\n\nCompany handbook:\n${handbook.slice(0, OFFICE_CONFIG.HANDBOOK_CHARS)}` : ''),
          prompt: said,
          history,
          maxSteps: MAX_CHAT_STEPS,
          tools: officeTools(agents),
          nativeWeb: false,
          cacheKey: `chat-${conversation}`,
          overBudget: () => false,
          inbox: () => [],
          onText: () => undefined,
          signal: signal || new AbortController().signal,
        });
        // What the chat cost is the office's spending too
        if (run.tokens) store.addAgentTokens(host.id, run.tokens);
        store.addOtherSpend(startOfMonth(Date.now()), run.cost || 0);
        reply = run.finalText || run.problems[0] || 'Done.';
      }
    } catch (e: any) {
      reply = e instanceof ToolsUnsupportedError ? answerWithoutTools(agents, said) : `Something went wrong: ${e?.message || 'unknown error'}`;
    }

    store.addChatTurn(conversation, 'assistant', reply);
    return reply;
  });
  queues.set(conversation, turn);
  return turn;
};
