"use client";

import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, CornerDownRight, ListTree, OctagonX, CheckCircle2, Download, FileText, RotateCcw, Pencil, FolderPlus, FolderOpen, FolderTree, GitCommitHorizontal, BookmarkPlus, Send, X } from 'lucide-react';
import { Agent, TaskItem, TaskStatus } from '../lib/types';
import { OFFICE_CONFIG, FINISHED_STATUSES, budgetOf, cleanPrompt, formatBudget, formatUsage, projectOf, sumUsage, taskTitle } from '../lib/officeConfig';
import ProjectBrowser from './ProjectBrowser';
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
  onSaveTemplate: (agent: Agent, task: TaskItem) => void;
  onCancel: (agentId: string, taskId: string) => void;
  onApprove: (agentId: string, taskId: string) => void;
  onRetry: (taskId: string) => void;
  onRevise: (taskId: string, note: string) => void;
  onContinue: (agentId: string, project: string, prompt: string, budget?: number) => void;
}

/** The one-line form open under a task: feedback for a revision, or a new request for the same project. */
interface Composer {
  taskId: string;
  mode: 'revise' | 'continue' | 'answer';
}

const COMPOSER_TEXT: Record<Composer['mode'], { placeholder: string; send: string }> = {
  revise: { placeholder: 'What should be changed?', send: 'Send back' },
  continue: { placeholder: 'New request for this project…', send: 'Assign' },
  answer: { placeholder: 'Your answer…', send: 'Answer' },
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  AWAITING_APPROVAL: 'Needs Approval',
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

/** Flattens a node's subtree (excluding the node itself). */
const descendants = (node: TaskNode): TaskNode[] =>
  node.children.flatMap(c => [c, ...descendants(c)]);

export default function TaskTree({ agents, projectsDir, live, notify, onAnswer, onSaveTemplate, onCancel, onApprove, onRetry, onRevise, onContinue }: TaskTreeProps) {
  const [composer, setComposer] = useState<Composer | null>(null);
  const [composerText, setComposerText] = useState('');
  const [composerBudget, setComposerBudget] = useState('');
  // The project whose files are open, optionally on what one task changed
  const [browsing, setBrowsing] = useState<{ project: string; commit?: string } | null>(null);

  const openComposer = (taskId: string, mode: Composer['mode']) => {
    setComposer(composer?.taskId === taskId && composer.mode === mode ? null : { taskId, mode });
    setComposerText('');
    setComposerBudget('');
  };
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [openDetails, setOpenDetails] = useState<Set<string>>(new Set());

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
    const composing = composer?.taskId === task.id ? composer.mode : null;

    const submitComposer = () => {
      const text = composerText.trim();
      if (!text || !composing) return;
      if (composing === 'revise') onRevise(task.id, text);
      else if (composing === 'answer') onAnswer(task.id, text);
      else onContinue(agent.id, task.project!, text, Number(composerBudget) > 0 ? Number(composerBudget) : undefined);
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

            <span className={styles.kind}>{depth === 0 ? 'Task' : isReview ? 'Review' : isMeeting ? 'Meeting' : 'Sub-task'}</span>

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

              {task.report && (
                <>
                  <button
                    id={`task-report-${task.id}`}
                    className={`${styles.cancelBtn} ${styles.approveBtn}`}
                    onClick={() => downloadText(`${projectOf(task)}-report.md`, task.report!)}
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
                    style={{ textDecoration: 'none' }}
                  >
                    <Download size={11} />
                    Output (.zip)
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
                  className={styles.cancelBtn}
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

          {task.status === 'WAITING_FOR_INPUT' && task.question && (
            <div className={styles.detailSummary} style={{ marginTop: 8 }}>
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
            <div className={styles.detailTokens} style={{ marginTop: 4 }}>
              {branchUsage && <>Total with sub-tasks: {branchUsage}</>}
              {depth === 0 && <>{branchUsage ? ' · ' : ''}Budget: ${(branchTotal.cost || 0).toFixed(4)} of {formatBudget(budgetOf(task))}</>}
            </div>
          )}

          {detailsOpen && (
            <div className={styles.details}>
              <div className={styles.detailPrompt}>{cleanPrompt(task.prompt)}</div>
              {task.response && <div className={styles.detailResponse}>{task.response}</div>}
              {task.error && <div className={styles.detailError}>{task.error}</div>}
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
                <div className={styles.detailTokens} style={{ marginTop: 0 }}>
                  <strong>Usage:</strong> {usage}{task.model ? ` · ${task.model}` : ''}
                </div>
              )}
              {task.report && (
                <div className={styles.detailResponse}>
                  <strong>Report</strong>
                  {'\n\n'}
                  {task.report}
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
      <ul className={styles.tree}>{roots.map(r => renderNode(r, 0))}</ul>
    </>
  );
}
