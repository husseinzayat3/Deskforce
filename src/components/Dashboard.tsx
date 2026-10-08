"use client";

import React, { useState } from 'react';
import { useSimulation } from '../lib/SimulationContext';
import { AgentRole, APIProvider, Agent, Attachment, TaskItem } from '../lib/types';
import { UserPlus, Briefcase, Zap, CheckCircle2, ChevronRight, ChevronDown, MessageSquare, Terminal, Trash2, Pause, Play, SquareX, ListTree, Settings, Users, Wallet, BookmarkCheck, Pencil, Paperclip, FolderUp, X, BookOpen, FolderKanban, Search } from 'lucide-react';
import styles from './Dashboard.module.css';
import TaskTree from './TaskTree';
import SettingsPanel from './SettingsPanel';
import RolesPanel from './RolesPanel';
import InsightsPanel from './InsightsPanel';
import TemplatesPanel from './TemplatesPanel';
import EmployeeEditor from './EmployeeEditor';
import KnowledgePanel from './KnowledgePanel';
import AvatarPicker from './AvatarPicker';
import ProjectsPanel from './ProjectsPanel';
import SearchPanel from './SearchPanel';
import ProjectBrowser from './ProjectBrowser';
import { readAttachments } from '../lib/attachments';
import { OFFICE_CONFIG, MODEL_SUGGESTIONS, cleanPrompt, formatUsage, projectOf, taskTitle } from '../lib/officeConfig';
import { TemplateDraft } from '../lib/SimulationContext';

/** How an employee's state reads in the team list. */
const STATE_LABEL: Record<string, string> = {
  IDLE: 'Idle', WORKING: 'Working', BREAK: 'On a break', COFFEE: 'Getting coffee', TOILET: 'Away', WAITING_FOR_HELP: 'Has a question', MEETING: 'In a meeting',
};

/** 18798 → "18.8k" */
const compactTokens = (tokens: number) => (tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens));

