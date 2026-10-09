import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function openStore(dir) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'workbench.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      client_view INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      column_name TEXT NOT NULL DEFAULT 'backlog',
      priority INTEGER NOT NULL DEFAULT 0,
      assignee TEXT,
      labels TEXT NOT NULL DEFAULT '[]',
      deps TEXT NOT NULL DEFAULT '[]',
      next_task_title TEXT NOT NULL DEFAULT '',
      requires_review INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      retry_count INTEGER NOT NULL DEFAULT 0,
      meta TEXT NOT NULL DEFAULT '{}',
      lease_holder TEXT,
      lease_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES tasks(id),
      agent TEXT NOT NULL,
      model TEXT,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit (
      ts TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      task_id TEXT,
      project_id TEXT,
      detail TEXT
    );

    CREATE TABLE IF NOT EXISTS wip (
      project_id TEXT NOT NULL,
      column_name TEXT NOT NULL,
      limit_value INTEGER NOT NULL,
      PRIMARY KEY (project_id, column_name)
    );
  `);

  // Migrate DBs created before the meta column existed.
  try {
    db.exec("ALTER TABLE tasks ADD COLUMN meta TEXT NOT NULL DEFAULT '{}'");
  } catch {
    // column already present — fine
  }

  // Projects need somewhere to remember which GitHub repo they mirror — without
  // it, an imported issue had to land on "whichever project was created last".
  try {
    db.exec("ALTER TABLE projects ADD COLUMN meta TEXT NOT NULL DEFAULT '{}'");
  } catch {
    // column already present — fine
  }

  return db;
}
