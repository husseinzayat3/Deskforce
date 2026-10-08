"use client";

import React, { useCallback, useEffect, useState } from 'react';
import { Download, ExternalLink, FileText, History, ListChecks, Play, RotateCcw, X } from 'lucide-react';
import styles from './Dashboard.module.css';

interface Commit {
  id: string;
  message: string;
  author: string;
  time: number;
}

interface DiffLine {
  type: 'context' | 'add' | 'remove' | 'gap';
  text: string;
}

interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

interface Overview {
  files: string[];
  history: Commit[];
  canPreview: boolean;
  /** Whether running checks is turned on in the settings. */
  canCheck: boolean;
}

type View =
  | { kind: 'empty' }
  | { kind: 'file'; path: string; text?: string; size: number }
  | { kind: 'commit'; commit: Commit; files: FileChange[] }
  | { kind: 'preview'; url: string }
  | { kind: 'checks'; passed: boolean; output: string };

const DIFF_STYLE: Record<DiffLine['type'], React.CSSProperties> = {
  context: { color: '#334155' },
  add: { background: '#ecfdf5', color: '#065f46' },
  remove: { background: '#fef2f2', color: '#991b1b' },
  gap: { color: '#94a3b8', fontStyle: 'italic', background: '#f8fafc' },
};
// The sign carries the meaning too, so a diff does not depend on telling red from green
const DIFF_SIGN: Record<DiffLine['type'], string> = { context: ' ', add: '+', remove: '-', gap: '⋯' };

const STATUS_LABEL: Record<FileChange['status'], string> = { added: 'new file', modified: 'changed', deleted: 'deleted' };

const mono: React.CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, lineHeight: 1.5 };
const listButton = (active: boolean): React.CSSProperties => ({
  display: 'block', width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer', padding: '6px 10px', borderRadius: 6,
  background: active ? '#e0edff' : 'transparent', color: '#0f172a', fontSize: 12, overflowWrap: 'anywhere',
});

const getJson = async (url: string) => {
  const res = await fetch(url, { cache: 'no-store' });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};

