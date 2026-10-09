import crypto from 'node:crypto';
import { emit } from './bus.js';
import { PRICES, DEFAULT_PRICE } from './providers.js';
import { getToken, commentIssue, closeIssue, createIssue, reopenIssue, issueState } from './github.js';

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
  return db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all().map(withRepo);
}

// A project mirrors one GitHub repo. Stored in projects.meta so the import and
// sync paths have a home — without this, an incoming issue had to be attached
// to whichever project happened to be created last.
export function bindProjectRepo(db, projectId, repo) {
  const project = getProject(db, projectId); // 404s loudly rather than writing meta to a ghost
  const meta = repo
    ? { ...project.meta, github: { repo: parseRepo(repo) } }
    : stripRepo(project.meta);
  db.prepare('UPDATE projects SET meta = ? WHERE id = ?').run(JSON.stringify(meta), projectId);
  audit(db, 'system', 'project.github_bind', null, projectId, repo || '(unbind)');
  emit('project.update', { id: projectId, repo: repo || null });
  return getProject(db, projectId);
}

// "owner/repo" only — anything else is a typo we'd otherwise discover on the
// first API call, as a confusing 404 from the wrong URL.
export function parseRepo(repo) {
  const value = String(repo || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(value)) {
    fail('bad_request', `Not a repo ("owner/repo"): "${repo}"`);
  }
  return value;
}

function stripRepo(meta) {
  const { github, ...rest } = meta;
  return rest;
}

function withRepo(p) {
  const meta = parseJson(p.meta, {});
  return { ...p, meta, repo: meta.github?.repo || null };
}

export function getProject(db, id) {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!p) fail('not_found', `Project ${id} not found`);
  const meta = parseJson(p.meta, {});
  return {
    ...p,
    meta,
    repo: meta.github?.repo || null,
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

  // Closing the mirror issue has to happen here, not in a bus listener: the bus
  // is in-process, and a task reaches 'done' from the worker, from MCP, and from
  // the HTTP API. A listener registered by the server would silently miss every
  // worker-driven completion. Fire-and-forget — a board move must not block on,
  // or fail because of, GitHub's availability.
  if (to === 'done' && t.column_name !== 'done') closeMirrorIssue(db, id, actor);

  // The mirror image, on the same event. Must key off `from === 'done'` rather
  // than "the card isn't in done now": only a card actually leaving done should
  // reopen anything. Inferring it from current state made a sync pass see
  // "backlog + closed issue" after someone closed an issue on GitHub, read it
  // as a reopen, and undo their close — which is how a live card's issue got
  // silently reopened.
  if (t.column_name === 'done' && to !== 'done') reopenMirrorIssue(db, id, t.column_name, actor);

  // Chaining: completing a task can auto-create a follow-up
  if (to === 'done' && t.next_task_title) {
    const chained = createTask(db, {
      project_id: t.project_id,
      title: t.next_task_title,
      assignee: t.assignee,
      priority: t.priority,
      deps: [id],
      // A follow-up invented by the workflow should be checked like the work
      // that spawned it — otherwise a worker's output lands in done unreviewed.
      requires_review: t.requires_review,
    }, 'system');
    addSystemComment(db, id, `Chained follow-up created: ${chained.id} "${chained.title}"`);
  }

  return getTask(db, id);
}

