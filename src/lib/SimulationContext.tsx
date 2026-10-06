"use client";

import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { Agent, AgentState, TaskItem, TaskStatus } from './types';

type NewAgent = Pick<Agent, 'name' | 'role' | 'api' | 'avatar'>;

interface SimulationContextType {
  agents: Agent[];
  /** False while another browser tab is running this office. */
  isLeader: boolean;
  /** Employee last clicked on the map. `at` changes on every click, so clicking the same one again still counts. */
  focus: { agentId: string; at: number } | null;
  focusAgent: (agentId: string) => void;
  addAgent: (agent: NewAgent) => void;
  removeAgent: (agentId: string) => void;
  updateAgentTokens: (agentId: string, tokens: number) => void;
  setAgentState: (agentId: string, state: AgentState) => void;
  enqueueTask: (agentId: string, prompt: string, assignedBy: string, parentId?: string, status?: TaskStatus, extra?: Partial<TaskItem>) => string;
  patchTask: (agentId: string, taskId: string, patch: Partial<TaskItem>) => void;
  updateTaskStatus: (agentId: string, taskId: string, status: TaskStatus, response?: string, error?: string) => void;
  clearAllTasks: () => void;
}

const SimulationContext = createContext<SimulationContextType | undefined>(undefined);

// Define some points of interest in the office map based on a 1024x1024 or similar coordinate system
export const POI = {
  DESKS: {
    CEO: [{ x: 480, y: 180 }, { x: 430, y: 180 }], // Meeting room / private area
    'Tech Lead': [{ x: 150, y: 400 }, { x: 250, y: 400 }, { x: 350, y: 400 }, { x: 450, y: 400 }],
    'Junior Dev': [{ x: 150, y: 550 }, { x: 250, y: 550 }, { x: 350, y: 550 }, { x: 450, y: 550 }, { x: 150, y: 700 }, { x: 250, y: 700 }, { x: 350, y: 700 }, { x: 450, y: 700 }],
    'Designer': [{ x: 800, y: 350 }, { x: 850, y: 350 }],
    'HR': [{ x: 800, y: 400 }]
  },
  COFFEE: { x: 850, y: 450 },
  BREAK_ROOM: { x: 800, y: 600 },
  TOILET: { x: 800, y: 200 },
};

const ENTRANCE = { x: 500, y: 900 };

/** Only one browser tab may run the office, otherwise every tab would execute the same queue. */
const OFFICE_LOCK = 'my-office-simulation';

const TICK_MS = 1000;
const SAVE_MS = 2000;
const IDLE_BEFORE_BREAK_MS = 30_000;
const MAX_BREAKS_PER_IDLE_STRETCH = 2;
/** Chance per tick that an agent on a break heads back to the desk. */
const BREAK_RETURN_CHANCE = 0.02;

const ON_BREAK = new Set<AgentState>(['COFFEE', 'TOILET', 'BREAK']);
const UNFINISHED = new Set<TaskStatus>(['AWAITING_APPROVAL', 'PENDING', 'IN_PROGRESS']);

const newId = () => Math.random().toString(36).slice(2, 11);
const jitter = (range: number) => Math.random() * range - range / 2;

const deskFor = (agent: Agent, all: Agent[]) => {
  const desks = POI.DESKS[agent.role] || POI.DESKS['Junior Dev'];
  const index = Math.max(0, all.filter(a => a.role === agent.role).findIndex(a => a.id === agent.id));
  return desks[index % desks.length];
};

const destinationFor = (agent: Agent, state: AgentState, all: Agent[]) => {
  if (state === 'COFFEE') return { x: POI.COFFEE.x + jitter(40), y: POI.COFFEE.y + jitter(40) };
  if (state === 'TOILET') return { x: POI.TOILET.x + jitter(40), y: POI.TOILET.y + jitter(40) };
  if (state === 'BREAK') return { x: POI.BREAK_ROOM.x + jitter(100), y: POI.BREAK_ROOM.y + jitter(100) };
  return deskFor(agent, all);
};

/** Switch state and send the agent to wherever that state happens (the map animates the walk). */
const moveTo = (agent: Agent, state: AgentState, all: Agent[]): Agent => {
  const { x, y } = destinationFor(agent, state, all);
  return { ...agent, state, x, y, targetX: x, targetY: y };
};

const isWalking = (agent: Agent) => agent.x !== agent.targetX || agent.y !== agent.targetY;

