import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withRetry } from './retry.js';

const execFileP = promisify(execFile);

const KEYCHAIN_SERVICE = 'workbench';
const KEYCHAIN_ACCOUNT = 'github-token';

// Token resolution order:
//   1. gh CLI auth (if the user is already logged in via `gh auth login`)
//   2. macOS Keychain entry (stored on first run / via the dashboard prompt)
// The token never touches the DB, .env, logs, or any API response.
export async function getToken() {
  const fromGh = await ghAuthToken();
  if (fromGh) return fromGh;
  return keychainToken();
}

async function ghAuthToken() {
  try {
    const { stdout } = await execFileP('gh', ['auth', 'token']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function keychainToken() {
  try {
    const { stdout } = await execFileP('security', [
      'find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-w',
    ]);
    return stdout.trim() || null;
  } catch {
    return null; // no entry — that's the "prompt for first run" case
  }
}

export async function saveKeychainToken(token) {
  if (!token?.trim()) throw new Error('token required');
  // -U updates in place if the entry already exists
  await execFileP('security', [
    'add-generic-password', '-U',
    '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE,
    '-w', token.trim(),
  ]);
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'workbench',
  };
}

export async function githubStatus() {
  const token = await getToken();
  let user = null;
  let source = null;
  if (token) {
    source = await ghAuthToken() ? 'gh-cli' : 'keychain';
    try {
      const res = await fetch('https://api.github.com/user', { headers: authHeaders(token) });
      if (res.ok) user = (await res.json()).login;
    } catch { /* offline */ }
  }
  return { connected: !!token && !!user, user, source };
}

export async function createIssue(token, repo, { title, body, labels = [] }) {
  return withRetry(async () => {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, labels }),
    });
    if (!res.ok) {
      const err = new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
      err.response = res;
      throw err;
    }
    return res.json(); // { number, html_url, ... }
  }, { context: { operation: 'createIssue', repo } });
}

export async function commentIssue(token, repo, number, body) {
  return withRetry(async () => {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues/${number}/comments`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) {
      const err = new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
      err.response = res;
      throw err;
    }
    return res.json();
  }, { context: { operation: 'commentIssue', repo, number } });
}

export async function closeIssue(token, repo, number) {
  return withRetry(async () => {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues/${number}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'closed' }),
    });
    if (!res.ok) {
      const err = new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
      err.response = res;
      throw err;
    }
    return res.json();
  }, { context: { operation: 'closeIssue', repo, number } });
}

export async function reopenIssue(token, repo, number) {
  return withRetry(async () => {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues/${number}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'open' }),
    });
    if (!res.ok) {
      const err = new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
      err.response = res;
      throw err;
    }
    return res.json();
  }, { context: { operation: 'reopenIssue', repo, number } });
}

// 'open' | 'closed' | null. Returns null rather than throwing when the issue
// is gone or unreadable, because the only caller is deciding whether a reopen
// is needed — a card whose issue was deleted by hand should not be able to
// fail a whole sync pass.
export async function issueState(token, repo, number) {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${number}`, {
    headers: { ...authHeaders(token), Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) return null;
  return (await res.json()).state ?? null;
}

// ---------- pull requests ----------
//
// These exist so an agent's work is reviewable as a diff rather than taken on
// trust. A task in `review` should mean "there is a PR open", not "a comment
// was posted".

export async function createPullRequest(token, repo, { title, body, head, base = 'main' }) {
  return withRetry(async () => {
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, head, base }),
    });
    if (!res.ok) {
      const err = new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
      err.response = res;
      throw err;
    }
    return res.json(); // { number, html_url, mergeable, state, ... }
  }, { context: { operation: 'createPullRequest', repo, head, base } });
}

