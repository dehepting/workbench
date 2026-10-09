// Two-way GitHub sync: issues become tasks, issue state reconciles tasks, task
// comments push back out. Network is mocked (global fetch) and the token is
// faked with a stub `gh` on PATH — nothing here touches the real API.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import * as board from '../src/board.js';
import * as sync from '../src/sync.js';

const realFetch = globalThis.fetch;
const realPath = process.env.PATH;
let db, dir, binDir, calls, issues;

// Serve a canned issue list per ?state= open/closed, and accept writes.
function mockFetch() {
  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (u.includes('/issues?state=')) {
      const state = u.includes('state=closed') ? 'closed' : 'open';
      return ok(issues.filter((i) => i.state === state));
    }
    if (u.includes('/comments')) return ok({ number: 7 });
    return ok({});
  };
}
const ok = (payload) => ({ ok: true, status: 200, json: async () => payload, text: async () => '' });

function makeIssue(n, over = {}) {
  return {
    number: n, title: `Issue ${n}`, body: `Body of ${n}`, state: 'open',
    url: `http://x/${n}`, labels: [], assignee: null, updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-sync-test-'));
  db = openStore(dir);
  board.createProject(db, 'Test project');
  binDir = mkdtempSync(join(tmpdir(), 'wb-sync-bin-'));
  writeFileSync(join(binDir, 'gh'), '#!/bin/sh\necho gho_faketoken\n', { mode: 0o755 });
  process.env.PATH = `${binDir}:${realPath}`;
  issues = [];
  mockFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.PATH = realPath;
  db?.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

const projectId = () => board.listProjects(db)[0].id;
const bind = (repo = 'dehepting/workbench') => board.bindProjectRepo(db, projectId(), repo);

test('importIssues turns open issues into backlog tasks', () => {
  issues = [makeIssue(1), makeIssue(2, { labels: ['priority: high'] })];
  const r = board.importIssues(db, projectId(), 'dehepting/workbench', issues);

  assert.equal(r.created.length, 2);
  const tasks = board.listTasks(db, { project_id: projectId() });
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every((t) => t.column_name === 'backlog'), 'imports land in backlog, never auto-run');
  const labelled = tasks.find((t) => t.title === 'Issue 2');
  assert.equal(labelled.priority, 3, 'a priority label maps to board priority');
  assert.equal(labelled.meta.github.number, 2);
});

test('an issue anchored in another project is a conflict, not a silent skip', () => {
  // Two projects bound to the same repo: one issue is one unit of work, so the
  // second project must not get a duplicate card — but it also must not look
  // broken. Found this live when the poll loop imported into the newer project
  // and a manual sync for the older one silently imported nothing.
  const mine = projectId(); // listProjects is newest-first, so grab it before adding
  const other = board.createProject(db, 'Other project');
  issues = [makeIssue(4)];
  board.importIssues(db, other.id, 'dehepting/workbench', issues);

  const r = board.importIssues(db, mine, 'dehepting/workbench', issues);

  assert.equal(r.created.length, 0, 'no duplicate card');
  assert.equal(r.skipped.length, 0, 'it is not merely "already imported"');
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].other_project, other.id, 'the conflict names where the work actually lives');
  assert.equal(r.conflicts[0].number, 4);
});

test('an issue anchored in the same project is a plain skip', () => {
  issues = [makeIssue(4)];
  board.importIssues(db, projectId(), 'dehepting/workbench', issues);
  const again = board.importIssues(db, projectId(), 'dehepting/workbench', issues);
  assert.deepEqual(again.conflicts, [], 'a re-sync of your own project is not a conflict');
  assert.deepEqual(again.skipped, [4]);
});

test('re-importing the same issues creates nothing new', () => {
  issues = [makeIssue(1), makeIssue(2)];
  board.importIssues(db, projectId(), 'dehepting/workbench', issues);
  const again = board.importIssues(db, projectId(), 'dehepting/workbench', issues);

  assert.deepEqual(again.created, [], 'nothing new');
  assert.equal(again.skipped.length, 2, 'both recognised as already tracked');
  assert.equal(board.listTasks(db, { project_id: projectId() }).length, 2, 'no duplicate cards');
});