export const SimulationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tabRole, setTabRole] = useState<'pending' | 'leader' | 'follower'>('pending');
  const isLeader = tabRole === 'leader';
  const [focus, setFocus] = useState<{ agentId: string; at: number } | null>(null);
  const focusAgent = (agentId: string) => setFocus({ agentId, at: Date.now() });

  const agentsRef = useRef<Agent[]>(agents);
  const loadedRef = useRef(false);
  const lastSavedRef = useRef<Agent[] | null>(null);
  const idleSinceRef = useRef(new Map<string, number>());

  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  // Claim the office for this tab; other tabs wait until it is closed
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.locks) {
      setTabRole('leader');
      return;
    }

    let cancelled = false;
    let release: (() => void) | undefined;
    const abort = new AbortController();

    // Holding the lock = keeping this promise pending
    const hold = () => {
      if (cancelled) return Promise.resolve();
      return new Promise<void>(resolve => {
        release = resolve;
        setTabRole('leader');
      });
    };

    (async () => {
      const gotIt = await navigator.locks.request(OFFICE_LOCK, { ifAvailable: true }, async lock => {
        if (!lock) return false;
        await hold();
        return true;
      });
      if (gotIt || cancelled) return;
      setTabRole('follower');
      await navigator.locks.request(OFFICE_LOCK, { signal: abort.signal }, hold);
    })().catch(() => undefined);

    return () => {
      cancelled = true;
      abort.abort();
      release?.();
    };
  }, []);

  // Load from SQLite database once this tab runs the office
  useEffect(() => {
    if (!isLeader) return;
    let stale = false;

    fetch('/api/db')
      .then(res => res.json())
      .then(data => {
        if (stale || !Array.isArray(data.agents) || data.agents.length === 0) return;
        const loaded: Agent[] = data.agents;
        // Nothing is running right after a (re)load: interrupted work goes back to the queue
        setAgents(loaded.map(a => {
          const taskQueue = a.taskQueue.map(t => t.status === 'IN_PROGRESS' ? { ...t, status: 'PENDING' as TaskStatus } : t);
          if (ON_BREAK.has(a.state)) return { ...a, taskQueue };
          const desk = deskFor(a, loaded);
          return { ...a, taskQueue, state: a.state === 'WORKING' ? 'IDLE' : a.state, targetX: desk.x, targetY: desk.y };
        }));
      })
      .catch(e => console.error("Failed to load db", e))
      .finally(() => {
        if (!stale) loadedRef.current = true;
      });

    return () => {
      stale = true;
    };
  }, [isLeader]);

  // Save to SQLite database when something changed
  useEffect(() => {
    if (!isLeader) return;
    const interval = setInterval(() => {
      const snapshot = agentsRef.current;
      if (!loadedRef.current || snapshot === lastSavedRef.current) return;
      fetch('/api/db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agents: snapshot })
      })
        .then(res => {
          if (res.ok) lastSavedRef.current = snapshot;
        })
        .catch(e => console.error("Failed to save db", e));
    }, SAVE_MS);
    return () => clearInterval(interval);
  }, [isLeader]);

  const addAgent = (agentData: NewAgent) => {
    setAgents(prev => {
      const newAgent: Agent = {
        ...agentData,
        id: newId(),
        state: 'IDLE',
        x: ENTRANCE.x,
        y: ENTRANCE.y,
        targetX: ENTRANCE.x,
        targetY: ENTRANCE.y,
        tokensUsed: 0,
        currentTask: null,
        idleTicks: 0,
        workingTicks: 0,
        breaksTaken: 0,
        taskQueue: [],
      };
      // Spawn at the entrance; the simulation loop walks them to their desk
      const desk = deskFor(newAgent, [...prev, newAgent]);
      return [...prev, { ...newAgent, targetX: desk.x, targetY: desk.y }];
    });
  };

  const removeAgent = (agentId: string) => {
    setAgents(prev => prev.filter(a => a.id !== agentId));
    fetch(`/api/db?agentId=${agentId}`, { method: 'DELETE' }).catch(console.error);
  };

  const updateAgentTokens = (agentId: string, tokens: number) => {
    setAgents(prev => prev.map(a => a.id === agentId ? { ...a, tokensUsed: a.tokensUsed + tokens } : a));
  };

  const enqueueTask = (agentId: string, prompt: string, assignedBy: string, parentId?: string, status: TaskStatus = 'PENDING', extra?: Partial<TaskItem>) => {
    const taskId = newId();
    setAgents(prev => prev.map(a => a.id === agentId ? {
      ...a,
      taskQueue: [{ ...extra, id: taskId, prompt, status, timestamp: Date.now(), assignedBy, parentId }, ...a.taskQueue]
    } : a));
    return taskId;
  };

  const patchTask = (agentId: string, taskId: string, patch: Partial<TaskItem>) => {
    setAgents(prev => prev.map(a => a.id === agentId ? {
      ...a,
      taskQueue: a.taskQueue.map(t => t.id === taskId ? { ...t, ...patch } : t)
    } : a));
  };

  const updateTaskStatus = (agentId: string, taskId: string, status: TaskStatus, response?: string, error?: string) => {
    setAgents(prev => prev.map(a => a.id === agentId ? {
      ...a,
      taskQueue: a.taskQueue.map(t => t.id === taskId ? { ...t, status, response: response ?? t.response, error: error ?? t.error } : t)
    } : a));
  };

  // Tasks are cancelled rather than dropped so the halt is saved and survives a reload
  const clearAllTasks = () => {
    setAgents(prev => prev.map(a => ({
      ...a,
      state: a.state === 'WORKING' ? 'IDLE' : a.state,
      taskQueue: a.taskQueue.map(t => UNFINISHED.has(t.status) ? { ...t, status: 'CANCELLED' as TaskStatus } : t)
    })));
  };

  const setAgentState = (agentId: string, state: AgentState) => {
    setAgents(prev => prev.map(a => {
      if (a.id !== agentId) return a;

      let finalState = state;
      let breaksTaken = state === 'WORKING' ? 0 : a.breaksTaken;

      // Once the queue is empty, take a break before settling back at the desk
      if (a.state === 'WORKING' && state === 'IDLE' && !a.taskQueue.some(t => t.status === 'PENDING')) {
        finalState = Math.random() < 0.5 ? 'BREAK' : 'COFFEE';
        breaksTaken = 1;
      }

      return { ...moveTo(a, finalState, prev), breaksTaken };
    }));
  };

  // Simulation loop: breaks, returning to the desk, and walking to a new target.
  // Idle time lives in a ref so an idle office does not re-render (or re-save) every tick.
  useEffect(() => {
    if (!isLeader) return;
    const idleSince = idleSinceRef.current;

    const tick = setInterval(() => {
      const now = Date.now();
      const current = agentsRef.current;
      const moves = new Map<string, { from: AgentState; to: AgentState }>();

      for (const agent of current) {
        if (agent.state !== 'IDLE') idleSince.delete(agent.id);

        if (agent.state === 'IDLE') {
          const since = idleSince.get(agent.id) ?? now;
          idleSince.set(agent.id, since);
          if (now - since > IDLE_BEFORE_BREAK_MS && agent.breaksTaken < MAX_BREAKS_PER_IDLE_STRETCH) {
            const r = Math.random();
            moves.set(agent.id, { from: 'IDLE', to: r < 0.2 ? 'TOILET' : r < 0.6 ? 'COFFEE' : 'BREAK' });
            idleSince.delete(agent.id);
          }
        } else if (ON_BREAK.has(agent.state) && Math.random() < BREAK_RETURN_CHANCE) {
          moves.set(agent.id, { from: agent.state, to: 'IDLE' });
        }
      }

      if (moves.size === 0 && !current.some(isWalking)) return;

      setAgents(prev => prev.map(a => {
        const move = moves.get(a.id);
        // Skip the move if the agent changed state since it was decided (e.g. picked up a task)
        if (move && a.state === move.from) {
          const moved = moveTo(a, move.to, prev);
          return move.to === 'IDLE' ? moved : { ...moved, breaksTaken: a.breaksTaken + 1 };
        }
        return isWalking(a) ? { ...a, x: a.targetX, y: a.targetY } : a;
      }));
    }, TICK_MS);
    return () => clearInterval(tick);
  }, [isLeader]);

  return (
    <SimulationContext.Provider value={{ agents, isLeader, focus, focusAgent, addAgent, removeAgent, updateAgentTokens, setAgentState, enqueueTask, patchTask, updateTaskStatus, clearAllTasks }}>
      {children}
      {tabRole === 'follower' && (
        <div style={{
          position: 'fixed',
          inset: 0,
          zIndex: 1000,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '8px',
          padding: '24px',
          textAlign: 'center',
          background: 'rgba(15, 23, 42, 0.9)',
          color: 'white',
        }}>
          <strong style={{ fontSize: '18px' }}>This office is already open in another tab</strong>
          <span style={{ fontSize: '14px', opacity: 0.8 }}>Close the other tab and this one will take over automatically.</span>
        </div>
      )}
    </SimulationContext.Provider>
  );
};

export const useSimulation = () => {
  const context = useContext(SimulationContext);
  if (!context) throw new Error("useSimulation must be used within SimulationProvider");
  return context;
};
