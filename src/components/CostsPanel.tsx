"use client";

import React, { useMemo, useState } from 'react';
import { Agent } from '../lib/types';
import { spentAt, startOfMonth } from '../lib/officeConfig';
import { MonthStatus } from '../lib/SimulationContext';
import styles from './Dashboard.module.css';

// One hue for magnitude; state colours only on the cap meter, always with words beside them
const BAR = '#2a78d6';
const INK = '#0b0b0b';
const SECONDARY = '#52514e';
const MUTED = '#898781';
const METER = {
  ok: { fill: '#2a78d6', track: '#cde2fb' },
  warning: { fill: '#fab219', track: '#fdecc4' },
  critical: { fill: '#d03b3b', track: '#f5d3d3' },
};

const MAX_ROWS = 10;
const DAYS_SHOWN = 14;
const WARNING_SHARE = 0.8;

const money = (usd: number) => (usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);

interface Row {
  label: string;
  value: number;
  detail: string;
}

/** A ranked list of horizontal bars sharing one scale; the value is written at the end of each row. */
const BarList = ({ title, rows, empty }: { title: string; rows: Row[]; empty: string }) => {
  const max = Math.max(...rows.map(r => r.value), 0);
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <h4 style={{ margin: 0, fontSize: 12, fontWeight: 600, color: SECONDARY }}>{title}</h4>
      {rows.length === 0 && <div style={{ fontSize: 12, color: MUTED }}>{empty}</div>}
      {rows.map(row => (
        <div key={row.label} title={`${row.label}: ${money(row.value)} · ${row.detail}`} style={{ display: 'grid', gridTemplateColumns: '96px 1fr 64px', alignItems: 'center', gap: 8, fontSize: 12 }}>
          <span style={{ color: SECONDARY, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.label}</span>
          <span style={{ height: 12, display: 'block' }}>
            <span style={{ display: 'block', height: '100%', width: max > 0 ? `${Math.max((row.value / max) * 100, row.value > 0 ? 1 : 0)}%` : 0, background: BAR, borderRadius: '0 4px 4px 0' }} />
          </span>
          <span style={{ color: INK, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(row.value)}</span>
        </div>
      ))}
    </section>
  );
};

/** This month's estimated spending: against the cap, per day, per employee and per model. */
export default function CostsPanel({ agents, month, onSetCap }: { agents: Agent[]; month: MonthStatus; onSetCap: (amount: number) => void }) {
  const [capDraft, setCapDraft] = useState('');
  // The month being shown is the one the panel was opened in
  const [openedAt] = useState(() => Date.now());

  const { byDay, byEmployee, byModel, unpriced, taskCount } = useMemo(() => {
    const since = startOfMonth(openedAt);
    const days = new Map<string, { value: number; tasks: number; time: number }>();
    const employees = new Map<string, { value: number; tasks: number }>();
    const models = new Map<string, { value: number; tasks: number }>();
    let unpricedTasks = 0;
    let tasks = 0;

    for (const agent of agents) {
      for (const task of agent.taskQueue) {
        if (!task.tokens || spentAt(task) < since) continue;
        tasks += 1;
        if (task.cost === undefined) unpricedTasks += 1;
        const cost = task.cost || 0;

        const date = new Date(spentAt(task));
        const dayKey = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        const day = days.get(dayKey) || { value: 0, tasks: 0, time: new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() };
        days.set(dayKey, { ...day, value: day.value + cost, tasks: day.tasks + 1 });

        const employee = employees.get(agent.name) || { value: 0, tasks: 0 };
        employees.set(agent.name, { value: employee.value + cost, tasks: employee.tasks + 1 });

        const modelKey = task.model || 'unknown';
        const model = models.get(modelKey) || { value: 0, tasks: 0 };
        models.set(modelKey, { value: model.value + cost, tasks: model.tasks + 1 });
      }
    }

    const describe = (n: number) => `${n} task${n === 1 ? '' : 's'}`;
    const ranked = (map: Map<string, { value: number; tasks: number }>): Row[] =>
      Array.from(map, ([label, v]) => ({ label, value: v.value, detail: describe(v.tasks) })).sort((a, b) => b.value - a.value).slice(0, MAX_ROWS);

    return {
      // Days read in calendar order, newest first
      byDay: Array.from(days, ([label, v]) => ({ label, value: v.value, detail: describe(v.tasks), time: v.time })).sort((a, b) => b.time - a.time).slice(0, DAYS_SHOWN),
      byEmployee: ranked(employees),
      byModel: ranked(models),
      unpriced: unpricedTasks,
      taskCount: tasks,
    };
  }, [agents, openedAt]);

  const share = month.cap > 0 ? month.spent / month.cap : 0;
  const level = month.reached ? 'critical' : share >= WARNING_SHARE ? 'warning' : 'ok';
  const status = month.cap === 0
    ? 'No monthly cap set'
    : month.reached
      ? `Cap reached — new tasks are on hold`
      : `${Math.round(share * 100)}% of the ${money(month.cap)} cap${level === 'warning' ? ' — close to the limit' : ''}`;

  const submitCap = (e: React.FormEvent) => {
    e.preventDefault();
    const amount = Number(capDraft);
    if (capDraft.trim() === '' || !(amount >= 0)) return;
    onSetCap(amount);
    setCapDraft('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, padding: '4px 2px' }}>
      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h4 style={{ margin: 0, fontSize: 12, fontWeight: 600, color: SECONDARY }}>
          Spent in {new Date(openedAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
        </h4>
        <div style={{ fontSize: 48, fontWeight: 600, lineHeight: 1, color: INK, fontVariantNumeric: 'tabular-nums' }}>{money(month.spent)}</div>
        {month.cap > 0 && (
          <div
            role="meter"
            aria-label="Monthly spending against the cap"
            aria-valuemin={0}
            aria-valuemax={month.cap}
            aria-valuenow={Math.min(month.spent, month.cap)}
            aria-valuetext={status}
            title={`${money(month.spent)} of ${money(month.cap)}`}
            style={{ height: 12, borderRadius: 4, background: METER[level].track, overflow: 'hidden' }}
          >
            <div style={{ height: '100%', width: `${Math.min(share, 1) * 100}%`, background: METER[level].fill }} />
          </div>
        )}
        <div style={{ fontSize: 12, color: SECONDARY }}>
          {level === 'critical' ? '⛔ ' : level === 'warning' ? '⚠ ' : ''}{status} · {taskCount} task{taskCount === 1 ? '' : 's'} this month
        </div>
        <form onSubmit={submitCap} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 12, color: SECONDARY, display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
            Monthly cap ($)
            <input
              type="number"
              min="0"
              step="0.01"
              className={styles.input}
              style={{ flex: 1, minWidth: 0, padding: '6px 8px' }}
              placeholder={month.cap > 0 ? month.cap.toFixed(2) : 'none'}
              value={capDraft}
              onChange={e => setCapDraft(e.target.value)}
            />
          </label>
          <button type="submit" className={styles.button} style={{ padding: '6px 12px', fontSize: 12 }}>Set</button>
        </form>
        <div style={{ fontSize: 11, color: MUTED }}>
          When the cap is reached, running tasks finish and no new ones start. Set it to 0 for no cap.
        </div>
      </section>

      <BarList title={`Per day (last ${DAYS_SHOWN} days with activity)`} rows={byDay} empty="Nothing spent yet this month." />
      <BarList title="Per employee" rows={byEmployee} empty="Nothing spent yet this month." />
      <BarList title="Per model" rows={byModel} empty="Nothing spent yet this month." />

      <div style={{ fontSize: 11, color: MUTED }}>
        Estimates from list prices per token. Local Ollama models count as free.
        {unpriced > 0 && ` ${unpriced} task${unpriced === 1 ? ' uses' : 's use'} a model with no listed price and count${unpriced === 1 ? 's' : ''} as $0.`}
      </div>
    </div>
  );
}
