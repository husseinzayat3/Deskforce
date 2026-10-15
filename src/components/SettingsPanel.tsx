"use client";

import React, { useEffect, useRef, useState } from 'react';
import { Bell, Download, Upload, X } from 'lucide-react';
import { OfficeFile } from '../lib/types';
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
  { name: 'slackAppToken', label: 'Slack app-level token (xapp-…)', secret: true },
  { name: 'slackBotToken', label: 'Slack bot token (xoxb-…)', secret: true },
  { name: 'slackUsers', label: 'Slack user IDs allowed to give instructions', secret: false },
] as const;

type FieldName = typeof FIELDS[number]['name'];
/** On/off settings, saved the moment they are switched. */
type SwitchName = 'webAccess' | 'allowChecks' | 'planFirst';
type Settings = Record<FieldName | SwitchName, SecretInfo | ValueInfo>;
type Draft = Record<FieldName, string>;

const EMPTY_DRAFT = Object.fromEntries(FIELDS.map(f => [f.name, ''])) as Draft;

const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontWeight: 600, color: '#334155' };
const hintStyle: React.CSSProperties = { fontSize: 11, fontWeight: 400, color: '#64748b' };

/** Where the AI providers are configured. Keys are sent to the server once and never shown again. */
export default function SettingsPanel({ onClose, onSaved, onImport }: { onClose: () => void; onSaved: (message: string) => void; onImport: (office: OfficeFile) => void }) {
  const importInput = useRef<HTMLInputElement>(null);
  // Read once the panel is open; the server-rendered page has no Notification object
  const [notifications, setNotifications] = useState<NotificationPermission | 'unsupported' | 'desktop'>('unsupported');

  useEffect(() => {
    const state = window.desktop ? 'desktop' : typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
    // After the first paint, so the panel renders the same on the server and in the browser
    const timer = setTimeout(() => setNotifications(state), 0);
    return () => clearTimeout(timer);
  }, []);

  const importFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      onImport(JSON.parse(await file.text()));
    } catch {
      setError('That file could not be read as an office file.');
    }
  };

  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [slack, setSlack] = useState<{ status: string; detail: string } | null>(null);

  const show = (data: Settings) => {
    setSettings(data);
    setSlack((data as unknown as { slack?: { status: string; detail: string } }).slack || null);
    // Keys start empty (their value is never sent to the browser); the rest shows what is in effect
    setDraft(Object.fromEntries(FIELDS.map(f => [f.name, f.secret ? '' : (data[f.name] as ValueInfo).value])) as Draft);
  };

  useEffect(() => {
    fetch('/api/settings', { cache: 'no-store' })
      .then(res => res.json())
      .then(data => (data.error ? setError(data.error) : show(data)))
      .catch(() => setError('The settings could not be loaded.'));
  }, []);

  const save = async (changes: Partial<Draft & Record<SwitchName, string>>) => {
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
          <h3 style={{ margin: 0, fontSize: 16 }}>Settings</h3>
          <button type="button" className={styles.actionButton} onClick={onClose} aria-label="Close settings"><X size={16} /></button>
        </div>

        {!settings && !error && <div style={hintStyle}>Loading…</div>}

        {settings && FIELDS.map(({ name, label, secret }) => {
          const firstSlack = name === 'slackAppToken';
          const info = settings[name];
          const key = secret ? (info as SecretInfo) : null;
          return (
            <React.Fragment key={name}>
            {firstSlack && (
              <>
                <h4 style={{ margin: '8px 0 0', fontSize: 13 }}>Slack</h4>
                <span style={hintStyle}>
                  Talk to the office from Slack: message the app, and your most senior employee answers, starts tasks, and tells you when a plan, a question or a report is waiting.
                  The Slack guide at husseinzayat3.github.io/Deskforce/slack has the five-minute setup. Status: <strong style={{ color: slack?.status === 'connected' ? '#006300' : slack?.status === 'error' ? '#b91c1c' : '#64748b' }}>{slack?.detail || 'Not set up'}</strong>
                </span>
              </>
            )}
            <label style={labelStyle}>
              {label}
              <input
                type={secret ? 'password' : 'text'}
                autoComplete="off"
                spellCheck={false}
                className={styles.input}
                value={draft[name]}
                placeholder={key ? (key.set ? `Saved (${key.hint}) — type to replace` : name.startsWith('slack') ? 'Not set' : 'Not set: this provider answers with mock text') : name === 'slackUsers' ? 'For example U012AB3CD, U045EF6GH' : ''}
                onChange={e => setDraft(prev => ({ ...prev, [name]: e.target.value }))}
              />
              <span style={hintStyle}>
                {info.source === 'app' ? 'Saved in the app.' : info.source === 'environment' ? 'Taken from the environment (.env.local).' : key || name === 'slackUsers' ? '' : 'Default value.'}
                {key && info.source === 'app' && (
                  <button type="button" onClick={() => save({ [name]: '' })} disabled={saving} style={{ marginLeft: 6, border: 'none', background: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 11, padding: 0 }}>
                    Remove key
                  </button>
                )}
              </span>
            </label>
            </React.Fragment>
          );
        })}

        {settings && (
          <>
            <h4 style={{ margin: '8px 0 0', fontSize: 13 }}>How tasks start</h4>
            <label style={{ ...labelStyle, flexDirection: 'row', alignItems: 'flex-start', gap: 8, fontWeight: 400 }}>
              <input type="checkbox" checked={(settings.planFirst as ValueInfo).value === 'on'} disabled={saving} onChange={e => save({ planFirst: e.target.checked ? 'on' : 'off' })} />
              <span>
                <strong>Plan first</strong>
                <span style={{ ...hintStyle, display: 'block' }}>
                  A new task starts with the employee proposing a plan and a cost estimate, and waits for you to approve it. You can still choose per task. Scheduled tasks never wait for a plan.
                </span>
              </span>
            </label>

            <h4 style={{ margin: '8px 0 0', fontSize: 13 }}>What agents may do</h4>
            <label style={{ ...labelStyle, flexDirection: 'row', alignItems: 'flex-start', gap: 8, fontWeight: 400 }}>
              <input type="checkbox" checked={(settings.webAccess as ValueInfo).value === 'on'} disabled={saving} onChange={e => save({ webAccess: e.target.checked ? 'on' : 'off' })} />
              <span>
                <strong>Search the web and read pages</strong>
                <span style={{ ...hintStyle, display: 'block' }}>
                  For current facts such as prices and versions. Searches run through Anthropic, OpenAI or Gemini, whichever has a key, and are billed there. Agents can only reach public websites, never this computer or your network.
                </span>
              </span>
            </label>
            <label style={{ ...labelStyle, flexDirection: 'row', alignItems: 'flex-start', gap: 8, fontWeight: 400 }}>
              <input type="checkbox" checked={(settings.allowChecks as ValueInfo).value === 'on'} disabled={saving} onChange={e => save({ allowChecks: e.target.checked ? 'on' : 'off' })} />
              <span>
                <strong>Run checks and tests on this computer</strong>
                <span style={{ ...hintStyle, display: 'block' }}>
                  Checks the syntax of a project&apos;s files and runs its tests, so broken output is caught and fixed. Tests are code a model wrote, running on your computer: on macOS they run in a sandbox with no network and no access to your documents or keys; elsewhere there is no sandbox. Off by default.
                </span>
              </span>
            </label>

            <h4 style={{ margin: '8px 0 0', fontSize: 13 }}>Notifications</h4>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#334155' }}>
              <Bell size={14} />
              {notifications === 'desktop' && <span>The app notifies you when a report is ready, an employee has a question or a task fails.</span>}
              {notifications === 'unsupported' && <span>This browser does not offer notifications.</span>}
              {notifications === 'granted' && <span>On: you are notified when a report is ready, an employee has a question or a task fails, while this page is in the background.</span>}
              {notifications === 'denied' && <span>Blocked in the browser. Allow notifications for this site in the browser&apos;s settings to turn them on.</span>}
              {notifications === 'default' && (
                <button type="button" className={styles.button} style={{ padding: '6px 12px', fontSize: 12 }} onClick={() => Notification.requestPermission().then(setNotifications)}>
                  Turn on notifications
                </button>
              )}
            </div>

            <h4 style={{ margin: '8px 0 0', fontSize: 13 }}>Office file</h4>
            <span style={hintStyle}>The roles, employees and templates of this office as one file, to set up the same office elsewhere. It holds no keys, tasks or project files. Importing adds what is missing and never removes anything.</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <a className={styles.button} href="/api/office?export=1" download="deskforce-office.json" style={{ padding: '6px 12px', fontSize: 12, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, background: '#475569' }}>
                <Download size={13} /> Export
              </a>
              <button type="button" className={styles.button} style={{ padding: '6px 12px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6, background: '#475569' }} onClick={() => importInput.current?.click()}>
                <Upload size={13} /> Import
              </button>
              <input ref={importInput} type="file" accept="application/json,.json" hidden onChange={importFile} />
            </div>
          </>
        )}

        {error && <div role="alert" style={{ fontSize: 12, color: '#dc2626' }}>{error}</div>}

        <span style={hintStyle}>Keys are stored on this computer, in the office database, and are only sent to their own provider. Each employee can use a different model than the default; choose it when hiring.</span>

        <button type="submit" className={styles.button} disabled={!settings || saving}>
          {saving ? 'Saving…' : 'Save keys and models'}
        </button>
      </form>
    </div>
  );
}
