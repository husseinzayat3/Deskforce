"use client";

import React, { useState } from 'react';
import { useSimulation } from '../lib/SimulationContext';
import { AgentRole, APIProvider, Agent, TaskItem } from '../lib/types';
import { UserPlus, Briefcase, Zap, CheckCircle2, ChevronRight, MessageSquare, Terminal, Trash2, Pause, Play, SquareX, ListTree } from 'lucide-react';
import styles from './Dashboard.module.css';
import TaskTree from './TaskTree';
import { OFFICE_CONFIG, ROLE_RANK, indexTasks, getAncestors, getRoot, getTree, projectSlug, similarity } from '../lib/officeConfig';

export default function Dashboard() {
  const { agents, addAgent, removeAgent, setAgentState, updateAgentTokens, enqueueTask, patchTask, updateTaskStatus, clearAllTasks } = useSimulation();

  const [isPaused, setIsPaused] = useState(false);

  const [name, setName] = useState('');
  const [role, setRole] = useState<AgentRole>('Junior Dev');
  const [api, setApi] = useState<APIProvider>('Ollama');
  const [avatar, setAvatar] = useState('/avatars/robot.png');

  // State for inline task assignment
  const [activeTaskAgent, setActiveTaskAgent] = useState<string | null>(null);
  const [taskPrompt, setTaskPrompt] = useState('');

  // State for expanding task history
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);

  // Right-panel view: employee roster or hierarchical task board
  const [panelView, setPanelView] = useState<'roster' | 'tasks'>('roster');
  const activeTaskCount = agents.reduce(
    (sum, a) => sum + (a.taskQueue || []).filter(t => t.status === 'PENDING' || t.status === 'IN_PROGRESS').length,
    0
  );

  // Notifications state
  const [notifications, setNotifications] = useState<{ id: string, message: string }[]>([]);

  const showNotification = (message: string) => {
    const id = Math.random().toString();
    setNotifications(prev => [...prev, { id, message }]);
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== id));
    }, 5000);
  };

  const handleAddEmployee = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    addAgent({ name, role, api, avatar });
    setName('');
  };

  // Background Queue Executor
  const executingTasks = React.useRef(new Set<string>());

  const handleManualAssignment = (agent: Agent, prompt: string) => {
    if (!prompt.trim()) return;
    setActiveTaskAgent(null);
    setTaskPrompt('');
    enqueueTask(agent.id, prompt, 'User');
    showNotification(`Task queued for ${agent.name}`);
  };

  const executeTask = async (agent: Agent, task: TaskItem) => {
    if (executingTasks.current.has(task.id)) return;
    executingTasks.current.add(task.id);

    setAgentState(agent.id, 'WORKING');
    updateTaskStatus(agent.id, task.id, 'IN_PROGRESS');
    
    try {
      const taskIndex = indexTasks(agents);
      const rootTask = getRoot(task.id, taskIndex)?.task || task;
      const slug = projectSlug(rootTask);
      const ancestors = getAncestors(task.id, taskIndex);
      const tree = getTree(rootTask.id, taskIndex);
      const treeTokens = tree.reduce((sum, ref) => sum + (ref.task.tokens || 0), 0);
      const mySubtasks = tree.filter(ref => ref.task.parentId === task.id);

      // Fetch existing project files
      let existingFiles: string[] = [];
      try {
        const res = await fetch(`/api/workspace?project=${slug}`);
        if (res.ok) {
          const data = await res.json();
          existingFiles = data.files || [];
        }
      } catch (e) {
        // ignore
      }

      // Build office roster context
      const roster = agents.filter(a => a.id !== agent.id).map(a => `- ${a.name} (Role: ${a.role}, ID: ${a.id})`).join('\n');

      let systemPrompt = `You are ${agent.name}, the ${agent.role} of the company.\nYour current project workspace is: ${slug}\n`;
      
      if (existingFiles.length > 0) {
        systemPrompt += `\nExisting project files:\n${existingFiles.slice(0, OFFICE_CONFIG.MAX_FILES_IN_PROMPT).map(f => `- ${f}`).join('\n')}\n`;
      }

      if (roster.length > 0) {
        systemPrompt += `\nHere are your available colleagues:\n${roster}\n\nIf you need to assign work to them, output your reasoning and then append your assignments using this EXACT format at the end of your message:\n[ASSIGN: their_id] task description [/ASSIGN]\n`;
      }

      systemPrompt += `\nIf you need to create a document, write code, or save any work to the local project folder, use this EXACT format:\n[FILE: filename.ext]\nfile contents\n[/FILE]\n\nIf you need to initialize a new project, use:\n[SCAFFOLD: flutter] or [SCAFFOLD: node]\n\nFinally, end your response with a summary of the work done for the admin using this EXACT format:\n[SUMMARY] your summary [/SUMMARY]`;

      // Build history context
      if (agent.taskQueue && agent.taskQueue.length > 0) {
        const completed = agent.taskQueue.filter(t => t.status === 'COMPLETED').slice(0, 3);
        const historyText = completed.map(h => `Previous Task: ${h.prompt}\nYour Previous Response: ${h.response?.slice(0, OFFICE_CONFIG.MEMORY_CHARS)}`).join('\n\n');
        if (historyText) systemPrompt += `\n\nYour Recent Memory:\n${historyText}`;
      }

      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: task.prompt, apiProvider: agent.api, systemPrompt })
      });
      const data = await res.json();
      
      if (data.error) {
        throw new Error(data.error);
      }

      if (data.tokens) {
        updateAgentTokens(agent.id, data.tokens);
      }

      let parsedSummary: string | undefined;
      const writtenFiles: string[] = [];

      if (data.response) {
        updateTaskStatus(agent.id, task.id, 'COMPLETED', data.response);
        
        const summaryMatch = data.response.match(/\[SUMMARY\]([\s\S]*?)\[\/SUMMARY\]/i);
        if (summaryMatch) {
          parsedSummary = summaryMatch[1].trim();
        }

        // Parse assignments
        const regex = /\[ASSIGN:\s*([a-zA-Z0-9_-]+)\]([\s\S]*?)\[\/ASSIGN\]/gi;
        let match;
        while ((match = regex.exec(data.response)) !== null) {
          const targetId = match[1];
          const taskDesc = match[2].trim();

          const targetAgent = agents.find(a => a.id === targetId);
          if (targetAgent) {
            // Apply Guardrails
            let violation = '';
            if (ancestors.length >= OFFICE_CONFIG.MAX_DELEGATION_DEPTH) violation = `Max depth ${OFFICE_CONFIG.MAX_DELEGATION_DEPTH} reached.`;
            else if (mySubtasks.length >= OFFICE_CONFIG.MAX_SUBTASKS_PER_TASK) violation = `Max subtasks ${OFFICE_CONFIG.MAX_SUBTASKS_PER_TASK} reached.`;
            else if (treeTokens + (data.tokens || 0) >= OFFICE_CONFIG.TASK_TREE_TOKEN_BUDGET) violation = `Token budget ${OFFICE_CONFIG.TASK_TREE_TOKEN_BUDGET} exhausted.`;
            else if (ROLE_RANK[targetAgent.role] <= ROLE_RANK[agent.role]) violation = `Cannot delegate to equal or higher rank (${targetAgent.role}).`;
            else if (tree.some(ref => similarity(ref.task.prompt, taskDesc) > 0.8)) violation = `Duplicate task detected.`;

            const status = violation ? 'AWAITING_APPROVAL' : 'PENDING';
            const finalDesc = violation ? `[GUARDRAIL: ${violation}]\n${taskDesc}` : taskDesc;

            setTimeout(() => {
              enqueueTask(targetAgent.id, `Task delegated from ${agent.name}:\n${finalDesc}`, agent.name, task.id, status);
            }, 1000);
          }
        }

        // Parse scaffold
        const scaffoldRegex = /\[SCAFFOLD:\s*(flutter|node)\]/gi;
        let scaffoldMatch;
        while ((scaffoldMatch = scaffoldRegex.exec(data.response)) !== null) {
          const kind = scaffoldMatch[1].toLowerCase();
          try {
            await fetch('/api/workspace', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'scaffold', project: slug, kind })
            });
          } catch (e) {
            console.error("Scaffold error", e);
          }
        }

        // Parse file creations
        const fileRegex = /\[FILE:\s*([a-zA-Z0-9_.-]+)\]([\s\S]*?)\[\/FILE\]/gi;
        let fileMatch;
        while ((fileMatch = fileRegex.exec(data.response)) !== null) {
          const filename = fileMatch[1];
          const content = fileMatch[2].trim();

          try {
            const saveRes = await fetch('/api/workspace', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'write', project: slug, filename, content })
            });
            const saveData = await saveRes.json();
            if (saveData.path) writtenFiles.push(saveData.path);
          } catch (err) {
            console.error("File save error", err);
          }
        }
      }

      patchTask(agent.id, task.id, { 
        tokens: data.tokens, 
        summary: parsedSummary, 
        files: writtenFiles.length > 0 ? writtenFiles : undefined 
      });

    } catch (e: any) {
    let isRateLimit = false;
    if (e && e.message) {
      isRateLimit = e.message.toLowerCase().includes('429') || e.message.toLowerCase().includes('rate limit');
    }
    updateTaskStatus(agent.id, task.id, 'FAILED', undefined, e.message || 'Unknown error');
    showNotification(`Task for ${agent.name} failed.${isRateLimit ? ' (Rate Limit Hit)' : ''}`);
    
    executingTasks.current.delete(task.id);
    
    // Send to break on rate limit instead of IDLE
    if (isRateLimit) {
      setAgentState(agent.id, 'BREAK');
      return;
    }
  }

  // Normal execution path (success or non-rate-limit failure)
  executingTasks.current.delete(task.id);
  setAgentState(agent.id, 'IDLE');
};