test('an issue naming a task id is adopted, not duplicated', () => {
  const existing = board.createTask(db, { project_id: projectId(), title: 'Already on the board' }, 'test');
  issues = [makeIssue(5, { body: `Tracking as ${existing.id}` })];

  const r = board.importIssues(db, projectId(), 'dehepting/workbench', issues);

  assert.equal(r.created.length, 0, 'no second card for the same work');
  assert.equal(r.linked.length, 1);
  assert.equal(board.getTask(db, existing.id).meta.github.number, 5, 'the existing task is now anchored');
});

test('syncIssuesFromGithub completes a task when its issue closes', () => {
  issues = [makeIssue(9)];
  board.importIssues(db, projectId(), 'dehepting/workbench', issues);
  const t = board.listTasks(db, { project_id: projectId() })[0];

  issues = [makeIssue(9, { state: 'closed' })];
  const r = board.syncIssuesFromGithub(db, projectId(), 'dehepting/workbench', issues);

  assert.equal(board.getTask(db, t.id).column_name, 'done');
  assert.equal(r.moved[0].to, 'done');
  const comments = board.listComments(db, t.id);
  assert.match(comments.at(-1).body, /Closed in GitHub/);
});

// The close fires from moveTask without awaiting, and getToken() spawns a real
// subprocess — so poll for it to land rather than guessing at a sleep length.
async function settleClose(timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (calls.filter((c) => c.method === 'PATCH').length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('syncIssuesFromGithub requeues a task when its issue reopens', async () => {
  issues = [makeIssue(9)];
  board.importIssues(db, projectId(), 'dehepting/workbench', issues);
  const t = board.listTasks(db, { project_id: projectId() })[0];
  board.moveTask(db, t.id, 'todo', { actor: 'test' });
  board.moveTask(db, t.id, 'done', { actor: 'test', force: true });
  await settleClose(); // let the fire-and-forget close finish before we reopen

  issues = [makeIssue(9, { state: 'open' })];
  board.syncIssuesFromGithub(db, projectId(), 'dehepting/workbench', issues);

  assert.equal(board.getTask(db, t.id).column_name, 'todo', 'a reopened issue is work again');
});

test('closing from GitHub does not bounce back and close the issue', () => {
  issues = [makeIssue(9)];
  board.importIssues(db, projectId(), 'dehepting/workbench', issues);
  const t = board.listTasks(db, { project_id: projectId() })[0];

  issues = [makeIssue(9, { state: 'closed' })];
  board.syncIssuesFromGithub(db, projectId(), 'dehepting/workbench', issues);
  const patches = calls.filter((c) => c.method === 'PATCH');

  assert.equal(patches.length, 0, 'the actor guard stops a close loop');
});

test('pushCommentsToIssue posts new comments and advances the watermark', async () => {
  issues = [makeIssue(9)];
  board.importIssues(db, projectId(), 'dehepting/workbench', issues);
  const t = board.listTasks(db, { project_id: projectId() })[0];
  board.addTaskComment(db, t.id, 'worker-1', 'Working on it…');

  const r = await board.pushCommentsToIssue(db, t.id);
  assert.equal(r.pushed, 1);
  const posted = calls.find((c) => c.url.includes('/comments') && c.method === 'POST');
  assert.match(posted.body.body, /worker-1/);
  assert.match(posted.body.body, /Working on it/);
  assert.match(posted.body.body, /<!-- workbench:c_/, 'each comment carries an id marker');

  const again = await board.pushCommentsToIssue(db, t.id);
  assert.equal(again.pushed, 0, 'the watermark prevents re-posting');
});

test('a failed push stops and retries later instead of skipping forever', async () => {
  issues = [makeIssue(9)];
  board.importIssues(db, projectId(), 'dehepting/workbench', issues);
  const t = board.listTasks(db, { project_id: projectId() })[0];
  board.addTaskComment(db, t.id, 'worker-1', 'First');
  board.addTaskComment(db, t.id, 'worker-1', 'Second');

  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (String(url).includes('/comments') && opts.method === 'POST') {
      // Exactly one failure: the second comment fails, the retry succeeds.
      if (calls.filter((c) => c.method === 'POST').length === 2) return { ok: false, status: 500, text: async () => 'boom' };
      return ok({});
    }
    return ok([]);
  };

  const r = await board.pushCommentsToIssue(db, t.id);
  assert.equal(r.pushed, 1, 'the first posted, the second hit the failure');
  const comments = board.listComments(db, t.id);
  assert.match(comments.at(-1).body, /Could not push comment/, 'the failure is visible on the task');

  const retry = await board.pushCommentsToIssue(db, t.id);
  assert.equal(retry.pushed, 1, 'the un-pushed comment is retried, not lost');
});

test('syncProject imports open issues and reconciles against closed ones', async () => {
  bind();
  issues = [makeIssue(1), makeIssue(2, { state: 'closed' })];

  const r = await sync.syncProject(db, projectId());

  assert.equal(r.repo, 'dehepting/workbench');
  assert.equal(r.open_issues, 1);
  assert.equal(r.imported.created.length, 1, 'only open issues become cards — closed ones would flood the board with finished work');
  assert.equal(r.imported.created[0].number, 1);
  assert.ok(r.last_sync_at, 'the pass records when it ran');
});

test('syncProject skips a project with no bound repo', async () => {
  const r = await sync.syncProject(db, projectId());
  assert.deepEqual(r, { skipped: 'project has no repo bound' });
  assert.equal(calls.length, 0, 'no API traffic for an unbound project');
});

test('syncAll only visits bound projects and survives one failing', async () => {
  const second = board.createProject(db, 'Unbound project');
  bind();
  issues = [makeIssue(1)];

  // The bound repo's calls blow up; the unbound project must not be visited.
  globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => 'Not Found' });

  const r = await sync.syncAll(db);
  assert.equal(r.projects.length, 1, 'only bound projects are visited');
  assert.ok(r.projects[0].error.includes('404'), `expected the 404 to surface, got ${JSON.stringify(r.projects[0])}`);
  assert.ok(second.id, 'the other project still exists');
});

