"use client";

import React, { useState } from 'react';
import { CalendarClock, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { Agent, Template } from '../lib/types';
import { OFFICE_CONFIG } from '../lib/officeConfig';
import { WEEKDAYS, describeSchedule, formatTimeOfDay } from '../lib/schedule';
import { TemplateDraft } from '../lib/SimulationContext';
import styles from './Dashboard.module.css';

const BLANK: TemplateDraft = { name: '', prompt: '', schedule: 'none', weekday: 1, minuteOfDay: 9 * 60 };

const field: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontWeight: 600, color: '#334155', flex: 1, minWidth: 0 };
const small: React.CSSProperties = { padding: '6px 8px', fontSize: 12 };

const toMinutes = (time: string) => {
  const [hours, minutes] = time.split(':').map(Number);
  return (hours || 0) * 60 + (minutes || 0);
};

/** The form for a new or existing template, including its schedule. */
const TemplateForm = ({ initial, agents, onSave, onCancel }: { initial: TemplateDraft; agents: Agent[]; onSave: (draft: TemplateDraft) => void; onCancel: () => void }) => {
  const [draft, setDraft] = useState<TemplateDraft>(initial);
  const set = (patch: Partial<TemplateDraft>) => setDraft(prev => ({ ...prev, ...patch }));
  const scheduled = draft.schedule !== 'none';
  const valid = draft.name.trim() && draft.prompt.trim() && (!scheduled || draft.agentId);

  return (
    <form
      onSubmit={e => {
        e.preventDefault();
        if (valid) onSave(draft);
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, border: '1px solid #e2e8f0', borderRadius: 8, background: '#f8fafc' }}
    >
      <label style={field}>
        Name
        <input className={styles.input} style={small} value={draft.name} onChange={e => set({ name: e.target.value })} placeholder="Weekly dependency update" />
      </label>
      <label style={field}>
        Task
        <textarea className={styles.input} style={{ ...small, minHeight: 72, resize: 'vertical', fontFamily: 'inherit' }} value={draft.prompt} onChange={e => set({ prompt: e.target.value })} placeholder="What should be done each time" />
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <label style={field}>
          Employee
          <select className={styles.select} style={small} value={draft.agentId || ''} onChange={e => set({ agentId: e.target.value || undefined })}>
            <option value="">Choose when running</option>
            {agents.map(a => <option key={a.id} value={a.id}>{a.name} ({a.role})</option>)}
          </select>
        </label>
        <label style={{ ...field, flex: '0 0 90px' }}>
          Budget ($)
          <input type="number" min="0.01" max={OFFICE_CONFIG.MAX_TASK_BUDGET_USD} step="0.01" className={styles.input} style={small} value={draft.budget ?? ''} placeholder={OFFICE_CONFIG.DEFAULT_TASK_BUDGET_USD.toFixed(2)} onChange={e => set({ budget: Number(e.target.value) > 0 ? Number(e.target.value) : undefined })} />
        </label>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <label style={field}>
          Schedule
          <select className={styles.select} style={small} value={draft.schedule} onChange={e => set({ schedule: e.target.value as Template['schedule'] })}>
            <option value="none">Run by hand only</option>
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
          </select>
        </label>
        {draft.schedule === 'weekly' && (
          <label style={field}>
            Day
            <select className={styles.select} style={small} value={draft.weekday} onChange={e => set({ weekday: Number(e.target.value) })}>
              {WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}
            </select>
          </label>
        )}
        {scheduled && (
          <label style={{ ...field, flex: '0 0 96px' }}>
            Time
            <input type="time" className={styles.input} style={small} value={formatTimeOfDay(draft.minuteOfDay)} onChange={e => set({ minuteOfDay: toMinutes(e.target.value) })} />
          </label>
        )}
      </div>
      {initial.project && (
        <label style={{ fontSize: 12, color: '#334155', display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={Boolean(draft.project)} onChange={e => set({ project: e.target.checked ? initial.project : undefined })} />
          Keep working in the project “{initial.project}” instead of starting a new one each time
        </label>
      )}
      {scheduled && !draft.agentId && <div role="alert" style={{ fontSize: 11, color: '#dc2626' }}>A scheduled task needs an employee.</div>}
      {scheduled && <div style={{ fontSize: 11, color: '#64748b' }}>Scheduled tasks run while the office is running. A run missed while it was off happens once when it starts again.</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" className={styles.button} style={{ padding: '6px 12px', fontSize: 12 }} disabled={!valid}>Save</button>
        <button type="button" className={styles.button} style={{ padding: '6px 12px', fontSize: 12, background: '#94a3b8' }} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
};

/** Saved tasks: run one with a click, or put it on a daily or weekly schedule. */
export default function TemplatesPanel({ templates, agents, draft, onDraftDone, onSave, onRemove, onRun }: {
  templates: Template[];
  agents: Agent[];
  /** A template being created from a task on the board. */
  draft: TemplateDraft | null;
  onDraftDone: () => void;
  onSave: (template: TemplateDraft) => void;
  onRemove: (id: string) => void;
  onRun: (id: string, agentId?: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [runWith, setRunWith] = useState<Record<string, string>>({});

  const closeNew = () => {
    setCreating(false);
    onDraftDone();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 2px' }}>
      {creating || draft ? (
        <TemplateForm initial={draft || BLANK} agents={agents} onSave={t => { onSave(t); closeNew(); }} onCancel={closeNew} />
      ) : (
        <button className={styles.button} style={{ padding: '8px 12px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start' }} onClick={() => setCreating(true)}>
          <Plus size={14} /> New template
        </button>
      )}

      {templates.length === 0 && !creating && !draft && (
        <div style={{ fontSize: 12, color: '#64748b' }}>
          No templates yet. Save a task you give often, or use “Save as template” on a task in the task board.
        </div>
      )}

      {templates.map(template => {
        if (editing === template.id) {
          return <TemplateForm key={template.id} initial={template} agents={agents} onSave={t => { onSave({ ...t, id: template.id }); setEditing(null); }} onCancel={() => setEditing(null)} />;
        }
        const owner = agents.find(a => a.id === template.agentId);
        const runner = runWith[template.id] || owner?.id || '';
        return (
          <div key={template.id} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 12, border: '1px solid #e2e8f0', borderRadius: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong style={{ fontSize: 13, flex: 1, minWidth: 0, color: '#0f172a' }}>{template.name}</strong>
              <button className={styles.actionButton} onClick={() => setEditing(template.id)} title="Edit" aria-label={`Edit ${template.name}`}><Pencil size={14} /></button>
              <button className={styles.actionButton} style={{ color: '#ef4444' }} onClick={() => onRemove(template.id)} title="Delete" aria-label={`Delete ${template.name}`}><Trash2 size={14} /></button>
            </div>
            <div style={{ fontSize: 12, color: '#475569', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{template.prompt}</div>
            <div style={{ fontSize: 11, color: '#64748b', display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
              <CalendarClock size={12} />
              {describeSchedule(template)}
              {template.schedule !== 'none' && (owner ? ` · ${owner.name}` : ' · employee missing')}
              {template.nextRunAt && ` · next ${new Date(template.nextRunAt).toLocaleString()}`}
              {template.project && ` · project ${template.project}`}
              {template.budget && ` · budget $${template.budget.toFixed(2)}`}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <select aria-label="Employee to run this task" className={styles.select} style={{ ...small, flex: 1, minWidth: 0 }} value={runner} onChange={e => setRunWith(prev => ({ ...prev, [template.id]: e.target.value }))}>
                <option value="">Choose an employee</option>
                {agents.map(a => <option key={a.id} value={a.id}>{a.name} ({a.role})</option>)}
              </select>
              <button className={styles.button} style={{ padding: '6px 12px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }} disabled={!runner} onClick={() => onRun(template.id, runner)}>
                <Play size={12} /> Run now
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
