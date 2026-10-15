"use client";

import { Send, X } from 'lucide-react';
import { OFFICE_CONFIG, formatBudget } from '../lib/officeConfig';
import styles from './TaskTree.module.css';

/** What the one-line form under a task is for. */
export type ComposerMode = 'revise' | 'continue' | 'answer' | 'replan' | 'steer';

export const COMPOSER_TEXT: Record<ComposerMode, { placeholder: string; send: string }> = {
  revise: { placeholder: 'What should be changed?', send: 'Send back' },
  continue: { placeholder: 'New request for this project…', send: 'Assign' },
  answer: { placeholder: 'Your answer…', send: 'Answer' },
  replan: { placeholder: 'What should the plan do differently?', send: 'Ask for a new plan' },
  steer: { placeholder: 'Message to the employee while they work…', send: 'Send' },
};

/** The one-line form open under a task: feedback, an answer, a message, or a new request for the project. */
export default function TaskComposer({ mode, text, onText, budget, onBudget, plan, onPlan, onSubmit, onClose }: {
  mode: ComposerMode;
  text: string;
  onText: (text: string) => void;
  /** Spending limit for a new request, as typed; only used to continue a project. */
  budget: string;
  onBudget: (budget: string) => void;
  /** Whether a new request starts with a plan; only used to continue a project. */
  plan: boolean;
  onPlan: (plan: boolean) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
      <input
        autoFocus
        type="text"
        aria-label={COMPOSER_TEXT[mode].placeholder}
        placeholder={COMPOSER_TEXT[mode].placeholder}
        value={text}
        onChange={e => onText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') onSubmit();
          if (e.key === 'Escape') onClose();
        }}
        style={{ flex: 1, minWidth: 0, fontSize: 11, padding: '4px 8px', border: '1px solid #cbd5e1', borderRadius: 4 }}
      />
      {mode === 'continue' && (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: '#475569', whiteSpace: 'nowrap' }} title="Have the employee propose a plan for approval before working">
          <input type="checkbox" checked={plan} onChange={e => onPlan(e.target.checked)} />
          Plan first
        </label>
      )}
      {mode === 'continue' && (
        <input
          type="number"
          min="0.01"
          max={OFFICE_CONFIG.MAX_TASK_BUDGET_USD}
          step="0.01"
          aria-label="Budget in US dollars"
          title={`Spending limit in US dollars. Leave empty for ${formatBudget(OFFICE_CONFIG.DEFAULT_TASK_BUDGET_USD)}.`}
          placeholder={`$ ${OFFICE_CONFIG.DEFAULT_TASK_BUDGET_USD.toFixed(2)}`}
          value={budget}
          onChange={e => onBudget(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') onSubmit();
            if (e.key === 'Escape') onClose();
          }}
          style={{ width: 64, fontSize: 11, padding: '4px 6px', border: '1px solid #cbd5e1', borderRadius: 4 }}
        />
      )}
      <button className={`${styles.cancelBtn} ${styles.approveBtn}`} onClick={onSubmit}>
        <Send size={11} />
        {COMPOSER_TEXT[mode].send}
      </button>
      <button className={styles.cancelBtn} onClick={onClose} aria-label="Close">
        <X size={11} />
      </button>
    </div>
  );
}