test('the poll loop runs a pass and reports it', async () => {
  bind();
  issues = [makeIssue(1)];
  const seen = [];
  const loop = sync.startSyncLoop(db, { intervalMs: 5000, onTick: (r) => seen.push(r) });

  await loop.tick();
  loop.stop();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].projects[0].imported.created.length, 1, 'the tick actually imported');
});

test('overlapping ticks do not double-import', async () => {
  bind();
  issues = [makeIssue(1)];
  const loop = sync.startSyncLoop(db, { intervalMs: 5000 });

  // Fire a second tick while the first is still in flight.
  const first = loop.tick();
  const second = loop.tick();
  await Promise.all([first, second]);
  loop.stop();

  assert.equal(board.listTasks(db, { project_id: projectId() }).length, 1, 'one issue, one task');
});

// Regression: the push pass once inferred "the card was reopened" from a state
// snapshot of "card not in done + issue closed". Both directions look identical
// in a snapshot, so the first time someone closed an issue on GitHub the push
// pass reopened it, undoing their close and hiding the card's completion.
test('pushing cards must not reopen an issue that was closed on GitHub', async () => {
  bind();
  const t = board.createTask(db, { project_id: projectId(), title: 'Mirrored work' });
  board.linkGithub(db, t.id, 'dehepting/workbench', 5, 'http://x/5');
  issues = [makeIssue(5, { state: 'closed' })];

  await sync.syncProject(db, projectId());

  const reopened = calls.filter((c) => c.method === 'PATCH' && c.body?.state === 'open');
  assert.equal(reopened.length, 0, 'a GitHub close is the pull direction — pushing must not fight it');
  assert.equal(board.getTask(db, t.id).column_name, 'done', 'the closed issue still completes its card');
});

