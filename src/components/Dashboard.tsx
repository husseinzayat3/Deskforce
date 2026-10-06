"use client";

import React, { useState } from 'react';
import { useSimulation } from '../lib/SimulationContext';
import { AgentRole, APIProvider, Agent, TaskItem } from '../lib/types';
import { UserPlus, Briefcase, Zap, CheckCircle2, ChevronRight, MessageSquare, Terminal, Trash2, Pause, Play, SquareX, ListTree } from 'lucide-react';
import styles from './Dashboard.module.css';
import TaskTree from './TaskTree';
import { OFFICE_CONFIG, ROLE_RANK, FINISHED_STATUSES, indexTasks, getAncestors, getRoot, getTree, projectOf, projectNameFromPrompt, slugifyProjectName, similarity, stripGuardrailNote, formatUsage } from '../lib/officeConfig';
import { buildSystemPrompt, FILE_PATH_PLACEHOLDER, PROJECT_NAME_PLACEHOLDER, REVIEW_TASK_PROMPT } from '../lib/agentPrompt';
import { buildReport, buildTranscript, REPORT_FILENAME, TRANSCRIPT_FILENAME } from '../lib/report';

/** Delegations more alike than this (0–1 word overlap) count as the same task. */
const DUPLICATE_SIMILARITY = 0.8;

const PLACEHOLDER_FILENAMES = new Set([FILE_PATH_PLACEHOLDER, 'filename.ext']);

