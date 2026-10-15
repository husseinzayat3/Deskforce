"use client";

import { useState } from 'react';
import { UserPlus, ChevronDown, ChevronRight } from 'lucide-react';
import { AgentRole, APIProvider, Role } from '../lib/types';
import { MODEL_SUGGESTIONS } from '../lib/officeConfig';
import AvatarPicker from './AvatarPicker';
import styles from './Dashboard.module.css';

/** The card for hiring an employee: name, picture, role, provider and model. */
export default function HireForm({ roles, open, onToggle, onHire }: {
  roles: Role[];
  open: boolean;
  onToggle: () => void;
  onHire: (employee: { name: string; role: AgentRole; api: APIProvider; avatar: string; model?: string }) => void;
}) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<AgentRole>('Junior Dev');
  const [api, setApi] = useState<APIProvider>('Ollama');
  // Empty = the provider's default model from the settings
  const [model, setModel] = useState('');
  const [avatar, setAvatar] = useState('/avatars/robot.png');
  // The role picked in the form, or the most junior one while the list loads or after it changed
  const hireRole = roles.some(r => r.name === role) ? role : roles[roles.length - 1]?.name || '';

  const handleAddEmployee = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !hireRole) return;
    onHire({ name, role: hireRole, api, avatar, model: model.trim() || undefined });
    setName('');
  };

  return (
    <div className={`${styles.card} ${styles.hireCard}`}>
      <button type="button" className={styles.cardToggle} onClick={onToggle} aria-expanded={open}>
        <UserPlus size={16} />
        <h3>Hire new employee</h3>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      {open && (
      <form onSubmit={handleAddEmployee} className={styles.form}>
        <input
          type="text"
          placeholder="Employee Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={styles.input}
        />
        <AvatarPicker value={avatar} onChange={setAvatar} />
        <div className={styles.row}>
          <select aria-label="Role" value={hireRole} onChange={(e) => setRole(e.target.value)} className={styles.select}>
            {roles.map(r => <option key={r.name} value={r.name}>{r.name}</option>)}
          </select>
          <select aria-label="AI provider" value={api} onChange={(e) => { setApi(e.target.value as APIProvider); setModel(''); }} className={styles.select}>
            <option value="OpenAI">OpenAI</option>
            <option value="Anthropic">Anthropic (Claude)</option>
            <option value="Gemini">Google Gemini</option>
            <option value="Grok">Grok (xAI)</option>
            <option value="Ollama">Ollama (Local)</option>
          </select>
        </div>
        <input
          type="text"
          list="model-suggestions"
          aria-label="Model"
          title="The model this employee uses. Leave empty for the provider's default from the settings."
          placeholder="Model (empty = provider default)"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className={styles.input}
          autoComplete="off"
          spellCheck={false}
        />
        <datalist id="model-suggestions">
          {(MODEL_SUGGESTIONS[api] || []).map(m => <option key={m} value={m} />)}
        </datalist>
        <button type="submit" className={styles.button}>
          Hire Employee
        </button>
      </form>
      )}
    </div>
  );
}