export default function Dashboard() {
  const {
    agents, paused, projectsDir, live, roles, templates, month, planFirst, handbook, notes, notifications, notify, focus,
    approvePlan, rejectPlan, steerTask, saveHandbook, removeNote, compareModels, deleteProject,
    addAgent, removeAgent, editAgent, archiveTask, deleteTask, importOffice, assignTask, retryTask, reviseTask, cancelTask, approveTask, haltAll, setPaused,
    answerTask, saveRole, removeRole, saveTemplate, removeTemplate, runTemplate, setMonthlyCap,
  } = useSimulation();

  const [name, setName] = useState('');
  const [role, setRole] = useState<AgentRole>('Junior Dev');
  const [api, setApi] = useState<APIProvider>('Ollama');
  // Empty = the provider's default model from the settings
  const [model, setModel] = useState('');
  const [rolesOpen, setRolesOpen] = useState(false);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  // Whether the task being assigned starts with a plan; null = the office's default
  const [planChoice, setPlanChoice] = useState<boolean | null>(null);
  const wantsPlan = planChoice ?? planFirst;
  // The hiring form stays out of the way once the office has people; null = not chosen by hand yet
  const [hireOpen, setHireOpen] = useState<boolean | null>(null);
  const showHire = hireOpen ?? agents.length === 0;
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  // Files picked for the task being assigned
  const [attached, setAttached] = useState<{ files: Attachment[]; folder: boolean } | null>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const folderInput = React.useRef<HTMLInputElement>(null);

  const pickFiles = async (event: React.ChangeEvent<HTMLInputElement>, folder: boolean) => {
    const picked = Array.from(event.target.files || []);
    event.target.value = '';
    if (picked.length === 0) return;
    try {
      const files = await readAttachments(picked);
      if (files.length === 0) return notify('Nothing to attach: the folder only holds files that are skipped (such as node_modules).');
      setAttached({ files, folder });
    } catch (e: any) {
      notify(e.message);
    }
  };
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
  const [panelView, setPanelView] = useState<'roster' | 'tasks' | 'projects' | 'costs' | 'templates'>('roster');
  const [search, setSearch] = useState('');
  const searching = search.trim().length >= 2;
  // A task to show on the task board, and a project whose files are open, both reached from search or the projects list
  const [focusTask, setFocusTask] = useState<{ id: string; at: number } | null>(null);
  const [openProject, setOpenProject] = useState<{ project: string; file?: string } | null>(null);
  const showTask = (id: string) => {
    setSearch('');
    setPanelView('tasks');
    setFocusTask({ id, at: Date.now() });
  };
  const questionCount = agents.reduce((sum, a) => sum + a.taskQueue.filter(t => t.status === 'WAITING_FOR_INPUT' || t.status === 'PLAN_REVIEW').length, 0);
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
    setAttached(null);
    setPlanChoice(null);
    assignTask(agent.id, prompt, {
      budget: Number(taskBudget) > 0 ? Number(taskBudget) : undefined,
      plan: wantsPlan,
      ...(attached ? { attachments: attached.files, attachedFolder: attached.folder } : {}),
    });
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

    {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} onSaved={notify} onImport={importOffice} />}
    {editingAgent && <EmployeeEditor agent={editingAgent} roles={roles} onSave={changes => editAgent(editingAgent.id, changes)} onClose={() => setEditingAgent(null)} />}
    <input ref={fileInput} type="file" multiple hidden onChange={e => pickFiles(e, false)} />
    {/* webkitdirectory lets a whole folder be picked; React has no typed prop for it */}
    <input ref={folderInput} type="file" multiple hidden onChange={e => pickFiles(e, true)} {...({ webkitdirectory: '' } as object)} />
    {openProject && <ProjectBrowser key={`${openProject.project}:${openProject.file || ''}`} project={openProject.project} initialFile={openProject.file} onClose={() => setOpenProject(null)} notify={notify} />}
    {knowledgeOpen && <KnowledgePanel handbook={handbook} notes={notes} onSave={saveHandbook} onRemoveNote={removeNote} onClose={() => setKnowledgeOpen(false)} />}
    {rolesOpen && <RolesPanel roles={roles} agents={agents} onSave={saveRole} onRemove={removeRole} onClose={() => setRolesOpen(false)} />}

    <div className={styles.header}>
      <div className={styles.brand}>
        <div className={styles.iconBox}><Terminal size={18} color="#38bdf8" /></div>
        <h2 className={styles.title}>AI Office</h2>
      </div>
      <div className={styles.headerActions}>
        <button
          onClick={() => setPaused(!paused)}
          className={styles.headerButton}
          style={{ background: paused ? '#10b981' : '#f59e0b' }}
          title={paused ? 'Let employees pick up tasks again' : 'Stop employees from starting new tasks'}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />}
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button onClick={haltAll} className={styles.headerButton} style={{ background: '#ef4444' }} title="Cancel every task that has not finished">
          <SquareX size={14} /> Halt
        </button>
        <button onClick={() => setKnowledgeOpen(true)} className={styles.headerButton} style={{ background: '#475569' }} title="Company knowledge: the handbook and notes every employee is given" aria-label="Company knowledge">
          <BookOpen size={14} />
        </button>
        <button onClick={() => setRolesOpen(true)} className={styles.headerButton} style={{ background: '#475569' }} title="Roles and their instructions" aria-label="Roles and their instructions">
          <Users size={14} />
        </button>
        <button onClick={() => setSettingsOpen(true)} className={styles.headerButton} style={{ background: '#475569' }} title="Settings" aria-label="Settings">
          <Settings size={14} />
        </button>
      </div>
    </div>

    <div className={`${styles.card} ${styles.hireCard}`}>
      <button type="button" className={styles.cardToggle} onClick={() => setHireOpen(!showHire)} aria-expanded={showHire}>
        <UserPlus size={16} />
        <h3>Hire new employee</h3>
        {showHire ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      {showHire && (
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

    <div className={`${styles.card} ${styles.panelCard}`}>
      <div className={styles.searchBox}>
        <Search size={14} />
        <input type="search" aria-label="Search tasks and project files" placeholder="Search tasks and files…" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setSearch(''); }} />
        {search && <button type="button" onClick={() => setSearch('')} aria-label="Clear the search"><X size={14} /></button>}
      </div>

      <div className={styles.tabs} role="tablist" style={searching ? { display: 'none' } : undefined}>
        <button
          id="tab-roster"
          role="tab"
          aria-selected={panelView === 'roster'}
          className={`${styles.tab} ${panelView === 'roster' ? styles.tabActive : ''}`}
          onClick={() => setPanelView('roster')}
        >
          <Briefcase size={14} /> Team ({agents.length})
        </button>
        <button
          id="tab-tasks"
          role="tab"
          aria-selected={panelView === 'tasks'}
          className={`${styles.tab} ${panelView === 'tasks' ? styles.tabActive : ''}`}
          onClick={() => setPanelView('tasks')}
        >
          <ListTree size={14} /> Tasks
          {activeTaskCount > 0 && <span className={styles.tabCount}>{activeTaskCount}</span>}
          {questionCount > 0 && <span className={styles.tabCount} style={{ background: '#f59e0b' }} title="Questions waiting for your answer">?{questionCount}</span>}
        </button>
        <button
          id="tab-projects"
          role="tab"
          aria-selected={panelView === 'projects'}
          className={`${styles.tab} ${panelView === 'projects' ? styles.tabActive : ''}`}
          onClick={() => setPanelView('projects')}
        >
          <FolderKanban size={14} /> Projects
        </button>
        <button
          id="tab-costs"
          role="tab"
          aria-selected={panelView === 'costs'}
          className={`${styles.tab} ${panelView === 'costs' ? styles.tabActive : ''}`}
          onClick={() => setPanelView('costs')}
        >
          <Wallet size={14} /> Insights
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

      {searching ? (
        <div className={styles.agentList}>
          <SearchPanel query={search.trim()} onOpenTask={showTask} onOpenFile={(project, file) => setOpenProject({ project, file })} />
        </div>
      ) : panelView === 'projects' ? (
        <div className={styles.agentList}>
          <ProjectsPanel agents={agents} planFirst={planFirst} notify={notify} onOpenFiles={project => setOpenProject({ project })} onOpenTask={showTask} onContinue={assignTask} onDelete={deleteProject} />
        </div>
      ) : panelView === 'costs' ? (
        <div className={styles.agentList}>
          <InsightsPanel agents={agents} month={month} onSetCap={setMonthlyCap} onCompare={compareModels} onUse={(agentId, api, model) => editAgent(agentId, { api, model })} notify={notify} />
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
            onApprovePlan={approvePlan}
            onRejectPlan={rejectPlan}
            onSteer={steerTask}
            planFirst={planFirst}
            focusTask={focusTask}
            onArchive={archiveTask}
            onDelete={deleteTask}
            onSaveTemplate={startTemplateFrom}
            onRetry={retryTask}
            onRevise={reviseTask}
            onContinue={(agentId, project, prompt, budget, plan) => assignTask(agentId, prompt, { project, budget, plan })}
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
              <div className={styles.agentAvatar}>
                <img src={agent.avatar || '/avatars/robot.png'} alt={agent.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </div>
              <div className={styles.agentInfo}>
                <div className={styles.agentName}>
                  <span className={styles.agentNameText} title={agent.name}>{agent.name}</span>
                  <span className={styles.badge}>{agent.role}</span>
                </div>
                <div className={styles.agentDetails} title={`${agent.api}${agent.model ? ` · ${agent.model}` : ''} · ${agent.tokensUsed.toLocaleString('en-US')} tokens used`}>
                  <span className={styles.statusText} data-status={agent.state}>{STATE_LABEL[agent.state] || agent.state}</span>
                  <span className={styles.dot}>•</span>
                  <Zap size={11} style={{ marginRight: 3, flexShrink: 0 }} />
                  <span className={styles.agentModel}>{agent.model || agent.api}</span>
                  <span className={styles.dot}>•</span>
                  <span style={{ flexShrink: 0 }}>{compactTokens(agent.tokensUsed)} tokens</span>
                </div>
              </div>
              <div className={styles.agentActions}>
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
                  onClick={(e) => { e.stopPropagation(); setEditingAgent(agent); }}
                  title="Edit employee"
                >
                  <Pencil size={14} />
                </button>
                <button
                  className={styles.actionButton}
                  style={{ color: '#ef4444' }}
                  onClick={(e) => { e.stopPropagation(); if (window.confirm(`Remove ${agent.name}? Their tasks and history are deleted with them. To change their role or model instead, use Edit.`)) removeAgent(agent.id); }}
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
                <button type="button" className={styles.actionButton} onClick={() => fileInput.current?.click()} title="Attach files or images for this task" aria-label="Attach files">
                  <Paperclip size={14} />
                </button>
                <button type="button" className={styles.actionButton} onClick={() => folderInput.current?.click()} title="Start from an existing folder: its files become the project" aria-label="Attach a folder">
                  <FolderUp size={14} />
                </button>
                <button className={styles.sendButton} onClick={() => handleManualAssignment(agent, taskPrompt)}>
                  <ChevronRight size={16} />
                </button>
              </div>
            )}
            {activeTaskAgent === agent.id && (
              <label onClick={e => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#475569', padding: '0 12px 8px', background: '#fff', cursor: 'pointer' }} title="The employee first proposes a plan with a cost estimate. Nothing is built until you approve it.">
                <input type="checkbox" checked={wantsPlan} onChange={e => setPlanChoice(e.target.checked)} />
                Show me a plan to approve before any work starts
              </label>
            )}
            {activeTaskAgent === agent.id && attached && (
              <div onClick={e => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#475569', padding: '4px 12px 8px' }}>
                <Paperclip size={12} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {attached.folder
                    ? `Folder with ${attached.files.length} file${attached.files.length === 1 ? '' : 's'}: they become the project`
                    : attached.files.map(f => f.path).join(', ')}
                </span>
                <button type="button" className={styles.actionButton} onClick={() => setAttached(null)} aria-label="Remove attachments"><X size={12} /></button>
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
