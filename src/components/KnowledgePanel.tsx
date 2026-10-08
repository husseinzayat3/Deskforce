"use client";

import React, { useState } from 'react';
import { Trash2, X } from 'lucide-react';
import { Note } from '../lib/types';
import styles from './Dashboard.module.css';

const MAX_HANDBOOK_CHARS = 8000;
const hint: React.CSSProperties = { fontSize: 11, color: '#64748b' };

/** What every agent knows before it starts: the handbook you write, and the notes agents saved. */
export default function KnowledgePanel({ handbook, notes, onSave, onRemoveNote, onClose }: {
  handbook: string;
  notes: Note[];
  onSave: (text: string) => void;
  onRemoveNote: (id: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(handbook);
  const changed = draft.trim() !== handbook.trim();

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Company knowledge"
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 900, background: 'rgba(15, 23, 42, 0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    >
      <div onClick={e => e.stopPropagation()} className={styles.card} style={{ width: 'min(620px, 100%)', maxHeight: '100%', overflowY: 'auto', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Company knowledge</h3>
          <button type="button" className={styles.actionButton} onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        <h4 style={{ margin: 0, fontSize: 13 }}>Handbook</h4>
        <span style={hint}>
          Your standing rules: coding conventions, tone, preferred tools, things to avoid. Every employee is given this with every task, so keep it to what always applies.
        </span>
        <textarea
          className={styles.input}
          aria-label="Company handbook"
          style={{ minHeight: 180, resize: 'vertical', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.5 }}
          maxLength={MAX_HANDBOOK_CHARS}
          placeholder={'For example:\n- Use TypeScript, two-space indentation, no semicolons.\n- Write for non-technical readers; British spelling.\n- Every project gets a README that says how to run it.'}
          value={draft}
          onChange={e => setDraft(e.target.value)}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ ...hint, flex: 1 }}>{draft.length.toLocaleString('en-US')} of {MAX_HANDBOOK_CHARS.toLocaleString('en-US')} characters</span>
          <button type="button" className={styles.button} style={{ padding: '8px 14px', fontSize: 12 }} disabled={!changed} onClick={() => onSave(draft)}>
            {changed ? 'Save handbook' : 'Saved'}
          </button>
        </div>

        <h4 style={{ margin: '8px 0 0', fontSize: 13 }}>Notes from earlier projects ({notes.length})</h4>
        <span style={hint}>
          Lessons employees wrote down while working. They are given to every employee as advice. Delete any that are wrong or no longer apply.
        </span>
        {notes.length === 0 && <div style={{ ...hint, fontStyle: 'italic' }}>No notes yet.</div>}
        {notes.map(note => (
          <div key={note.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 10px', border: '1px solid #e2e8f0', borderRadius: 8 }}>
            <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: '#0f172a', overflowWrap: 'anywhere' }}>
              {note.text}
              <div style={hint}>{note.author}{note.project ? ` · ${note.project}` : ''} · {new Date(note.at).toLocaleDateString()}</div>
            </div>
            <button type="button" className={styles.actionButton} style={{ color: '#ef4444' }} onClick={() => onRemoveNote(note.id)} title="Delete this note" aria-label="Delete this note">
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