// The mirror writes (close/reopen issue) are fired without awaiting, because a
// board move must not block on GitHub. Waiting a fixed time races the gh child
// process getToken() spawns, and a test that asserts too early passes for the
// wrong reason — it proves nothing, it just fails to observe the write. So wait
// for the observable effect instead, and fail loudly if it never arrives.
async function waitFor(predicate, { timeoutMs = 3000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = predicate();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('a card leaving done reopens its issue', async () => {
  bind();
  const t = board.createTask(db, { project_id: projectId(), title: 'Finished then revived' });
  board.linkGithub(db, t.id, 'dehepting/workbench', 6, 'http://x/6');
  board.moveTask(db, t.id, 'done', { actor: 'david' });
  // moveTask fires closeMirrorIssue without awaiting. If that close is still in
  // flight when calls is reset below, its own PATCH lands mid-test and gets
  // misread as the reopen. Settle it first.
  await waitFor(() => calls.some((c) => c.method === 'PATCH' && c.body?.state === 'closed'),
    { what: 'the setup close to settle' });

  // The issue is closed on GitHub; the card is what moves.
  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (opts.method === 'PATCH') return ok({ state: 'open' });
    if (String(url).includes('/issues/6')) return ok({ state: 'closed' });
    return ok({});
  };

  board.moveTask(db, t.id, 'todo', { actor: 'david', force: true });

  const reopen = await waitFor(
    () => calls.find((c) => c.method === 'PATCH' && c.body?.state === 'open'),
    { what: 'the reopen PATCH' },
  );
  assert.match(String(reopen.url), /\/issues\/6$/, 'and reopens the right one');
});

test('leaving done does not touch an issue that is already open', async () => {
  bind();
  const t = board.createTask(db, { project_id: projectId(), title: 'Never closed' });
  board.linkGithub(db, t.id, 'dehepting/workbench', 7, 'http://x/7');
  board.moveTask(db, t.id, 'done', { actor: 'david' });
  // Same settling as above — without it the setup's own close PATCH is counted
  // as a write caused by leaving done, which is a false failure.
  await waitFor(() => calls.some((c) => c.method === 'PATCH' && c.body?.state === 'closed'),
    { what: 'the setup close to settle' });

  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (String(url).includes('/issues/7')) return ok({ state: 'open' });
    return ok({});
  };

  board.moveTask(db, t.id, 'todo', { actor: 'david', force: true });

  // Wait for the read that decides, then assert nothing was written. Asserting
  // "no PATCH" before the decision was even made would pass no matter what.
  await waitFor(() => calls.some((c) => c.method === 'GET' && String(c.url).includes('/issues/7')),
    { what: 'the issueState read' });
  await new Promise((r) => setTimeout(r, 50)); // give a wrong write time to land

  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0,
    'no write when the issue was never closed');
});

test('pushTasksToGithub raises an issue per card and links it', async () => {
  bind();
  const a = board.createTask(db, { project_id: projectId(), title: 'Card A', description: 'Desc A', labels: ['engineering'] });
  board.createTask(db, { project_id: projectId(), title: 'Card B' });

  // createIssue returns whatever GitHub echoes; the mock echoes the body.
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (opts.method === 'POST' && String(url).includes('/issues')) {
      const b = opts.body ? JSON.parse(opts.body) : {};
      return ok({ number: 42, html_url: 'http://x/42', title: b.title });
    }
    return ok({});
  };
  calls = [];

  const r = await board.pushTasksToGithub(db, projectId());

  assert.equal(r.created.length, 2, 'backlog cards are included, not just committed work');
  const post = calls.find((c) => c.method === 'POST' && String(c.url).includes('/issues'));
  assert.equal(post.body.title, 'Card A');
  assert.match(post.body.body, new RegExp(a.id), 'the task id is in the body, so importIssues can adopt it back');
  assert.deepEqual(post.body.labels, ['engineering'], 'labels carry across');
  assert.equal(board.getTask(db, a.id).meta.github.number, 42, 'the card is anchored to its issue');
});

test('already-mirrored cards are not re-issued', async () => {
  bind();
  const t = board.createTask(db, { project_id: projectId(), title: 'Already out there' });
  board.linkGithub(db, t.id, 'dehepting/workbench', 9, 'http://x/9');

  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    return ok({});
  };

  const r = await board.pushTasksToGithub(db, projectId());

  assert.equal(r.created.length, 0, 'idempotent — a second pass creates nothing');
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('done and failed cards get no retroactive issue', async () => {
  bind();
  const done = board.createTask(db, { project_id: projectId(), title: 'Long finished' });
  board.moveTask(db, done.id, 'done', { actor: 'david' });

  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    return ok({});
  };

  const r = await board.pushTasksToGithub(db, projectId());

  assert.equal(r.created.length, 0, 'an issue opened now would only be closed again — noise, not history');
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].task_id, done.id);
});

test('a deleted card closes its mirror issue', async () => {
  bind();
  const t = board.createTask(db, { project_id: projectId(), title: 'Doomed' });
  board.linkGithub(db, t.id, 'dehepting/workbench', 11, 'http://x/11');

  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    return ok({});
  };

  const r = board.deleteTask(db, t.id, 'david');
  await r.github_close;

  const close = calls.find((c) => c.method === 'PATCH' && c.body?.state === 'closed');
  assert.ok(close, 'the orphan issue is closed, not left claiming work that is gone');
  const comment = calls.find((c) => c.method === 'POST' && String(c.url).includes('/comments'));
  // calls stores the parsed body, so the text is nested one level down.
  assert.match(comment?.body?.body || '', /card was deleted/, 'and says why');
});

