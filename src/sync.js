// Two-way sync between bound projects and their GitHub repos.
//
// Polling, not webhooks: a local-first tool on localhost can't be reached by
// GitHub's webhook delivery without a tunnel, so a loop that asks is the
// mechanism that actually works. It also means nothing depends on the server
// process being the one that moved a task — every direction is idempotent and
// every write is anchored on meta.github, so overlap is harmless.
import * as board from './board.js';
import * as github from './github.js';

const DEFAULT_INTERVAL_MS = +(process.env.WORKBENCH_SYNC_INTERVAL_MS || 60_000);

// One full pass over every project bound to a repo. Exported so the dashboard
// can trigger it on demand, and so tests can drive it directly.
export async function syncAll(db, { actor = 'github' } = {}) {
  const projects = board.listProjects(db).filter((p) => p.repo);
  const results = [];
  for (const p of projects) {
    try {
      results.push({ project_id: p.id, repo: p.repo, ...(await syncProject(db, p.id, { actor })) });
    } catch (e) {
      // One repo being unreachable (bad token, renamed repo, rate limit) must
      // not stop the others, and must not take the server down with it.
      results.push({ project_id: p.id, repo: p.repo, error: e.message });
    }
  }
  return { synced_at: new Date().toISOString(), projects: results };
}

export async function syncProject(db, projectId, { actor = 'github' } = {}) {
  const project = board.getProject(db, projectId);
  const repo = project.repo;
  if (!repo) return { skipped: 'project has no repo bound' };

  const token = await github.getToken();
  if (!token) return { skipped: 'GitHub not connected' };

  // Pull: open issues become backlog tasks, deduped on meta.github.
  const open = await github.listIssues(token, repo, { state: 'open' });
  const imported = board.importIssues(db, projectId, repo, open, { actor });

  // Reconcile: also need closed issues to complete their tasks.
  const closed = await github.listIssues(token, repo, { state: 'closed' });
  const reconciled = board.syncIssuesFromGithub(db, projectId, repo, [...open, ...closed], { actor });

  // Push: task comments land back on their issue.
  const pushed = [];
  for (const row of db.prepare('SELECT id FROM tasks WHERE project_id = ?').all(projectId)) {
    const gh = board.getTask(db, row.id).meta?.github;
    if (!gh?.repo || !gh.number) continue;
    try {
      const r = await board.pushCommentsToIssue(db, row.id);
      if (r.pushed) pushed.push({ task_id: row.id, count: r.pushed });
    } catch (e) {
      pushed.push({ task_id: row.id, error: e.message });
    }
  }

  return {
    repo,
    open_issues: open.length,
    imported,
    reconciled,
    pushed,
    last_sync_at: new Date().toISOString(),
  };
}

// Background loop. `unref()` so a pending timer never keeps a process alive —
// a CLI one-shot that starts a sync should still be able to exit.
export function startSyncLoop(db, { intervalMs = DEFAULT_INTERVAL_MS, onTick = null } = {}) {
  let running = false;
  let stopped = false;

  const tick = async () => {
    // Overlapping ticks would double-import: two passes could both see an issue
    // as unclaimed before either writes its task.
    if (running || stopped) return;
    running = true;
    try {
      const result = await syncAll(db);
      if (onTick) onTick(result);
    } catch (e) {
      if (onTick) onTick({ error: e.message });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return {
    tick,
    stop() { stopped = true; clearInterval(timer); },
  };
}
