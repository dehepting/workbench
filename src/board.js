import crypto from 'node:crypto';
import { emit } from './bus.js';

export const COLUMNS = ['backlog', 'todo', 'doing', 'review', 'done', 'failed'];

const now = () => new Date().toISOString();
const uid = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
const parseJson = (s, fallback = []) => {
  try { return JSON.parse(s ?? '[]'); } catch { return fallback; }
};

export class BoardError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new BoardError(code, message); };

// ---------- helpers ----------

function hydrate(t) {
  return {
    ...t,
    labels: parseJson(t.labels),
    deps: parseJson(t.deps),
    meta: parseJson(t.meta, {}),
    requires_review: !!t.requires_review,
  };
}

export function getTask(db, id) {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!t) fail('not_found', `Task ${id} not found`);
  return hydrate(t);
}

function taskStatus(db, id) {
  return db.prepare('SELECT column_name AS col FROM tasks WHERE id = ?').get(id)?.col ?? null;
}

function createsCycle(db, taskId, deps) {
  const seen = new Set();
  const stack = [...deps];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === taskId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const row = db.prepare('SELECT deps FROM tasks WHERE id = ?').get(cur);
    if (row) stack.push(...parseJson(row.deps));
  }
  return false;
}

function countInColumn(db, projectId, column) {
  return db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE project_id = ? AND column_name = ?').get(projectId, column).c;
}

function wipLimit(db, projectId, column) {
  return db.prepare('SELECT limit_value FROM wip WHERE project_id = ? AND column_name = ?').get(projectId, column)?.limit_value ?? null;
}

function audit(db, actor, action, taskId = null, projectId = null, detail = null) {
  db.prepare('INSERT INTO audit (ts, actor, action, task_id, project_id, detail) VALUES (?,?,?,?,?,?)')
    .run(now(), actor, action, taskId, projectId, detail);
}

function addSystemComment(db, taskId, body) {
  db.prepare('INSERT INTO comments (id, task_id, author, body, system, created_at) VALUES (?,?,?,?,1,?)')
    .run(uid('c'), taskId, 'system', body, now());
}

// ---------- projects ----------

export function createProject(db, name, { clientView = false } = {}) {
  if (!name?.trim()) fail('bad_request', 'Project name required');
  const id = uid('p');
  db.prepare('INSERT INTO projects (id, name, status, client_view, created_at) VALUES (?,?,?,?,?)')
    .run(id, name.trim(), 'active', clientView ? 1 : 0, now());
  audit(db, 'system', 'project.create', null, id, name);
  emit('project.create', { id, name });
  return getProject(db, id);
}

export function listProjects(db) {
  return db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
}

export function getProject(db, id) {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!p) fail('not_found', `Project ${id} not found`);
  return {
    ...p,
    client_view: !!p.client_view,
    tasks: db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY priority DESC, created_at ASC').all(id).map(hydrate),
    wip: db.prepare('SELECT column_name, limit_value FROM wip WHERE project_id = ?').all(id),
  };
}

export function setWipLimit(db, projectId, column, value) {
  if (!COLUMNS.includes(column)) fail('bad_request', `Unknown column "${column}". Valid: ${COLUMNS.join(', ')}`);
  if (!Number.isInteger(value) || value < 0) fail('bad_request', 'limit must be a non-negative integer');
  db.prepare(`INSERT INTO wip (project_id, column_name, limit_value) VALUES (?,?,?)
              ON CONFLICT(project_id, column_name) DO UPDATE SET limit_value = excluded.limit_value`)
    .run(projectId, column, value);
  emit('wip.update', { project_id: projectId, column, limit: value });
  return { project_id: projectId, column, limit: value };
}

// ---------- tasks ----------

export function createTask(db, input, actor = 'system') {
  const {
    project_id, title, description = '', assignee = null, priority = 0,
    labels = [], deps = [], next_task_title = '', requires_review = false, max_retries = 3,
    meta = {},
  } = input;
  if (!project_id || !db.prepare('SELECT id FROM projects WHERE id = ?').get(project_id)) {
    fail('not_found', `Project ${project_id} not found`);
  }
  if (!title?.trim()) fail('bad_request', 'Task title required');
  const cleanDeps = [...new Set(deps)];
  for (const d of cleanDeps) {
    if (!taskStatus(db, d)) fail('bad_request', `Unknown dependency: ${d}`);
  }
  const id = uid('t');
  db.prepare(`INSERT INTO tasks
    (id, project_id, title, description, column_name, priority, assignee, labels, deps,
     next_task_title, requires_review, max_retries, meta, created_at, updated_at)
    VALUES (?,?,?,?,'backlog',?,?,?,?,?,?,?,?,?,?)`)
    .run(id, project_id, title.trim(), description, priority | 0, assignee,
      JSON.stringify([...new Set(labels)]), JSON.stringify(cleanDeps),
      next_task_title || '', requires_review ? 1 : 0, max_retries | 0,
      JSON.stringify(meta), now(), now());
  audit(db, actor, 'task.create', id, project_id, title);
  emit('task.create', { id, project_id, title, actor });
  return getTask(db, id);
}