export function deleteTask(db, id, actor = 'system') {
  const t = getTask(db, id);
  const dependents = db.prepare('SELECT id FROM tasks WHERE id != ? AND deps LIKE ?').all(id, `%${id}%`);
  if (dependents.length) fail('blocked', `Other tasks depend on it: ${dependents.map(d => d.id).join(', ')}`);

  // The close is started before the row is deleted so a caller that can await
  // it (the HTTP route) shrinks the window where the issue is still open — long
  // enough for a concurrent sync tick to re-import it as a brand-new card and
  // resurrect work that was just removed. Callers that don't await get
  // fire-and-forget, which is still correct, just eventual.
  const gh = t.meta?.github;
  const closing = gh?.repo && gh?.number
    ? closeOrphanIssue(db, gh, id, t.title, actor)
    : Promise.resolve();

  db.prepare('DELETE FROM comments WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  audit(db, actor, 'task.delete', id, t.project_id, t.title);
  emit('task.delete', { id, project_id: t.project_id, actor });

  return { deleted: id, github_close: closing };
}

// A card was deleted but its issue is still on GitHub claiming work exists.
// Closing it keeps the repo a truthful picture of the board; commenting first
// means anyone watching the issue learns why it stopped rather than guessing.
async function closeOrphanIssue(db, gh, taskId, title, actor) {
  try {
    const token = await getToken();
    if (!token) return; // nothing to say, and nothing that can be done about it
    await commentIssue(token, gh.repo, gh.number,
      `Closed because its Workbench card was deleted (\`${taskId}\` — ${title}).`);
    await closeIssue(token, gh.repo, gh.number);
    audit(db, actor, 'task.github_close_orphan', taskId, null, `${gh.repo}#${gh.number}`);
  } catch {
    // Best-effort by design. An unreachable GitHub leaves an open issue that a
    // later sync can reconcile; failing the delete would leave a card the user
    // already decided to remove.
  }
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

// ---------- github ----------

// Turn GitHub issues into backlog tasks, deduped on the meta.github anchor so a
// re-import never duplicates work. Returns what happened, per issue, because a
// silent import is indistinguishable from a broken one.
export function importIssues(db, projectId, repo, issues, { actor = 'github' } = {}) {
  const project = getProject(db, projectId);
  const result = { created: [], skipped: [], linked: [], conflicts: [] };

  for (const issue of issues) {
    // Dedupe is global, not per-project: one issue is one unit of work, and two
    // projects bound to the same repo must not each get a card for it. But when
    // the anchor lives in a DIFFERENT project, say so explicitly — otherwise a
    // second project bound to the same repo silently imports nothing and looks
    // broken for no reason it can see.
    const anchor = anchoredTask(db, repo, issue.number);
    if (anchor) {
      if (anchor.project_id === projectId) {
        result.skipped.push(issue.number);
      } else {
        result.conflicts.push({
          number: issue.number,
          task_id: anchor.id,
          other_project: anchor.project_id,
        });
      }
      continue;
    }

    // An issue that names a task id in its body is already work we track —
    // adopt it rather than creating a second card for the same work.
    const claimed = issue.body.match(/\bt_[0-9a-f]{12}\b/)?.[0];
    if (claimed && taskExists(db, claimed)) {
      linkGithub(db, claimed, repo, issue.number, issue.url);
      result.linked.push({ number: issue.number, task_id: claimed });
      continue;
    }

    const task = createTask(db, {
      project_id: projectId,
      title: issue.title,
      description: `${issue.body}\n\n_From ${repo}#${issue.number}: ${issue.url}_`,
      assignee: issue.assignee,
      labels: issue.labels,
      // Imported work starts in backlog, not todo: nothing should start running
      // because a sync happened. A human (or a worker claim) moves it forward.
      priority: issue.labels.some((l) => /priority|critical/i.test(l)) ? 3 : 0,
      meta: { github: { repo, number: issue.number, url: issue.url } },
    }, actor);
    result.created.push({ number: issue.number, task_id: task.id });
  }

  audit(db, actor, 'github.import', null, project.id,
    `${repo}: +${result.created.length} linked ${result.linked.length} skipped ${result.skipped.length} conflicts ${result.conflicts.length}`);
  return result;
}

// The task already anchored to an issue, in whatever project owns it.
function anchoredTask(db, repo, number) {
  const row = db.prepare('SELECT id, project_id, meta FROM tasks').all()
    .find((r) => {
      const gh = parseJson(r.meta, {}).github;
      return gh?.repo === repo && gh?.number === number;
    });
  return row || null;
}

// Issue numbers already anchored to a task in this repo.
export function tasksByRepo(db, repo) {
  const numbers = [];
  for (const r of db.prepare('SELECT meta FROM tasks').all()) {
    const meta = parseJson(r.meta, {});
    if (meta.github?.repo === repo && Number.isInteger(meta.github?.number)) numbers.push(meta.github.number);
  }
  return numbers;
}

// Reconcile board state against GitHub: a closed issue completes its task, and
// a reopened issue requeues it. Called by the poll loop.
export function syncIssuesFromGithub(db, projectId, repo, issues, { actor = 'github' } = {}) {
  const state = new Map(issues.map((i) => [i.number, i]));
  const moved = [];
  for (const row of db.prepare('SELECT id, meta, column_name FROM tasks WHERE project_id = ?').all(projectId)) {
    const gh = parseJson(row.meta, {}).github;
    if (!gh || gh.repo !== repo) continue;
    const issue = state.get(gh.number);
    if (!issue) continue;

    if (issue.state === 'closed' && row.column_name !== 'done') {
      // force: a reviewed task must be allowed to land in done from a GitHub
      // close, and the actor guard stops this bouncing back to close the issue.
      moveTask(db, row.id, 'done', { actor, force: true });
      addSystemComment(db, row.id, `Closed in GitHub: ${issue.url}`);
      moved.push({ task_id: row.id, to: 'done' });
    } else if (issue.state === 'open' && row.column_name === 'done') {
      moveTask(db, row.id, 'todo', { actor, force: true });
      addSystemComment(db, row.id, `Reopened in GitHub — back to todo: ${issue.url}`);
      moved.push({ task_id: row.id, to: 'todo' });
    }
  }
  return { repo, moved };
}

function taskExists(db, id) {
  return !!db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(id);
}

// The other direction: board cards become GitHub issues.
//
// Sync was pull-only, which meant a project planned entirely on the board had
// an empty repo — nothing was trackable outside the board, and the link only
// existed if someone raised each issue by hand. Every card in a bound project
// gets an issue now, backlog included: the board is where work is planned, but
// the repo is where it is visible to everyone and everything else.
//
// Idempotency rests on two independent anchors, because either can be lost:
//   - meta.github, written by linkGithub, is the fast path;
//   - the task id in the issue body, which importIssues already adopts.
// So a card whose meta was wiped re-links instead of duplicating, and a repo
// issue raised by hand on a card that already exists is adopted, not re-created.
export async function pushTasksToGithub(db, projectId, { actor = 'github' } = {}) {
  const project = getProject(db, projectId);
  const repo = project.repo;
  if (!repo) return { skipped: 'project has no repo bound' };

  const token = await getToken();
  if (!token) return { skipped: 'GitHub not connected' };

  const result = { created: [], linked: [], skipped: [], errors: [] };

  for (const row of db.prepare('SELECT id, column_name FROM tasks WHERE project_id = ?').all(projectId)) {
    const t = getTask(db, row.id);
    const gh = t.meta?.github;

    // Already mirrored. Deliberately does NOT overwrite the issue title or
    // body: a human editing the issue on GitHub should not have their words
    // reverted by the next poll. Reopening is NOT handled here either — see
    // moveTask, which fires it off the event rather than a state snapshot.
    if (gh?.repo && gh?.number) continue;

    // Done or failed work that was never mirrored gets no retroactive issue:
    // an issue created now would only be closed on the next line, which is
    // noise in the repo rather than history. Its record lives on the board.
    if (t.column_name === 'done' || t.column_name === 'failed') {
      result.skipped.push({ task_id: t.id, reason: `already ${t.column_name}, no issue created` });
      continue;
    }

    try {
      const issue = await createIssue(token, repo, {
        title: t.title,
        // The task id in the body is load-bearing, not decoration: it is what
        // lets importIssues adopt this issue back onto the card if the meta
        // anchor is ever lost.
        body: issueBody(t, repo),
        labels: t.labels || [],
      });
      linkGithub(db, t.id, repo, issue.number, issue.html_url);
      result.created.push({ task_id: t.id, number: issue.number, url: issue.html_url });
    } catch (e) {
      // One failure (a label that 422s, a rate limit) must not abandon the rest
      // of the project's cards.
      result.errors.push({ task_id: t.id, error: e.message });
    }
  }

  audit(db, actor, 'github.push', project.id, project.id,
    `${repo}: +${result.created.length} skipped ${result.skipped.length} errors ${result.errors.length}`);
  return { repo, ...result };
}

// Issue body for a board card. Kept in one place so the API's manual
// link route and this path produce issues importIssues can equally adopt.
export function issueBody(t, repo) {
  return [
    t.description || '',
    '',
    `---`,
    `_Workbench task \`${t.id}\`${repo ? ` — ${repo}` : ''} · http://localhost:4173/tasks/${t.id}_`,
  ].join('\n');
}

// Push new task comments onto the linked issue, so the repo shows what the
// agents actually did without anyone copying it over. Which comments have gone
// out is tracked in the task's meta (pushed_ids) rather than a comments.meta
// column — no migration for a field only this path reads.
export async function pushCommentsToIssue(db, taskId) {
  const t = getTask(db, taskId);
  const gh = t.meta?.github;
  if (!gh?.repo || !gh?.number) return { skipped: 'not linked' };

  const token = await getToken();
  if (!token) return { skipped: 'no token' };

  // Track which comments have gone out by id, not by timestamp: two comments
  // written in the same millisecond (a worker adding notes in a burst) share a
  // created_at, and a ">" watermark would silently drop all but the first.
  const already = new Set(t.meta.github.pushed_ids || []);
  const pending = listComments(db, taskId)
    // System comments are board bookkeeping — auto-retry notes, lease chatter,
    // and this function's own failure reports. Echoing them onto the issue
    // would spam the repo and, in the failure case, push a note about the
    // failed push on every retry.
    .filter((c) => !c.system && c.author !== 'github' && !already.has(c.id));
  if (!pending.length) return { pushed: 0 };

  let pushed = 0;
  const sent = [...already];
  for (const c of pending) {
    const marker = `<!-- workbench:${c.id} -->`;
    try {
      await commentIssue(token, gh.repo, gh.number, `${marker}\n**${c.author}**:\n\n${c.body}`);
      pushed++;
      sent.push(c.id);
    } catch (e) {
      // Stop at the first failure and record only what actually went out, so
      // the next sync retries the rest rather than dropping them forever.
      addSystemComment(db, taskId, `Could not push comment ${c.id} to ${gh.repo}#${gh.number}: ${e.message}`);
      break;
    }
  }

  if (pushed) {
    // Keep the list bounded — it only has to cover comments still on the task.
    const meta = { ...t.meta, github: { ...t.meta.github, pushed_ids: sent.slice(-500) } };
    db.prepare('UPDATE tasks SET meta = ? WHERE id = ?').run(JSON.stringify(meta), taskId);
    audit(db, 'github', 'task.github_push', taskId, t.project_id, `${gh.repo}#${gh.number}: ${pushed} comment(s)`);
  }
  return { pushed };
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

// A completed task closes its mirror issue and leaves the result on it, so the
// repo shows what happened without anyone re-typing it. Deliberately best-effort:
// called from moveTask, it must never turn a completed task back into a failure
// because GitHub was unreachable or the token expired. Every outcome is recorded
// on the task rather than only in a log nobody reads.
export async function closeMirrorIssue(db, taskId, actor = 'system') {
  const t = getTask(db, taskId);
  // getTask() already hydrates meta — parsing the object again JSON.parse-throws
  // and quietly returns {}, which made every linked task look unlinked.
  const gh = t.meta?.github;
  if (!gh?.repo || !gh?.number) return { skipped: 'not linked' };

  // Only close issues we are not the source of — the webhook already closed it.
  if (actor === 'github') return { skipped: 'actor is github' };

  const token = await getToken();
  if (!token) {
    addSystemComment(db, taskId, `Task is done but ${gh.repo}#${gh.number} was left open: no GitHub token (run \`gh auth login\`)`);
    return { skipped: 'no token' };
  }

  try {
    const completed = [...listComments(db, taskId)].reverse().find((c) => c.body.startsWith('completed:'));
    const summary = completed ? completed.body.replace(/^completed:\s*/, '').slice(0, 2000) : `Workbench task ${taskId} is done.`;
    await commentIssue(token, gh.repo, gh.number, `Completed by Workbench task \`${taskId}\`:\n\n${summary}`);
    await closeIssue(token, gh.repo, gh.number);
    audit(db, actor, 'task.github_close', taskId, t.project_id, `${gh.repo}#${gh.number}`);
    emit('task.update', { id: taskId, project_id: t.project_id, actor });
    return { closed: `${gh.repo}#${gh.number}` };
  } catch (e) {
    addSystemComment(db, taskId, `Done, but could not close ${gh.repo}#${gh.number}: ${e.message}`);
    return { error: e.message };
  }
}

// The other half of closeMirrorIssue: a card that leaves done is live work
// again, so its issue reopens.
//
// Fired from moveTask off the event itself, for the same reason closing is —
// and specifically because inferring this from a state snapshot is wrong. A
// sync pass that sees "card not in done, issue closed" cannot tell a human
// reopening the card apart from GitHub closing the issue; the first time it
// guesses wrong it silently undoes a close someone made on GitHub. Anchoring
// on `from === 'done'` means the only thing that can reopen an issue is a card
// actually leaving done.
export async function reopenMirrorIssue(db, taskId, from, actor = 'system') {
  const t = getTask(db, taskId);
  const gh = t.meta?.github;
  if (!gh?.repo || !gh?.number) return { skipped: 'not linked' };
  if (from !== 'done') return { skipped: 'did not leave done' };
  // Same guard as closeMirrorIssue: github-driven moves must not write back.
  if (actor === 'github') return { skipped: 'actor is github' };

  const token = await getToken();
  if (!token) return { skipped: 'no token' };

  try {
    // issueState, not an unconditional reopen: a card that left done while its
    // issue was already open must not generate a write (or a spurious event).
    if (await issueState(token, gh.repo, gh.number) !== 'closed') return { skipped: 'issue already open' };
    await reopenIssue(token, gh.repo, gh.number);
    await commentIssue(token, gh.repo, gh.number, `Reopened — Workbench task \`${taskId}\` moved out of done.`);
    audit(db, actor, 'task.github_reopen', taskId, t.project_id, `${gh.repo}#${gh.number}`);
    emit('task.update', { id: taskId, project_id: t.project_id, actor });
    return { reopened: `${gh.repo}#${gh.number}` };
  } catch (e) {
    // Non-fatal, but must be visible: if the issue stays closed the next sync
    // will see a closed issue against a live card and push it straight back to
    // done, which looks exactly like the move never happened.
    addSystemComment(db, taskId, `Moved out of done, but could not reopen ${gh.repo}#${gh.number}: ${e.message}`);
    return { error: e.message };
  }
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

// $ per 1M tokens [input, output] — table imported from providers.js (top of
// file) so the ledger and the router never drift apart.

// Accepts a bare model id, a provider name, or the documented
// "provider/model" form — "groq/llama-3.3-70b" must price as groq (free),
// not fall through to the paid default.
function priceFor(model) {
  if (!model) return DEFAULT_PRICE;
  if (PRICES[model]) return PRICES[model];
  const head = model.split('/')[0].split(':')[0];
  return PRICES[head] ?? DEFAULT_PRICE;
}

export function recordRun(db, { agent, model, tokens_in = 0, tokens_out = 0, cost = null, task_id = null }) {
  if (!agent) fail('bad_request', 'agent required');
  if (task_id) getTask(db, task_id);
  if (cost == null) {
    const [pin, pout] = priceFor(model);
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
