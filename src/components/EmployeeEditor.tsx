"use client";

import React, { useState } from 'react';
import { X } from 'lucide-react';
import { Agent, APIProvider, Role } from '../lib/types';
import { MODEL_SUGGESTIONS } from '../lib/officeConfig';
import styles from './Dashboard.module.css';

export const AVATARS = ['/avatars/robot.png', '/avatars/dog.png', '/avatars/manager.png', '/avatars/worker.png'];

export const PROVIDERS: { value: APIProvider; label: string }[] = [
  { value: 'OpenAI', label: 'OpenAI' },
  { value: 'Anthropic', label: 'Anthropic (Claude)' },
  { value: 'Gemini', label: 'Google Gemini' },
  { value: 'Grok', label: 'Grok (xAI)' },
  { value: 'Ollama', label: 'Ollama (Local)' },
];

const label: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontWeight: 600, color: '#334155', flex: 1, minWidth: 0 };

/** Changes an employee in place: their tasks and history stay with them. */
export default function EmployeeEditor({ agent, roles, onSave, onClose }: {
  agent: Agent;
  roles: Role[];
  onSave: (changes: { name: string; role: string; api: APIProvider; model: string; avatar: string }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState(agent.role);
  const [api, setApi] = useState<APIProvider>(agent.api);
  const [model, setModel] = useState(agent.model || '');
  const [avatar, setAvatar] = useState(agent.avatar);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${agent.name}`}
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 900, background: 'rgba(15, 23, 42, 0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    >
      <form
        onClick={e => e.stopPropagation()}
        onSubmit={e => {
          e.preventDefault();
          if (!name.trim()) return;
          onSave({ name: name.trim(), role, api, model: model.trim(), avatar });
          onClose();
        }}
        className={styles.card}
        style={{ width: 'min(420px, 100%)', gap: 12 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Edit employee</h3>
          <button type="button" className={styles.actionButton} onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        <label style={label}>
          Name
          <input className={styles.input} value={name} onChange={e => setName(e.target.value)} />
        </label>

        <div style={{ display: 'flex', gap: 8 }}>
          {AVATARS.map(src => (
            <button key={src} type="button" onClick={() => setAvatar(src)} aria-label={`Avatar ${src.split('/').pop()}`} aria-pressed={avatar === src} style={{ padding: 0, border: avatar === src ? '2px solid #3b82f6' : '2px solid transparent', borderRadius: '50%', background: '#e2e8f0', cursor: 'pointer', lineHeight: 0 }}>
              <img src={src} alt="" style={{ width: 40, height: 40, borderRadius: '50%' }} />
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <label style={label}>
            Role
            <select className={styles.select} value={role} onChange={e => setRole(e.target.value)}>
              {/* A role that was deleted since stays selectable until it is changed */}
              {!roles.some(r => r.name === agent.role) && <option value={agent.role}>{agent.role}</option>}
              {roles.map(r => <option key={r.name} value={r.name}>{r.name}</option>)}
            </select>
          </label>
          <label style={label}>
            AI provider
            <select className={styles.select} value={api} onChange={e => { setApi(e.target.value as APIProvider); setModel(''); }}>
              {PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </label>
        </div>

        <label style={label}>
          Model
          <input className={styles.input} list="edit-model-suggestions" value={model} onChange={e => setModel(e.target.value)} placeholder="Empty = the provider's default from the settings" autoComplete="off" spellCheck={false} />
          <datalist id="edit-model-suggestions">
            {(MODEL_SUGGESTIONS[api] || []).map(m => <option key={m} value={m} />)}
          </datalist>
        </label>

        <span style={{ fontSize: 11, color: '#64748b' }}>Changes apply from the employee&apos;s next task. A task that is running finishes as it started.</span>

        <button type="submit" className={styles.button} disabled={!name.trim()}>Save</button>
      </form>
    </div>
  );
}
