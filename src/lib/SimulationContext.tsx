"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Agent, AgentState } from './types';

type NewAgent = Pick<Agent, 'name' | 'role' | 'api' | 'avatar'>;

interface Notification {
  id: string;
  message: string;
}

interface SimulationContextType {
  /** Employees and their tasks as the server reports them, placed on the map by this browser. */
  agents: Agent[];
  /** True while the server is not handing out new tasks. */
  paused: boolean;
  notifications: Notification[];
  notify: (message: string) => void;
  /** Employee last clicked on the map. `at` changes on every click, so clicking the same one again still counts. */
  focus: { agentId: string; at: number } | null;
  focusAgent: (agentId: string) => void;
  addAgent: (agent: NewAgent) => void;
  removeAgent: (agentId: string) => void;
  /** `budget`: spending limit in USD. `project`: continue an existing project instead of starting a new one. */
  assignTask: (agentId: string, prompt: string, options?: { budget?: number; project?: string }) => void;
  /** Queue a failed or cancelled task again. */
  retryTask: (taskId: string) => void;
  /** Send a finished task back with feedback. */
  reviseTask: (taskId: string, note: string) => void;
  cancelTask: (taskId: string) => void;
  approveTask: (taskId: string) => void;
  haltAll: () => void;
  setPaused: (paused: boolean) => void;
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

const POLL_MS = 1000;
const TICK_MS = 1000;
const NOTIFICATION_MS = 5000;
const IDLE_BEFORE_BREAK_MS = 30_000;
const MAX_BREAKS_PER_IDLE_STRETCH = 2;
/** Chance per tick that an employee on a break heads back to the desk. */
const BREAK_RETURN_CHANCE = 0.02;

/**
 * Where an employee is on the map and what they appear to be doing.
 * The server only knows working / not working; breaks and walking are decoration added by each browser.
 */
interface Visual {
  state: AgentState;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  breaksTaken: number;
  idleSince: number;
}

const jitter = (range: number) => Math.random() * range - range / 2;

const deskFor = (agent: Agent, all: Agent[]) => {
  const desks = POI.DESKS[agent.role] || POI.DESKS['Junior Dev'];
  const index = Math.max(0, all.filter(a => a.role === agent.role).findIndex(a => a.id === agent.id));
  return desks[index % desks.length];
};

const at = (visual: Visual, state: AgentState, spot: { x: number; y: number }): Visual =>
  ({ ...visual, state, x: spot.x, y: spot.y, targetX: spot.x, targetY: spot.y });

const onBreak = (visual: Visual, state: 'COFFEE' | 'TOILET' | 'BREAK'): Visual => {
  const spot = state === 'COFFEE'
    ? { x: POI.COFFEE.x + jitter(40), y: POI.COFFEE.y + jitter(40) }
    : state === 'TOILET'
      ? { x: POI.TOILET.x + jitter(40), y: POI.TOILET.y + jitter(40) }
      : { x: POI.BREAK_ROOM.x + jitter(100), y: POI.BREAK_ROOM.y + jitter(100) };
  return { ...at(visual, state, spot), breaksTaken: visual.breaksTaken + 1 };
};

/**
 * Advances the map by one step. Returns the same object when nothing moved, so React can skip the render.
 * `seated`: first load, employees start at their desks instead of walking in.
 * `timed`: called by the clock rather than by new server data, so chance-based moves may happen.
 */
const stepVisuals = (prev: Record<string, Visual>, agents: Agent[], now: number, seated: boolean, timed: boolean) => {
  const next: Record<string, Visual> = {};
  let changed = Object.keys(prev).length !== agents.length;

  for (const agent of agents) {
    const desk = deskFor(agent, agents);
    const before = prev[agent.id];
    let visual = before;

    if (!visual) {
      const spot = seated ? desk : ENTRANCE;
      visual = { state: 'IDLE', x: spot.x, y: spot.y, targetX: desk.x, targetY: desk.y, breaksTaken: 0, idleSince: now };
    } else if (agent.state === 'WORKING') {
      if (visual.state !== 'WORKING' || visual.x !== desk.x || visual.y !== desk.y) {
        visual = { ...at(visual, 'WORKING', desk), breaksTaken: 0 };
      }
    } else if (visual.state === 'WORKING') {
      // Just finished: straight on to the next task, or a break once the queue is empty
      visual = agent.taskQueue.some(t => t.status === 'PENDING')
        ? { ...visual, state: 'IDLE', idleSince: now }
        : onBreak({ ...visual, breaksTaken: 0 }, Math.random() < 0.5 ? 'BREAK' : 'COFFEE');
    } else if (visual.state === 'IDLE') {
      if (visual.targetX !== desk.x || visual.targetY !== desk.y) {
        visual = { ...visual, targetX: desk.x, targetY: desk.y };
      } else if (visual.x !== desk.x || visual.y !== desk.y) {
        if (timed) visual = at(visual, 'IDLE', desk);
      } else if (now - visual.idleSince > IDLE_BEFORE_BREAK_MS && visual.breaksTaken < MAX_BREAKS_PER_IDLE_STRETCH) {
        const r = Math.random();
        visual = onBreak(visual, r < 0.2 ? 'TOILET' : r < 0.6 ? 'COFFEE' : 'BREAK');
      }
    } else if (timed && Math.random() < BREAK_RETURN_CHANCE) {
      visual = { ...at(visual, 'IDLE', desk), idleSince: now };
    }

    if (visual !== before) changed = true;
    next[agent.id] = visual;
  }

  return changed ? next : prev;
};

export const SimulationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [serverAgents, setServerAgents] = useState<Agent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [paused, setPausedState] = useState(false);
  const [visuals, setVisuals] = useState<Record<string, Visual>>({});
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [focus, setFocus] = useState<{ agentId: string; at: number } | null>(null);

