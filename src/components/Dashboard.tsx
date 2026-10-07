"use client";

import React, { useState } from 'react';
import { useSimulation } from '../lib/SimulationContext';
import { AgentRole, APIProvider, Agent, TaskItem } from '../lib/types';
import { UserPlus, Briefcase, Zap, CheckCircle2, ChevronRight, MessageSquare, Terminal, Trash2, Pause, Play, SquareX, ListTree, Settings, Users, Wallet, BookmarkCheck } from 'lucide-react';
import styles from './Dashboard.module.css';
import TaskTree from './TaskTree';
import SettingsPanel from './SettingsPanel';
import RolesPanel from './RolesPanel';
import CostsPanel from './CostsPanel';
import TemplatesPanel from './TemplatesPanel';
import { OFFICE_CONFIG, MODEL_SUGGESTIONS, cleanPrompt, formatUsage, projectOf, taskTitle } from '../lib/officeConfig';
import { TemplateDraft } from '../lib/SimulationContext';

export default function Dashboard() {
  const {
    agents, paused, projectsDir, live, roles, templates, month, notifications, notify, focus,
    addAgent, removeAgent, assignTask, retryTask, reviseTask, cancelTask, approveTask, haltAll, setPaused,
    answerTask, saveRole, removeRole, saveTemplate, removeTemplate, runTemplate, setMonthlyCap,
  } = useSimulation();

  const [name, setName] = useState('');
  const [role, setRole] = useState<AgentRole>('Junior Dev');
  const [api, setApi] = useState<APIProvider>('Ollama');
  // Empty = the provider's default model from the settings
  const [model, setModel] = useState('');
  const [rolesOpen, setRolesOpen] = useState(false);
  // A template being created from a task on the board
  const [templateDraft, setTemplateDraft] = useState<TemplateDraft | null>(null);
  const [avatar, setAvatar] = useState('/avatars/robot.png');

  // State for inline task assignment
  const [activeTaskAgent, setActiveTaskAgent] = useState<string | null>(null);
  const [taskPrompt, setTaskPrompt] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Optional spending limit in USD for the task being assigned; empty = the default
  const [taskBudget, setTaskBudget] = useState('');

  // State for expanding task history
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);

  // Right-panel view: employee roster or hierarchical task board
  const [panelView, setPanelView] = useState<'roster' | 'tasks' | 'costs' | 'templates'>('roster');
  const questionCount = agents.reduce((sum, a) => sum + a.taskQueue.filter(t => t.status === 'WAITING_FOR_INPUT').length, 0);
  // The role picked in the form, or the most junior one while the list loads or after it changed
  const hireRole = roles.some(r => r.name === role) ? role : roles[roles.length - 1]?.name || '';
  const activeTaskCount = agents.reduce(
    (sum, a) => sum + (a.taskQueue || []).filter(t => t.status === 'PENDING' || t.status === 'IN_PROGRESS').length,
    0
  );

  const handleAddEmployee = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !hireRole) return;
    addAgent({ name, role: hireRole, api, avatar, model: model.trim() || undefined });
    setName('');
  };

  const startTemplateFrom = (agent: Agent, task: TaskItem) => {
    setTemplateDraft({ name: taskTitle(task).slice(0, 60), prompt: cleanPrompt(task.prompt), agentId: agent.id, budget: task.budget, project: task.project ? projectOf(task) : undefined, schedule: 'none', weekday: 1, minuteOfDay: 9 * 60 });
    setPanelView('templates');
  };

  // Tasks are queued on the server, which runs them whether or not this page stays open
  const handleManualAssignment = (agent: Agent, prompt: string) => {
    if (!prompt.trim()) return;
    setActiveTaskAgent(null);
    setTaskPrompt('');
    setTaskBudget('');
    assignTask(agent.id, prompt, { budget: Number(taskBudget) > 0 ? Number(taskBudget) : undefined });
    notify(`Task queued for ${agent.name}`);
  };

  // Clicking an employee on the map opens their tasks in the side panel
  const [handledFocus, setHandledFocus] = useState(0);
  if (focus && focus.at !== handledFocus) {
    setHandledFocus(focus.at);
    setPanelView('roster');
    setExpandedAgentId(focus.agentId);
  }

  React.useEffect(() => {
    if (!focus) return;
    const timer = setTimeout(() => {
      document.getElementById(`agent-row-${focus.agentId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
    return () => clearTimeout(timer);
  }, [focus]);

return (
  <div className={styles.dashboard}>
    {/* Toast Notifications */}
    <div className={styles.toastContainer}>
      {notifications.map(n => (
        <div key={n.id} className={styles.toast}>
          <CheckCircle2 size={16} color="#10b981" />
          <span>{n.message}</span>
        </div>
      ))}
    </div>

    {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} onSaved={notify} />}
    {rolesOpen && <RolesPanel roles={roles} agents={agents} onSave={saveRole} onRemove={removeRole} onClose={() => setRolesOpen(false)} />}

    <div className={styles.header}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <div className={styles.iconBox}><Terminal size={20} color="#38bdf8" /></div>
        <h2 className={styles.title}>AI Office Manager</h2>
      </div>
      <div style={{ display: 'flex', gap: '8px' }}>
        <button 
          onClick={() => setPaused(!paused)} 
          className={styles.button} 
          style={{ background: paused ? '#10b981' : '#f59e0b', padding: '6px 12px', fontSize: '12px' }}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />} 
          {paused ? 'Resume Tasks' : 'Pause Tasks'}
        </button>
        <button 
          onClick={haltAll} 
          className={styles.button} 
          style={{ background: '#ef4444', padding: '6px 12px', fontSize: '12px' }}
        >
          <SquareX size={14} /> Halt Simulation
        </button>
        <button
          onClick={() => setRolesOpen(true)}
          className={styles.button}
          style={{ background: '#475569', padding: '6px 10px', fontSize: '12px' }}
          title="Roles and their instructions"
          aria-label="Roles and their instructions"
        >
          <Users size={14} />
        </button>
        <button
          onClick={() => setSettingsOpen(true)}
          className={styles.button}
          style={{ background: '#475569', padding: '6px 10px', fontSize: '12px' }}
          title="AI provider settings"
          aria-label="AI provider settings"
        >
          <Settings size={14} />
        </button>
      </div>
    </div>

    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <UserPlus size={16} />
        <h3>Hire New Employee</h3>
      </div>
      <form onSubmit={handleAddEmployee} className={styles.form}>
        <input
          type="text"
          placeholder="Employee Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={styles.input}
        />
        <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', marginBottom: '8px', paddingBottom: '4px' }}>
          {['/avatars/robot.png', '/avatars/dog.png', '/avatars/manager.png', '/avatars/worker.png'].map(src => (
            <img 
              key={src} 
              src={src} 
              alt="avatar" 
              onClick={() => setAvatar(src)}
              style={{ width: '40px', height: '40px', borderRadius: '50%', cursor: 'pointer', border: avatar === src ? '2px solid #3b82f6' : '2px solid transparent', backgroundColor: '#e2e8f0' }} 
            />
          ))}
        </div>
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
    </div>

    <div className={styles.card} style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className={styles.tabs} role="tablist" style={{ flexWrap: 'wrap' }}>
        <button
          id="tab-roster"
          role="tab"
          aria-selected={panelView === 'roster'}
          className={`${styles.tab} ${panelView === 'roster' ? styles.tabActive : ''}`}
          onClick={() => setPanelView('roster')}
        >
          <Briefcase size={14} /> Employees ({agents.length})
        </button>
        <button
          id="tab-tasks"
          role="tab"
          aria-selected={panelView === 'tasks'}
          className={`${styles.tab} ${panelView === 'tasks' ? styles.tabActive : ''}`}
          onClick={() => setPanelView('tasks')}
        >
          <ListTree size={14} /> Task Board
          {activeTaskCount > 0 && <span className={styles.tabCount}>{activeTaskCount}</span>}
          {questionCount > 0 && <span className={styles.tabCount} style={{ background: '#f59e0b' }} title="Questions waiting for your answer">?{questionCount}</span>}
        </button>
        <button
          id="tab-costs"
          role="tab"
          aria-selected={panelView === 'costs'}
          className={`${styles.tab} ${panelView === 'costs' ? styles.tabActive : ''}`}
          onClick={() => setPanelView('costs')}
        >
          <Wallet size={14} /> Costs
        </button>
        <button
          id="tab-templates"
          role="tab"
          aria-selected={panelView === 'templates'}
          className={`${styles.tab} ${panelView === 'templates' ? styles.tabActive : ''}`}
          onClick={() => setPanelView('templates')}
        >
          <BookmarkCheck size={14} /> Templates
        </button>
      </div>

      {panelView === 'costs' ? (
        <div className={styles.agentList}>
          <CostsPanel agents={agents} month={month} onSetCap={setMonthlyCap} />
        </div>
      ) : panelView === 'templates' ? (
        <div className={styles.agentList}>
          <TemplatesPanel templates={templates} agents={agents} draft={templateDraft} onDraftDone={() => setTemplateDraft(null)} onSave={saveTemplate} onRemove={removeTemplate} onRun={runTemplate} />
        </div>
      ) : panelView === 'tasks' ? (
        <div className={styles.agentList}>
          <TaskTree 
            agents={agents} 
            onCancel={(_agentId, taskId) => cancelTask(taskId)}
            onApprove={(_agentId, taskId) => approveTask(taskId)}
            projectsDir={projectsDir}
            live={live}
            notify={notify}
            onAnswer={answerTask}
            onSaveTemplate={startTemplateFrom}
            onRetry={retryTask}
            onRevise={reviseTask}
            onContinue={(agentId, project, prompt, budget) => assignTask(agentId, prompt, { project, budget })}
          />
        </div>
      ) : (
      <div className={styles.agentList}>
        {agents.map(agent => (
          <div
            key={agent.id}
            id={`agent-row-${agent.id}`}
            className={`${styles.agentItem} ${expandedAgentId === agent.id ? styles.expanded : ''}`}
            onClick={() => setExpandedAgentId(expandedAgentId === agent.id ? null : agent.id)}
          >
            <div className={styles.agentMain}>
              <div className={styles.agentAvatar} style={{ padding: 0, overflow: 'hidden', backgroundColor: 'transparent' }}>
                <img src={agent.avatar || '/avatars/robot.png'} alt={agent.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </div>
              <div className={styles.agentInfo}>
                <div className={styles.agentName}>
                  {agent.name}
                  <span className={styles.badge}>{agent.role}</span>
                </div>
                <div className={styles.agentDetails}>
                  <Zap size={12} style={{ marginRight: 4 }} />{agent.api}{agent.model ? ` · ${agent.model}` : ''}
                  <span className={styles.dot}>•</span>
                  <span className={styles.statusText} data-status={agent.state}>{agent.state}</span>
                </div>
              </div>
              <div className={styles.agentActions}>
                <div className={styles.tokenCounter}>{agent.tokensUsed} tkns</div>
                {agent.state !== 'WORKING' && activeTaskAgent !== agent.id && (
                  <button
                    className={styles.actionButton}
                    onClick={(e) => { e.stopPropagation(); setActiveTaskAgent(agent.id); }}
                    title="Assign Task"
                  >
                    <MessageSquare size={14} />
                  </button>
                )}
                <button
                  className={styles.actionButton}
                  style={{ color: '#ef4444' }}
                  onClick={(e) => { e.stopPropagation(); removeAgent(agent.id); }}
                  title="Remove Employee"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>

            {/* Inline Task Assignment */}
            {activeTaskAgent === agent.id && (
              <div className={styles.taskInputBox} onClick={(e) => e.stopPropagation()}>
                <input
                  autoFocus
                  type="text"
                  placeholder="Enter task prompt..."
                  value={taskPrompt}
                  onChange={e => setTaskPrompt(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleManualAssignment(agent, taskPrompt);
                    if (e.key === 'Escape') setActiveTaskAgent(null);
                  }}
                  className={styles.taskInput}
                />
                <input
                  type="number"
                  min="0.01"
                  max={OFFICE_CONFIG.MAX_TASK_BUDGET_USD}
                  step="0.01"
                  aria-label="Budget in US dollars"
                  title={`Spending limit for this task and its sub-tasks, in US dollars. Leave empty for $${OFFICE_CONFIG.DEFAULT_TASK_BUDGET_USD.toFixed(2)}.`}
                  placeholder={`$ ${OFFICE_CONFIG.DEFAULT_TASK_BUDGET_USD.toFixed(2)}`}
                  value={taskBudget}
                  onChange={e => setTaskBudget(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleManualAssignment(agent, taskPrompt);
                    if (e.key === 'Escape') setActiveTaskAgent(null);
                  }}
                  className={styles.taskInput}
                  style={{ flex: '0 0 72px', width: '72px' }}
                />
                <button className={styles.sendButton} onClick={() => handleManualAssignment(agent, taskPrompt)}>
                  <ChevronRight size={16} />
                </button>
              </div>
            )}

            {/* Task Queue Panel */}
            {expandedAgentId === agent.id && (
              <div className={styles.historyPanel} onClick={(e) => e.stopPropagation()}>
                <h4 className={styles.historyTitle}>Task Queue & History</h4>
                {agent.taskQueue && agent.taskQueue.length > 0 ? (
                  <div className={styles.historyList}>
                    {agent.taskQueue.map((task) => (
                      <div key={task.id} className={styles.historyItem} data-status={task.status}>
                        <div className={styles.historyHeader}>
                          <span className={styles.taskStatus}>{task.status}</span>
                          <span className={styles.taskAssigner}>
                            {task.kind === 'REVIEW' ? 'Final review · ' : task.parentId ? 'Sub-task · ' : ''}From: {task.assignedBy}
                          </span>
                        </div>
                        <div className={styles.historyPrompt}>
                          <strong>{task.title || 'Task'}:</strong> {cleanPrompt(task.prompt)}
                        </div>
                        {task.response && (
                          <div className={styles.historyResponse}>
                            <strong>Response:</strong> {task.response}{task.clipped ? ' (open the task on the task board for the rest)' : ''}
                          </div>
                        )}
                        {task.error && (
                          <div className={styles.historyError}>
                            <strong>Error:</strong> {task.error}
                          </div>
                        )}
                        <div className={styles.historyFooter}>
                          <span className={styles.historyTime}>
                            {new Date(task.timestamp).toLocaleTimeString()}
                            {task.tokens ? ` · ${formatUsage(task.tokens, task.cost)}` : ''}
                          </span>
                          {task.status === 'PENDING' && (
                            <button
                              className={styles.cancelTaskBtn}
                              onClick={() => cancelTask(task.id)}
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className={styles.noHistory}>No tasks assigned yet.</div>
                )}
              </div>
            )}
          </div>
        ))}
        {agents.length === 0 && (
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon}>🪑</div>
            <p>The office is completely empty.</p>
            <span>Hire an employee to start the simulation.</span>
          </div>
        )}
      </div>
      )}
    </div>
  </div>
);
}
