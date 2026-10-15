"use client";

import { Agent } from '../lib/types';
import { cleanPrompt, formatUsage } from '../lib/officeConfig';
import styles from './Dashboard.module.css';

/** An employee's tasks, newest first, under their row in the team list. */
export default function TaskHistory({ agent, onCancel }: { agent: Agent; onCancel: (taskId: string) => void }) {
  return (
    <div className={styles.historyPanel} onClick={(e) => e.stopPropagation()}>
      <h4 className={styles.historyTitle}>Task Queue & History</h4>
      {agent.taskQueue && agent.taskQueue.length > 0 ? (
        <div className={styles.historyList}>
          {agent.taskQueue.map((task) => (
            <div key={task.id} className={styles.historyItem} data-status={task.status}>
              <div className={styles.historyHeader}>
                <span className={styles.taskStatus}>{task.status}</span>
                <span className={styles.taskAssigner}>
                  {task.kind === 'REVIEW' ? 'Final review · ' : task.parentId ? 'Sub-task · ' : ''}From: {task.assignedBy}
                </span>
              </div>
              <div className={styles.historyPrompt}>
                <strong>{task.title || 'Task'}:</strong> {cleanPrompt(task.prompt)}
              </div>
              {task.response && (
                <div className={styles.historyResponse}>
                  <strong>Response:</strong> {task.response}{task.clipped ? ' (open the task on the task board for the rest)' : ''}
                </div>
              )}
              {task.error && (
                <div className={styles.historyError}>
                  <strong>Error:</strong> {task.error}
                </div>
              )}
              <div className={styles.historyFooter}>
                <span className={styles.historyTime}>
                  {new Date(task.timestamp).toLocaleTimeString()}
                  {task.tokens ? ` · ${formatUsage(task.tokens, task.cost)}` : ''}
                </span>
                {task.status === 'PENDING' && (
                  <button
                    className={styles.cancelTaskBtn}
                    onClick={() => onCancel(task.id)}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.noHistory}>No tasks assigned yet.</div>
      )}
    </div>
  );
}
