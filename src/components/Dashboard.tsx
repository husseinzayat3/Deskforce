"use client";

import React, { useState } from 'react';
import { useSimulation } from '../lib/SimulationContext';
import { AgentRole, APIProvider, Agent } from '../lib/types';
import { UserPlus, Briefcase, Zap, CheckCircle2, ChevronRight, MessageSquare, Terminal, Trash2, Pause, Play, SquareX, ListTree } from 'lucide-react';
import styles from './Dashboard.module.css';
import TaskTree from './TaskTree';
import { OFFICE_CONFIG, cleanPrompt, formatUsage } from '../lib/officeConfig';

export default function Dashboard() {
  const { agents, paused, notifications, notify, focus, addAgent, removeAgent, assignTask, retryTask, reviseTask, cancelTask, approveTask, haltAll, setPaused } = useSimulation();

  const [name, setName] = useState('');
  const [role, setRole] = useState<AgentRole>('Junior Dev');
  const [api, setApi] = useState<APIProvider>('Ollama');
  const [avatar, setAvatar] = useState('/avatars/robot.png');

  // State for inline task assignment
  const [activeTaskAgent, setActiveTaskAgent] = useState<string | null>(null);
  const [taskPrompt, setTaskPrompt] = useState('');
  // Optional spending limit in USD for the task being assigned; empty = the default
  const [taskBudget, setTaskBudget] = useState('');

  // State for expanding task history
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);

  // Right-panel view: employee roster or hierarchical task board
  const [panelView, setPanelView] = useState<'roster' | 'tasks'>('roster');
  const activeTaskCount = agents.reduce(
    (sum, a) => sum + (a.taskQueue || []).filter(t => t.status === 'PENDING' || t.status === 'IN_PROGRESS').length,
    0
  );

  const handleAddEmployee = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    addAgent({ name, role, api, avatar });
    setName('');
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
  React.useEffect(() => {
    if (!focus) return;
    setPanelView('roster');
    setExpandedAgentId(focus.agentId);
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
          <select value={role} onChange={(e) => setRole(e.target.value as AgentRole)} className={styles.select}>
            <option value="CEO">CEO</option>
            <option value="Tech Lead">Tech Lead</option>
            <option value="Junior Dev">Junior Dev</option>
            <option value="Designer">Designer</option>
            <option value="HR">HR</option>
          </select>
          <select value={api} onChange={(e) => setApi(e.target.value as APIProvider)} className={styles.select}>
            <option value="OpenAI">OpenAI (GPT-4o mini)</option>
            <option value="Grok">Grok (xAI)</option>
            <option value="Ollama">Ollama (Local)</option>
          </select>
        </div>
        <button type="submit" className={styles.button}>
          Hire Employee
        </button>
      </form>
    </div>

    <div className={styles.card} style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className={styles.tabs} role="tablist">
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
        </button>
      </div>

      {panelView === 'tasks' ? (
        <div className={styles.agentList}>
          <TaskTree 
            agents={agents} 
            onCancel={(_agentId, taskId) => cancelTask(taskId)}
            onApprove={(_agentId, taskId) => approveTask(taskId)}
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
                  <Zap size={12} style={{ marginRight: 4 }} />{agent.api}
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
                            <strong>Response:</strong> {task.response}
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
