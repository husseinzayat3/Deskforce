import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Ensure workspace directory exists
const workspaceDir = path.join(process.cwd(), 'workspace');
if (!fs.existsSync(workspaceDir)) {
  fs.mkdirSync(workspaceDir, { recursive: true });
}

const dbPath = path.join(workspaceDir, 'office_state.db');
const db = new Database(dbPath);

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    avatar TEXT NOT NULL,
    role TEXT NOT NULL,
    api TEXT NOT NULL,
    state TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    targetX REAL NOT NULL,
    targetY REAL NOT NULL,
    tokensUsed INTEGER NOT NULL DEFAULT 0,
    idleTicks INTEGER NOT NULL DEFAULT 0,
    workingTicks INTEGER NOT NULL DEFAULT 0,
    breaksTaken INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    agentId TEXT NOT NULL,
    prompt TEXT NOT NULL,
    assignedBy TEXT NOT NULL,
    status TEXT NOT NULL,
    answer TEXT,
    createdAt INTEGER NOT NULL,
    startedAt INTEGER,
    completedAt INTEGER,
    parentId TEXT,
    FOREIGN KEY (agentId) REFERENCES agents (id) ON DELETE CASCADE
  );
`);

// Non-destructive migrations for existing databases
const taskColumns = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
const TASK_MIGRATIONS: Record<string, string> = {
  parentId: 'TEXT',
  summary: 'TEXT',
  files: 'TEXT', // JSON array of workspace-relative paths
  tokens: 'INTEGER',
  reviewStatus: 'TEXT',
  reviewNote: 'TEXT',
};
for (const [column, type] of Object.entries(TASK_MIGRATIONS)) {
  if (!taskColumns.some(c => c.name === column)) {
    db.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${type}`);
  }
}

export default db;