export default function Dashboard() {
  const { agents, isLeader, focus, addAgent, removeAgent, setAgentState, updateAgentTokens, enqueueTask, patchTask, updateTaskStatus, clearAllTasks } = useSimulation();

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

  // Always-current snapshot, so a long model call can see what changed while it was waiting
  const agentsRef = React.useRef(agents);
  agentsRef.current = agents;

  const handleManualAssignment = (agent: Agent, prompt: string) => {
    if (!prompt.trim()) return;
    setActiveTaskAgent(null);
    setTaskPrompt('');
    enqueueTask(agent.id, prompt, 'User');
    showNotification(`Task queued for ${agent.name}`);
  };

  const postWorkspace = async (body: Record<string, unknown>) => {
    const res = await fetch('/api/workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `Workspace request failed (${res.status})`);
    return data;
  };

  /** Returns `base`, or `base-2`, `base-3`… when a project with that name already exists. */
  const claimProjectName = async (base: string, taskId: string) => {
    const taken = new Set<string>();
    agentsRef.current.forEach(a => a.taskQueue.forEach(t => t.project && taken.add(t.project)));

    for (let n = 1; n <= 20; n++) {
      const candidate = n === 1 ? base : `${base}-${n}`;
      if (taken.has(candidate)) continue;
      try {
        const res = await fetch(`/api/workspace?project=${candidate}`);
        const data = await res.json();
        if (res.ok && !data.exists) return candidate;
      } catch (e) {
        break;
      }
    }
    return `${base}-${taskId.slice(0, 4)}`;
  };

  /** Models sometimes repeat the project folder in front of the path, which would nest the project inside itself. */
  const normalizeFilename = (filename: string, slug: string) => {
    let cleaned = filename.trim().replace(/^[`'"]+|[`'"]+$/g, '').replace(/\\/g, '/').replace(/^\.?\/+/, '');
    for (const prefix of [`workspace/projects/${slug}/`, `projects/${slug}/`, `${slug}/`]) {
      if (cleaned.startsWith(prefix)) cleaned = cleaned.slice(prefix.length);
    }
    return cleaned;
  };

  const executeTask = async (agent: Agent, task: TaskItem) => {
    if (executingTasks.current.has(task.id)) return;

    const taskIndex = indexTasks(agents);
    const rootTask = getRoot(task.id, taskIndex)?.task || task;
    const isReview = task.kind === 'REVIEW';
    // A root task that has not run yet starts a new project, which the agent names in its response
    const namesProject = rootTask.id === task.id && !task.project;
    let slug = namesProject ? '' : projectOf(rootTask);
    const ancestors = getAncestors(task.id, taskIndex);
    const depth = ancestors.length;
    const tree = getTree(rootTask.id, taskIndex);
    const treeTokens = tree.reduce((sum, ref) => sum + (ref.task.tokens || 0), 0);

    // Sub-tasks queued before the tree ran out of budget wait for approval instead of running
    if (task.parentId && !isReview && task.reviewStatus !== 'APPROVED' && treeTokens >= OFFICE_CONFIG.TASK_TREE_TOKEN_BUDGET) {
      patchTask(agent.id, task.id, {
        status: 'AWAITING_APPROVAL',
        reviewStatus: 'PENDING_REVIEW',
        reviewNote: `Token budget ${OFFICE_CONFIG.TASK_TREE_TOKEN_BUDGET} exhausted.`
      });
      return;
    }

    executingTasks.current.add(task.id);
    setAgentState(agent.id, 'WORKING');
    updateTaskStatus(agent.id, task.id, 'IN_PROGRESS');

    /** True once the task was halted (or its agent removed) while the model was working. */
    const wasCancelled = () => {
      const current = agentsRef.current.find(a => a.id === agent.id)?.taskQueue.find(t => t.id === task.id);
      return !current || current.status === 'CANCELLED';
    };

    try {
      // The real state of the project: what exists, and what is in it
      let existingFiles: string[] = [];
      let fileContents: Record<string, string> = {};
      if (slug) {
        try {
          const res = await fetch(`/api/workspace?project=${slug}&contents=1`);
          if (res.ok) {
            const data = await res.json();
            existingFiles = data.files || [];
            fileContents = data.contents || {};
          }
        } catch (e) {
          // ignore
        }
      }

      // Only offer colleagues this agent is actually allowed to delegate to
      const canDelegate = !isReview && depth < OFFICE_CONFIG.MAX_DELEGATION_DEPTH;
      const colleagues = canDelegate
        ? agents.filter(a => a.id !== agent.id && ROLE_RANK[a.role] > ROLE_RANK[agent.role])
        : [];

      const systemPrompt = buildSystemPrompt({
        agent, task, rootTask, parent: ancestors[0], tree, slug, namesProject, isReview, colleagues, existingFiles, fileContents
      });

      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: stripGuardrailNote(task.prompt),
          apiProvider: agent.api,
          systemPrompt,
          maxTokens: isReview ? OFFICE_CONFIG.REVIEW_MAX_TOKENS : undefined
        })
      });
      const data = await res.json();

      if (!res.ok || data.error) {
        throw new Error(data.error || `Agent request failed (${res.status})`);
      }

      if (data.tokens) {
        updateAgentTokens(agent.id, data.tokens);
      }

      if (!data.response) {
        throw new Error('The model returned an empty response.');
      }

      // Halted while the model was working: discard the result
      if (wasCancelled()) return;

      const response: string = data.response;
      const summary = response.match(/\[SUMMARY\]([\s\S]*?)\[\/SUMMARY\]/i)?.[1].trim();
      const problems: string[] = [];

      if (namesProject) {
        const proposed = slugifyProjectName(response.match(/\[PROJECT:\s*([^\]\n]+)\]/i)?.[1] || '');
        const base = proposed && proposed !== PROJECT_NAME_PLACEHOLDER ? proposed : projectNameFromPrompt(task.prompt);
        slug = await claimProjectName(base, task.id);
        // Saved on the root task so its sub-tasks (and later reloads) find the same folder
        patchTask(agent.id, task.id, { project: slug });
      }

      // Scaffold first, so the files below (and delegated work) land in a finished skeleton
      if (!isReview) {
        const kinds = new Set<string>();
        const scaffoldRegex = /\[SCAFFOLD:\s*(flutter|node)\]/gi;
        let scaffoldMatch;
        while ((scaffoldMatch = scaffoldRegex.exec(response)) !== null) {
          kinds.add(scaffoldMatch[1].toLowerCase());
        }
        for (const kind of Array.from(kinds)) {
          try {
            await postWorkspace({ action: 'scaffold', project: slug, kind });
          } catch (e: any) {
            problems.push(`Scaffold ${kind}: ${e.message}`);
          }
        }
      }

      // Parse file creations (the server validates that each path stays inside the project)
      const writtenFiles: string[] = [];
      const fileRegex = /\[FILE:\s*([^\]\n]+?)\s*\]([\s\S]*?)\[\/FILE\]/gi;
      let fileMatch;
      let closedFileBlocks = 0;
      while ((fileMatch = fileRegex.exec(response)) !== null) {
        closedFileBlocks += 1;
        const filename = normalizeFilename(fileMatch[1], slug);
        const content = fileMatch[2].trim();
        // Models sometimes echo the format example back verbatim
        if (!filename || PLACEHOLDER_FILENAMES.has(filename.toLowerCase())) continue;

        try {
          const saved = await postWorkspace({ action: 'write', project: slug, filename, content });
          if (saved.path && !writtenFiles.includes(saved.path)) writtenFiles.push(saved.path);
        } catch (e: any) {
          problems.push(`${filename}: ${e.message}`);
        }
      }

      const openedFileBlocks = (response.match(/\[FILE:/gi) || []).length;
      if (openedFileBlocks > closedFileBlocks) {
        problems.push(`${openedFileBlocks - closedFileBlocks} file block(s) had no closing [/FILE] tag and were not saved.`);
      }
      if (data.truncated) {
        problems.push('The response reached the length limit and may be incomplete.');
      }

      if (wasCancelled()) return;

      // Parse assignments (after the files are saved, so delegated work starts from the current project)
      if (canDelegate) {
        let spawned = tree.filter(ref => ref.task.parentId === task.id).length;
        const knownPrompts = tree.map(ref => ref.task.prompt);
        const proposed: string[] = [];
        const regex = /\[ASSIGN:\s*([a-zA-Z0-9_-]+)\]([\s\S]*?)\[\/ASSIGN\]/gi;
        let match;
        while ((match = regex.exec(response)) !== null) {
          const targetId = match[1];
          const taskDesc = match[2].trim();
          const isDuplicate = (other: string) => similarity(other, taskDesc) > DUPLICATE_SIMILARITY;

          const targetAgent = agents.find(a => a.id === targetId);
          // The same assignment repeated within one response is simply dropped
          if (!targetAgent || !taskDesc || proposed.some(isDuplicate)) continue;

          // Apply Guardrails
          let violation = '';
          if (spawned >= OFFICE_CONFIG.MAX_SUBTASKS_PER_TASK) violation = `Max subtasks ${OFFICE_CONFIG.MAX_SUBTASKS_PER_TASK} reached.`;
          else if (treeTokens + (data.tokens || 0) >= OFFICE_CONFIG.TASK_TREE_TOKEN_BUDGET) violation = `Token budget ${OFFICE_CONFIG.TASK_TREE_TOKEN_BUDGET} exhausted.`;
          else if (ROLE_RANK[targetAgent.role] <= ROLE_RANK[agent.role]) violation = `Cannot delegate to equal or higher rank (${targetAgent.role}).`;
          else if (knownPrompts.some(isDuplicate)) violation = `Duplicate task detected.`;

          proposed.push(taskDesc);
          spawned += 1;

          // Link the sub-task to the task that produced it so the board can nest it
          enqueueTask(
            targetAgent.id,
            `Task delegated from ${agent.name}:\n${taskDesc}`,
            agent.name,
            task.id,
            violation ? 'AWAITING_APPROVAL' : 'PENDING',
            violation ? { reviewStatus: 'PENDING_REVIEW', reviewNote: violation } : undefined
          );
        }
      }

      if (problems.length > 0) {
        showNotification(`${agent.name}: ${problems.length} problem${problems.length > 1 ? 's' : ''} saving work — see the task details.`);
      }

      patchTask(agent.id, task.id, {
        status: 'COMPLETED',
        response,
        tokens: data.tokens,
        cost: typeof data.cost === 'number' ? data.cost : undefined,
        model: data.model,
        summary,
        files: writtenFiles.length > 0 ? writtenFiles : undefined,
        ...(problems.length > 0 ? { reviewNote: problems.join('\n') } : {})
      });
      setAgentState(agent.id, 'IDLE');
    } catch (e: any) {
      if (wasCancelled()) return;

      const message: string = e?.message || 'Unknown error';
      const isRateLimit = message.toLowerCase().includes('429') || message.toLowerCase().includes('rate limit');
      updateTaskStatus(agent.id, task.id, 'FAILED', undefined, message);
      showNotification(`Task for ${agent.name} failed.${isRateLimit ? ' (Rate Limit Hit)' : ''}`);

      // Send to break on rate limit instead of IDLE
      setAgentState(agent.id, isRateLimit ? 'BREAK' : 'IDLE');
    } finally {
      executingTasks.current.delete(task.id);
    }
  };

  React.useEffect(() => {
    // Do not pull new tasks if paused, or if another tab is running the office
    if (isPaused || !isLeader) return;

    agents.forEach(agent => {
      // If agent isn't already working on something
      if (agent.state === 'WORKING') return;

      // Oldest pending task first
      const nextTask = (agent.taskQueue || [])
        .filter(t => t.status === 'PENDING')
        .reduce<TaskItem | undefined>((oldest, t) => (!oldest || t.timestamp < oldest.timestamp ? t : oldest), undefined);
      if (nextTask) executeTask(agent, nextTask);
    });
    // executeTask is re-created each render and reads the same `agents` this effect depends on
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, isPaused, isLeader]);

  // Wrap up finished projects: one final review once all delegated work is done, then the report.
  // Only for tasks the user assigned, and only for projects named under the current scheme.
  const wrappingUp = React.useRef(new Set<string>());

  React.useEffect(() => {
    if (!isLeader) return;
    const taskIndex = indexTasks(agents);

    agents.forEach(agent => agent.taskQueue.forEach(root => {
      if (root.parentId || root.status !== 'COMPLETED' || !root.project || root.report) return;

      const tree = getTree(root.id, taskIndex);
      if (tree.some(ref => !FINISHED_STATUSES.has(ref.task.status))) return;

      const subtasks = tree.filter(ref => ref.task.id !== root.id);
      const reviewed = subtasks.some(ref => ref.task.kind === 'REVIEW');
      const reviewKey = `review:${root.id}`;

      // Several people worked on it: have the owner check the pieces fit together before reporting
      if (subtasks.some(ref => ref.task.status === 'COMPLETED') && !reviewed) {
        if (wrappingUp.current.has(reviewKey)) return;
        wrappingUp.current.add(reviewKey);
        enqueueTask(agent.id, REVIEW_TASK_PROMPT, 'Office', root.id, 'PENDING', { kind: 'REVIEW' });
        return;
      }

      if (wrappingUp.current.has(root.id)) return;
      wrappingUp.current.add(root.id);

      const rootRef = { task: root, agent };
      const report = buildReport(rootRef, tree);
      patchTask(agent.id, root.id, { report });
      showNotification(`Report ready: ${root.project}`);

      Promise.all([
        postWorkspace({ action: 'write', project: root.project, filename: REPORT_FILENAME, content: report }),
        postWorkspace({ action: 'write', project: root.project, filename: TRANSCRIPT_FILENAME, content: buildTranscript(rootRef, tree) }),
      ]).catch(e => showNotification(`Could not save the report files for ${root.project}: ${e.message}`));
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, isLeader]);

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
            onCancel={(agentId, taskId) => updateTaskStatus(agentId, taskId, 'CANCELLED')}
            onApprove={(agentId, taskId) => patchTask(agentId, taskId, { status: 'PENDING', reviewStatus: 'APPROVED' })}
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
                            {task.tokens ? ` · ${formatUsage(task.tokens, task.cost)}` : ''}
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
