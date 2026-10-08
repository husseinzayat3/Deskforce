"use client";

import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, CornerDownRight, ListTree, OctagonX, CheckCircle2, Download, FileText, RotateCcw, Pencil, FolderPlus, FolderOpen, FolderTree, GitCommitHorizontal, BookmarkPlus, Send, X, Archive, ArchiveRestore, Trash2, MoreHorizontal } from 'lucide-react';
import { Agent, TaskItem, TaskStatus } from '../lib/types';
import { OFFICE_CONFIG, FINISHED_STATUSES, budgetOf, cleanPrompt, formatBudget, formatUsage, projectOf, sumUsage, taskTitle } from '../lib/officeConfig';
import ProjectBrowser from './ProjectBrowser';
import { formatDuration } from '../lib/performance';
import styles from './TaskTree.module.css';

interface TaskNode {
  task: TaskItem;
  agent: Agent;
  children: TaskNode[];
}

interface TaskTreeProps {
  agents: Agent[];
  /** Folder on the server's disk that holds the projects. */
  projectsDir: string;
  /** Task id → what its model has written so far. */
  live: Record<string, string>;
  notify: (message: string) => void;
  onAnswer: (taskId: string, text: string) => void;
  onApprovePlan: (taskId: string, plan?: string) => void;
  onRejectPlan: (taskId: string, note: string) => void;
  onSteer: (taskId: string, text: string) => void;
  /** Whether a continued project starts with a plan by default. */
  planFirst: boolean;
  /** A task to bring into view with its details open; `at` changes on every request. */
  focusTask?: { id: string; at: number } | null;
  onArchive: (taskId: string, archived: boolean) => void;
  onDelete: (taskId: string, withProject: boolean) => void;
  onSaveTemplate: (agent: Agent, task: TaskItem) => void;
  onCancel: (agentId: string, taskId: string) => void;
  onApprove: (agentId: string, taskId: string) => void;
  onRetry: (taskId: string) => void;
  onRevise: (taskId: string, note: string) => void;
  onContinue: (agentId: string, project: string, prompt: string, budget?: number, plan?: boolean) => void;
}

/** The one-line form open under a task: feedback for a revision, or a new request for the same project. */
interface Composer {
  taskId: string;
  mode: 'revise' | 'continue' | 'answer' | 'replan' | 'steer';
}

