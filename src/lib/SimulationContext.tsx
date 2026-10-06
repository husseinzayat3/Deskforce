"use client";

import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { Agent, Task, AgentState, TaskItem, TaskStatus } from './types';

interface SimulationContextType {
  agents: Agent[];
  tasks: Task[];
  addAgent: (agent: Omit<Agent, 'id' | 'x' | 'y' | 'targetX' | 'targetY' | 'tokensUsed' | 'state' | 'currentTask' | 'taskQueue' | 'idleTicks' | 'workingTicks' | 'breaksTaken'>) => void;
  removeAgent: (agentId: string) => void;
  addTask: (task: Omit<Task, 'id' | 'status'>) => void;
  updateAgentTokens: (agentId: string, tokens: number) => void;
  setAgentState: (agentId: string, state: AgentState) => void;
  enqueueTask: (agentId: string, prompt: string, assignedBy: string, parentId?: string, status?: TaskStatus) => string;
  patchTask: (agentId: string, taskId: string, patch: Partial<TaskItem>) => void;
  updateTaskStatus: (agentId: string, taskId: string, status: import('./types').TaskStatus, response?: string, error?: string) => void;
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

export const SimulationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);

  const agentsRef = useRef<Agent[]>(agents);

  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  // Load from SQLite database on mount
  useEffect(() => {
    fetch('/api/db')
      .then(res => res.json())
      .then(data => {
        if (data.agents && data.agents.length > 0) {
          setAgents(data.agents);
        }
      })
      .catch(e => console.error("Failed to load db", e));
  }, []);

  // Save to SQLite database every 2 seconds if changes exist
  useEffect(() => {
    const interval = setInterval(() => {
      fetch('/api/db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agents: agentsRef.current })
      }).catch(e => console.error("Failed to save db", e));
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  const addAgent = (agentData: Omit<Agent, 'id' | 'x' | 'y' | 'targetX' | 'targetY' | 'tokensUsed' | 'state' | 'currentTask' | 'taskQueue' | 'idleTicks' | 'workingTicks' | 'breaksTaken'>) => {
    // Find available desk for role
    const roleDesks = POI.DESKS[agentData.role as keyof typeof POI.DESKS] || POI.DESKS['Junior Dev'];
    const currentRoleCount = agents.filter(a => a.role === agentData.role).length;
    const assignedDesk = roleDesks[currentRoleCount % roleDesks.length];

    const newAgent: Agent = {
      ...agentData,
      id: Math.random().toString(36).substr(2, 9),
      state: 'IDLE',
      x: 500, // Spawn near entrance
      y: 900,
      targetX: assignedDesk.x,
      targetY: assignedDesk.y,
      tokensUsed: 0,
      currentTask: null,
      idleTicks: 0,
      workingTicks: 0,
      breaksTaken: 0,
      taskQueue: [],
    };
    setAgents(prev => [...prev, newAgent]);
  };

  const removeAgent = (agentId: string) => {
    setAgents(prev => prev.filter(a => a.id !== agentId));
    fetch(`/api/db?agentId=${agentId}`, { method: 'DELETE' }).catch(console.error);
  };

  const addTask = (taskData: Omit<Task, 'id' | 'status'>) => {
    const newTask: Task = {
      ...taskData,
      id: Math.random().toString(36).substr(2, 9),
      status: 'PENDING',
    };
    setTasks(prev => [...prev, newTask]);
  };

  const updateAgentTokens = (agentId: string, tokens: number) => {
    setAgents(prev => prev.map(a => a.id === agentId ? { ...a, tokensUsed: a.tokensUsed + tokens } : a));
  };

  const enqueueTask = (agentId: string, prompt: string, assignedBy: string, parentId?: string, status: TaskStatus = 'PENDING') => {
    const taskId = Math.random().toString(36).substr(2, 9);
    setAgents(prev => prev.map(a => a.id === agentId ? {
      ...a,
      taskQueue: [{ id: taskId, prompt, status, timestamp: Date.now(), assignedBy, parentId }, ...a.taskQueue]
    } : a));
    return taskId;
  };

  const patchTask = (agentId: string, taskId: string, patch: Partial<TaskItem>) => {
    setAgents(prev => prev.map(a => a.id === agentId ? {
      ...a,
      taskQueue: a.taskQueue.map(t => t.id === taskId ? { ...t, ...patch } : t)
    } : a));
  };

  const updateTaskStatus = (agentId: string, taskId: string, status: import('./types').TaskStatus, response?: string, error?: string) => {
    setAgents(prev => prev.map(a => a.id === agentId ? {
      ...a,
      taskQueue: a.taskQueue.map(t => t.id === taskId ? { ...t, status, response: response ?? t.response, error: error ?? t.error } : t)
    } : a));
  };

  const clearAllTasks = () => {
    setAgents(prev => prev.map(a => ({
      ...a,
      state: a.state === 'WORKING' ? 'IDLE' : a.state,
      taskQueue: a.taskQueue.filter(t => t.status === 'COMPLETED' || t.status === 'FAILED')
    })));
  };

  const setAgentState = (agentId: string, state: AgentState) => {
    setAgents(prev => prev.map(a => {
      if (a.id === agentId) {
        let targetX = a.x;
        let targetY = a.y;
        let finalState = state;

        // If transitioning from WORKING to IDLE, take a break if worked long enough
        if (a.state === 'WORKING' && state === 'IDLE' && a.breaksTaken < 2) {
          // Small chance or forced break if they did a task
          finalState = Math.random() < 0.5 ? 'BREAK' : 'COFFEE';
          a.breaksTaken += 1;
        }

        if (finalState === 'COFFEE') {
          targetX = POI.COFFEE.x + (Math.random() * 40 - 20);
          targetY = POI.COFFEE.y + (Math.random() * 40 - 20);
        } else if (finalState === 'TOILET') {
          targetX = POI.TOILET.x + (Math.random() * 40 - 20);
          targetY = POI.TOILET.y + (Math.random() * 40 - 20);
        } else if (finalState === 'BREAK') {
          targetX = POI.BREAK_ROOM.x + (Math.random() * 100 - 50);
          targetY = POI.BREAK_ROOM.y + (Math.random() * 100 - 50);
        } else if (finalState === 'WORKING' || finalState === 'IDLE') {
          // Go back to assigned desk
          const roleDesks = POI.DESKS[a.role as keyof typeof POI.DESKS] || POI.DESKS['Junior Dev'];
          const sameRoleAgents = prev.filter(ag => ag.role === a.role);
          const deskIndex = sameRoleAgents.findIndex(ag => ag.id === agentId);
          if (deskIndex !== -1) {
            targetX = roleDesks[deskIndex % roleDesks.length].x;
            targetY = roleDesks[deskIndex % roleDesks.length].y;
          }
        }

        return { ...a, state: finalState, targetX, targetY, idleTicks: 0, workingTicks: 0 };
      }
      return a;
    }));
  }

  // Simulation loop for ticks and state transitions
  useEffect(() => {
    const tick = setInterval(() => {
      setAgents(prev => {
        let changed = false;
        const newAgents = prev.map(agent => {
          let { x, y, state, idleTicks, workingTicks } = agent;
          let targetX = x;
          let targetY = y;

          if (state === 'IDLE') {
            idleTicks += 1;
            workingTicks = 0;
          } else if (state === 'WORKING') {
            workingTicks += 1;
            idleTicks = 0;
          } else {
            // ON BREAK
            idleTicks = 0;
            workingTicks = 0;
          }

          // Decide if need to go to break (e.g. idle for > 300 ticks ~ 30 seconds)
          if (state === 'IDLE' && idleTicks > 300 && agent.breaksTaken < 2) {
            const r = Math.random();
            let newState: AgentState = 'IDLE';
            if (r < 0.2) newState = 'TOILET';
            else if (r < 0.6) newState = 'COFFEE';
            else newState = 'BREAK';

            changed = true;
            state = newState;
            agent.breaksTaken += 1;
            
            if (state === 'COFFEE') {
              targetX = POI.COFFEE.x + (Math.random() * 40 - 20);
              targetY = POI.COFFEE.y + (Math.random() * 40 - 20);
            } else if (state === 'TOILET') {
              targetX = POI.TOILET.x + (Math.random() * 40 - 20);
              targetY = POI.TOILET.y + (Math.random() * 40 - 20);
            } else if (state === 'BREAK') {
              targetX = POI.BREAK_ROOM.x + (Math.random() * 80 - 40);
              targetY = POI.BREAK_ROOM.y + (Math.random() * 80 - 40);
            }
          }

          // Return to work from break automatically after some time (random chance)
          if ((state === 'COFFEE' || state === 'TOILET' || state === 'BREAK') && Math.random() < 0.002) {
            state = 'IDLE';
            idleTicks = 0;
            const roleDesks = POI.DESKS[agent.role as keyof typeof POI.DESKS] || POI.DESKS['Junior Dev'];
            const sameRoleAgents = prev.filter(ag => ag.role === agent.role);
            const deskIndex = sameRoleAgents.findIndex(ag => ag.id === agent.id);
            if (deskIndex !== -1) {
              targetX = roleDesks[deskIndex % roleDesks.length].x;
              targetY = roleDesks[deskIndex % roleDesks.length].y;
            }
            changed = true;
          }

          if (x !== targetX || y !== targetY || idleTicks !== agent.idleTicks || workingTicks !== agent.workingTicks || state !== agent.state) {
            changed = true;
          }

          return { ...agent, x: targetX, y: targetY, targetX, targetY, state, idleTicks, workingTicks };
        });

        return changed ? newAgents : prev;
      });
    }, 100);
    return () => clearInterval(tick);
  }, []);

  return (
    <SimulationContext.Provider value={{ agents, tasks, addAgent, removeAgent, addTask, updateAgentTokens, setAgentState, enqueueTask, patchTask, updateTaskStatus, clearAllTasks }}>
      {children}
    </SimulationContext.Provider>
  );
};

export const useSimulation = () => {
  const context = useContext(SimulationContext);
  if (!context) throw new Error("useSimulation must be used within SimulationProvider");
  return context;
};
