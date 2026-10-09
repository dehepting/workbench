import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import * as board from './board.js';
import * as providers from './providers.js';
import * as github from './github.js';
import * as sync from './sync.js';
import { onEvent } from './bus.js';

export function startServer(db) {
  const PORT = +(process.env.PORT || 3000);
  const API_KEY = process.env.WORKBENCH_API_KEY || null;
  const WEBHOOK_URL = process.env.WORKBENCH_WEBHOOK_URL || null;
  const WEBHOOK_SECRET = process.env.WORKBENCH_WEBHOOK_SECRET || null;
  const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || null;

  const sseClients = new Set();
  onEvent((event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try { res.write(payload); } catch { /* dropped client */ }
    }
    if (WEBHOOK_URL) {
      const body = JSON.stringify({ ts: new Date().toISOString(), event, data });
      const headers = { 'Content-Type': 'application/json' };
      if (WEBHOOK_SECRET) headers['X-Workbench-Signature'] = 'sha256=' + createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
      fetch(WEBHOOK_URL, { method: 'POST', headers, body }).catch(() => {});
    }
  });

  const html = readFileSync(join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');
  const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;

    if (API_KEY && path.startsWith('/api/')) {
      if ((req.headers.authorization || '') !== `Bearer ${API_KEY}`) {
        return send(res, 401, { error: 'unauthorized' });
      }
    }

    if (path === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    try {
      const body = await readBody(req);
      const m = (method) => req.method === method;

      // --- projects ---
      if (m('GET') && path === '/api/projects') return send(res, 200, board.listProjects(db));
      if (m('POST') && path === '/api/projects') return send(res, 201, board.createProject(db, body.name, body));

      // project ↔ repo binding: which GitHub repo this project mirrors.
      // Pass { repo: null } to unbind.
      const projGhMatch = path.match(/^\/api\/projects\/([\w-]+)\/github$/);
      if (projGhMatch && m('POST')) {
        return send(res, 200, board.bindProjectRepo(db, projGhMatch[1], body.repo));
      }
      const projMatch = path.match(/^\/api\/projects\/([\w-]+)(\/wip)?$/);
      if (projMatch) {
        const id = projMatch[1];
        if (!projMatch[2] && m('GET')) return send(res, 200, board.getProject(db, id));
        if (projMatch[2] === '/wip' && m('PUT')) return send(res, 200, board.setWipLimit(db, id, body.column, body.limit));
      }

      // --- github ---
      if (m('GET') && path === '/api/github/status') return send(res, 200, await github.githubStatus());
      if (m('GET') && path === '/api/github/repos') {
        // The picker's data source: repos this token can see, plus whichever
        // repo the working directory points at so it can be pre-selected.
        const token = await github.getToken();
        if (!token) return send(res, 200, { connected: false, repos: [] });
        const [repos, detected] = await Promise.all([
          github.listRepos(token).catch(() => []),
          github.detectRepo(),
        ]);
        return send(res, 200, { connected: true, detected, repos });
      }
      if (m('POST') && path === '/api/github/sync') return send(res, 200, await sync.syncAll(db));
      if (m('POST') && path === '/api/projects/sync') return send(res, 200, await sync.syncProject(db, body.project_id));
      if (m('POST') && path === '/api/github/setup') {
        await github.saveKeychainToken(body.token || '');
        return send(res, 200, await github.githubStatus());
      }
      if (m('POST') && path === '/api/github/webhook') {
        const raw = await readRaw(req);
        if (GITHUB_WEBHOOK_SECRET) {
          const sig = req.headers['x-hub-signature-256'] || '';
          const expected = 'sha256=' + createHmac('sha256', GITHUB_WEBHOOK_SECRET).update(raw).digest('hex');
          if (sig !== expected) return send(res, 401, { error: 'bad signature' });
        }
        let payload;
        try { payload = JSON.parse(raw); } catch { return send(res, 400, { error: 'invalid json' }); }
        return send(res, 200, handleGithubEvent(db, req.headers['x-github-event'], payload));
      }

      // --- tasks ---
      if (m('GET') && path === '/api/tasks') return send(res, 200, board.listTasks(db, Object.fromEntries(url.searchParams)));
      if (m('POST') && path === '/api/tasks') return send(res, 201, board.createTask(db, body, body.actor || 'api'));
      if (m('POST') && path === '/api/tasks/next') return send(res, 200, board.nextTask(db, body.agent, body) ?? { empty: true });

      const taskMatch = path.match(/^\/api\/tasks\/([\w-]+)(?:\/(move|claim|release|comments))?$/);
      if (taskMatch) {
        const id = taskMatch[1];
        const sub = taskMatch[2];
        if (!sub && m('GET')) return send(res, 200, board.getTask(db, id));
        if (!sub && m('PATCH')) return send(res, 200, board.updateTask(db, id, body, body.actor || 'api'));
        if (!sub && m('DELETE')) {
          // Await the mirror-issue close before responding: the delete already
          // happened, but a caller that knows the close finished can safely run
          // a sync next without racing a re-import of the now-orphaned issue.
          const r = board.deleteTask(db, id, body.actor || 'api');
          if (r.github_close) await r.github_close;
          const { github_close, ...rest } = r;
          return send(res, 200, rest);
        }
        if (sub === 'move' && m('POST')) return send(res, 200, board.moveTask(db, id, body.column, { actor: body.actor || 'api', force: !!body.force }));
        if (sub === 'claim' && m('POST')) return send(res, 200, board.claimTask(db, id, body.agent, body.minutes ?? 10));
        if (sub === 'release' && m('POST')) return send(res, 200, board.releaseTask(db, id, body.agent));
        if (sub === 'comments' && m('GET')) return send(res, 200, board.listComments(db, id));
        if (sub === 'comments' && m('POST')) return send(res, 201, board.addTaskComment(db, id, body.author || 'api', body.body));
      }

      // task → github issue (two-way link)
      const ghMatch = path.match(/^\/api\/tasks\/([\w-]+)\/github$/);
      if (ghMatch && m('POST')) {
        const token = await github.getToken();
        if (!token) return send(res, 400, { error: 'GitHub not connected — run `gh auth login` or POST a token to /api/github/setup' });
        const t = board.getTask(db, ghMatch[1]);
        // Default to the project's bound repo, so a linked project doesn't have
        // to restate owner/repo on every single issue it raises.
        const repo = body.repo || t.meta?.github?.repo || board.getProject(db, t.project_id).repo;
        if (!repo?.includes('/')) return send(res, 400, { error: 'repo must be owner/repo — bind one to the project or pass { repo }' });
        const issue = await github.createIssue(token, repo, {
          title: t.title,
          body: `${t.description || ''}\n\n_Workbench task ${t.id} — track it at http://localhost:4173_`,
          labels: body.labels || (t.labels || []),
        });
        const linked = board.linkGithub(db, t.id, repo, issue.number, issue.html_url);
        await github.commentIssue(token, repo, issue.number, `Linked to Workbench task \`${t.id}\``);
        return send(res, 201, linked);
      }

      // --- runs, ledger, stats, audit ---
      if (m('POST') && path === '/api/runs') return send(res, 201, board.recordRun(db, body));
      if (m('GET') && path === '/api/ledger') return send(res, 200, board.ledgerSummary(db));
      if (m('GET') && path === '/api/providers') return send(res, 200, { providers: providers.providerHealth() });
      if (m('GET') && path === '/api/stats') return send(res, 200, board.flowStats(db));
      if (m('GET') && path === '/api/audit') return send(res, 200, board.auditTrail(db, +(url.searchParams.get('limit') || 100)));

      return send(res, 404, { error: 'not found' });
    } catch (e) {
      const code = e.code === 'not_found' ? 404 : e.code === 'bad_request' ? 400 : 409;
      return send(res, code, { error: e.message });
    }
  });

  // Poll for GitHub changes. Opt-out for anyone who wants a board with no
  // outbound network calls at all; on-demand sync still works either way.
  const syncLoop = process.env.WORKBENCH_SYNC === 'off' ? null : sync.startSyncLoop(db, {
    onTick: (result) => {
      if (result.error) return console.error(`[sync] ${result.error}`);
      const n = result.projects.reduce((a, p) => a + (p.imported?.created?.length || 0), 0);
      if (n) console.log(`[sync] imported ${n} issue(s) from GitHub`);
    },
  });

  server.listen(PORT, () => {
    console.log(`workbench → http://localhost:${PORT}  (data: ${process.env.WORKBENCH_DATA || '~/.workbench'})`);
    if (syncLoop) console.log(`[sync] GitHub poll every ${process.env.WORKBENCH_SYNC_INTERVAL_MS || 60000}ms — set WORKBENCH_SYNC=off to disable`);
  });
  server.on('close', () => syncLoop?.stop());
  return server;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}

