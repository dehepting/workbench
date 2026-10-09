// The worker loop itself: pull → work → advance, and above all the failure
// path. It used to end with `.catch()` on a synchronous function, so the first
// failed task threw a TypeError and killed the process — auto-retry never
// actually ran in production.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import * as board from '../src/board.js';
import { runOnce } from '../src/worker.js';

let dataDir, db, projectId;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wb-loop-test-'));
  db = openStore(dataDir);
  projectId = board.createProject(db, 'Loop project').id;
});

afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
  rmSync(dataDir, { recursive: true, force: true });
});

const makeTask = (fields = {}) =>
  board.createTask(db, { project_id: projectId, title: 'work', ...fields }, 'test');

test('empty queue returns null without throwing', async () => {
  assert.equal(await runOnce(db, 'tester', { exec: 'echo hi' }), null);
});

test('a failing exec records the error and auto-retries instead of crashing', async () => {
  const t = makeTask({ title: 'flaky', max_retries: 3 });

  // This is the assertion that would have caught the crash: runOnce must
  // resolve, not reject.
  const worked = await runOnce(db, 'tester', { exec: 'echo about to fail >&2; exit 3' });
  assert.ok(worked, 'the task should have been picked up');

  const after = board.getTask(db, t.id);
  assert.equal(after.column_name, 'todo', 'failure bounces back to todo for retry');
  assert.equal(after.retry_count, 1);
  assert.equal(after.lease_holder, null, 'lease is released on retry');

  const comments = board.listComments(db, t.id);
  const failure = comments.find((c) => c.body.startsWith('failed:'));
  assert.ok(failure, 'the error must be recorded on the task');
  assert.match(failure.body, /exit code 3|Command failed/);
});

test('retries exhaust into failed, then the queue drains', async () => {
  const t = makeTask({ title: 'hopeless', max_retries: 2 });

  await runOnce(db, 'tester', { exec: 'exit 1' }); // retry 1 -> todo
  await runOnce(db, 'tester', { exec: 'exit 1' }); // retry 2 -> todo
  await runOnce(db, 'tester', { exec: 'exit 1' }); // retries exhausted -> failed

  const after = board.getTask(db, t.id);
  assert.equal(after.column_name, 'failed');
  assert.equal(after.retry_count, 2);

  assert.equal(await runOnce(db, 'tester', { exec: 'exit 1' }), null, 'nothing left to pull');
});

test('a successful exec completes the task and keeps its output', async () => {
  const t = makeTask({ title: 'shippable' });

  await runOnce(db, 'tester', { exec: 'echo "did the work"' });

  const after = board.getTask(db, t.id);
  assert.equal(after.column_name, 'done');
  assert.ok(after.completed_at, 'done stamps completed_at');

  const comments = board.listComments(db, t.id);
  const completion = comments.find((c) => c.body.startsWith('completed:'));
  assert.ok(completion, 'output is captured on the task');
  assert.match(completion.body, /did the work/);
});

test('requires_review tasks stop in review, not done', async () => {
  const t = makeTask({ title: 'careful', requires_review: true });

  await runOnce(db, 'tester', { exec: 'echo looks good' });

  assert.equal(board.getTask(db, t.id).column_name, 'review');
});

test('the prompt the agent receives includes the task context', async () => {
  const t = makeTask({ title: 'Prompt shape', description: 'be exact', labels: ['research'] });

  // `cat` has no input (stdin is /dev/null) so echo the prompt instead:
  // printf with the substituted prompt round-trips it through the shell.
  await runOnce(db, 'tester', { exec: 'echo received; printf %s {prompt}' });

  const comments = board.listComments(db, t.id);
  const completion = comments.find((c) => c.body.startsWith('completed:'));
  assert.match(completion.body, /Task: Prompt shape/);
  assert.match(completion.body, /be exact/);
  assert.match(completion.body, /research/);
  assert.match(completion.body, /Acceptance:/);
});
