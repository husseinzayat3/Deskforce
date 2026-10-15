"use client";

import { TaskItem } from '../lib/types';
import { cleanPrompt } from '../lib/officeConfig';
import { formatDuration } from '../lib/performance';
import styles from './TaskTree.module.css';

/** Everything about a task, shown when its details are open on the task board. */
export default function TaskDetails({ task, usage, fullText, projectsDir }: {
  task: TaskItem;
  /** Tokens and cost, already formatted. */
  usage: string;
  /** The long texts the office overview leaves out, once loaded. */
  fullText?: { response?: string; report?: string };
  projectsDir: string;
}) {
  return (
    <div className={styles.details}>
      <div className={styles.detailPrompt}>{cleanPrompt(task.prompt)}</div>
      {task.response && <div className={styles.detailResponse}>{fullText?.response ?? task.response}</div>}
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
      {task.hasReport && fullText?.report && (
        <div className={styles.detailResponse}>
          <strong>Report</strong>
          {'\n\n'}
          {fullText.report}
        </div>
      )}
      {task.project && <div className={styles.detailTime}>Project folder: {projectsDir}/{task.project}</div>}
      <div className={styles.detailTime}>{new Date(task.timestamp).toLocaleString()}</div>
    </div>
  );
}
