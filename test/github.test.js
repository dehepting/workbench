// Project ↔ repo binding, and closing the mirror issue when work finishes.
// Every GitHub call is mocked (global fetch) and the token is faked with a stub
// `gh` on PATH — these tests never touch the network or the real keychain.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import * as board from '../src/board.js';

const realFetch = globalThis.fetch;
const realPath = process.env.PATH;
let db, dir, binDir, calls;

function resetDb() {
  dir = mkdtempSync(join(tmpdir(), 'wb-gh-test-'));
  db = openStore(dir);
  board.createProject(db, 'Test project');
}

// A `gh` that reports a token, so getToken() takes the gh-cli branch.
function withFakeGh() {
  binDir = mkdtempSync(join(tmpdir(), 'wb-gh-bin-'));
  writeFileSync(join(binDir, 'gh'), '#!/bin/sh\necho gho_faketoken\n', { mode: 0o755 });
  writeFileSync(join(binDir, 'security'), '#!/bin/sh\necho keychain_token\n', { mode: 0o755 });
  process.env.PATH = `${binDir}:${realPath}`;
}

function withNoGh() {
  // Nothing on PATH resolves, so both gh and security miss → no token.
  binDir = mkdtempSync(join(tmpdir(), 'wb-gh-empty-'));
  process.env.PATH = binDir;
}

function mockFetch(statusFor = () => 200) {
  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    const status = statusFor(String(url), opts);
    return { ok: status >= 200 && status < 300, status, json: async () => ({ number: 7, html_url: 'u' }), text: async () => 'boom' };
  };
}

beforeEach(resetDb);
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.PATH = realPath;
  db?.close();
  rmSync(dir, { recursive: true, force: true });
  if (binDir) rmSync(binDir, { recursive: true, force: true });
});

test('parseRepo accepts owner/repo and rejects everything else', () => {
  assert.equal(board.parseRepo('dehepting/workbench'), 'dehepting/workbench');
  assert.equal(board.parseRepo('  Some-Org/repo.name  '), 'Some-Org/repo.name');
  assert.throws(() => board.parseRepo('nope'), /Not a repo/);
  assert.throws(() => board.parseRepo('https://github.com/a/b'), /Not a repo/);
  assert.throws(() => board.parseRepo('a/b/c'), /Not a repo/);
  assert.throws(() => board.parseRepo(''), /Not a repo/);
});

test('a project remembers its repo, and forgets it on unbind', () => {
  const projectId = board.listProjects(db)[0].id;

  const bound = board.bindProjectRepo(db, projectId, 'dehepting/workbench');
  assert.equal(bound.repo, 'dehepting/workbench', 'getProject surfaces the repo');
  assert.equal(bound.meta.github.repo, 'dehepting/workbench');
  assert.equal(board.listProjects(db)[0].repo, 'dehepting/workbench', 'listProjects surfaces it too');

  const unbound = board.bindProjectRepo(db, projectId, null);
  assert.equal(unbound.repo, null);
  assert.deepEqual(unbound.meta, {}, 'the github key is gone, not left as a husk');
  assert.equal(board.listProjects(db)[0].repo, null);
});

test('binding to a ghost project fails instead of writing meta into the void', () => {
  assert.throws(() => board.bindProjectRepo(db, 'p_missing', 'a/b'), /not found/);
});

test('binding survives a reopen of the store', () => {
  const projectId = board.listProjects(db)[0].id;
  board.bindProjectRepo(db, projectId, 'dehepting/workbench');
  db.close();
  db = openStore(dir);
  assert.equal(board.getProject(db, projectId).repo, 'dehepting/workbench');
});

test('closing is skipped for a task with no linked issue', async () => {
  withFakeGh();
  mockFetch();
  const t = board.createTask(db, { project_id: board.listProjects(db)[0].id, title: 'Unlinked' }, 'test');
  const r = await board.closeMirrorIssue(db, t.id, 'test');
  assert.deepEqual(r, { skipped: 'not linked' });
  assert.equal(calls.length, 0, 'no API calls for an unlinked task');
});