function readRaw(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
  });
}

// GitHub webhook → board. Issues opened become tasks; issues closed complete them.
function handleGithubEvent(db, event, payload) {
  if (event !== 'issues') return { received: true, event };
  const { action, issue, repository } = payload;
  const repo = repository?.full_name;

  if (action === 'opened') {
    const project = db.prepare('SELECT id FROM projects ORDER BY created_at DESC').get();
    if (!project) return { received: true, note: 'no project to attach' };
    const task = board.createTask(db, {
      project_id: project.id,
      title: issue.title,
      description: `${issue.body || ''}\n\n_From ${repo}#${issue.number}: ${issue.html_url}_`,
      assignee: issue.assignee?.login || null,
      labels: (issue.labels || []).map((l) => l.name),
      priority: (issue.labels || []).some((l) => /priority|critical/i.test(l.name)) ? 3 : 0,
      meta: { github: { repo, number: issue.number, url: issue.html_url } },
    }, 'github');
    return { received: true, created_task: task.id };
  }

  if (action === 'closed') {
    const taskId = github.findTaskByIssue(db, repo, issue.number);
    if (!taskId) return { received: true, note: 'no linked task' };
    board.addTaskComment(db, taskId, 'github', `Issue closed in GitHub: ${issue.html_url}`, true);
    board.moveTask(db, taskId, 'done', { actor: 'github' });
    return { received: true, completed_task: taskId };
  }

  return { received: true, event, action };
}
