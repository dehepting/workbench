// Integration tests over the real HTTP API: the gates that make the board
// safe for a fleet of agents (DAG deps, WIP limits, review gate, leases,
// auto-retry) plus the flow metrics the dashboard reports.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { startServer } from '../src/server.js';

let db, server, base, dataDir, project;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wb-test-'));
  process.env.WORKBENCH_DATA = dataDir;
  process.env.PORT = '0';
  db = openStore(dataDir);
  server = startServer(db);
  await new Promise((resolve) => server.on('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.closeAllConnections?.();
  server?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
}
const post = (path, body) => call(path, { method: 'POST', body });
const patch = (path, body) => call(path, { method: 'PATCH', body });
const put = (path, body) => call(path, { method: 'PUT', body });

test('GET / serves the dashboard', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /Workbench/);
});

test('unknown route 404s as json', async () => {
  const { status, json } = await call('/api/nope');
  assert.equal(status, 404);
  assert.equal(json.error, 'not found');
});

test('project lifecycle', async () => {
  const created = await post('/api/projects', { name: 'Test Project' });
  assert.equal(created.status, 201);
  project = created.json;
  assert.ok(project.id.startsWith('p_'));

  const list = await call('/api/projects');
  assert.equal(list.status, 200);
  assert.ok(list.json.some((p) => p.id === project.id));

  const emptyName = await post('/api/projects', { name: '  ' });
  assert.equal(emptyName.status, 400);

  const missing = await call('/api/projects/p_doesnotexist');
  assert.equal(missing.status, 404);
});