export function listTasks(db, filters = {}) {
  const where = [];
  const params = [];
  if (filters.project_id) { where.push('project_id = ?'); params.push(filters.project_id); }
  if (filters.column) { where.push('column_name = ?'); params.push(filters.column); }
  if (filters.assignee) { where.push('assignee = ?'); params.push(filters.assignee); }
  if (filters.label) { where.push('EXISTS (SELECT 1 FROM json_each(tasks.labels) WHERE value = ?)'); params.push(filters.label); }
  const sql = `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY priority DESC, created_at ASC`;
  return db.prepare(sql).all(...params).map(hydrate);
}

export function updateTask(db, id, patch, actor = 'system') {
  const t = getTask(db, id);
  const allowed = ['title', 'description', 'assignee', 'priority', 'labels', 'meta', 'next_task_title', 'requires_review', 'max_retries'];
  const set = {};
  for (const k of allowed) if (k in patch) set[k] = patch[k];

  let newDeps = null;
  if ('deps' in patch) {
    newDeps = [...new Set(patch.deps)];
    for (const d of newDeps) {
      if (!taskStatus(db, d)) fail('bad_request', `Unknown dependency: ${d}`);
    }
    if (createsCycle(db, id, newDeps)) fail('bad_request', 'Dependency would create a cycle');
  }

  if (!Object.keys(set).length && newDeps === null) return t;

  const parts = [];
  const params = [];
  for (const [k, v] of Object.entries(set)) {
    if (k === 'labels' || k === 'meta') { parts.push(`${k} = ?`); params.push(JSON.stringify(v)); }
    else if (k === 'requires_review') { parts.push('requires_review = ?'); params.push(v ? 1 : 0); }
    else { parts.push(`${k} = ?`); params.push(v); }
  }
  if (newDeps !== null) { parts.push('deps = ?'); params.push(JSON.stringify(newDeps)); }
  parts.push('updated_at = ?'); params.push(now());
  params.push(id);
  db.prepare(`UPDATE tasks SET ${parts.join(', ')} WHERE id = ?`).run(...params);

  audit(db, actor, 'task.update', id, t.project_id, JSON.stringify(patch));
  emit('task.update', { id, project_id: t.project_id, patch, actor });
  return getTask(db, id);
}

export function moveTask(db, id, to, { actor = 'system', force = false } = {}) {
  const t = getTask(db, id);
  if (!COLUMNS.includes(to)) fail('bad_request', `Unknown column "${to}". Valid: ${COLUMNS.join(', ')}`);
  if (to === t.column_name) return t;

  // Auto-retry: a failure bounces back to todo until retries are exhausted
  if (to === 'failed' && !force && t.retry_count < t.max_retries) {
    db.prepare(`UPDATE tasks SET column_name = 'todo', retry_count = retry_count + 1,
                lease_holder = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`)
      .run(now(), id);
    addSystemComment(db, id, `Auto-retry ${t.retry_count + 1}/${t.max_retries}: bounced back to todo`);
    audit(db, actor, 'task.retry', id, t.project_id, `${t.column_name} -> failed -> todo (${t.retry_count + 1}/${t.max_retries})`);
    emit('task.retry', { id, project_id: t.project_id, retry_count: t.retry_count + 1, max: t.max_retries, actor });
    return getTask(db, id);
  }

  // Dependency gate
  if (to === 'doing' && !force) {
    const blocked = t.deps.filter(d => taskStatus(db, d) !== 'done');
    if (blocked.length) fail('blocked', `Blocked by unfinished dependencies: ${blocked.join(', ')}`);
  }

  // Review gate
  if (to === 'done' && t.requires_review && t.column_name !== 'review' && !force) {
    fail('gate', 'Task is marked requires_review — move it to review first');
  }

  // WIP gate
  const limit = wipLimit(db, t.project_id, to);
  if (!force && limit != null && countInColumn(db, t.project_id, to) >= limit) {
    fail('wip', `Column "${to}" is at its WIP limit (${limit})`);
  }

  const sets = ['column_name = ?', 'updated_at = ?'];
  const params = [to, now()];
  if (to === 'doing' && !t.started_at) { sets.push('started_at = ?'); params.push(now()); }
  if (to === 'done' && !t.completed_at) { sets.push('completed_at = ?'); params.push(now()); }
  // Work is finished or the task is being re-queued — release the claim.
  // Leases survive moves to doing/review so the working agent keeps its claim.
  if (['backlog', 'todo', 'done', 'failed'].includes(to)) { sets.push('lease_holder = NULL', 'lease_expires_at = NULL'); }
  params.push(id);
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  audit(db, actor, 'task.move', id, t.project_id, `${t.column_name} -> ${to}`);
  emit('task.move', { id, project_id: t.project_id, from: t.column_name, to, actor });

  // Chaining: completing a task can auto-create a follow-up
  if (to === 'done' && t.next_task_title) {
    const chained = createTask(db, {
      project_id: t.project_id,
      title: t.next_task_title,
      assignee: t.assignee,
      priority: t.priority,
      deps: [id],
    }, 'system');
    addSystemComment(db, id, `Chained follow-up created: ${chained.id} "${chained.title}"`);
  }

  return getTask(db, id);
}

