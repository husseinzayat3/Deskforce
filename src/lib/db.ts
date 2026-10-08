import Database from 'better-sqlite3';
import fs from 'fs';
import { DATA_DIR, DB_PATH } from './server/paths';

const workspaceDir = DATA_DIR;
const dbPath = DB_PATH;

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
  title: 'TEXT',
  feedback: 'TEXT',
  budget: 'REAL', // USD, set on root tasks
  commitId: 'TEXT', // git commit with the files the task wrote
  question: 'TEXT',
  clarifications: 'TEXT',
  participants: 'TEXT', // JSON array of agent ids (meetings)
  blockedBy: 'TEXT',
  archived: 'INTEGER',
  attachments: 'TEXT', // JSON array of project-relative paths
  checkRuns: 'INTEGER',
  checkPassed: 'INTEGER',
  checkOutput: 'TEXT',
  needsPlan: 'INTEGER',
  cachedTokens: 'INTEGER',
  durationMs: 'INTEGER',
  retries: 'INTEGER',
  revisions: 'INTEGER',
  compareId: 'TEXT',
  apiOverride: 'TEXT',
  modelOverride: 'TEXT',
  plan: 'TEXT',
  planApproved: 'INTEGER',
  planEstimate: 'REAL',
  planNote: 'TEXT',
};

const open = () => {
  // Ensure workspace directory exists
  fs.mkdirSync(workspaceDir, { recursive: true });

  const db = new Database(dbPath);
  // The database also holds API keys saved from the settings screen: owner-only
  fs.chmodSync(dbPath, 0o600);

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

    -- Small key/value store: change counter, pause flag, which process runs the engine
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS roles (
      name TEXT PRIMARY KEY,
      rank INTEGER NOT NULL,
      instructions TEXT NOT NULL DEFAULT ''
    );

    -- Saved tasks, optionally run on a schedule
    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      agentId TEXT,
      budget REAL,
      project TEXT,
      schedule TEXT NOT NULL DEFAULT 'none',
      weekday INTEGER NOT NULL DEFAULT 1,
      minuteOfDay INTEGER NOT NULL DEFAULT 540,
      nextRunAt INTEGER,
      lastRunAt INTEGER
    );

    -- Lessons agents wrote down for future projects
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      author TEXT NOT NULL,
      project TEXT,
      at INTEGER NOT NULL
    );

    -- What was said in a chat with the office (from Slack, or the chat endpoint)
    CREATE TABLE IF NOT EXISTS chat (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      at INTEGER NOT NULL
    );

    -- Notifications from the engine, shown as toasts in the browser
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message TEXT NOT NULL,
      at INTEGER NOT NULL
    );
  `);

  const agentColumns = db.prepare('PRAGMA table_info(agents)').all() as { name: string }[];
  if (!agentColumns.some(c => c.name === 'model')) db.exec('ALTER TABLE agents ADD COLUMN model TEXT');

  const eventColumns = db.prepare('PRAGMA table_info(events)').all() as { name: string }[];
  if (!eventColumns.some(c => c.name === 'kind')) db.exec("ALTER TABLE events ADD COLUMN kind TEXT NOT NULL DEFAULT 'info'");

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