// Merge state is a three-way answer, not a boolean. Callers need to tell
// "merged" from "closed without merging" from "GitHub has not computed
// mergeability yet", because only the first is success.
export async function getPullRequest(token, repo, number) {
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${number}`, {
    headers: authHeaders(token),
  });
  if (!res.ok) return null;
  const pr = await res.json();
  return {
    number: pr.number,
    state: pr.state,               // 'open' | 'closed'
    merged: !!pr.merged,           // true only once the merge actually landed
    mergeable: pr.mergeable,       // true | false | null (still computing)
    title: pr.title,
    url: pr.html_url,
    head: pr.head?.ref,
    base: pr.base?.ref,
  };
}

export async function mergePullRequest(token, repo, number, { method = 'squash' } = {}) {
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${number}/merge`, {
    method: 'PUT',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ merge_method: method }),
  });
  // 405 means the PR is not mergeable (conflicts, checks pending). Throwing the
  // raw body loses which of those it was, so name them.
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 405) {
      throw new Error(`${repo}#${number} is not mergeable — ${text.slice(0, 200)}`);
    }
    throw new Error(`GitHub ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json(); // { merged: true, sha, message }
}

export async function closePullRequest(token, repo, number) {
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${number}`, {
    method: 'PATCH',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'closed' }),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function paged(token, url) {
  // Pull every page rather than silently returning the first 30 — an import
  // that drops issues past page one is worse than one that says "too many".
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const sep = url.includes('?') ? '&' : '?';
    const batch = await withRetry(async () => {
      const res = await fetch(`${url}${sep}per_page=100&page=${page}`, { headers: authHeaders(token) });
      if (!res.ok) {
        const err = new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
        err.response = res;
        throw err;
      }
      return res.json();
    }, { context: { operation: 'paged', url, page } });
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

// The repos this token can see, most recently pushed first. Feeds the picker so
// nobody has to type an owner/repo by hand.
export async function listRepos(token) {
  const repos = await paged(token, 'https://api.github.com/user/repos?sort=pushed&affiliation=owner,collaborator,organization_member');
  return repos.map((r) => ({
    repo: r.full_name,
    private: !!r.private,
    pushed_at: r.pushed_at,
    default_branch: r.default_branch,
    open_issues: r.open_issues_count ?? 0,
  }));
}

// Open issues (pull requests excluded — a PR is not a task).
export async function listIssues(token, repo, { state = 'open' } = {}) {
  const issues = await paged(token, `https://api.github.com/repos/${repo}/issues?state=${state}`);
  return issues.filter((i) => !i.pull_request).map((i) => ({
    number: i.number,
    title: i.title,
    body: i.body || '',
    url: i.html_url,
    state: i.state,
    labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
    assignee: i.assignee?.login || null,
    updated_at: i.updated_at,
  }));
}

// Best-effort guess at which repo we're sitting in, from a git remote. Lets the
// dashboard pre-select the obvious answer instead of asking for it.
//
// Checks several locations because the answer depends on how the process was
// started: a launchd server has a cwd of "/", while a CLI run sits in the repo.
// The package root is always a git checkout of workbench itself.
export async function detectRepo(cwd = process.cwd()) {
  const roots = [
    cwd,
    dirname(dirname(fileURLToPath(import.meta.url))), // package root
    process.env.WORKBENCH_WORKER_CWD,
  ].filter(Boolean);

  const seen = new Set();
  for (const root of roots) {
    if (seen.has(root)) continue;
    seen.add(root);
    try {
      const { stdout } = await execFileP('git', ['-C', root, 'remote', 'get-url', 'origin'], { timeout: 5000 });
      const m = stdout.trim().match(/(?:github\.com[/:]|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
      if (m) return m[1];
    } catch {
      // not a git checkout — try the next candidate
    }
  }
  return null;
}

// Find the task linked to a GitHub issue number (meta.github.number).
export function findTaskByIssue(db, repo, number) {
  const rows = db.prepare("SELECT id FROM tasks WHERE meta LIKE ?").all(`%"github"%`);
  for (const r of rows) {
    const row = db.prepare('SELECT meta FROM tasks WHERE id = ?').get(r.id);
    let meta = {};
    try { meta = JSON.parse(row.meta); } catch { continue; }
    if (meta.github?.repo === repo && meta.github?.number === number) return r.id;
  }
  return null;
}
