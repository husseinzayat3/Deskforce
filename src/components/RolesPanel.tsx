"use client";

import React, { useState } from 'react';
import { Trash2, X } from 'lucide-react';
import { Agent, Role } from '../lib/types';
import styles from './Dashboard.module.css';

const hint: React.CSSProperties = { fontSize: 11, color: '#64748b' };
const NEW_ROLE: Role = { name: '', rank: 2, instructions: '' };

/** One role: its level in the hierarchy and the instructions its employees work by. */
const RoleEditor = ({ role, isNew, inUse, onSave, onRemove }: { role: Role; isNew?: boolean; inUse: number; onSave: (role: Role) => void; onRemove?: () => void }) => {
  const [draft, setDraft] = useState(role);

  const changed = draft.name !== role.name || draft.rank !== role.rank || draft.instructions !== role.instructions;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 12, border: '1px solid #e2e8f0', borderRadius: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {isNew ? (
          <input className={styles.input} style={{ flex: 1, minWidth: 0, padding: '6px 8px', fontSize: 13 }} placeholder="Role name, e.g. Data Analyst" aria-label="Role name" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
        ) : (
          <strong style={{ flex: 1, minWidth: 0, fontSize: 13, color: '#0f172a' }}>{role.name}</strong>
        )}
        <label style={{ fontSize: 12, color: '#334155', display: 'flex', alignItems: 'center', gap: 6 }}>
          Level
          <input type="number" min={0} max={9} className={styles.input} style={{ width: 56, padding: '6px 8px', fontSize: 12 }} value={draft.rank} onChange={e => setDraft({ ...draft, rank: Math.round(Number(e.target.value)) })} />
        </label>
        {onRemove && (
          <button type="button" className={styles.actionButton} style={{ color: inUse ? '#cbd5e1' : '#ef4444' }} disabled={inUse > 0} onClick={onRemove} title={inUse ? `Held by ${inUse} employee${inUse > 1 ? 's' : ''}` : 'Delete role'} aria-label={`Delete ${role.name}`}>
            <Trash2 size={14} />
          </button>
        )}
      </div>
      <textarea
        className={styles.input}
        style={{ padding: '6px 8px', fontSize: 12, minHeight: 60, resize: 'vertical', fontFamily: 'inherit' }}
        aria-label={`Instructions for ${draft.name || 'the new role'}`}
        placeholder="What this role is responsible for and how it should work"
        value={draft.instructions}
        onChange={e => setDraft({ ...draft, instructions: e.target.value })}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ ...hint, flex: 1 }}>{isNew ? '' : inUse ? `${inUse} employee${inUse > 1 ? 's' : ''}` : 'Nobody holds this role'}</span>
        <button type="button" className={styles.button} style={{ padding: '6px 12px', fontSize: 12 }} disabled={!draft.name.trim() || (!isNew && !changed)} onClick={() => onSave({ ...draft, name: draft.name.trim() })}>
          {isNew ? 'Add role' : 'Save'}
        </button>
      </div>
    </div>
  );
};

/** The roles of this office. Level 0 is the top; an employee can delegate only to roles with a higher number. */
export default function RolesPanel({ roles, agents, onSave, onRemove, onClose }: { roles: Role[]; agents: Agent[]; onSave: (role: Role) => void; onRemove: (name: string) => void; onClose: () => void }) {
  // Remount the blank form after each addition so it empties itself
  const [added, setAdded] = useState(0);
  const holders = (name: string) => agents.filter(a => a.role === name).length;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Roles"
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 900, background: 'rgba(15, 23, 42, 0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    >
      <div onClick={e => e.stopPropagation()} className={styles.card} style={{ width: 'min(560px, 100%)', maxHeight: '100%', overflowY: 'auto', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Roles</h3>
          <button type="button" className={styles.actionButton} onClick={onClose} aria-label="Close roles"><X size={16} /></button>
        </div>
        <span style={hint}>
          Level 0 is the top of the office. An employee can delegate only to roles with a higher level number, and the instructions are given to every employee with the role.
        </span>

        {roles.map(role => (
          // Keyed on the saved values, so an editor starts afresh once a save comes back
          <RoleEditor key={`${role.name}:${role.rank}:${role.instructions}`} role={role} inUse={holders(role.name)} onSave={onSave} onRemove={() => onRemove(role.name)} />
        ))}

        <h4 style={{ margin: '4px 0 0', fontSize: 13 }}>New role</h4>
        <RoleEditor
          key={added}
          role={NEW_ROLE}
          isNew
          inUse={0}
          onSave={role => {
            if (roles.some(r => r.name.toLowerCase() === role.name.toLowerCase())) return;
            onSave(role);
            setAdded(n => n + 1);
          }}
        />
      </div>
    </div>
  );
}
