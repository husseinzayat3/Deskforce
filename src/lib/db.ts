import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const workspaceDir = path.join(process.cwd(), 'workspace');
const dbPath = path.join(workspaceDir, 'office_state.db');

// Non-destructive migrations for existing databases
const TASK_MIGRATIONS: Record<string, string> = {
  parentId: 'TEXT',
  summary: 'TEXT',
  files: 'TEXT', // JSON array of workspace-relative paths
  tokens: 'INTEGER',
  reviewStatus: 'TEXT',
  reviewNote: 'TEXT',
  project: 'TEXT', // folder name under workspace/projects, set on root tasks
  cost: 'REAL', // estimated USD
  model: 'TEXT',
  kind: 'TEXT',
  report: 'TEXT', // markdown, set on root tasks
};

const open = () => {
  // Ensure workspace directory exists
  fs.mkdirSync(workspaceDir, { recursive: true });

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

  const taskColumns = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
  for (const [column, type] of Object.entries(TASK_MIGRATIONS)) {
    if (!taskColumns.some(c => c.name === column)) {
      db.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${type}`);
    }
  }

  return { db, inode: fs.statSync(dbPath).ino };
};

let connection: ReturnType<typeof open> | undefined;

/**
 * The open database. If the file was deleted or replaced while the server was running
 * (e.g. the workspace folder was cleared), the old handle can no longer be written to
 * (SQLITE_READONLY_DBMOVED), so a fresh database is opened in its place.
 */
export const getDb = () => {
  if (connection) {
    let inode: number | undefined;
    try {
      inode = fs.statSync(dbPath).ino;
    } catch {
      // file is gone
    }
    if (inode === connection.inode) return connection.db;

    try {
      connection.db.close();
    } catch {
      // already unusable
    }
  }

  connection = open();
  return connection.db;
};
