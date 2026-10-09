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
                    'githubBtn', 'githubOverlay', 'githubModal',
                    'chips', 'board', 'taskOverlay', 'formOverlay', 'providersOverlay']) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id} in index.html`);
  }
});

test('the GitHub panel is a picker, not a prompt', () => {
  const src = inlineScript(html);
  assert.ok(src.includes("$('#githubBtn').onclick = openGithub"), 'githubBtn opens the panel');
  assert.ok(src.includes('/api/github/repos'), 'the panel lists repos from the API');
  assert.ok(src.includes('data-repo='), 'repos are clickable rows');
  assert.ok(src.includes('this checkout'), 'the detected repo is flagged');
  assert.ok(src.includes('repoRow'), 'rows carry the repoRow class for styling');
  // A free-text prompt would defeat the point — the whole reason for the panel
  // is that owner/repo is easy to mistype and impossible to guess.
  assert.ok(!/githubBtn[\s\S]{0,400}prompt\(/.test(src), 'the GitHub flow must not ask for a repo by hand');
});

test('the panel reports connection state and the current binding', () => {
  const src = inlineScript(html);
  assert.ok(src.includes('Connected') && src.includes('Not connected'), 'both connection states render');
  assert.ok(src.includes('gh auth login'), 'an unconnected user is told how to connect');
  assert.ok(src.includes('mirrors'), 'the current binding is shown');
  assert.ok(src.includes('unbind'), 'there is a way to unbind');
});

test('the panel can trigger a sync and the binding endpoint is wired', () => {
  const src = inlineScript(html);
  assert.ok(src.includes('/api/projects/sync'), 'a sync button posts to the sync endpoint');
  assert.ok(/\/api\/projects\/\$\{project\.id\}\/github/.test(src), 'clicking a repo posts to the binding endpoint');
  assert.ok(src.includes('renderChips'), 'binding refreshes the header chip');
});

test('the repo name is escaped before display', () => {
  const src = inlineScript(html);
  // Repo names are echoed into the panel and the chip — escape them both.
  assert.equal((src.match(/esc\(r\.repo\)/g) || []).length >= 2, true, 'rows escape the repo name');
  assert.ok(src.includes('esc(repo)'), 'the chip escapes the repo name');
});

test('favicon is declared (avoids a 404 on /favicon.ico)', () => {
  assert.ok(html.includes('rel="icon"'), 'index.html should declare a favicon');
});
