"use client";

import React, { useEffect, useRef, useState } from 'react';
import { useSimulation } from '../lib/SimulationContext';
import { motion } from 'framer-motion';
import { taskTitle } from '../lib/officeConfig';

/** Side of the floorplan image in pixels; employee positions are in these units. */
const MAP_SIZE = 1024;

export default function OfficeSimulation() {
  const { agents, live, focus, focusAgent } = useSimulation();

  // The floorplan is drawn at a fixed size and scaled to whatever room the page gives it
  const frame = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setScale(Math.min(entry.contentRect.width, entry.contentRect.height) / MAP_SIZE));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={frame} style={{ width: '100%', height: '100%', overflow: 'hidden' }}>
    <div style={{ 
      position: 'relative', 
      width: `${MAP_SIZE}px`, 
      height: `${MAP_SIZE}px`, 
      transform: `scale(${scale})`,
      transformOrigin: 'top left',
      backgroundColor: '#e2e8f0'
    }}>
      <img src="/office_bg.png" alt="Office Floorplan" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      
      {agents.map(agent => {

        let stateEmoji = '';
        if (agent.state === 'COFFEE') stateEmoji = '☕';
        if (agent.state === 'TOILET') stateEmoji = '🚽';
        if (agent.state === 'BREAK') stateEmoji = '🛋️';
        if (agent.state === 'WORKING') stateEmoji = '💻';
        if (agent.state === 'WAITING_FOR_HELP') stateEmoji = '❓';
        if (agent.state === 'MEETING') stateEmoji = '💬';

        const currentTask = agent.taskQueue?.find(t => t.status === 'IN_PROGRESS');
        // The last thing the model wrote, so the bubble shows the work as it happens
        const writing = currentTask ? (live[currentTask.id] || '').replace(/\s+/g, ' ').trim().slice(-110) : '';

        return (
          <motion.div
            key={agent.id}
            initial={{ x: agent.x, y: agent.y, opacity: 0 }}
            animate={{ x: agent.x, y: agent.y, opacity: 1 }}
            transition={{ type: "spring", stiffness: 40, damping: 12, mass: 1.2 }}
            role="button"
            tabIndex={0}
            title={`Show ${agent.name}'s tasks`}
            onClick={() => focusAgent(agent.id)}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                focusAgent(agent.id);
              }
            }}
            style={{
              cursor: 'pointer',
              position: 'absolute',
              top: 0,
              left: 0,
              width: '48px',
              height: '48px',
              marginLeft: '-24px', // Center horizontally
              marginTop: '-24px',  // Center vertically
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 10,
            }}
          >
            {/* Speech Bubble for current task */}
            {currentTask && (
              <motion.div
                initial={{ opacity: 0, y: 10, scale: 0.8 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                style={{
                  position: 'absolute',
                  bottom: '100%',
                  marginBottom: '12px',
                  background: 'white',
                  padding: '8px 12px',
                  borderRadius: '12px',
                  boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
                  fontSize: '12px',
                  color: '#334155',
                  width: '160px',
                  textAlign: 'center',
                  zIndex: 20,
                  border: '1px solid #e2e8f0',
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: '2px', color: '#2563eb', fontSize: '10px', textTransform: 'uppercase' }}>Working on:</div>
                <div style={{
                  display: '-webkit-box',
                  WebkitLineClamp: 3,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                }}>
                  {taskTitle(currentTask)}
                </div>
                {writing && (
                  <div style={{ marginTop: '4px', paddingTop: '4px', borderTop: '1px solid #e2e8f0', color: '#64748b', fontSize: '10px', textAlign: 'left', fontFamily: 'ui-monospace, monospace', overflowWrap: 'anywhere' }}>
                    …{writing}
                  </div>
                )}
                {/* Speech bubble pointer */}
                <div style={{
                  position: 'absolute',
                  bottom: '-6px',
                  left: '50%',
                  marginLeft: '-6px',
                  width: '12px',
                  height: '12px',
                  background: 'white',
                  transform: 'rotate(45deg)',
                  borderRight: '1px solid #e2e8f0',
                  borderBottom: '1px solid #e2e8f0',
                }} />
              </motion.div>
            )}

            {/* Tooltip for state */}
            {stateEmoji && !currentTask && (
              <motion.div 
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                style={{
                  position: 'absolute',
                  top: '-20px',
                  right: '-10px',
                  background: 'white',
                  borderRadius: '50%',
                  width: '24px',
                  height: '24px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
                  fontSize: '14px',
                  zIndex: 11
                }}
              >
                {stateEmoji}
              </motion.div>
            )}

            {/* Avatar */}
            <div style={{
              width: '48px',
              height: '48px',
              borderRadius: '50%',
              overflow: 'hidden',
              flexShrink: 0,
              // Ring around the employee whose tasks are open in the side panel
              boxShadow: focus?.agentId === agent.id ? '0 0 0 3px #3b82f6, 0 0 0 5px white' : undefined
            }}>
              <img src={agent.avatar || '/avatars/robot.png'} alt={agent.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </div>
            
            {/* Name badge */}
            <div style={{
              marginTop: '4px',
              background: 'rgba(15, 23, 42, 0.8)',
              color: 'white',
              padding: '2px 6px',
              borderRadius: '4px',
              fontSize: '11px',
              fontWeight: 600,
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
            }}>
              {agent.name}
            </div>
          </motion.div>
        );
      })}
    </div>
    </div>
  );
}