export function deleteTask(db, id, actor = 'system') {
  const t = getTask(db, id);
  const dependents = db.prepare('SELECT id FROM tasks WHERE id != ? AND deps LIKE ?').all(id, `%${id}%`);
  if (dependents.length) fail('blocked', `Other tasks depend on it: ${dependents.map(d => d.id).join(', ')}`);
  db.prepare('DELETE FROM comments WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  audit(db, actor, 'task.delete', id, t.project_id, t.title);
  emit('task.delete', { id, project_id: t.project_id, actor });
  return { deleted: id };
}

// ---------- claiming (leases) ----------

export function claimTask(db, id, agent, minutes = 10) {
  if (!agent) fail('bad_request', 'agent required');
  const expires = new Date(Date.now() + minutes * 60000).toISOString();
  const res = db.prepare(`UPDATE tasks SET lease_holder = ?, lease_expires_at = ?, updated_at = ?
                          WHERE id = ? AND (lease_holder IS NULL OR lease_expires_at IS NULL OR lease_expires_at < ?)`)
    .run(agent, expires, now(), id, now());
  if (res.changes === 0) {
    const t = getTask(db, id);
    fail('claimed', `Task is held by ${t.lease_holder} until ${t.lease_expires_at}`);
  }
  audit(db, agent, 'task.claim', id, null, `${minutes}m lease`);
  emit('task.claim', { id, agent, lease_expires_at: expires });
  return getTask(db, id);
}

export function releaseTask(db, id, agent) {
  const t = getTask(db, id);
  if (t.lease_holder && t.lease_holder !== agent) fail('claimed', `Held by ${t.lease_holder}`);
  db.prepare('UPDATE tasks SET lease_holder = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?')
    .run(now(), id);
  audit(db, agent, 'task.release', id, t.project_id, null);
  emit('task.release', { id, agent, project_id: t.project_id });
  return getTask(db, id);
}

// Atomically pull + claim the highest-priority unblocked task. Two agents can never get the same one.
export function nextTask(db, agent, { project_id = null, minutes = 10 } = {}) {
  if (!agent) fail('bad_request', 'agent required');
  db.exec('BEGIN IMMEDIATE');
  try {
    const rows = db.prepare(`SELECT id, project_id, deps FROM tasks
      WHERE column_name IN ('backlog','todo')
        AND (lease_holder IS NULL OR lease_expires_at IS NULL OR lease_expires_at < ?)
        ${project_id ? 'AND project_id = ?' : ''}
      ORDER BY priority DESC, created_at ASC`)
      .all(...(project_id ? [now(), project_id] : [now()]));
    for (const r of rows) {
      const deps = parseJson(r.deps);
      if (deps.some(d => taskStatus(db, d) !== 'done')) continue;
      const t = claimTask(db, r.id, agent, minutes);
      db.exec('COMMIT');
      return t;
    }
    db.exec('COMMIT');
    return null;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Extend a lease you already hold (workers call this to stay alive on long tasks).
export function renewLease(db, id, agent, minutes = 10) {
  if (!agent) fail('bad_request', 'agent required');
  const expires = new Date(Date.now() + minutes * 60000).toISOString();
  const res = db.prepare('UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_holder = ?')
    .run(expires, now(), id, agent);
  if (res.changes === 0) {
    const t = getTask(db, id);
    fail('claimed', t.lease_holder === agent
      ? `Task moved on — lease no longer applicable (now in ${t.column_name})`
      : `Task is held by ${t.lease_holder || 'nobody'}`);
  }
  return getTask(db, id);
}

// Link a task to a GitHub issue (two-way sync anchor).
export function linkGithub(db, taskId, repo, issueNumber, url) {
  const t = getTask(db, taskId);
  const meta = { ...parseJson(t.meta, {}), github: { repo, number: issueNumber, url } };
  db.prepare('UPDATE tasks SET meta = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(meta), now(), taskId);
  audit(db, 'github', 'task.github_link', taskId, t.project_id, `${repo}#${issueNumber}`);
  emit('task.update', { id: taskId, project_id: t.project_id, actor: 'github' });
  return getTask(db, taskId);
}

// ---------- comments ----------

export function listComments(db, id) {
  return db.prepare('SELECT * FROM comments WHERE task_id = ? ORDER BY created_at ASC').all(id);
}

export function addTaskComment(db, id, author, body) {
  getTask(db, id);
  if (!body?.trim()) fail('bad_request', 'Comment body required');
  db.prepare('INSERT INTO comments (id, task_id, author, body, system, created_at) VALUES (?,?,?,?,0,?)')
    .run(uid('c'), id, author, body, now());
  audit(db, author, 'comment.add', id, null, body);
  emit('comment.add', { id, author, body });
  return listComments(db, id);
}

// ---------- runs / cost ledger ----------

// $ per 1M tokens [input, output]. Free tiers are zero; extend as needed.
const PRICES = {
  groq: [0, 0], cerebras: [0, 0], nvidia: [0, 0], mistral: [0, 0],
  'openrouter:free': [0, 0], google: [0, 0], cloudflare: [0, 0],
  deepinfra: [0.03, 0.05],
};
const DEFAULT_PRICE = [0.15, 0.6];

export function recordRun(db, { agent, model, tokens_in = 0, tokens_out = 0, cost = null, task_id = null }) {
  if (!agent) fail('bad_request', 'agent required');
  if (task_id) getTask(db, task_id);
  if (cost == null) {
    const [pin, pout] = PRICES[model] ?? DEFAULT_PRICE;
    cost = +(((tokens_in / 1e6) * pin) + ((tokens_out / 1e6) * pout)).toFixed(6);
  }
  const id = uid('r');
  db.prepare('INSERT INTO runs (id, task_id, agent, model, tokens_in, tokens_out, cost, started_at, ended_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, task_id, agent, model || null, tokens_in | 0, tokens_out | 0, cost, now(), now());
  emit('run.record', { id, agent, model, tokens_in, tokens_out, cost, task_id });
  return { id, agent, model, tokens_in, tokens_out, cost, task_id };
}

export function ledgerSummary(db) {
  const total = db.prepare(`SELECT COUNT(*) AS runs, ROUND(COALESCE(SUM(cost),0),4) AS cost,
    COALESCE(SUM(tokens_in),0) AS tokens_in, COALESCE(SUM(tokens_out),0) AS tokens_out FROM runs`).get();
  const byAgent = db.prepare(`SELECT agent, COUNT(*) AS runs, ROUND(SUM(cost),4) AS cost,
    SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out FROM runs GROUP BY agent ORDER BY cost DESC`).all();
  const byModel = db.prepare(`SELECT model, COUNT(*) AS runs, ROUND(SUM(cost),4) AS cost FROM runs GROUP BY model ORDER BY cost DESC`).all();
  const recent = db.prepare('SELECT * FROM runs ORDER BY ended_at DESC LIMIT 20').all();
  return { total, byAgent, byModel, recent };
}

// ---------- flow metrics ----------

export function flowStats(db) {
  const iso = (ms) => new Date(Date.now() - ms).toISOString();
  const day = 86400000;
  const doneToday = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE column_name='done' AND completed_at >= ?").get(iso(day)).c;
  const doneWeek = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE column_name='done' AND completed_at >= ?").get(iso(7 * day)).c;
  const wip = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE column_name='doing'").get().c;
  const failed = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE column_name='failed'").get().c;
  const open = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE column_name NOT IN ('done','failed')").get().c;

  const cycleRows = db.prepare("SELECT started_at, completed_at FROM tasks WHERE column_name='done' AND started_at IS NOT NULL AND completed_at >= ?").all(iso(30 * day));
  const durations = cycleRows.map(r => new Date(r.completed_at) - new Date(r.started_at)).filter(d => d > 0).sort((a, b) => a - b);
  const medianCycleMs = durations.length ? durations[Math.floor(durations.length / 2)] : null;

  const perDay = [];
  for (let i = 6; i >= 0; i--) {
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - i);
    const end = new Date(start.getTime() + day);
    const created = db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE created_at >= ? AND created_at < ?').get(start.toISOString(), end.toISOString()).c;
    const finished = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE column_name='done' AND completed_at >= ? AND completed_at < ?").get(start.toISOString(), end.toISOString()).c;
    perDay.push({ date: start.toISOString().slice(0, 10), created, finished });
  }

  const slowest = db.prepare("SELECT id, title, column_name, created_at, assignee FROM tasks WHERE column_name NOT IN ('done','failed') ORDER BY created_at ASC LIMIT 5").all();

  return { doneToday, doneWeek, throughputPerDay: +(doneWeek / 7).toFixed(1), wip, failed, open, medianCycleMs, perDay, slowest };
}

export function auditTrail(db, limit = 100) {
  return db.prepare('SELECT * FROM audit ORDER BY rowid DESC LIMIT ?').all(limit);
}