const COMPOSER_TEXT: Record<Composer['mode'], { placeholder: string; send: string }> = {
  revise: { placeholder: 'What should be changed?', send: 'Send back' },
  continue: { placeholder: 'New request for this project…', send: 'Assign' },
  answer: { placeholder: 'Your answer…', send: 'Answer' },
  replan: { placeholder: 'What should the plan do differently?', send: 'Ask for a new plan' },
  steer: { placeholder: 'Message to the employee while they work…', send: 'Send' },
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  AWAITING_APPROVAL: 'Needs Approval',
  PLAN_REVIEW: 'Plan to approve',
  WAITING_FOR_INPUT: 'Has a question',
  PENDING: 'Pending',
  IN_PROGRESS: 'Working',
  COMPLETED: 'Done',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

/** Saves text as a file from the browser. */
const downloadText = (filename: string, text: string) => {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

/** The whole task, with the long texts the office overview leaves out. */
const fetchTask = async (taskId: string): Promise<TaskItem> => {
  const res = await fetch(`/api/office?task=${encodeURIComponent(taskId)}`, { cache: 'no-store' });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || 'The task could not be loaded.');
  return data;
};

/** Changes whenever the long texts of a task may have changed. */
const textVersion = (task: TaskItem) => `${task.status}:${task.completedAt || 0}:${task.hasReport ? 1 : 0}`;

/** Flattens a node's subtree (excluding the node itself). */
const descendants = (node: TaskNode): TaskNode[] =>
  node.children.flatMap(c => [c, ...descendants(c)]);

export default function TaskTree({ agents, projectsDir, live, notify, onAnswer, onApprovePlan, onRejectPlan, onSteer, planFirst, focusTask, onArchive, onDelete, onSaveTemplate, onCancel, onApprove, onRetry, onRevise, onContinue }: TaskTreeProps) {
  const [composer, setComposer] = useState<Composer | null>(null);
  const [composerText, setComposerText] = useState('');
  const [composerBudget, setComposerBudget] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  // The plan being edited before approval: which task, and the text so far
  const [planEdit, setPlanEdit] = useState<{ taskId: string; text: string } | null>(null);
  const [continuePlan, setContinuePlan] = useState<boolean | null>(null);
  // Tasks whose less-used actions are shown
  const [moreOpen, setMoreOpen] = useState<Set<string>>(new Set());

  const confirmDelete = (task: TaskItem, subtasks: number) => {
    const what = `"${taskTitle(task)}"${subtasks ? ` and its ${subtasks} sub-task${subtasks > 1 ? 's' : ''}` : ''}`;
    if (!window.confirm(`Delete ${what} for good?\n\nWhat they cost stays counted in this month's spending.`)) return;
    const withProject = Boolean(task.project) && window.confirm(`Also delete the project's files (${task.project})?\n\nOK deletes the folder and its history. Cancel keeps the files.`);
    onDelete(task.id, withProject);
  };
  // The project whose files are open, optionally on what one task changed
  const [browsing, setBrowsing] = useState<{ project: string; commit?: string } | null>(null);

  const openComposer = (taskId: string, mode: Composer['mode']) => {
    setComposer(composer?.taskId === taskId && composer.mode === mode ? null : { taskId, mode });
    setComposerText('');
    setComposerBudget('');
  };
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [openDetails, setOpenDetails] = useState<Set<string>>(new Set());

  // A task asked for from elsewhere (a search result, the projects list): open it and scroll to it
  const [shownFocus, setShownFocus] = useState(0);
  if (focusTask && focusTask.at !== shownFocus) {
    setShownFocus(focusTask.at);
    setOpenDetails(prev => new Set(prev).add(focusTask.id));
    setCollapsed(new Set());
    setShowArchived(true);
  }
  useEffect(() => {
    if (!focusTask) return;
    const timer = setTimeout(() => document.getElementById(`task-title-${focusTask.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
    return () => clearTimeout(timer);
  }, [focusTask]);


  // Full texts of the tasks whose details are open, fetched when needed
  const [fullTexts, setFullTexts] = useState<Record<string, { version: string; response?: string; report?: string }>>({});

  useEffect(() => {
    agents.forEach(agent => agent.taskQueue.forEach(task => {
      if (!openDetails.has(task.id) || !(task.clipped || task.hasReport)) return;
      const version = textVersion(task);
      if (fullTexts[task.id]?.version === version) return;
      // Marked first, so the same text is not requested again while it loads
      setFullTexts(prev => ({ ...prev, [task.id]: { ...prev[task.id], version } }));
      fetchTask(task.id)
        .then(full => setFullTexts(prev => ({ ...prev, [task.id]: { version, response: full.response, report: full.report } })))
        .catch(() => undefined);
    }));
  }, [agents, openDetails, fullTexts]);

  const downloadReport = (task: TaskItem) => {
    fetchTask(task.id)
      .then(full => downloadText(`${projectOf(task)}-report.md`, full.report || ''))
      .catch(e => notify(e.message));
  };


  const roots = useMemo(() => {
    const nodes = new Map<string, TaskNode>();
    agents.forEach(agent =>
      (agent.taskQueue || []).forEach(task => nodes.set(task.id, { task, agent, children: [] }))
    );

    const rootList: TaskNode[] = [];
    nodes.forEach(node => {
      const parent = node.task.parentId ? nodes.get(node.task.parentId) : undefined;
      if (parent) parent.children.push(node);
      else rootList.push(node);
    });

    // Sub-tasks read top-to-bottom in creation order; newest top-level tasks first.
    nodes.forEach(n => n.children.sort((a, b) => a.task.timestamp - b.task.timestamp));
    return rootList.sort((a, b) => b.task.timestamp - a.task.timestamp);
  }, [agents]);

  const toggle = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) =>
    setter(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const cancelBranch = (node: TaskNode) => {
    [node, ...descendants(node)]
      .filter(n => n.task.status === 'PENDING')
      .forEach(n => onCancel(n.agent.id, n.task.id));
  };

  const renderNode = (node: TaskNode, depth: number, rootProject?: string): React.ReactNode => {
    const { task, agent, children } = node;
    const subtree = descendants(node);
    const hasChildren = children.length > 0;
    const isCollapsed = collapsed.has(task.id);
    const detailsOpen = openDetails.has(task.id);
    const doneCount = subtree.filter(n => n.task.status === 'COMPLETED').length;
    const pendingInBranch = [node, ...subtree].filter(n => n.task.status === 'PENDING').length;
    const progress = subtree.length ? Math.round((doneCount / subtree.length) * 100) : 0;
    const isReview = task.kind === 'REVIEW';
    const isMeeting = task.kind === 'MEETING';
    // Sub-tasks work in the project of the task at the top of their tree
    const project = depth === 0 ? task.project : rootProject;
    const writing = task.status === 'IN_PROGRESS' ? live[task.id] : undefined;
    const usage = formatUsage(task.tokens, task.cost);
    const branchTotal = sumUsage([task, ...subtree.map(n => n.task)]);
    const branchUsage = hasChildren ? formatUsage(branchTotal.tokens, branchTotal.cost) : '';
    const finished = FINISHED_STATUSES.has(task.status);
    // Less-used actions (request changes, continue, template, archive, delete) sit behind "More"
    const hasMore = depth === 0 || (task.status === 'COMPLETED' && !isReview && !isMeeting);
    const showMore = hasMore && moreOpen.has(task.id);
    const composing = composer?.taskId === task.id ? composer.mode : null;

    const submitComposer = () => {
      const text = composerText.trim();
      if (!text || !composing) return;
      if (composing === 'revise') onRevise(task.id, text);
      else if (composing === 'answer') onAnswer(task.id, text);
      else if (composing === 'replan') onRejectPlan(task.id, text);
      else if (composing === 'steer') onSteer(task.id, text);
      else onContinue(agent.id, task.project!, text, Number(composerBudget) > 0 ? Number(composerBudget) : undefined, continuePlan ?? planFirst);
      setComposer(null);
    };

    return (
      <li key={task.id} className={styles.nodeWrapper}>
        <div
          className={`${styles.node} ${depth === 0 ? styles.rootNode : styles.subNode}`}
          data-status={task.status}
        >
          <div className={styles.nodeRow}>
            {hasChildren ? (
              <button
                id={`task-toggle-${task.id}`}
                className={styles.toggle}
                onClick={() => toggle(setCollapsed, task.id)}
                aria-label={isCollapsed ? 'Expand sub-tasks' : 'Collapse sub-tasks'}
              >
                {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              </button>
            ) : depth > 0 ? (
              <span className={styles.toggleSpacer}><CornerDownRight size={12} /></span>
            ) : (
              <span className={styles.toggleSpacer} />
            )}

            <span className={styles.kind}>{task.compareId ? 'Comparison' : depth === 0 ? 'Task' : isReview ? 'Review' : isMeeting ? 'Meeting' : task.kind === 'FOLLOWUP' ? 'Follow-up' : 'Sub-task'}</span>

            <button
              id={`task-title-${task.id}`}
              className={styles.title}
              onClick={() => toggle(setOpenDetails, task.id)}
              title="Show details"
            >
              {taskTitle(task)}
            </button>

            <span className={styles.status}>{STATUS_LABEL[task.status]}</span>
          </div>

          <div className={styles.metaRow}>
            <img src={agent.avatar || '/avatars/robot.png'} alt={agent.name} className={styles.avatar} />
            <span className={styles.assignee}>{agent.name}</span>
            <span className={styles.metaDim}>· {agent.role}</span>
            <span className={styles.metaDim}>· from {task.assignedBy}</span>
            {task.compareId && <span className={styles.metaDim}>· trying {task.modelOverride || task.apiOverride}</span>}
            {usage && <span className={styles.metaDim} title="Tokens used by this task and its estimated cost">· {usage}</span>}

            <span className={styles.metaRight}>
              {hasChildren && (
                <span className={styles.progressWrap} title={`${doneCount} of ${subtree.length} sub-tasks done`}>
                  <span className={styles.progressBar}>
                    <span className={styles.progressFill} style={{ width: `${progress}%` }} />
                  </span>
                  <span className={styles.progressText}>{doneCount}/{subtree.length}</span>
                </span>
              )}

              {task.hasReport && (
                <>
                  <button
                    id={`task-report-${task.id}`}
                    className={`${styles.cancelBtn} ${styles.approveBtn}`}
                    onClick={() => downloadReport(task)}
                    title="Download the report for this task"
                  >
                    <FileText size={11} />
                    Report
                  </button>
                  <a
                    id={`task-download-${task.id}`}
                    className={`${styles.cancelBtn} ${styles.approveBtn}`}
                    href={`/api/workspace?project=${projectOf(task)}&download=1`}
                    download
                    title="Download every file of this project, including the report, as a .zip"
                  >
                    <Download size={11} />
                    Download
                  </a>
                </>
              )}

              {(task.status === 'FAILED' || task.status === 'CANCELLED') && (
                <button
                  id={`task-retry-${task.id}`}
                  className={`${styles.cancelBtn} ${styles.approveBtn}`}
                  onClick={() => onRetry(task.id)}
                  title="Put this task back in the queue"
                >
                  <RotateCcw size={11} />
                  Retry
                </button>
              )}

              {task.status === 'PLAN_REVIEW' && (
                <>
                  <button id={`task-plan-approve-${task.id}`} className={`${styles.cancelBtn} ${styles.approveBtn}`} onClick={() => onApprovePlan(task.id)} title="Start the work as planned">
                    <CheckCircle2 size={11} />
                    Approve plan
                  </button>
                  <button id={`task-plan-edit-${task.id}`} className={`${styles.cancelBtn} ${styles.quietBtn}`} onClick={() => setPlanEdit(planEdit?.taskId === task.id ? null : { taskId: task.id, text: task.plan || '' })} title="Change the plan yourself, then approve it">
                    <Pencil size={11} />
                    Edit
                  </button>
                  <button id={`task-plan-redo-${task.id}`} className={`${styles.cancelBtn} ${styles.quietBtn}`} onClick={() => openComposer(task.id, 'replan')} title="Say what should be different and get a new plan">
                    <RotateCcw size={11} />
                    Ask for a new plan
                  </button>
                  <button className={styles.cancelBtn} onClick={() => onCancel(agent.id, task.id)} title="Drop this task">
                    <OctagonX size={11} />
                    Cancel
                  </button>
                </>
              )}

              {task.status === 'IN_PROGRESS' && !isMeeting && (
                <button id={`task-steer-${task.id}`} className={`${styles.cancelBtn} ${styles.quietBtn}`} onClick={() => openComposer(task.id, 'steer')} title="Say something to the employee without stopping the task">
                  <Send size={11} />
                  Message
                </button>
              )}

              {task.status === 'WAITING_FOR_INPUT' && (
                <button
                  id={`task-answer-${task.id}`}
                  className={`${styles.cancelBtn} ${styles.approveBtn}`}
                  onClick={() => openComposer(task.id, 'answer')}
                  title="Answer the question so the task can carry on"
                >
                  <Send size={11} />
                  Answer
                </button>
              )}

              {task.commit && project && (
                <button
                  id={`task-changes-${task.id}`}
                  className={`${styles.cancelBtn} ${styles.approveBtn}`}
                  onClick={() => setBrowsing({ project, commit: task.commit })}
                  title="See what this task changed, and undo it if needed"
                >
                  <GitCommitHorizontal size={11} />
                  Changes
                </button>
              )}

              {depth === 0 && task.project && (
                <button
                  id={`task-files-${task.id}`}
                  className={`${styles.cancelBtn} ${styles.approveBtn}`}
                  onClick={() => setBrowsing({ project: task.project! })}
                  title="Browse this project's files and history"
                >
                  <FolderTree size={11} />
                  Files
                </button>
              )}

              {hasMore && (
                <button
                  id={`task-more-${task.id}`}
                  className={`${styles.cancelBtn} ${styles.quietBtn}`}
                  onClick={() => toggle(setMoreOpen, task.id)}
                  aria-expanded={showMore}
                  title={showMore ? 'Hide the other actions' : 'Request changes, continue the project, archive, delete…'}
                >
                  <MoreHorizontal size={12} />
                  {showMore ? 'Less' : 'More'}
                </button>
              )}

              {showMore && (
              <>
              {depth === 0 && finished && subtree.every(n => FINISHED_STATUSES.has(n.task.status)) && (
                <>
                  <button
                    id={`task-archive-${task.id}`}
                    className={`${styles.cancelBtn} ${styles.quietBtn}`}
                    onClick={() => onArchive(task.id, !task.archived)}
                    title={task.archived ? 'Show this task on the board again' : 'Hide this task from the board. Nothing is deleted.'}
                  >
                    {task.archived ? <ArchiveRestore size={11} /> : <Archive size={11} />}
                    {task.archived ? 'Unarchive' : 'Archive'}
                  </button>
                  <button
                    id={`task-delete-${task.id}`}
                    className={styles.cancelBtn}
                    onClick={() => confirmDelete(task, subtree.length)}
                    title="Delete this task and its sub-tasks for good"
                  >
                    <Trash2 size={11} />
                    Delete
                  </button>
                </>
              )}

              {depth === 0 && (
                <button
                  id={`task-template-${task.id}`}
                  className={`${styles.cancelBtn} ${styles.approveBtn}`}
                  onClick={() => onSaveTemplate(agent, task)}
                  title="Save this task to run again, by hand or on a schedule"
                >
                  <BookmarkPlus size={11} />
                  Save as template
                </button>
              )}

              {task.status === 'COMPLETED' && !isReview && !isMeeting && (
                <button
                  id={`task-revise-${task.id}`}
                  className={`${styles.cancelBtn} ${styles.quietBtn}`}
                  onClick={() => openComposer(task.id, 'revise')}
                  title="Send this task back with your feedback"
                >
                  <Pencil size={11} />
                  Request changes
                </button>
              )}

              {depth === 0 && task.project && typeof window !== 'undefined' && window.desktop && (
                <button
                  id={`task-folder-${task.id}`}
                  className={`${styles.cancelBtn} ${styles.approveBtn}`}
                  onClick={() => window.desktop!.openProject(task.project!)}
                  title="Show this project's files"
                >
                  <FolderOpen size={11} />
                  Open folder
                </button>
              )}

              {depth === 0 && finished && task.project && (
                <button
                  id={`task-continue-${task.id}`}
                  className={`${styles.cancelBtn} ${styles.approveBtn}`}
                  onClick={() => openComposer(task.id, 'continue')}
                  title="Assign a new request that keeps working in this project's folder"
                >
                  <FolderPlus size={11} />
                  Continue project
                </button>
              )}

              </>
              )}

              {task.status === 'AWAITING_APPROVAL' ? (
                <button
                  id={`task-approve-${task.id}`}
                  className={`${styles.cancelBtn} ${styles.approveBtn}`}
                  onClick={() => onApprove(agent.id, task.id)}
                  title="Approve this task"
                >
                  <CheckCircle2 size={11} />
                  Approve
                </button>
              ) : null}

              {task.status === 'WAITING_FOR_INPUT' && (
                <button className={styles.cancelBtn} onClick={() => onCancel(agent.id, task.id)} title="Cancel this task">
                  <OctagonX size={11} />
                  Cancel
                </button>
              )}

              {pendingInBranch > 0 && task.status !== 'AWAITING_APPROVAL' && (
                <button
                  id={`task-cancel-${task.id}`}
                  className={styles.cancelBtn}
                  onClick={() => cancelBranch(node)}
                  title={hasChildren ? 'Cancel all pending tasks in this branch' : 'Cancel this task'}
                >
                  <OctagonX size={11} />
                  {hasChildren ? `Stop branch (${pendingInBranch})` : 'Cancel'}
                </button>
              )}
            </span>
          </div>

          {task.status === 'PLAN_REVIEW' && task.plan && (
            <div className={`${styles.detailSummary} ${styles.callout}`}>
              <strong>{agent.name} proposes:</strong>
              {planEdit?.taskId === task.id ? (
                <>
                  <textarea
                    aria-label="The plan"
                    value={planEdit.text}
                    onChange={e => setPlanEdit({ taskId: task.id, text: e.target.value })}
                    style={{ display: 'block', width: '100%', minHeight: 160, marginTop: 6, padding: 8, fontFamily: 'inherit', fontSize: 11, lineHeight: 1.5, border: '1px solid #fbbf24', borderRadius: 6, resize: 'vertical', color: '#0f172a', background: '#fff' }}
                  />
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    <button
                      className={`${styles.cancelBtn} ${styles.approveBtn}`}
                      disabled={!planEdit.text.trim()}
                      onClick={() => { onApprovePlan(task.id, planEdit.text.trim()); setPlanEdit(null); }}
                    >
                      <CheckCircle2 size={11} />
                      Approve my version
                    </button>
                    <button className={`${styles.cancelBtn} ${styles.quietBtn}`} onClick={() => setPlanEdit(null)}>Discard changes</button>
                  </div>
                </>
              ) : (
                <p>{task.plan}</p>
              )}
              <p style={{ fontWeight: 600 }}>
                Estimated cost: {task.planEstimate === undefined ? 'unknown (a model in the plan has no listed price)' : task.planEstimate === 0 ? 'free (local models)' : `about $${task.planEstimate < 0.01 ? task.planEstimate.toFixed(4) : task.planEstimate.toFixed(2)}`}
                <span style={{ fontWeight: 400 }}> · a rough figure from the size of each step · budget {formatBudget(budgetOf(task))}</span>
              </p>
            </div>
          )}

          {task.status === 'WAITING_FOR_INPUT' && task.question && (
            <div className={`${styles.detailSummary} ${styles.callout}`}>
              <strong>{agent.name} asks:</strong>
              <p>{task.question}</p>
            </div>
          )}

          {writing && (
            <div className={styles.detailResponse} style={{ marginTop: 8, maxHeight: 120, overflow: 'hidden', display: 'flex', flexDirection: 'column-reverse', fontFamily: 'ui-monospace, monospace', fontSize: 10 }} aria-live="off" title="What the model is writing right now">
              <span>{writing.slice(-700)}</span>
            </div>
          )}

          {composing && (
            <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
              <input
                autoFocus
                type="text"
                aria-label={COMPOSER_TEXT[composing].placeholder}
                placeholder={COMPOSER_TEXT[composing].placeholder}
                value={composerText}
                onChange={e => setComposerText(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') submitComposer();
                  if (e.key === 'Escape') setComposer(null);
                }}
                style={{ flex: 1, minWidth: 0, fontSize: 11, padding: '4px 8px', border: '1px solid #cbd5e1', borderRadius: 4 }}
              />
              {composing === 'continue' && (
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: '#475569', whiteSpace: 'nowrap' }} title="Have the employee propose a plan for approval before working">
                  <input type="checkbox" checked={continuePlan ?? planFirst} onChange={e => setContinuePlan(e.target.checked)} />
                  Plan first
                </label>
              )}
              {composing === 'continue' && (
                <input
                  type="number"
                  min="0.01"
                  max={OFFICE_CONFIG.MAX_TASK_BUDGET_USD}
                  step="0.01"
                  aria-label="Budget in US dollars"
                  title={`Spending limit in US dollars. Leave empty for ${formatBudget(OFFICE_CONFIG.DEFAULT_TASK_BUDGET_USD)}.`}
                  placeholder={`$ ${OFFICE_CONFIG.DEFAULT_TASK_BUDGET_USD.toFixed(2)}`}
                  value={composerBudget}
                  onChange={e => setComposerBudget(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') submitComposer();
                    if (e.key === 'Escape') setComposer(null);
                  }}
                  style={{ width: 64, fontSize: 11, padding: '4px 6px', border: '1px solid #cbd5e1', borderRadius: 4 }}
                />
              )}
              <button className={`${styles.cancelBtn} ${styles.approveBtn}`} onClick={submitComposer}>
                <Send size={11} />
                {COMPOSER_TEXT[composing].send}
              </button>
              <button className={styles.cancelBtn} onClick={() => setComposer(null)} aria-label="Close">
                <X size={11} />
              </button>
            </div>
          )}

          {task.status === 'AWAITING_APPROVAL' && task.reviewNote && (
            <div className={styles.detailError}>{task.reviewNote}</div>
          )}

          {(branchUsage || (depth === 0 && usage)) && (
            <div className={styles.totals}>
              {branchUsage && <>Total with sub-tasks: {branchUsage}</>}
              {depth === 0 && <>{branchUsage ? ' · ' : ''}Budget: ${(branchTotal.cost || 0).toFixed(4)} of {formatBudget(budgetOf(task))}</>}
            </div>
          )}

          {detailsOpen && (
            <div className={styles.details}>
              <div className={styles.detailPrompt}>{cleanPrompt(task.prompt)}</div>
              {task.response && <div className={styles.detailResponse}>{fullTexts[task.id]?.response ?? task.response}</div>}
              {task.error && <div className={styles.detailError}>{task.error}</div>}
              {task.attachments && task.attachments.length > 0 && (
                <div className={styles.detailFiles}>
                  <strong>Attached by you:</strong>
                  <ul>
                    {task.attachments.slice(0, 20).map(f => <li key={f}>{f}</li>)}
                    {task.attachments.length > 20 && <li>…and {task.attachments.length - 20} more</li>}
                  </ul>
                </div>
              )}
              {task.checkOutput && (
                <div className={task.checkPassed === false ? styles.detailError : styles.detailResponse}>
                  <strong>Checks{task.checkPassed === false ? ' (failed)' : task.checkPassed ? ' (passed)' : ''}</strong>
                  {'\n\n'}
                  {task.checkOutput}
                </div>
              )}
              {task.plan && task.status !== 'PLAN_REVIEW' && (
                <div className={styles.detailSummary}>
                  <strong>{task.planApproved ? 'Plan you approved:' : 'Plan:'}</strong>
                  <p>{task.plan}</p>
                </div>
              )}
              {task.clarifications && (
                <div className={styles.detailSummary}>
                  <strong>Questions and your answers:</strong>
                  <p style={{ whiteSpace: 'pre-wrap' }}>{task.clarifications.trim()}</p>
                </div>
              )}
              {task.feedback && (
                <div className={styles.detailSummary}>
                  <strong>{task.reviewStatus === 'CHANGES_REQUESTED' ? 'Changes requested:' : 'Redone after your feedback:'}</strong>
                  <p>{task.feedback}</p>
                </div>
              )}
              {task.status !== 'AWAITING_APPROVAL' && task.reviewNote && (
                <div className={styles.detailError}>{task.reviewNote}</div>
              )}
              {task.summary && (
                <div className={styles.detailSummary}>
                  <strong>Admin Summary:</strong>
                  <p>{task.summary}</p>
                </div>
              )}
              {task.files && task.files.length > 0 && (
                <div className={styles.detailFiles}>
                  <strong>Files written:</strong>
                  <ul>
                    {task.files.map(f => <li key={f}>{f}</li>)}
                  </ul>
                </div>
              )}
              {usage && (
                <div className={styles.detailTokens}>
                  <strong>Usage:</strong> {usage}{task.model ? ` · ${task.model}` : ''}
                  {task.cachedTokens ? ` · ${Math.round((task.cachedTokens / (task.tokens || 1)) * 100)}% of the tokens read from cache` : ''}
                  {task.durationMs ? ` · ${formatDuration(task.durationMs)}` : ''}
                </div>
              )}
              {task.hasReport && fullTexts[task.id]?.report && (
                <div className={styles.detailResponse}>
                  <strong>Report</strong>
                  {'\n\n'}
                  {fullTexts[task.id].report}
                </div>
              )}
              {task.project && <div className={styles.detailTime}>Project folder: {projectsDir}/{task.project}</div>}
              <div className={styles.detailTime}>{new Date(task.timestamp).toLocaleString()}</div>
            </div>
          )}
        </div>

        {hasChildren && !isCollapsed && (
          <ul className={styles.children}>
            {children.map(child => renderNode(child, depth + 1, project))}
          </ul>
        )}
      </li>
    );
  };

  if (roots.length === 0) {
    return (
      <div className={styles.empty}>
        <ListTree size={28} />
        <p>No tasks yet.</p>
        <span>Assign a task to an employee — delegated work will appear nested here.</span>
      </div>
    );
  }

  const archivedCount = roots.filter(r => r.task.archived).length;

  return (
    <>
      {browsing && (
        <ProjectBrowser
          key={`${browsing.project}:${browsing.commit || ''}`}
          project={browsing.project}
          commitId={browsing.commit}
          onClose={() => setBrowsing(null)}
          notify={notify}
        />
      )}
      <ul className={styles.tree}>{roots.filter(r => showArchived || !r.task.archived).map(r => renderNode(r, 0))}</ul>
      {archivedCount > 0 && (
        <button
          onClick={() => setShowArchived(!showArchived)}
          style={{ margin: '8px auto', display: 'block', border: 'none', background: 'none', color: '#64748b', fontSize: 11, cursor: 'pointer', textDecoration: 'underline' }}
        >
          {showArchived ? 'Hide archived tasks' : `Show ${archivedCount} archived task${archivedCount > 1 ? 's' : ''}`}
        </button>
      )}
    </>
  );
}