React.useEffect(() => {
  if (isPaused) return; // Do not pull new tasks if paused

  agents.forEach(agent => {
    // If agent isn't already working on something
    if (agent.state !== 'WORKING') {
      const pendingTask = agent.taskQueue?.find(t => t.status === 'PENDING');
      if (pendingTask) {
        executeTask(agent, pendingTask);
      }
    }
  });
}, [agents, isPaused]);

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
          onClick={() => setIsPaused(!isPaused)} 
          className={styles.button} 
          style={{ background: isPaused ? '#10b981' : '#f59e0b', padding: '6px 12px', fontSize: '12px' }}
        >
          {isPaused ? <Play size={14} /> : <Pause size={14} />} 
          {isPaused ? 'Resume Tasks' : 'Pause Tasks'}
        </button>
        <button 
          onClick={clearAllTasks} 
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
            <option value="OpenAI">OpenAI (GPT-4)</option>
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
            onCancel={(agentId, taskId) => updateTaskStatus(agentId, taskId, 'CANCELLED')}
            onApprove={(agentId, taskId) => updateTaskStatus(agentId, taskId, 'PENDING')}
          />
        </div>
      ) : (
      <div className={styles.agentList}>
        {agents.map(agent => (
          <div
            key={agent.id}
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
                            {task.parentId ? 'Sub-task · ' : ''}From: {task.assignedBy}
                          </span>
                        </div>
                        <div className={styles.historyPrompt}>
                          <strong>Task:</strong> {task.prompt}
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
                          </span>
                          {task.status === 'PENDING' && (
                            <button
                              className={styles.cancelTaskBtn}
                              onClick={() => updateTaskStatus(agent.id, task.id, 'CANCELLED')}
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
