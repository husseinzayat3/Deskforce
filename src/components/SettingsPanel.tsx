"use client";

import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import styles from './Dashboard.module.css';

type Source = 'app' | 'environment' | 'default';
interface SecretInfo { set: boolean; hint: string; source: Source }
interface ValueInfo { value: string; source: Source }

const FIELDS = [
  { name: 'openaiKey', label: 'OpenAI API key', secret: true },
  { name: 'openaiModel', label: 'OpenAI default model', secret: false },
  { name: 'anthropicKey', label: 'Anthropic (Claude) API key', secret: true },
  { name: 'anthropicModel', label: 'Anthropic default model', secret: false },
  { name: 'geminiKey', label: 'Google Gemini API key', secret: true },
  { name: 'geminiModel', label: 'Gemini default model', secret: false },
  { name: 'grokKey', label: 'Grok (xAI) API key', secret: true },
  { name: 'grokModel', label: 'Grok default model', secret: false },
  { name: 'ollamaUrl', label: 'Ollama address', secret: false },
  { name: 'ollamaModel', label: 'Ollama default model', secret: false },
] as const;

type FieldName = typeof FIELDS[number]['name'];
type Settings = Record<FieldName, SecretInfo | ValueInfo>;
type Draft = Record<FieldName, string>;

const EMPTY_DRAFT = Object.fromEntries(FIELDS.map(f => [f.name, ''])) as Draft;

const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontWeight: 600, color: '#334155' };
const hintStyle: React.CSSProperties = { fontSize: 11, fontWeight: 400, color: '#64748b' };

/** Where the AI providers are configured. Keys are sent to the server once and never shown again. */
export default function SettingsPanel({ onClose, onSaved }: { onClose: () => void; onSaved: (message: string) => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const show = (data: Settings) => {
    setSettings(data);
    // Keys start empty (their value is never sent to the browser); the rest shows what is in effect
    setDraft(Object.fromEntries(FIELDS.map(f => [f.name, f.secret ? '' : (data[f.name] as ValueInfo).value])) as Draft);
  };

  useEffect(() => {
    fetch('/api/settings', { cache: 'no-store' })
      .then(res => res.json())
      .then(data => (data.error ? setError(data.error) : show(data)))
      .catch(() => setError('The settings could not be loaded.'));
  }, []);

  const save = async (changes: Partial<Draft>) => {
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes)
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'The settings could not be saved.');
      show(data);
      onSaved('Settings saved');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    const changes: Partial<Draft> = {};
    for (const { name, secret } of FIELDS) {
      const value = draft[name].trim();
      // An empty key field means "keep the current key"; other fields are saved when edited
      if (secret ? value : value !== (settings[name] as ValueInfo).value) changes[name] = value;
    }
    if (Object.keys(changes).length === 0) return onClose();
    save(changes);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 900, background: 'rgba(15, 23, 42, 0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    >
      <form onSubmit={handleSubmit} onClick={e => e.stopPropagation()} className={styles.card} style={{ width: 'min(440px, 100%)', maxHeight: '100%', overflowY: 'auto', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>AI provider settings</h3>
          <button type="button" className={styles.actionButton} onClick={onClose} aria-label="Close settings"><X size={16} /></button>
        </div>

        {!settings && !error && <div style={hintStyle}>Loading…</div>}

        {settings && FIELDS.map(({ name, label, secret }) => {
          const info = settings[name];
          const key = secret ? (info as SecretInfo) : null;
          return (
            <label key={name} style={labelStyle}>
              {label}
              <input
                type={secret ? 'password' : 'text'}
                autoComplete="off"
                spellCheck={false}
                className={styles.input}
                value={draft[name]}
                placeholder={key ? (key.set ? `Saved (${key.hint}) — type to replace` : 'Not set: this provider answers with mock text') : ''}
                onChange={e => setDraft(prev => ({ ...prev, [name]: e.target.value }))}
              />
              <span style={hintStyle}>
                {info.source === 'app' ? 'Saved in the app.' : info.source === 'environment' ? 'Taken from the environment (.env.local).' : key ? '' : 'Default value.'}
                {key && info.source === 'app' && (
                  <button type="button" onClick={() => save({ [name]: '' })} disabled={saving} style={{ marginLeft: 6, border: 'none', background: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 11, padding: 0 }}>
                    Remove key
                  </button>
                )}
              </span>
            </label>
          );
        })}

        {error && <div role="alert" style={{ fontSize: 12, color: '#dc2626' }}>{error}</div>}

        <span style={hintStyle}>Keys are stored on this computer, in the office database, and are only sent to their own provider. Each employee can use a different model than the default; choose it when hiring.</span>

        <button type="submit" className={styles.button} disabled={!settings || saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </form>
    </div>
  );
}