async function newTask(fields) {
  const res = await post('/api/tasks', { project_id: project.id, ...fields });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

test('tasks are created into backlog', async () => {
  const t = await newTask({ title: 'First task', labels: ['a', 'b'], priority: 2 });
  assert.equal(t.column_name, 'backlog');
  assert.deepEqual(t.labels, ['a', 'b']);
  assert.equal(t.requires_review, false);

  const noTitle = await post('/api/tasks', { project_id: project.id, title: ' ' });
  assert.equal(noTitle.status, 400);

  const noProject = await post('/api/tasks', { project_id: 'p_nope', title: 'x' });
  assert.equal(noProject.status, 404);

  const unknownDep = await post('/api/tasks', {
    project_id: project.id, title: 'x', deps: ['t_nope'],
  });
  assert.equal(unknownDep.status, 400);
});

test('requires_review gate: done only via review', async () => {
  const t = await newTask({ title: 'Needs review', requires_review: true });

  const direct = await post(`/api/tasks/${t.id}/move`, { column: 'done' });
  assert.equal(direct.status, 409);
  assert.match(direct.json.error, /requires_review/);

  const toReview = await post(`/api/tasks/${t.id}/move`, { column: 'review' });
  assert.equal(toReview.status, 200);

  const nowDone = await post(`/api/tasks/${t.id}/move`, { column: 'done' });
  assert.equal(nowDone.status, 200);
  assert.equal(nowDone.json.column_name, 'done');
  assert.ok(nowDone.json.completed_at, 'completing stamps completed_at');
});

test('dependency gate: blocked until deps are done', async () => {
  const dep = await newTask({ title: 'Upstream' });
  const downstream = await newTask({ title: 'Downstream', deps: [dep.id] });

  const blocked = await post(`/api/tasks/${downstream.id}/move`, { column: 'doing' });
  assert.equal(blocked.status, 409);
  assert.match(blocked.json.error, new RegExp(dep.id));

  await post(`/api/tasks/${dep.id}/move`, { column: 'done' });

  const unblocked = await post(`/api/tasks/${downstream.id}/move`, { column: 'doing' });
  assert.equal(unblocked.status, 200);

  const cycle = await patch(`/api/tasks/${dep.id}`, { deps: [downstream.id] });
  assert.equal(cycle.status, 400);
  assert.match(cycle.json.error, /cycle/i);
});

test('WIP limit blocks overflow', async () => {
  const project2 = (await post('/api/projects', { name: 'WIP project' })).json;
  const a = (await post('/api/tasks', { project_id: project2.id, title: 'A' })).json;
  const b = (await post('/api/tasks', { project_id: project2.id, title: 'B' })).json;

  const set = await put(`/api/projects/${project2.id}/wip`, { column: 'doing', limit: 1 });
  assert.equal(set.status, 200);
  assert.equal(set.json.limit, 1);

  assert.equal((await post(`/api/tasks/${a.id}/move`, { column: 'doing' })).status, 200);

  const over = await post(`/api/tasks/${b.id}/move`, { column: 'doing' });
  assert.equal(over.status, 409);
  assert.match(over.json.error, /WIP limit/);

  const forced = await post(`/api/tasks/${b.id}/move`, { column: 'doing', force: true });
  assert.equal(forced.status, 200);

  const badColumn = await put(`/api/projects/${project2.id}/wip`, { column: 'nope', limit: 1 });
  assert.equal(badColumn.status, 400);
});

test('auto-retry bounces failed tasks back to todo', async () => {
  const t = await newTask({ title: 'Flaky', max_retries: 2 });

  const first = await post(`/api/tasks/${t.id}/move`, { column: 'failed' });
  assert.equal(first.status, 200);
  assert.equal(first.json.column_name, 'todo');
  assert.equal(first.json.retry_count, 1);

  await post(`/api/tasks/${t.id}/move`, { column: 'failed' });
  const exhausted = await post(`/api/tasks/${t.id}/move`, { column: 'failed' });
  assert.equal(exhausted.json.column_name, 'failed');
  assert.equal(exhausted.json.retry_count, 2);
});

test('leases: a second agent cannot steal a claim', async () => {
  const t = await newTask({ title: 'Contested' });

  const first = await post(`/api/tasks/${t.id}/claim`, { agent: 'agent-1', minutes: 10 });
  assert.equal(first.status, 200);
  assert.equal(first.json.lease_holder, 'agent-1');

  const second = await post(`/api/tasks/${t.id}/claim`, { agent: 'agent-2', minutes: 10 });
  assert.equal(second.status, 409);
  assert.match(second.json.error, /agent-1/);

  const otherRelease = await post(`/api/tasks/${t.id}/release`, { agent: 'agent-2' });
  assert.equal(otherRelease.status, 409);

  const released = await post(`/api/tasks/${t.id}/release`, { agent: 'agent-1' });
  assert.equal(released.status, 200);
  assert.equal(released.json.lease_holder, null);
});

test('nextTask hands each task to exactly one agent', async () => {
  const project3 = (await post('/api/projects', { name: 'Pull project' })).json;
  const low = (await post('/api/tasks', { project_id: project3.id, title: 'low', priority: 0 })).json;
  const high = (await post('/api/tasks', { project_id: project3.id, title: 'high', priority: 4 })).json;

  const first = await post('/api/tasks/next', { agent: 'coder-1', project_id: project3.id });
  assert.equal(first.status, 200);
  assert.equal(first.json.id, high.id, 'highest priority is pulled first');
  assert.equal(first.json.lease_holder, 'coder-1');

  const second = await post('/api/tasks/next', { agent: 'coder-2', project_id: project3.id });
  assert.equal(second.json.id, low.id, 'the claimed task is skipped');

  const third = await post('/api/tasks/next', { agent: 'coder-3', project_id: project3.id });
  assert.deepEqual(third.json, { empty: true }, 'queue is drained');
});

test('completing a task chains a follow-up', async () => {
  const t = await newTask({ title: 'Original', next_task_title: 'Follow-up work' });

  await post(`/api/tasks/${t.id}/move`, { column: 'done' });

  const tasks = await call(`/api/tasks?project_id=${project.id}`);
  const chained = tasks.json.find((x) => x.title === 'Follow-up work');
  assert.ok(chained, 'chained task should be created');
  assert.deepEqual(chained.deps, [t.id]);
});

test('tasks with dependents cannot be deleted', async () => {
  const dep = await newTask({ title: 'Anchor' });
  await newTask({ title: 'Dependent', deps: [dep.id] });

  const blocked = await call(`/api/tasks/${dep.id}`, { method: 'DELETE' });
  assert.equal(blocked.status, 409);
  assert.match(blocked.json.error, /depend/i);
});

test('comments and audit trail record activity', async () => {
  const t = await newTask({ title: 'Commented' });
  const added = await post(`/api/tasks/${t.id}/comments`, { author: 'tester', body: 'looks good' });
  assert.equal(added.status, 201);
  assert.ok(added.json.some((c) => c.body === 'looks good'));

  const empty = await post(`/api/tasks/${t.id}/comments`, { author: 'tester', body: '   ' });
  assert.equal(empty.status, 400);

  const audit = await call('/api/audit?limit=50');
  assert.equal(audit.status, 200);
  assert.ok(audit.json.some((a) => a.action === 'task.create'));
});

test('flow stats and ledger reflect the board', async () => {
  const stats = await call('/api/stats');
  assert.equal(stats.status, 200);
  assert.ok(stats.json.doneToday >= 1, 'at least one task has completed in this run');
  assert.ok(stats.json.open >= 1);
  assert.ok(Array.isArray(stats.json.perDay) && stats.json.perDay.length === 7);

  const ledger = await post('/api/runs', {
    agent: 'tester', model: 'groq/llama-3.3-70b-versatile',
    tokens_in: 1000, tokens_out: 2000, task_id: null,
  });
  assert.equal(ledger.status, 201);
  assert.equal(ledger.json.cost, 0, 'the documented provider/model form must price as free');

  const bare = await post('/api/runs', { agent: 'tester', model: 'groq', tokens_in: 1000, tokens_out: 2000 });
  assert.equal(bare.json.cost, 0, 'a bare provider name prices as free');

  const paid = await post('/api/runs', { agent: 'tester', model: 'deepinfra/DeepSeek-V3', tokens_in: 1e6, tokens_out: 1e6 });
  assert.equal(paid.json.cost, 0.08, 'paid providers keep their real per-Mtok price');

  const unknown = await post('/api/runs', { agent: 'tester', model: 'not-a-real-provider/x', tokens_in: 1e6, tokens_out: 1e6 });
  assert.equal(unknown.json.cost, 0.75, 'unknown models fall back to the default price');

  const explicit = await post('/api/runs', { agent: 'tester', model: 'groq/x', tokens_in: 1, tokens_out: 1, cost: 5 });
  assert.equal(explicit.json.cost, 5, 'an explicit cost is never overridden');

  const summary = await call('/api/ledger');
  assert.equal(summary.status, 200);
  assert.ok(summary.json.total.runs >= 1);

  const providers = await call('/api/providers');
  assert.equal(providers.status, 200);
  assert.ok(providers.json.providers.length >= 15);
});

test('SSE stream announces itself and carries board events', async () => {
  const controller = new AbortController();
  const res = await fetch(base + '/events', { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let pings = 0;
  while (!buf.includes('event:') && pings++ < 20) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    await post('/api/projects', { name: 'SSE ping' });
  }
  controller.abort();
  assert.match(buf, /retry: 2000/);
  assert.match(buf, /event: project\.create/);
});