  const serverAgentsRef = useRef(serverAgents);
  const seatedRef = useRef(false);
  const versionRef = useRef<string | null>(null);
  const lastEventRef = useRef<number | null>(null);
  // Responses can arrive out of order; only the newest request may update the state
  const requestSeq = useRef(0);
  const appliedSeq = useRef(0);
  const polling = useRef(false);

  useEffect(() => {
    serverAgentsRef.current = serverAgents;
  }, [serverAgents]);

  const notify = useCallback((message: string) => {
    const id = Math.random().toString();
    setNotifications(prev => [...prev, { id, message }]);
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== id));
    }, NOTIFICATION_MS);
  }, []);

  const focusAgent = useCallback((agentId: string) => setFocus({ agentId, at: Date.now() }), []);

  /** Takes over what the server sent, unless a newer answer was applied already. */
  const apply = useCallback((seq: number, data: any) => {
    if (seq < appliedSeq.current) return false;
    appliedSeq.current = seq;
    if (Array.isArray(data.agents)) setServerAgents(data.agents);
    if (typeof data.version === 'string') versionRef.current = data.version;
    setPausedState(Boolean(data.paused));
    setLoaded(true);
    return true;
  }, []);

  // The server runs the office; this tab only watches it
  useEffect(() => {
    const poll = async () => {
      if (polling.current) return;
      polling.current = true;
      const seq = ++requestSeq.current;
      try {
        const params = new URLSearchParams();
        if (versionRef.current !== null) params.set('version', versionRef.current);
        if (lastEventRef.current !== null) params.set('afterEvent', String(lastEventRef.current));
        const res = await fetch(`/api/office?${params}`, { cache: 'no-store' });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `Office request failed (${res.status})`);

        apply(seq, data);
        (data.events || []).forEach((event: { message: string }) => notify(event.message));
        if (typeof data.lastEventId === 'number') lastEventRef.current = data.lastEventId;
      } catch (e) {
        console.error('Failed to load the office', e);
      } finally {
        polling.current = false;
      }
    };

    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => clearInterval(interval);
  }, [apply, notify]);

  /** Sends a command to the server and shows the state it answers with. */
  const send = useCallback(async (body: Record<string, unknown>) => {
    const seq = ++requestSeq.current;
    try {
      const res = await fetch('/api/office', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `Office request failed (${res.status})`);
      apply(seq, data);
    } catch (e: any) {
      notify(e.message || 'The office server could not be reached.');
    }
  }, [apply, notify]);

  const addAgent = useCallback((agent: NewAgent) => { send({ action: 'hire', ...agent }); }, [send]);
  const removeAgent = useCallback((agentId: string) => { send({ action: 'remove', agentId }); }, [send]);
  const assignTask = useCallback((agentId: string, prompt: string, options?: { budget?: number; project?: string }) => { send({ action: 'assign', agentId, prompt, ...options }); }, [send]);
  const retryTask = useCallback((taskId: string) => { send({ action: 'retry', taskId }); }, [send]);
  const reviseTask = useCallback((taskId: string, note: string) => { send({ action: 'revise', taskId, note }); }, [send]);
  const cancelTask = useCallback((taskId: string) => { send({ action: 'cancel', taskId }); }, [send]);
  const approveTask = useCallback((taskId: string) => { send({ action: 'approve', taskId }); }, [send]);
  const haltAll = useCallback(() => { send({ action: 'halt' }); }, [send]);
  const setPaused = useCallback((value: boolean) => { send({ action: 'pause', paused: value }); }, [send]);

  // Map: react at once to what the server reports…
  useEffect(() => {
    if (!loaded) return;
    const seated = !seatedRef.current;
    seatedRef.current = true;
    setVisuals(prev => stepVisuals(prev, serverAgents, Date.now(), seated, false));
  }, [serverAgents, loaded]);

  // …and let time pass: walking, breaks, coming back to the desk
  useEffect(() => {
    const tick = setInterval(() => {
      if (!seatedRef.current) return;
      setVisuals(prev => stepVisuals(prev, serverAgentsRef.current, Date.now(), false, true));
    }, TICK_MS);
    return () => clearInterval(tick);
  }, []);

  const agents = useMemo(() => serverAgents.map(agent => {
    const visual = visuals[agent.id];
    // Not placed yet (first render after it appeared): keep it where it is about to show up
    const spot = visual || { state: 'IDLE' as AgentState, ...ENTRANCE, targetX: ENTRANCE.x, targetY: ENTRANCE.y };
    return { ...agent, state: spot.state, x: spot.x, y: spot.y, targetX: spot.targetX, targetY: spot.targetY };
  }), [serverAgents, visuals]);

  return (
    <SimulationContext.Provider value={{ agents, paused, notifications, notify, focus, focusAgent, addAgent, removeAgent, assignTask, retryTask, reviseTask, cancelTask, approveTask, haltAll, setPaused }}>
      {children}
    </SimulationContext.Provider>
  );
};

export const useSimulation = () => {
  const context = useContext(SimulationContext);
  if (!context) throw new Error("useSimulation must be used within SimulationProvider");
  return context;
};
