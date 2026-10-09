// Local git operations backing the branch -> commit -> pull request loop.
//
// The worker used to run in a single shared checkout sitting on main, which
// made review impossible by construction: an agent committing there would put
// work straight onto the default branch with nothing to diff it against, and
// two tasks would stomp each other's working tree.
//
// So each task gets its own worktree on its own branch, cut from origin/main.
// The agent works there, the result becomes a PR, and nothing reaches main
// without a human looking at a diff first. That is the entire point of the
// review column, and it is what a shared checkout could never provide.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const execFileP = promisify(execFile);

// Auth goes through the environment, never argv: a token on the command line
// is visible to every process on the box via `ps`, and lands in shell history
// for anything that logs its invocation. GIT_CONFIG_* is the mechanism GitHub's
// own runners use for the same reason.
function authEnv(token) {
  if (!token) return {};
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  };
}

async function git(dir, args, { token = null } = {}) {
  const { stdout } = await execFileP('git', ['-C', dir, ...args], {
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, ...authEnv(token) },
  });
  return stdout.trim();
}

// workbench/t_<id> — one branch per task, so a retry reuses its own branch
// rather than littering the repo with workbench-<agent>-1, -2, ...
export function branchFor(taskId) {
  return `workbench/${taskId}`;
}

// One clone per repo, shared by every worktree cut from it. Cloning fresh for
// each task would re-download the whole history per unit of work.
export async function ensureClone(repo, reposDir, { token = null } = {}) {
  const dir = join(reposDir, repo.replace(/[^\w.-]/g, '__'));
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(reposDir, { recursive: true });
    await execFileP('git', ['clone', '--quiet', `https://github.com/${repo}.git`, dir], {
      env: { ...process.env, ...authEnv(token) },
      maxBuffer: 20 * 1024 * 1024,
    });
  } else {
    await git(dir, ['fetch', '--quiet', 'origin'], { token });
  }
  return dir;
}

// A worktree for this task on a branch cut from origin/main. Rebuilt from
// scratch each run: a leftover worktree from a failed attempt would otherwise
// carry that attempt's half-finished changes into the next one.
export async function createWorktree(cloneDir, taskId, { base = 'origin/main', worktreesDir } = {}) {
  const dir = join(worktreesDir, taskId);
  const branch = branchFor(taskId);

  await git(cloneDir, ['worktree', 'prune']).catch(() => {});
  await git(cloneDir, ['branch', '-D', branch]).catch(() => {}); // a retry's branch
  await git(cloneDir, ['worktree', 'remove', '--force', dir]).catch(() => {});
  mkdirSync(worktreesDir, { recursive: true });

  await git(cloneDir, ['worktree', 'add', '--quiet', '-b', branch, dir, base]);
  return { dir, branch, base };
}

// Uncommitted work. The agent is told to commit, but an agent that forgets
// must not have its work silently dropped when the worktree is removed.
export async function hasChanges(dir) {
  const status = await git(dir, ['status', '--porcelain']);
  return status.length > 0;
}

export async function commitAll(dir, message) {
  await git(dir, ['add', '-A']);
  // --allow-empty: an agent that decided the work was already done should still
  // produce a reviewable PR that says so, rather than failing with no signal.
  await git(dir, ['commit', '--quiet', '--allow-empty', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

export async function pushBranch(dir, branch, { token = null } = {}) {
  await git(dir, ['push', '--quiet', '--force-with-lease', 'origin', `${branch}:${branch}`], { token });
  return branch;
}

// What the agent actually did, for the PR body. Guarded because a worktree
// with no commits has no diff to show.
export async function diffStat(dir, base = 'origin/main') {
  try {
    const stat = await git(dir, ['diff', '--stat', `${base}...HEAD`]);
    return stat || '(no file changes)';
  } catch {
    return '(diff unavailable)';
  }
}

export async function commitLog(dir, base = 'origin/main', limit = 5) {
  try {
    return await git(dir, ['log', `--oneline`, `-${limit}`, `${base}..HEAD`]);
  } catch {
    return '(no commits)';
  }
}

export async function removeWorktree(cloneDir, dir) {
  await git(cloneDir, ['worktree', 'remove', '--force', dir]).catch(() => {});
}
