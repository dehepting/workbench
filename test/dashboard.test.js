// Regression test for the bug that shipped in v0.1.0: a single unbalanced
// brace in the dashboard's inline <script> made the whole script fail to
// parse, so every click handler in the UI was dead while the page still
// looked fine. Compile-checking the script catches that class of bug.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = readFileSync(join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');

function inlineScript(source) {
  const m = source.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, 'index.html should contain an inline <script> block');
  return m[1];
}

test('dashboard has an inline script', () => {
  assert.ok(inlineScript(html).length > 0);
});

test('dashboard script parses', () => {
  const src = inlineScript(html);
  assert.doesNotThrow(
    () => new Function(src),
    'inline <script> in public/index.html must be syntactically valid — ' +
    'if this fails, the whole dashboard is unresponsive'
  );
});

test('every handler target exists in the markup', () => {
  // The wiring at the bottom of the script grabs these by id at load time;
  // a renamed element would throw before boot() ever runs.
  for (const id of ['projectSelect', 'newProjectBtn', 'newTaskBtn', 'providersBtn',
                    'chips', 'board', 'taskOverlay', 'formOverlay', 'providersOverlay']) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id} in index.html`);
  }
});

test('favicon is declared (avoids a 404 on /favicon.ico)', () => {
  assert.ok(html.includes('rel="icon"'), 'index.html should declare a favicon');
});
