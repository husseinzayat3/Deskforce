"use client";

import React, { useEffect, useState } from 'react';
import { FileText, ListTree } from 'lucide-react';
import styles from './Dashboard.module.css';

interface TaskHit {
  taskId: string;
  title: string;
  where: 'request' | 'response' | 'summary' | 'plan';
  snippet: string;
  status: string;
  project?: string;
}

interface FileHit {
  project: string;
  path: string;
  line: number;
  snippet: string;
  matches: number;
}

const WHERE: Record<TaskHit['where'], string> = { request: 'in the request', response: 'in the response', summary: 'in the summary', plan: 'in the plan' };
const hint: React.CSSProperties = { fontSize: 11, color: '#64748b' };
const row: React.CSSProperties = { display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff', font: 'inherit', cursor: 'pointer', minWidth: 0 };

/** The text with every occurrence of the query set in bold. */
const Marked = ({ text, query }: { text: string; query: string }) => {
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(needle); needle && at !== -1; at = lower.indexOf(needle, from)) {
    parts.push(text.slice(from, at), <mark key={at} style={{ background: '#fef08a', color: 'inherit', borderRadius: 2 }}>{text.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
};

/** What a search found, in tasks and in project files. */
export default function SearchPanel({ query, onOpenTask, onOpenFile }: {
  query: string;
  onOpenTask: (taskId: string) => void;
  onOpenFile: (project: string, path: string) => void;
}) {
  const [found, setFound] = useState<{ query: string; tasks: TaskHit[]; files: FileHit[] } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let closed = false;
    // A short pause, so a search is made for what was typed and not for every letter on the way
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(query)}`, { cache: 'no-store' })
        .then(res => res.json())
        .then(data => {
          if (closed) return;
          if (data.error) setError(data.error);
          else {
            setError('');
            setFound({ query, tasks: data.tasks || [], files: data.files || [] });
          }
        })
        .catch(() => { if (!closed) setError('The search could not be run.'); });
    }, 250);
    return () => {
      closed = true;
      clearTimeout(timer);
    };
  }, [query]);

  if (error) return <div role="alert" style={{ fontSize: 12, color: '#dc2626', padding: 8 }}>{error}</div>;
  if (!found || found.query !== query) return <div style={{ ...hint, padding: 8 }}>Searching…</div>;
  if (found.tasks.length === 0 && found.files.length === 0) {
    return <div style={{ ...hint, padding: 8 }}>Nothing found for “{query}” in tasks or project files.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} aria-live="polite">
      {found.tasks.length > 0 && <h4 style={{ margin: '4px 0 0', fontSize: 12, color: '#475569' }}>Tasks ({found.tasks.length})</h4>}
      {found.tasks.map(hit => (
        <button key={hit.taskId} style={row} onClick={() => onOpenTask(hit.taskId)}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: '#0f172a', minWidth: 0 }}>
            <ListTree size={12} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><Marked text={hit.title} query={query} /></span>
            <span className={styles.taskStatus} style={{ background: '#f1f5f9', color: '#64748b', flexShrink: 0 }}>{hit.status.replace(/_/g, ' ').toLowerCase()}</span>
          </div>
          <div style={{ fontSize: 11, color: '#334155', marginTop: 2, overflowWrap: 'anywhere' }}><Marked text={hit.snippet} query={query} /></div>
          <div style={hint}>{WHERE[hit.where]}{hit.project ? ` · ${hit.project}` : ''}</div>
        </button>
      ))}

      {found.files.length > 0 && <h4 style={{ margin: '8px 0 0', fontSize: 12, color: '#475569' }}>Files ({found.files.length})</h4>}
      {found.files.map(hit => (
        <button key={`${hit.project}/${hit.path}`} style={row} onClick={() => onOpenFile(hit.project, hit.path)}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: '#0f172a', minWidth: 0, fontFamily: 'ui-monospace, monospace' }}>
            <FileText size={12} style={{ flexShrink: 0 }} />
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><Marked text={hit.path} query={query} />{hit.line ? `:${hit.line}` : ''}</span>
          </div>
          {hit.line > 0 && <div style={{ fontSize: 11, color: '#334155', marginTop: 2, overflowWrap: 'anywhere', fontFamily: 'ui-monospace, monospace' }}><Marked text={hit.snippet} query={query} /></div>}
          <div style={hint}>{hit.project}{hit.matches > 1 ? ` · ${hit.matches} matching lines` : ''}</div>
        </button>
      ))}
    </div>
  );
}
