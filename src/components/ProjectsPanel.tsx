"use client";

import React, { useEffect, useMemo, useState } from 'react';
import { Download, FolderOpen, FolderPlus, FolderTree, Send, Trash2, X } from 'lucide-react';
import { Agent, TaskItem } from '../lib/types';
import { FINISHED_STATUSES, OFFICE_CONFIG, getTree, indexTasks, taskTitle } from '../lib/officeConfig';
import { AssignOptions } from '../lib/SimulationContext';
import styles from './Dashboard.module.css';
import tree from './TaskTree.module.css';

interface ProjectInfo {
  name: string;
  files: number;
  updatedAt: number;
  canPreview: boolean;
}

const hint: React.CSSProperties = { fontSize: 11, color: '#64748b' };
const money = (usd: number) => (usd === 0 ? 'free' : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);

/** Every project the office has worked on: what it holds, what it cost, and what was asked of it. */
export default function ProjectsPanel({ agents, planFirst, onOpenFiles, onOpenTask, onContinue, onDelete, notify }: {
  agents: Agent[];
  planFirst: boolean;
  onOpenFiles: (project: string) => void;
  onOpenTask: (taskId: string) => void;
  onContinue: (agentId: string, prompt: string, options: AssignOptions) => void;
  onDelete: (project: string) => void;
  notify: (message: string) => void;
}) {
  const [folders, setFolders] = useState<ProjectInfo[] | null>(null);
  const [continuing, setContinuing] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [assignee, setAssignee] = useState('');
  const [wantsPlan, setWantsPlan] = useState<boolean | null>(null);

  // What the tasks say about each project: its requests, cost, and whether anything is still going
  const byProject = useMemo(() => {
    const index = indexTasks(agents);
    const map = new Map<string, { roots: { task: TaskItem; agent: Agent }[]; tasks: number; cost: number; active: boolean }>();
    agents.forEach(agent => agent.taskQueue.forEach(task => {
      if (task.parentId || !task.project) return;
      const all = getTree(task.id, index);
      const entry = map.get(task.project) || { roots: [], tasks: 0, cost: 0, active: false };
      entry.roots.push({ task, agent });
      entry.tasks += all.length;
      entry.cost += all.reduce((sum, ref) => sum + (ref.task.cost || 0), 0);
      entry.active = entry.active || all.some(ref => !FINISHED_STATUSES.has(ref.task.status));
      map.set(task.project, entry);
    }));
    map.forEach(entry => entry.roots.sort((a, b) => b.task.timestamp - a.task.timestamp));
    return map;
  }, [agents]);

  // The folders are read again whenever a task finishes or a project comes or goes
  const signature = `${byProject.size}:${agents.reduce((n, a) => n + a.taskQueue.filter(t => FINISHED_STATUSES.has(t.status)).length, 0)}`;
  useEffect(() => {
    let closed = false;
    fetch('/api/workspace?projects=1', { cache: 'no-store' })
      .then(res => res.json())
      .then(data => { if (!closed) setFolders(data.projects || []); })
      .catch(() => { if (!closed) setFolders([]); });
    return () => {
      closed = true;
    };
  }, [signature]);

  const start = (project: string, fallbackOwner?: string) => {
    const agentId = assignee || fallbackOwner || agents[0]?.id;
    if (!prompt.trim() || !agentId) return;
    onContinue(agentId, prompt.trim(), { project, plan: wantsPlan ?? planFirst });
    notify(`Queued for ${agents.find(a => a.id === agentId)?.name || 'the team'}`);
    setContinuing(null);
    setPrompt('');
  };

  if (folders === null) return <div style={{ ...hint, padding: 8 }}>Loading…</div>;
  if (folders.length === 0) {
    return (
      <div className={styles.emptyState}>
        <div className={styles.emptyIcon}>📁</div>
        <p>No projects yet.</p>
        <span>Each task you assign creates one, with everything the team writes for it.</span>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {folders.map(folder => {
        const info = byProject.get(folder.name);
        const owner = info?.roots[0]?.agent;
        const open = continuing === folder.name;
        return (
          <div key={folder.name} className={styles.agentItem} style={{ cursor: 'default', padding: 12, background: '#fff' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <strong style={{ flex: 1, minWidth: 0, fontSize: 14, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={folder.name}>{folder.name}</strong>
              <span className={styles.taskStatus} style={info?.active ? { background: '#dbeafe', color: '#1d4ed8' } : { background: '#f1f5f9', color: '#64748b' }}>
                {info?.active ? 'In progress' : info ? 'Finished' : 'No tasks'}
              </span>
            </div>
            <div style={{ ...hint, marginTop: 2 }}>
              {folder.files} file{folder.files === 1 ? '' : 's'}
              {info ? ` · ${info.tasks} task${info.tasks === 1 ? '' : 's'} · ${money(info.cost)}` : ''}
              {` · changed ${new Date(folder.updatedAt).toLocaleDateString()}`}
            </div>

            {info && (
              <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {info.roots.slice(0, 4).map(({ task, agent }) => (
                  <li key={task.id}>
                    <button onClick={() => onOpenTask(task.id)} title="Show this task" style={{ display: 'flex', gap: 6, width: '100%', padding: '3px 0', border: 'none', background: 'none', font: 'inherit', fontSize: 12, color: '#334155', cursor: 'pointer', textAlign: 'left', minWidth: 0 }}>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{taskTitle(task)}</span>
                      <span style={{ ...hint, flexShrink: 0 }}>{agent.name} · {new Date(task.timestamp).toLocaleDateString()}</span>
                    </button>
                  </li>
                ))}
                {info.roots.length > 4 && <li style={hint}>…and {info.roots.length - 4} earlier request{info.roots.length - 4 === 1 ? '' : 's'}</li>}
              </ul>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              <button className={`${tree.cancelBtn} ${tree.approveBtn}`} onClick={() => onOpenFiles(folder.name)} title="Browse the files and their history">
                <FolderTree size={11} /> Files
              </button>
              <a className={`${tree.cancelBtn} ${tree.approveBtn}`} href={`/api/workspace?project=${folder.name}&download=1`} download title="Download everything as a .zip">
                <Download size={11} /> Download
              </a>
              <button className={`${tree.cancelBtn} ${tree.approveBtn}`} onClick={() => { setContinuing(open ? null : folder.name); setPrompt(''); setAssignee(''); }} disabled={agents.length === 0} title="Give the team a new request for this project">
                <FolderPlus size={11} /> Continue
              </button>
              {typeof window !== 'undefined' && window.desktop && (
                <button className={`${tree.cancelBtn} ${tree.quietBtn}`} onClick={() => window.desktop!.openProject(folder.name)}>
                  <FolderOpen size={11} /> Open folder
                </button>
              )}
              <button
                className={tree.cancelBtn}
                style={{ marginLeft: 'auto' }}
                disabled={info?.active}
                title={info?.active ? 'A task of this project is still going' : 'Delete the folder and the tasks that worked on it'}
                onClick={() => {
                  if (window.confirm(`Delete the project "${folder.name}"?\n\nIts folder, its history and ${info ? `its ${info.tasks} task${info.tasks === 1 ? '' : 's'}` : 'everything in it'} are deleted for good. What it cost stays counted in this month's spending.`)) onDelete(folder.name);
                }}
              >
                <Trash2 size={11} /> Delete
              </button>
            </div>

            {open && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                <textarea autoFocus className={styles.input} style={{ padding: '6px 8px', fontSize: 12, minHeight: 56, resize: 'vertical', fontFamily: 'inherit' }} aria-label={`New request for ${folder.name}`} placeholder="What should be added or changed?" value={prompt} onChange={e => setPrompt(e.target.value)} />
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <select aria-label="Employee" className={styles.select} style={{ padding: '4px 6px', fontSize: 12, flex: 1, minWidth: 0 }} value={assignee || owner?.id || agents[0]?.id || ''} onChange={e => setAssignee(e.target.value)}>
                    {agents.map(a => <option key={a.id} value={a.id}>{a.name} ({a.role})</option>)}
                  </select>
                  <label style={{ ...hint, display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }} title={`Budget: $${OFFICE_CONFIG.DEFAULT_TASK_BUDGET_USD.toFixed(2)} unless changed on the task`}>
                    <input type="checkbox" checked={wantsPlan ?? planFirst} onChange={e => setWantsPlan(e.target.checked)} /> Plan first
                  </label>
                  <button className={`${tree.cancelBtn} ${tree.approveBtn}`} disabled={!prompt.trim()} onClick={() => start(folder.name, owner?.id)}>
                    <Send size={11} /> Assign
                  </button>
                  <button className={`${tree.cancelBtn} ${tree.quietBtn}`} onClick={() => setContinuing(null)} aria-label="Close"><X size={11} /></button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
