"use client";

import { CheckCircle2 } from 'lucide-react';
import { TaskItem } from '../lib/types';
import { budgetOf, formatBudget } from '../lib/officeConfig';
import styles from './TaskTree.module.css';

/** A proposed plan waiting for approval, with its cost estimate; editable before it is approved. */
export default function PlanReview({ task, agentName, editing, onEdit, onApprove, onDiscard }: {
  task: TaskItem;
  agentName: string;
  /** The plan as the user is editing it, or null while it is shown as proposed. */
  editing: string | null;
  onEdit: (text: string) => void;
  /** Approves the edited version. */
  onApprove: (plan: string) => void;
  onDiscard: () => void;
}) {
  return (
    <div className={`${styles.detailSummary} ${styles.callout}`}>
      <strong>{agentName} proposes:</strong>
      {editing !== null ? (
        <>
          <textarea
            aria-label="The plan"
            value={editing}
            onChange={e => onEdit(e.target.value)}
            style={{ display: 'block', width: '100%', minHeight: 160, marginTop: 6, padding: 8, fontFamily: 'inherit', fontSize: 11, lineHeight: 1.5, border: '1px solid #fbbf24', borderRadius: 6, resize: 'vertical', color: '#0f172a', background: '#fff' }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button
              className={`${styles.cancelBtn} ${styles.approveBtn}`}
              disabled={!editing.trim()}
              onClick={() => onApprove(editing.trim())}
            >
              <CheckCircle2 size={11} />
              Approve my version
            </button>
            <button className={`${styles.cancelBtn} ${styles.quietBtn}`} onClick={onDiscard}>Discard changes</button>
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
  );
}
