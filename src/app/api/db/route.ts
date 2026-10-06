import { NextRequest, NextResponse } from 'next/server';
import db from '../../../lib/db';

const safeParseArray = (value: string): string[] | undefined => {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

export async function GET() {
  try {
    const agents = db.prepare('SELECT * FROM agents').all() as any[];
    const tasks = db.prepare('SELECT * FROM tasks').all() as any[];

    // Reconstruct the agent list with taskQueue
    const populatedAgents = agents.map(agent => {
      const agentTasks = tasks
        .filter(t => t.agentId === agent.id)
        .map(t => ({
          id: t.id,
          prompt: t.prompt,
          response: t.status === 'FAILED' ? undefined : t.answer,
          status: t.status,
          timestamp: t.createdAt,
          assignedBy: t.assignedBy,
          parentId: t.parentId || undefined,
          summary: t.summary || undefined,
          files: t.files ? safeParseArray(t.files) : undefined,
          tokens: t.tokens ?? undefined,
          reviewStatus: t.reviewStatus || undefined,
          reviewNote: t.reviewNote || undefined,
          error: t.status === 'FAILED' ? t.answer : undefined
        }))
        .sort((a, b) => a.timestamp - b.timestamp);

      // Determine current task based on IN_PROGRESS status
      const inProgressTask = agentTasks.find(t => t.status === 'IN_PROGRESS');

      return {
        ...agent,
        currentTask: inProgressTask ? inProgressTask.prompt : null,
        taskQueue: agentTasks
      };
    });

    return NextResponse.json({ agents: populatedAgents });
  } catch (error: any) {
    console.error('Database GET Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { agents } = await req.json();

    if (!agents) {
      return NextResponse.json({ error: 'Missing agents data' }, { status: 400 });
    }

    // Upsert agents and tasks in a transaction for safety
    const transaction = db.transaction((agentsList: any[]) => {
      const upsertAgent = db.prepare(`
        INSERT INTO agents (id, name, avatar, role, api, state, x, y, targetX, targetY, tokensUsed, idleTicks, workingTicks, breaksTaken)
        VALUES (@id, @name, @avatar, @role, @api, @state, @x, @y, @targetX, @targetY, @tokensUsed, @idleTicks, @workingTicks, @breaksTaken)
        ON CONFLICT(id) DO UPDATE SET
          state = excluded.state,
          x = excluded.x,
          y = excluded.y,
          targetX = excluded.targetX,
          targetY = excluded.targetY,
          tokensUsed = excluded.tokensUsed,
          idleTicks = excluded.idleTicks,
          workingTicks = excluded.workingTicks,
          breaksTaken = excluded.breaksTaken
      `);

      const upsertTask = db.prepare(`
        INSERT INTO tasks (id, agentId, prompt, assignedBy, status, answer, createdAt, parentId, summary, files, tokens, reviewStatus, reviewNote)
        VALUES (@id, @agentId, @prompt, @assignedBy, @status, @answer, @createdAt, @parentId, @summary, @files, @tokens, @reviewStatus, @reviewNote)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          answer = excluded.answer,
          parentId = COALESCE(excluded.parentId, tasks.parentId),
          summary = excluded.summary,
          files = excluded.files,
          tokens = excluded.tokens,
          reviewStatus = excluded.reviewStatus,
          reviewNote = excluded.reviewNote
      `);

      for (const agent of agentsList) {
        upsertAgent.run({
          id: agent.id,
          name: agent.name,
          avatar: agent.avatar || '/avatars/robot.png',
          role: agent.role,
          api: agent.api,
          state: agent.state,
          x: agent.x,
          y: agent.y,
          targetX: agent.targetX,
          targetY: agent.targetY,
          tokensUsed: agent.tokensUsed,
          idleTicks: agent.idleTicks,
          workingTicks: agent.workingTicks,
          breaksTaken: agent.breaksTaken || 0
        });

        if (agent.taskQueue && Array.isArray(agent.taskQueue)) {
          for (const task of agent.taskQueue) {
            upsertTask.run({
              id: task.id,
              agentId: agent.id,
              prompt: task.prompt,
              assignedBy: task.assignedBy,
              status: task.status,
              answer: task.error || task.response || null,
              createdAt: task.timestamp,
              parentId: task.parentId || null,
              summary: task.summary || null,
              files: task.files ? JSON.stringify(task.files) : null,
              tokens: task.tokens ?? null,
              reviewStatus: task.reviewStatus || null,
              reviewNote: task.reviewNote || null
            });
          }
        }
      }
    });

    transaction(agents);

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Database POST Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const agentId = searchParams.get('agentId');

    if (!agentId) {
      return NextResponse.json({ error: 'Missing agentId' }, { status: 400 });
    }

    db.prepare('DELETE FROM agents WHERE id = ?').run(agentId);
    // Note: Tasks are automatically deleted due to ON DELETE CASCADE in the schema
    
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Database DELETE Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