const postJson = async (body: Record<string, unknown>) => {
  const res = await fetch('/api/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};

/** A project's files and history: read any file, see what each task changed, undo a task, preview a web page. */
export default function ProjectBrowser({ project, commitId, initialFile, onClose, notify }: {
  project: string;
  /** Open straight on what this commit changed. */
  commitId?: string;
  /** Open straight on this file. */
  initialFile?: string;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [tab, setTab] = useState<'files' | 'history'>(commitId ? 'history' : 'files');
  const [view, setView] = useState<View>({ kind: 'empty' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const base = `/api/workspace?project=${encodeURIComponent(project)}`;

  const run = useCallback(async (work: () => Promise<void>) => {
    setError('');
    setBusy(true);
    try {
      await work();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }, []);

  const showCommit = useCallback((commit: Commit) => run(async () => {
    const data = await getJson(`${base}&commit=${commit.id}`);
    setView({ kind: 'commit', commit, files: data.files });
  }), [base, run]);

  const load = useCallback(() => run(async () => {
    setOverview(await getJson(base));
  }), [base, run]);

  // First load. The dialog is remounted for each project, so this runs once per opening.
  useEffect(() => {
    let closed = false;
    (async () => {
      try {
        const data: Overview = await getJson(base);
        if (closed) return;
        setOverview(data);
        if (initialFile) {
          const file = await getJson(`${base}&file=${encodeURIComponent(initialFile)}`);
          if (!closed) setView({ kind: 'file', path: initialFile, text: file.text, size: file.size });
        }
        const target = commitId && data.history.find(c => c.id === commitId);
        if (target) {
          const changes = await getJson(`${base}&commit=${target.id}`);
          if (!closed) setView({ kind: 'commit', commit: target, files: changes.files });
        }
      } catch (e: any) {
        if (!closed) setError(e.message);
      }
    })();
    return () => {
      closed = true;
    };
  }, [base, commitId, initialFile]);

  const showFile = (path: string) => run(async () => {
    const data = await getJson(`${base}&file=${encodeURIComponent(path)}`);
    setView({ kind: 'file', path, text: data.text, size: data.size });
  });

  const showPreview = () => run(async () => {
    const data = await postJson({ action: 'preview', project });
    setView({ kind: 'preview', url: data.url });
  });

  const showChecks = () => run(async () => {
    const result = await postJson({ action: 'check', project });
    setView({ kind: 'checks', passed: result.passed, output: result.output });
  });

  const undo = (commit: Commit) => {
    if (!window.confirm(`Undo "${commit.message.split('\n')[0]}"?\n\nEvery file this task changed goes back to how it was before. Files changed again since then are left alone.`)) return;
    run(async () => {
      const result = await postJson({ action: 'undo', project, commit: commit.id });
      notify(
        result.restored.length === 0
          ? 'Nothing was undone: every file was changed again afterwards.'
          : `Undone: ${result.restored.length} file${result.restored.length > 1 ? 's' : ''} restored${result.skipped.length ? `, ${result.skipped.length} left alone (changed since)` : ''}.`
      );
      setView({ kind: 'empty' });
      await load();
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Files of ${project}`}
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 900, background: 'rgba(15, 23, 42, 0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
    >
      <div onClick={e => e.stopPropagation()} className={styles.card} style={{ width: 'min(1100px, 100%)', height: 'min(760px, 100%)', padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid #e2e8f0' }}>
          <strong style={{ fontSize: 14, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project}</strong>
          {overview?.canCheck && (
            <button className={styles.button} style={{ padding: '6px 10px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4, background: '#475569' }} onClick={showChecks} disabled={busy} title="Check the syntax of the files and run the project's tests">
              <ListChecks size={13} /> {busy ? 'Working…' : 'Run checks'}
            </button>
          )}
          {overview?.canPreview && (
            <button className={styles.button} style={{ padding: '6px 10px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }} onClick={showPreview} disabled={busy}>
              <Play size={13} /> Run preview
            </button>
          )}
          <a className={styles.button} style={{ padding: '6px 10px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4, textDecoration: 'none', background: '#475569' }} href={`${base}&download=1`} download>
            <Download size={13} /> .zip
          </a>
          <button className={styles.actionButton} onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <div style={{ width: 280, flexShrink: 0, borderRight: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div role="tablist" style={{ display: 'flex', gap: 4, padding: 8 }}>
              <button role="tab" aria-selected={tab === 'files'} style={{ ...listButton(tab === 'files'), textAlign: 'center', fontWeight: 600 }} onClick={() => setTab('files')}>
                <FileText size={12} /> Files{overview ? ` (${overview.files.length})` : ''}
              </button>
              <button role="tab" aria-selected={tab === 'history'} style={{ ...listButton(tab === 'history'), textAlign: 'center', fontWeight: 600 }} onClick={() => setTab('history')}>
                <History size={12} /> History{overview ? ` (${overview.history.length})` : ''}
              </button>
            </div>
            <div style={{ overflowY: 'auto', padding: '0 8px 8px', flex: 1 }}>
              {!overview && !error && <div style={{ fontSize: 12, color: '#64748b', padding: 8 }}>Loading…</div>}
              {overview && tab === 'files' && (overview.files.length === 0
                ? <div style={{ fontSize: 12, color: '#64748b', padding: 8 }}>No files yet.</div>
                : overview.files.map(file => (
                  <button key={file} style={{ ...listButton(view.kind === 'file' && view.path === file), ...mono }} onClick={() => showFile(file)}>{file}</button>
                )))}
              {overview && tab === 'history' && (overview.history.length === 0
                ? <div style={{ fontSize: 12, color: '#64748b', padding: 8 }}>No history yet. Each task that writes files adds an entry here.</div>
                : overview.history.map(commit => (
                  <button key={commit.id} style={listButton(view.kind === 'commit' && view.commit.id === commit.id)} onClick={() => showCommit(commit)}>
                    <span style={{ fontWeight: 600 }}>{commit.message.split('\n')[0]}</span>
                    <span style={{ display: 'block', color: '#64748b', fontSize: 11 }}>{commit.author} · {new Date(commit.time).toLocaleString()}</span>
                  </button>
                )))}
            </div>
          </div>

          <div style={{ flex: 1, minWidth: 0, overflow: 'auto', background: '#fcfcfb' }}>
            {error && <div role="alert" style={{ margin: 16, fontSize: 12, color: '#dc2626' }}>{error}</div>}

            {view.kind === 'empty' && !error && (
              <div style={{ padding: 24, fontSize: 13, color: '#64748b' }}>
                Choose a file to read it, or an entry in the history to see what that task changed.
              </div>
            )}

            {view.kind === 'file' && (
              <div>
                <div style={{ padding: '10px 16px', fontSize: 12, color: '#64748b', borderBottom: '1px solid #e2e8f0', ...mono }}>{view.path} · {view.size.toLocaleString()} bytes</div>
                {view.text === undefined
                  ? <div style={{ padding: 16, fontSize: 13, color: '#64748b' }}>This file is binary or too large to show. It is included in the .zip.</div>
                  : <pre style={{ margin: 0, padding: 16, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: '#0f172a', ...mono }}>{view.text}</pre>}
              </div>
            )}

            {view.kind === 'commit' && (
              <div>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid #e2e8f0', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>{view.commit.message.split('\n')[0]}</div>
                    <div style={{ fontSize: 11, color: '#64748b' }}>
                      {view.commit.author} · {new Date(view.commit.time).toLocaleString()} · {view.files.length} file{view.files.length === 1 ? '' : 's'}
                    </div>
                  </div>
                  <button className={styles.button} style={{ padding: '6px 10px', fontSize: 12, background: '#dc2626', display: 'inline-flex', alignItems: 'center', gap: 4 }} onClick={() => undo(view.commit)} disabled={busy}>
                    <RotateCcw size={13} /> Undo this change
                  </button>
                </div>
                {view.files.map(file => (
                  <div key={file.path} style={{ borderBottom: '1px solid #e2e8f0' }}>
                    <div style={{ padding: '8px 16px', background: '#f1f5f9', color: '#0f172a', ...mono }}>
                      {file.path} <span style={{ color: '#64748b' }}>— {STATUS_LABEL[file.status]}, +{file.additions} −{file.deletions}</span>
                    </div>
                    {file.lines.length === 0
                      ? <div style={{ padding: '8px 16px', fontSize: 12, color: '#64748b' }}>Binary or very large file: contents not shown.</div>
                      : (
                        <pre style={{ margin: 0, ...mono }}>
                          {file.lines.map((line, index) => (
                            <div key={index} style={{ ...DIFF_STYLE[line.type], padding: '0 16px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                              {DIFF_SIGN[line.type]} {line.text}
                            </div>
                          ))}
                        </pre>
                      )}
                  </div>
                ))}
              </div>
            )}

            {view.kind === 'checks' && (
              <div>
                <div style={{ padding: '10px 16px', fontSize: 13, fontWeight: 600, borderBottom: '1px solid #e2e8f0', color: view.passed ? '#065f46' : '#991b1b' }}>
                  {view.passed ? '✓ Checks passed' : '✗ Checks failed'}
                </div>
                <pre style={{ margin: 0, padding: 16, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: '#0f172a', ...mono }}>{view.output}</pre>
              </div>
            )}

            {view.kind === 'preview' && (
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <div style={{ padding: '8px 16px', fontSize: 12, color: '#64748b', borderBottom: '1px solid #e2e8f0', display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ flex: 1 }}>Showing the project&apos;s web page as written. Nothing is built or installed, so projects that need a build step will not run here.</span>
                  <a href={view.url} target="_blank" rel="noreferrer" style={{ color: '#2563eb', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <ExternalLink size={12} /> Open in browser
                  </a>
                </div>
                <iframe title={`Preview of ${project}`} src={view.url} sandbox="allow-scripts allow-same-origin allow-forms allow-modals" style={{ flex: 1, border: 'none', background: 'white' }} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
