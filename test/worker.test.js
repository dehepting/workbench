// The worker passes its prompt through a user-supplied shell template
// (WORKBENCH_WORKER_EXEC, e.g. `claude -p "{prompt}"`). Getting that quoting
// wrong silently degrades every prompt the worker sends: v0.1.0 substituted
// JSON.stringify() output, so real newlines reached the agent as the literal
// two characters `\n`, and `$`/backticks would have been expanded by the shell.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shQuote, substitutePrompt, shellCommand, runExec, buildPrompt } from '../src/worker.js';

let tmp, echoScript;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wb-worker-test-'));
  echoScript = join(tmp, 'echo-argv.js');
  // Emit every argv after the script name, NUL-separated, so a prompt that
  // gets split by the shell shows up as a mismatch rather than a pass.
  writeFileSync(echoScript, 'process.stdout.write(process.argv.slice(2).join("\\u0000"));');
});

after(() => rmSync(tmp, { recursive: true, force: true }));

const NASTY = [
  'Line one',
  'Line two: single \' and double " quotes',
  'Line three: $HOME and `id` must not expand',
  'Line four: backslash \\ and a tab\there',
  'Line five: semicolon ; and ampersand & stay literal',
].join('\n');

function throughShell(template) {
  return new Promise((resolve, reject) => {
    execFile('/bin/sh', ['-lc', template], { maxBuffer: 1e6 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout));
  });
}

test('shQuote wraps in single quotes and escapes embedded quotes', () => {
  assert.equal(shQuote('plain'), "'plain'");
  assert.equal(shQuote("it's"), "'it'\\''s'");
  assert.equal(shQuote(''), "''");
});

test('prompt survives every template shape byte-for-byte', async () => {
  for (const template of [
    `node ${echoScript} {prompt}`,        // bare placeholder
    `node ${echoScript} "{prompt}"`,      // double-quoted (README's old example)
    `node ${echoScript} '{prompt}'`,      // single-quoted
    `FOO=1 node ${echoScript} {prompt}`,  // surrounding syntax
  ]) {
    const cmd = substitutePrompt(template, NASTY);
    const out = await throughShell(cmd);
    assert.equal(out, NASTY, `prompt mangled by template: ${template}`);
  }
});

test('substitutePrompt strips the template\'s own quotes before adding ours', () => {
  const inner = substitutePrompt('claude -p "{prompt}"', "it's");
  assert.equal(inner, "claude -p 'it'\\''s'");
  assert.ok(!inner.includes('""'), 'quotes must not nest');
  assert.ok(!inner.includes(`'it's'`), 'single quotes must not nest');
});

// Regression: without the subshell stdin redirect these hang forever (the
// worker's only escape was its 30-minute timeout, followed by 3 auto-retries).
test('runExec does not hang on a command that reads stdin', { timeout: 10_000 }, async () => {
  const t0 = Date.now();
  const out = await runExec('cat', 'prompt goes to argv, never to stdin');
  assert.equal(out, '(no output)');
  assert.ok(Date.now() - t0 < 5_000, 'cat must have hit EOF on /dev/null immediately');
});

test('pipes inside a template still supply their own stdin', { timeout: 10_000 }, async () => {
  const out = await runExec('printf %s {prompt} | tr a-z A-Z', 'abc def');
  assert.equal(out, 'ABC DEF');
});

test('shellCommand wraps the template and redirects stdin', () => {
  assert.equal(shellCommand('echo hi', 'p'), "(echo hi) < /dev/null");
});

test('acceptance demands the deliverable itself, not a description of one', () => {
  const prompt = buildPrompt({ title: 'Anything' });
  assert.match(prompt, /final message must contain the deliverable itself/i);
  assert.match(prompt, /did not actually write/i);
  assert.match(prompt, /Report exactly what you did/);
});

test('the prompt pins the model to its evidence instead of inviting invention', () => {
  // A pooled model asked for a comparison table invented GROQ_MODEL=groq-2-turbo
  // (no such model) and a "pre-2025 free tier" column the research never covered.
  // Both are checkable, so the acceptance block has to forbid them out loud.
  const prompt = buildPrompt({ title: 'Compare providers', deps: ['t_abc123'] });
  assert.match(prompt, /draw only on the evidence above/i);
  assert.match(prompt, /write "not recorded" rather than estimating/i);
  assert.match(prompt, /Keep every source citation/i);
  assert.match(prompt, /never invent model names, prices, limits, or dates/i);
  assert.match(prompt, /no evidence about/i);
});

test('the grounding rules arrive with the dependency context they govern', () => {
  // Grounding is meaningless without something to be grounded in: with no deps
  // the prompt must not pretend there is evidence, and with deps it must come
  // after them so the ordering reads evidence-then-constraints.
  const withoutDeps = buildPrompt({ title: 'Anything' });
  const withDeps = buildPrompt({ title: 'Anything', deps: ['t_abc123'] }, '### Research\nGroq: 30 RPM');
  assert.ok(withDeps.includes('### Research'), 'dependency context is present');
  assert.ok(
    withDeps.indexOf('### Research') < withDeps.indexOf('Ground rules'),
    'evidence precedes the rules that constrain it'
  );
  assert.match(withoutDeps, /Ground rules/, 'the rules apply to every prompt, deps or not');
});

test('buildPrompt assembles a task into an agent prompt', () => {
  const prompt = buildPrompt({
    title: 'Ship the thing',
    description: 'Do it carefully',
    labels: ['backend', 'urgent'],
    deps: ['t_abc123'],
  });
  assert.match(prompt, /Task: Ship the thing/);
  assert.match(prompt, /Do it carefully/);
  assert.match(prompt, /backend, urgent/);
  assert.match(prompt, /t_abc123/);
  assert.match(prompt, /Acceptance:/);
  assert.ok(prompt.includes('\n'), 'prompt is multi-line');
});
