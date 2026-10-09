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
