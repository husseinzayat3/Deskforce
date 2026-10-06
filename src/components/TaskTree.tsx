"use client";

import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, CornerDownRight, ListTree, OctagonX, CheckCircle2, Download, FileText, RotateCcw, Pencil, FolderPlus, Send, X } from 'lucide-react';
import { Agent, TaskItem, TaskStatus } from '../lib/types';
import { OFFICE_CONFIG, FINISHED_STATUSES, budgetOf, cleanPrompt, formatBudget, formatUsage, projectOf, sumUsage, taskTitle } from '../lib/officeConfig';
import styles from './TaskTree.module.css';

interface TaskNode {
  task: TaskItem;
  agent: Agent;
  children: TaskNode[];
}

interface TaskTreeProps {
  agents: Agent[];
  onCancel: (agentId: string, taskId: string) => void;
  onApprove: (agentId: string, taskId: string) => void;
  onRetry: (taskId: string) => void;
  onRevise: (taskId: string, note: string) => void;
  onContinue: (agentId: string, project: string, prompt: string, budget?: number) => void;
}

/** The one-line form open under a task: feedback for a revision, or a new request for the same project. */
interface Composer {
  taskId: string;
  mode: 'revise' | 'continue';
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  AWAITING_APPROVAL: 'Needs Approval',
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

export default function TaskTree({ agents, onCancel, onApprove, onRetry, onRevise, onContinue }: TaskTreeProps) {
  const [composer, setComposer] = useState<Composer | null>(null);
  const [composerText, setComposerText] = useState('');
  const [composerBudget, setComposerBudget] = useState('');

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

  const renderNode = (node: TaskNode, depth: number): React.ReactNode => {
    const { task, agent, children } = node;
    const subtree = descendants(node);
    const hasChildren = children.length > 0;
    const isCollapsed = collapsed.has(task.id);
    const detailsOpen = openDetails.has(task.id);
    const doneCount = subtree.filter(n => n.task.status === 'COMPLETED').length;
    const pendingInBranch = [node, ...subtree].filter(n => n.task.status === 'PENDING').length;
    const progress = subtree.length ? Math.round((doneCount / subtree.length) * 100) : 0;
    const isReview = task.kind === 'REVIEW';
    const usage = formatUsage(task.tokens, task.cost);
    const branchTotal = sumUsage([task, ...subtree.map(n => n.task)]);
    const branchUsage = hasChildren ? formatUsage(branchTotal.tokens, branchTotal.cost) : '';
    const finished = FINISHED_STATUSES.has(task.status);
    const composing = composer?.taskId === task.id ? composer.mode : null;

    const submitComposer = () => {
      const text = composerText.trim();
      if (!text || !composing) return;
      if (composing === 'revise') onRevise(task.id, text);
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

            <span className={styles.kind}>{depth === 0 ? 'Task' : isReview ? 'Review' : 'Sub-task'}</span>

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

              {task.status === 'COMPLETED' && !isReview && (
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

          {composing && (
            <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
              <input
                autoFocus
                type="text"
                aria-label={composing === 'revise' ? 'What should be changed' : 'New request for this project'}
                placeholder={composing === 'revise' ? 'What should be changed?' : `New request for ${task.project}…`}
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
              <button className={`${styles.cancelBtn} ${styles.approveBtn}`} onClick={submitComposer} title={composing === 'revise' ? 'Send back' : 'Assign'}>
                <Send size={11} />
                {composing === 'revise' ? 'Send back' : 'Assign'}
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
              {task.project && <div className={styles.detailTime}>Project folder: workspace/projects/{task.project}</div>}
              <div className={styles.detailTime}>{new Date(task.timestamp).toLocaleString()}</div>
            </div>
          )}
        </div>

        {hasChildren && !isCollapsed && (
          <ul className={styles.children}>
            {children.map(child => renderNode(child, depth + 1))}
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

  return <ul className={styles.tree}>{roots.map(r => renderNode(r, 0))}</ul>;
}
