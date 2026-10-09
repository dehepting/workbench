// .env parsing. Before this, comment-only lines became non-empty fake API
// keys (the dashboard reported 15/15 providers configured and healthy) and
// real keys were sent to providers with their trailing comment attached.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv, loadEnv } from '../src/env.js';

test('strips an inline comment from a real value', () => {
  assert.deepEqual(
    parseEnv('GROQ_API_KEY=gsk_abc123   # console.groq.com — 30 RPM, 14.4K req/day'),
    { GROQ_API_KEY: 'gsk_abc123' }
  );
});

test('a comment-only line yields an empty value, not a fake key', () => {
  assert.deepEqual(
    parseEnv('CEREBRAS_API_KEY=          # cloud.cerebras.ai — 1M tokens/day'),
    { CEREBRAS_API_KEY: '' }
  );
  assert.deepEqual(parseEnv('NO_SPACE=#starts with a hash'), { NO_SPACE: '' });
});

test('quoted values keep their # and spaces', () => {
  assert.deepEqual(parseEnv('A="has # inside"\nB=\'also # inside\''), { A: 'has # inside', B: 'also # inside' });
});

test('a # without preceding whitespace is part of the value', () => {
  assert.deepEqual(parseEnv('TOKEN=sk-abc#def'), { TOKEN: 'sk-abc#def' });
});

test('full-line comments, blanks, and malformed lines are skipped', () => {
  const parsed = parseEnv('# a comment\n\n   \nNOT_AN_ASSIGNMENT\n=nobody\nKEY=ok\n');
  assert.deepEqual(parsed, { KEY: 'ok' });
});

test('unquoted values are trimmed', () => {
  assert.deepEqual(parseEnv('  SPACED  =  padded value  '), { SPACED: 'padded value' });
});

test('a real environment variable beats the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-env-test-'));
  writeFileSync(join(dir, '.env'), 'WB_TEST_FROM_FILE=file value\nWB_TEST_ALREADY=from file\n');
  const previous = process.cwd();
  process.env.WB_TEST_ALREADY = 'from environment';
  delete process.env.WB_TEST_FROM_FILE;
  try {
    process.chdir(dir);
    loadEnv();
    assert.equal(process.env.WB_TEST_FROM_FILE, 'file value', 'unset vars come from the file');
    assert.equal(process.env.WB_TEST_ALREADY, 'from environment', 'existing env is not clobbered');
  } finally {
    process.chdir(previous);
    delete process.env.WB_TEST_FROM_FILE;
    delete process.env.WB_TEST_ALREADY;
    rmSync(dir, { recursive: true, force: true });
  }
});

afterEach(() => {
  delete process.env.WB_TEST_FROM_FILE;
  delete process.env.WB_TEST_ALREADY;
});
