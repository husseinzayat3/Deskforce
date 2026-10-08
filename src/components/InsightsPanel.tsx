"use client";

import React, { useMemo, useState } from 'react';
import { FileText, FolderTree, Play, Scale, UserCheck, X } from 'lucide-react';
import { Agent, APIProvider, TaskItem } from '../lib/types';
import { MODEL_SUGGESTIONS, OFFICE_CONFIG, formatCost } from '../lib/officeConfig';
import { Performance, formatDuration, measurePerformance } from '../lib/performance';
import { MonthStatus } from '../lib/SimulationContext';
import CostsPanel from './CostsPanel';
import ProjectBrowser from './ProjectBrowser';
import { PROVIDERS } from './EmployeeEditor';
import styles from './Dashboard.module.css';

const INK = '#0b0b0b';
const SECONDARY = '#52514e';
const MUTED = '#898781';

const heading: React.CSSProperties = { margin: 0, fontSize: 12, fontWeight: 600, color: SECONDARY };
const hint: React.CSSProperties = { fontSize: 11, color: MUTED };
const cell: React.CSSProperties = { padding: '6px 4px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const small: React.CSSProperties = { padding: '6px 8px', fontSize: 12 };

const percent = (share: number) => `${Math.round(share * 100)}%`;

// --- Performance ----------------------------------------------------------------

const PerformanceTable = ({ title, firstColumn, rows }: { title: string; firstColumn: string; rows: Performance[] }) => (
  <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <h4 style={heading}>{title}</h4>
    {rows.length === 0 ? (
      <div style={hint}>No finished tasks yet.</div>
    ) : (
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: INK }}>
        <thead>
          <tr style={{ color: MUTED, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.3 }}>
            <th style={{ ...cell, textAlign: 'left', fontWeight: 600 }}>{firstColumn}</th>
            <th style={{ ...cell, fontWeight: 600 }}>Tasks</th>
            <th style={{ ...cell, fontWeight: 600 }} title="Share of tasks that completed rather than failed">Success</th>
            <th style={{ ...cell, fontWeight: 600 }} title="Share of completed tasks that were sent back, retried, ended with problems, or had a file rewritten by a later review">Fixed after</th>
            <th style={{ ...cell, fontWeight: 600 }}>Avg cost</th>
            <th style={{ ...cell, fontWeight: 600 }} title="Average time the model worked on a task">Avg time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.name} style={{ borderTop: '1px solid #e1e0d9' }}>
              <td style={{ ...cell, textAlign: 'left', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', color: SECONDARY }} title={row.name}>{row.name}</td>
              <td style={cell}>{row.tasks}</td>
              <td style={cell}>{percent(row.successRate)}</td>
              <td style={cell}>{percent(row.fixRate)}</td>
              <td style={cell}>{row.averageCost === undefined ? '–' : row.averageCost === 0 ? 'free' : formatCost(row.averageCost).replace('~', '')}</td>
              <td style={cell}>{formatDuration(row.averageMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </section>
);

const PerformanceView = ({ agents }: { agents: Agent[] }) => {
  const { employees, models } = useMemo(() => measurePerformance(agents), [agents]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PerformanceTable title="Per employee" firstColumn="Employee" rows={employees} />
      <PerformanceTable title="Per model" firstColumn="Model" rows={models} />
      <div style={hint}>
        Counts each employee&apos;s own tasks that completed or failed; reviews, follow-ups and meetings are left out. &quot;Fixed after&quot; is the share of
        completed tasks that you sent back, that had to be retried, that ended with problems, or whose files a later review rewrote.
        Deleted tasks are not counted, and a few tasks say little: compare models on the same request for a fair test.
      </div>
    </div>
  );
};

// --- Comparison -----------------------------------------------------------------

interface Candidate {
  api: APIProvider;
  model: string;
}

interface Run {
  task: TaskItem;
  agent: Agent;
}

/** What a comparison task ran on, as the user chose it. */
const candidateLabel = (task: TaskItem) => `${task.apiOverride || ''}${task.modelOverride ? ` · ${task.modelOverride}` : ' · default model'}`;

const STATUS_WORDS: Record<string, string> = {
  PENDING: 'Waiting', IN_PROGRESS: 'Working…', COMPLETED: 'Done', FAILED: 'Failed', CANCELLED: 'Cancelled', WAITING_FOR_INPUT: 'Has a question', AWAITING_APPROVAL: 'Needs approval', PLAN_REVIEW: 'Plan to approve',
};

/** The runs of one comparison next to each other. */
const ComparisonDialog = ({ runs, onUse, onClose, notify }: { runs: Run[]; onUse: (run: Run) => void; onClose: () => void; notify: (message: string) => void }) => {
  const [browsing, setBrowsing] = useState<string | null>(null);
  const finished = runs.filter(r => r.task.status === 'COMPLETED');
  // The best figure in each row is marked, once there is something to compare
  const lowest = (pick: (task: TaskItem) => number | undefined) => {
    const values = finished.map(r => pick(r.task)).filter((v): v is number => v !== undefined);
    return values.length > 1 ? Math.min(...values) : undefined;
  };
  const cheapest = lowest(t => t.cost);
  const fastest = lowest(t => t.durationMs);
  const best: React.CSSProperties = { fontWeight: 700, color: '#006300' };

  const downloadReport = async (task: TaskItem) => {
    try {
      const full = await (await fetch(`/api/office?task=${encodeURIComponent(task.id)}`, { cache: 'no-store' })).json();
      const url = URL.createObjectURL(new Blob([full.report || ''], { type: 'text/markdown;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${task.project || 'comparison'}-report.md`;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      notify('The report could not be loaded.');
    }
  };

  const row = (label: string, render: (run: Run) => React.ReactNode, title?: string) => (
    <tr style={{ borderTop: '1px solid #e1e0d9', verticalAlign: 'top' }}>
      <th scope="row" title={title} style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, fontWeight: 600, color: MUTED, whiteSpace: 'nowrap' }}>{label}</th>
      {runs.map(run => <td key={run.task.id} style={{ padding: '8px 12px', fontSize: 12, color: INK, overflowWrap: 'anywhere' }}>{render(run)}</td>)}
    </tr>
  );

  return (
    <div role="dialog" aria-modal="true" aria-label="Model comparison" onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 900, background: 'rgba(15, 23, 42, 0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      {browsing && <ProjectBrowser key={browsing} project={browsing} onClose={() => setBrowsing(null)} notify={notify} />}
      <div onClick={e => e.stopPropagation()} className={styles.card} style={{ width: 'min(1100px, 100%)', maxHeight: '100%', overflow: 'auto', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>Model comparison</h3>
            <div style={{ ...hint, marginTop: 4, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{runs[0].task.prompt}</div>
          </div>
          <button type="button" className={styles.actionButton} onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: 96 }} />
            {runs.map(run => <col key={run.task.id} />)}
          </colgroup>
          <thead>
            <tr>
              <th />
              {runs.map(run => (
                <th key={run.task.id} scope="col" style={{ padding: '0 12px 8px', textAlign: 'left', fontSize: 13, color: INK, overflowWrap: 'anywhere' }}>
                  {run.task.model && run.task.model !== 'mock' ? run.task.model : candidateLabel(run.task)}
                  <div style={{ ...hint, fontWeight: 400 }}>{run.task.apiOverride}{run.task.model === 'mock' ? ' · no API key: mock answer' : ''}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {row('Result', run => (
              <span style={{ fontWeight: 600, color: run.task.status === 'FAILED' ? '#b91c1c' : INK }}>
                {run.task.status === 'COMPLETED' ? '✓ ' : run.task.status === 'FAILED' ? '✗ ' : ''}{STATUS_WORDS[run.task.status] || run.task.status}
              </span>
            ))}
            {row('Time', run => <span style={run.task.durationMs !== undefined && run.task.durationMs === fastest ? best : undefined}>{formatDuration(run.task.durationMs)}{run.task.durationMs === fastest ? ' · fastest' : ''}</span>, 'Time the model worked on the task')}
            {row('Cost', run => (
              <span style={run.task.cost !== undefined && run.task.cost === cheapest ? best : undefined}>
                {run.task.tokens ? formatCost(run.task.cost).replace('~', '') : '–'}{run.task.cost !== undefined && run.task.cost === cheapest ? ' · cheapest' : ''}
              </span>
            ), 'Estimated from list prices')}
            {row('Tokens', run => (run.task.tokens
              ? <>{run.task.tokens.toLocaleString('en-US')}{run.task.cachedTokens ? <span style={hint}> · {percent(run.task.cachedTokens / run.task.tokens)} from cache</span> : null}</>
              : '–'))}
            {row('Files', run => (run.task.files?.length
              ? <>{run.task.files.length}<div style={{ ...hint, fontFamily: 'ui-monospace, monospace' }}>{run.task.files.slice(0, 12).map(f => <div key={f}>{f}</div>)}{run.task.files.length > 12 ? `…and ${run.task.files.length - 12} more` : ''}</div></>
              : 'None'))}
            {row('Checks', run => (run.task.checkPassed === undefined ? <span style={hint}>Not run</span> : run.task.checkPassed ? '✓ Passed' : <span style={{ color: '#b91c1c' }}>✗ Failed</span>), 'Syntax checks and tests, when they are turned on in the settings')}
            {row('In its own words', run => <span style={{ whiteSpace: 'pre-wrap' }}>{run.task.error || run.task.summary || (run.task.clipped ? `${run.task.response}` : run.task.response) || '–'}</span>)}
            {row('', run => (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {run.task.project && (
                  <button className={styles.headerButton} style={{ background: '#475569', height: 28 }} onClick={() => setBrowsing(run.task.project!)}>
                    <FolderTree size={12} /> Files
                  </button>
                )}
                {run.task.hasReport && (
                  <button className={styles.headerButton} style={{ background: '#475569', height: 28 }} onClick={() => downloadReport(run.task)}>
                    <FileText size={12} /> Report
                  </button>
                )}
                {run.task.status === 'COMPLETED' && run.task.apiOverride && (
                  <button className={styles.headerButton} style={{ background: '#2a78d6', height: 28 }} onClick={() => onUse(run)} title={`Make this ${run.agent.name}'s model from now on`}>
                    <UserCheck size={12} /> Use for {run.agent.name}
                  </button>
                )}
              </div>
            ))}
          </tbody>
        </table>

        <div style={hint}>
          Each model worked alone on the same request, in {runs[0].agent.name}&apos;s role, in a project of its own. One run is one sample: models vary from run to run, so repeat the comparison before deciding on close results.
        </div>
      </div>
    </div>
  );
};

const CompareView = ({ agents, onCompare, onUse, notify }: {
  agents: Agent[];
  onCompare: (agentId: string, prompt: string, candidates: Candidate[], budget?: number) => void;
  onUse: (agentId: string, api: APIProvider, model: string) => void;
  notify: (message: string) => void;
}) => {
  const [agentId, setAgentId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [budget, setBudget] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([{ api: 'OpenAI', model: '' }, { api: 'Anthropic', model: '' }]);
  const [openId, setOpenId] = useState<string | null>(null);
  const owner = agents.find(a => a.id === agentId) || agents[0];

  // Comparisons, newest first, each with its runs in the order they were queued
  const comparisons = useMemo(() => {
    const groups = new Map<string, Run[]>();
    agents.forEach(agent => agent.taskQueue.forEach(task => {
      if (task.compareId && !task.parentId) groups.set(task.compareId, [...(groups.get(task.compareId) || []), { task, agent }]);
    }));
    return Array.from(groups, ([id, runs]) => ({ id, runs: runs.sort((a, b) => a.task.timestamp - b.task.timestamp) }))
      .sort((a, b) => b.runs[0].task.timestamp - a.runs[0].task.timestamp);
  }, [agents]);

  const setCandidate = (index: number, patch: Partial<Candidate>) => setCandidates(prev => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  const distinct = new Set(candidates.map(c => `${c.api}:${c.model.trim()}`)).size === candidates.length;
  const ready = Boolean(owner && prompt.trim() && distinct);
  const open = comparisons.find(c => c.id === openId);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {open && (
        <ComparisonDialog
          runs={open.runs}
          notify={notify}
          onClose={() => setOpenId(null)}
          onUse={run => {
            onUse(run.agent.id, run.task.apiOverride!, run.task.modelOverride || '');
            notify(`${run.agent.name} now uses ${run.task.apiOverride}${run.task.modelOverride ? ` · ${run.task.modelOverride}` : ''}.`);
          }}
        />
      )}

      <form
        onSubmit={e => {
          e.preventDefault();
          if (!ready) return;
          onCompare(owner.id, prompt.trim(), candidates.map(c => ({ api: c.api, model: c.model.trim() })), Number(budget) > 0 ? Number(budget) : undefined);
          setPrompt('');
          notify('Comparison queued. The models run one after the other.');
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
      >
        <h4 style={heading}>Try the same task on different models</h4>
        <textarea className={styles.input} style={{ ...small, minHeight: 64, resize: 'vertical', fontFamily: 'inherit' }} aria-label="Task to compare the models on" placeholder="A task that is typical of what you would give this employee" value={prompt} onChange={e => setPrompt(e.target.value)} />
        {candidates.map((candidate, index) => (
          <div key={index} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <select aria-label={`Provider ${index + 1}`} className={styles.select} style={{ ...small, flex: '0 0 44%' }} value={candidate.api} onChange={e => setCandidate(index, { api: e.target.value as APIProvider, model: '' })}>
              {PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
            <input aria-label={`Model ${index + 1}`} className={styles.input} style={{ ...small, flex: 1, minWidth: 0 }} list={`compare-models-${index}`} placeholder="Model (empty = default)" value={candidate.model} onChange={e => setCandidate(index, { model: e.target.value })} autoComplete="off" spellCheck={false} />
            <datalist id={`compare-models-${index}`}>{(MODEL_SUGGESTIONS[candidate.api] || []).map(m => <option key={m} value={m} />)}</datalist>
            {candidates.length > 2 && (
              <button type="button" className={styles.actionButton} onClick={() => setCandidates(prev => prev.filter((_, i) => i !== index))} aria-label={`Remove model ${index + 1}`}><X size={14} /></button>
            )}
          </div>
        ))}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select aria-label="Whose role the models work in" title="The models work in this employee's role, with its instructions" className={styles.select} style={{ ...small, flex: 1, minWidth: 0 }} value={owner?.id || ''} onChange={e => setAgentId(e.target.value)}>
            {agents.map(a => <option key={a.id} value={a.id}>As {a.name} ({a.role})</option>)}
          </select>
          <input type="number" min="0.01" max={OFFICE_CONFIG.MAX_TASK_BUDGET_USD} step="0.01" aria-label="Budget per model in US dollars" title="Spending limit for each model's run" className={styles.input} style={{ ...small, flex: '0 0 84px' }} placeholder={`$ ${OFFICE_CONFIG.DEFAULT_TASK_BUDGET_USD.toFixed(2)}`} value={budget} onChange={e => setBudget(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {candidates.length < 3 && (
            <button type="button" className={styles.headerButton} style={{ background: '#475569' }} onClick={() => setCandidates(prev => [...prev, { api: 'Gemini', model: '' }])}>Add a third model</button>
          )}
          <button type="submit" className={styles.headerButton} style={{ background: ready ? '#2a78d6' : '#94a3b8', marginLeft: 'auto' }} disabled={!ready}>
            <Play size={13} /> Run comparison
          </button>
        </div>
        {!distinct && <div role="alert" style={{ fontSize: 11, color: '#b91c1c' }}>Choose different models: two of these are the same.</div>}
        {agents.length === 0 && <div style={hint}>Hire an employee first: the models work in an employee&apos;s role.</div>}
        <div style={hint}>Each model does the whole task alone, so every run costs what a normal task costs. A provider without an API key answers with mock text.</div>
      </form>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h4 style={heading}>Comparisons</h4>
        {comparisons.length === 0 && <div style={hint}>None yet.</div>}
        {comparisons.map(({ id, runs }) => {
          const done = runs.filter(r => r.task.status === 'COMPLETED' || r.task.status === 'FAILED' || r.task.status === 'CANCELLED').length;
          return (
            <button key={id} onClick={() => setOpenId(id)} style={{ textAlign: 'left', padding: '8px 10px', border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff', cursor: 'pointer', font: 'inherit' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{runs[0].task.prompt.split('\n')[0]}</div>
              <div style={{ ...hint, display: 'flex', alignItems: 'center', gap: 4 }}>
                <Scale size={11} />
                {runs.map(r => r.task.modelOverride || r.task.apiOverride).join(' vs ')} · {done === runs.length ? 'finished' : `${done} of ${runs.length} done`} · {new Date(runs[0].task.timestamp).toLocaleDateString()}
              </div>
            </button>
          );
        })}
      </section>
    </div>
  );
};

// --- The tab --------------------------------------------------------------------

type View = 'spending' | 'performance' | 'compare';
const VIEWS: { id: View; label: string }[] = [
  { id: 'spending', label: 'Spending' },
  { id: 'performance', label: 'Performance' },
  { id: 'compare', label: 'Compare models' },
];

/** What the office costs, how well each employee and model does, and model comparisons. */
export default function InsightsPanel({ agents, month, onSetCap, onCompare, onUse, notify }: {
  agents: Agent[];
  month: MonthStatus;
  onSetCap: (amount: number) => void;
  onCompare: (agentId: string, prompt: string, candidates: Candidate[], budget?: number) => void;
  onUse: (agentId: string, api: APIProvider, model: string) => void;
  notify: (message: string) => void;
}) {
  const [view, setView] = useState<View>('spending');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 2px' }}>
      <div role="tablist" aria-label="Insights" style={{ display: 'flex', gap: 4 }}>
        {VIEWS.map(({ id, label }) => (
          <button
            key={id}
            role="tab"
            aria-selected={view === id}
            onClick={() => setView(id)}
            style={{ flex: 1, padding: '6px 4px', border: '1px solid', borderColor: view === id ? '#2a78d6' : '#e2e8f0', borderRadius: 6, background: view === id ? '#eaf2fd' : '#fff', color: view === id ? '#184f95' : SECONDARY, font: 'inherit', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            {label}
          </button>
        ))}
      </div>
      {view === 'spending' && <CostsPanel agents={agents} month={month} onSetCap={onSetCap} />}
      {view === 'performance' && <PerformanceView agents={agents} />}
      {view === 'compare' && <CompareView agents={agents} onCompare={onCompare} onUse={onUse} notify={notify} />}
    </div>
  );
}
