import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
  const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, labels }),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json(); // { number, html_url, ... }
}

export async function commentIssue(token, repo, number, body) {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${number}/comments`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function closeIssue(token, repo, number) {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${number}`, {
    method: 'PATCH',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'closed' }),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
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