test('the webhook closing an issue does not bounce back and close it again', async () => {
  withFakeGh();
  mockFetch();
  const projectId = board.listProjects(db)[0].id;
  const t = board.createTask(db, { project_id: projectId, title: 'Webhook closed' }, 'test');
  board.linkGithub(db, t.id, 'dehepting/workbench', 12, 'http://x/12');
  const r = await board.closeMirrorIssue(db, t.id, 'github');
  assert.deepEqual(r, { skipped: 'actor is github' });
  assert.equal(calls.length, 0, 'no redundant PATCH to an issue GitHub already closed');
});

test('a completed task comments on its issue, then closes it', async () => {
  withFakeGh();
  mockFetch();
  const projectId = board.listProjects(db)[0].id;
  const t = board.createTask(db, { project_id: projectId, title: 'Ship it' }, 'test');
  board.addTaskComment(db, t.id, 'worker-1', 'completed:\nThe thing is shipped.');
  board.linkGithub(db, t.id, 'dehepting/workbench', 9, 'http://x/9');

  const r = await board.closeMirrorIssue(db, t.id, 'worker-1');
  assert.deepEqual(r, { closed: 'dehepting/workbench#9' });

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /repos\/dehepting\/workbench\/issues\/9\/comments$/);
  assert.match(calls[0].body.body, /The thing is shipped\./, 'the result reaches the issue');
  assert.match(calls[0].body.body, new RegExp(t.id), 'and names the task it came from');
  assert.equal(calls[1].method, 'PATCH');
  assert.match(calls[1].url, /repos\/dehepting\/workbench\/issues\/9$/);
  assert.equal(calls[1].body.state, 'closed');

  const audited = db.prepare("SELECT * FROM audit WHERE action = 'task.github_close'").all();
  assert.equal(audited.length, 1, 'the close is auditable');
});

test('with no token the issue is left open, and the task says so', async () => {
  withNoGh();
  mockFetch();
  const projectId = board.listProjects(db)[0].id;
  const t = board.createTask(db, { project_id: projectId, title: 'No auth' }, 'test');
  board.linkGithub(db, t.id, 'dehepting/workbench', 3, 'http://x/3');

  const r = await board.closeMirrorIssue(db, t.id, 'test');
  assert.deepEqual(r, { skipped: 'no token' });
  assert.equal(calls.length, 0);
  const comments = board.listComments(db, t.id);
  assert.match(comments.at(-1).body, /left open: no GitHub token/, 'failure is visible on the task, not just in a log');
});

test('a GitHub outage records the failure instead of failing the board move', async () => {
  withFakeGh();
  mockFetch(() => 500);
  const projectId = board.listProjects(db)[0].id;
  const t = board.createTask(db, { project_id: projectId, title: 'Outage' }, 'test');
  board.linkGithub(db, t.id, 'dehepting/workbench', 4, 'http://x/4');

  const r = await board.closeMirrorIssue(db, t.id, 'test');
  assert.equal(r.error.includes('500'), true, `expected a 500 error, got ${JSON.stringify(r)}`);
  const comments = board.listComments(db, t.id);
  assert.match(comments.at(-1).body, /Done, but could not close dehepting\/workbench#4/);
});

// The close is fire-and-forget and getToken() spawns a subprocess, so poll
// rather than sleeping a fixed amount — and keep the db open until it lands.
async function waitForCalls(n, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (calls.length < n && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return calls.length;
}

test('moving a linked task to done closes the issue without being asked', async () => {
  withFakeGh();
  mockFetch();
  const projectId = board.listProjects(db)[0].id;
  const t = board.createTask(db, { project_id: projectId, title: 'Auto-close' }, 'test');
  board.linkGithub(db, t.id, 'dehepting/workbench', 21, 'http://x/21');

  board.moveTask(db, t.id, 'doing', { actor: 'test' });
  board.moveTask(db, t.id, 'done', { actor: 'test' });

  await waitForCalls(2);
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 1, 'the move alone closed the issue');
});

test('tasks with no linked issue move to done without any API traffic', async () => {
  withFakeGh();
  mockFetch();
  const projectId = board.listProjects(db)[0].id;
  const t = board.createTask(db, { project_id: projectId, title: 'Ordinary task' }, 'test');
  board.moveTask(db, t.id, 'doing', { actor: 'test' });
  board.moveTask(db, t.id, 'done', { actor: 'test' });
  await waitForCalls(1, 400); // nothing should arrive
  assert.equal(calls.length, 0, 'the common path stays free of network calls');
});
