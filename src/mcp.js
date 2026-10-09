import readline from 'node:readline';
import * as board from './board.js';
import * as model from './model.js';
import * as github from './github.js';
import * as sync from './sync.js';
import { providerHealth } from './providers.js';

const TOOLS = [
  { name: 'wb_list_projects', description: 'List all projects', inputSchema: { type: 'object', properties: {} } },
  { name: 'wb_create_project', description: 'Create a project', inputSchema: { type: 'object', properties: { name: { type: 'string' }, client_view: { type: 'boolean' } }, required: ['name'] } },
  { name: 'wb_get_project', description: 'Get a project with all its tasks and WIP limits', inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] } },
  { name: 'wb_set_wip_limit', description: 'Set a WIP (work-in-progress) limit on a column', inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, column: { type: 'string', enum: board.COLUMNS }, limit: { type: 'integer' } }, required: ['project_id', 'column', 'limit'] } },
  { name: 'wb_list_tasks', description: 'List tasks, optionally filtered by project/column/assignee/label', inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, column: { type: 'string', enum: board.COLUMNS }, assignee: { type: 'string' }, label: { type: 'string' } } } },
  { name: 'wb_create_task', description: 'Create a task. Supports labels, deps (DAG), next_task_title (auto-chaining), requires_review, max_retries', inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, assignee: { type: 'string' }, priority: { type: 'integer' }, labels: { type: 'array', items: { type: 'string' } }, deps: { type: 'array', items: { type: 'string' } }, next_task_title: { type: 'string' }, requires_review: { type: 'boolean' }, max_retries: { type: 'integer' } }, required: ['project_id', 'title'] } },
  { name: 'wb_get_task', description: 'Get a task with its full comment thread', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } },
  { name: 'wb_update_task', description: 'Update task fields (title, assignee, priority, labels, deps, etc.)', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, assignee: { type: 'string' }, priority: { type: 'integer' }, labels: { type: 'array', items: { type: 'string' } }, deps: { type: 'array', items: { type: 'string' } }, next_task_title: { type: 'string' }, requires_review: { type: 'boolean' }, max_retries: { type: 'integer' } }, required: ['task_id'] } },
  { name: 'wb_move_task', description: 'Move a task between columns: backlog → todo → doing → review → done. Moving to failed auto-retries. Gates: deps must be done before doing; requires_review tasks must pass through review; WIP limits enforced', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, column: { type: 'string', enum: board.COLUMNS }, force: { type: 'boolean', description: 'Bypass gates (WIP, deps, review) — use sparingly' }, actor: { type: 'string' } }, required: ['task_id', 'column'] } },
  { name: 'wb_claim_task', description: 'Claim a task with a time-limited lease (default 10 min). Fails if another agent holds an unexpired lease', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, agent: { type: 'string' }, minutes: { type: 'number' } }, required: ['task_id', 'agent'] } },
  { name: 'wb_release_task', description: 'Release a task lease (e.g. when work is abandoned or handed off)', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, agent: { type: 'string' } }, required: ['task_id', 'agent'] } },
  { name: 'wb_next_task', description: 'Atomically pull and claim the highest-priority unblocked task. This is how agents grab work without collisions', inputSchema: { type: 'object', properties: { agent: { type: 'string' }, project_id: { type: 'string' }, minutes: { type: 'number' } }, required: ['agent'] } },
  { name: 'wb_delete_task', description: 'Delete a task. Refused while other tasks depend on it', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, actor: { type: 'string' } }, required: ['task_id'] } },
  { name: 'wb_add_comment', description: 'Add a comment to a task (progress notes, handoffs, failures)', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, author: { type: 'string' }, body: { type: 'string' } }, required: ['task_id', 'author', 'body'] } },
  { name: 'wb_renew_lease', description: 'Extend a task lease you already hold (keeps long work from being re-claimed)', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, agent: { type: 'string' }, minutes: { type: 'number' } }, required: ['task_id', 'agent'] } },
  { name: 'wb_providers', description: 'Health of the pooled inference providers (configured, tier, latency, failures) — keys are never exposed', inputSchema: { type: 'object', properties: {} } },
  { name: 'wb_complete', description: 'Run a prompt through the pooled free-tier providers and log it to the cost ledger. Model aliases: free:smart, free:fast, free:cheap, free:a, free:s — or an explicit provider/model like groq/llama-3.3-70b-versatile', inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, model: { type: 'string' }, agent: { type: 'string' }, task_id: { type: 'string' }, max_tokens: { type: 'integer' } }, required: ['prompt'] } },
  { name: 'wb_github_status', description: 'GitHub connection status (via gh CLI auth or macOS Keychain token)', inputSchema: { type: 'object', properties: {} } },
  { name: 'wb_github_repos', description: 'Repos this token can see, plus the one the working directory points at — pick from these instead of typing owner/repo', inputSchema: { type: 'object', properties: {} } },
  { name: 'wb_github_sync', description: 'Two-way sync: pull open issues into a bound project as backlog tasks, complete/requeue tasks from issue state, push task comments back as issue comments', inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: [] } },
  { name: 'wb_project_bind_repo', description: 'Bind a project to a GitHub repo (owner/repo). Issues on that repo become tasks; done tasks close them. Pass repo: null to unbind', inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, repo: { type: ['string', 'null'] } }, required: ['project_id'] } },
  { name: 'wb_github_link_task', description: 'Create a GitHub issue for a task and link it bidirectionally (task card shows the issue, issue gets a link back)', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, repo: { type: 'string', description: 'owner/repo, e.g. dehepting/workbench' }, labels: { type: 'array', items: { type: 'string' } } }, required: ['task_id', 'repo'] } },
  { name: 'wb_stats', description: 'Flow metrics: throughput/day, WIP, median cycle time, slowest tasks, created-vs-finished per day', inputSchema: { type: 'object', properties: {} } },
  { name: 'wb_record_run', description: 'Record an agent run to the cost ledger (agent, model, tokens in/out; cost auto-estimated if omitted)', inputSchema: { type: 'object', properties: { agent: { type: 'string' }, model: { type: 'string' }, tokens_in: { type: 'integer' }, tokens_out: { type: 'integer' }, cost: { type: 'number' }, task_id: { type: 'string' } }, required: ['agent'] } },
  { name: 'wb_ledger', description: 'Spend ledger: totals, per-agent and per-model breakdowns, recent runs', inputSchema: { type: 'object', properties: {} } },
  { name: 'wb_audit', description: 'Recent audit trail (who did what, when)', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } }, required: [] } },
];

async function dispatch(name, args, db) {
  switch (name) {
    case 'wb_list_projects': return board.listProjects(db);
    case 'wb_create_project': return board.createProject(db, args.name, { clientView: args.client_view });
    case 'wb_get_project': return board.getProject(db, args.project_id);
    case 'wb_set_wip_limit': return board.setWipLimit(db, args.project_id, args.column, args.limit);
    case 'wb_list_tasks': return board.listTasks(db, args);
    case 'wb_create_task': return board.createTask(db, args, args.actor || 'mcp');
    case 'wb_get_task': return { ...board.getTask(db, args.task_id), comments: board.listComments(db, args.task_id) };
    case 'wb_update_task': { const { task_id, ...patch } = args; return board.updateTask(db, task_id, patch, args.actor || 'mcp'); }
    case 'wb_move_task': return board.moveTask(db, args.task_id, args.column, { actor: args.actor || 'mcp', force: !!args.force });
    case 'wb_claim_task': return board.claimTask(db, args.task_id, args.agent, args.minutes ?? 10);
    case 'wb_release_task': return board.releaseTask(db, args.task_id, args.agent);
    case 'wb_renew_lease': return board.renewLease(db, args.task_id, args.agent, args.minutes ?? 10);
    case 'wb_next_task': return board.nextTask(db, args.agent, args) ?? { empty: true };
    case 'wb_delete_task': return board.deleteTask(db, args.task_id, args.actor || 'mcp');
    case 'wb_add_comment': return board.addTaskComment(db, args.task_id, args.author, args.body);
    case 'wb_providers': return { providers: providerHealth() };
    case 'wb_github_status': return github.githubStatus();
    case 'wb_github_repos': {
      const token = await github.getToken();
      if (!token) return { connected: false, repos: [] };
      const [repos, detected] = await Promise.all([
        github.listRepos(token).catch(() => []),
        github.detectRepo(),
      ]);
      return { connected: true, detected, repos };
    }
    case 'wb_github_sync': {
      if (!args.project_id) return sync.syncAll(db);
      return sync.syncProject(db, args.project_id);
    }
    case 'wb_project_bind_repo': {
      const project = board.bindProjectRepo(db, args.project_id, args.repo ?? null);
      return { project_id: project.id, name: project.name, repo: project.repo };
    }
    case 'wb_github_link_task': {
      const token = await github.getToken();
      if (!token) throw new Error('GitHub not connected — run `gh auth login` or POST a token to /api/github/setup');
      const t = board.getTask(db, args.task_id);
      if (!args.repo?.includes('/')) throw new Error('repo must be owner/repo');
      const issue = await github.createIssue(token, args.repo, {
        title: t.title,
        body: `${t.description || ''}\n\n_Workbench task ${t.id} — track it at http://localhost:4173_`,
        labels: args.labels || t.labels || [],
      });
      const linked = board.linkGithub(db, t.id, args.repo, issue.number, issue.html_url);
      await github.commentIssue(token, args.repo, issue.number, `Linked to Workbench task \`${t.id}\``);
      return linked;
    }
    case 'wb_complete': { const { prompt, ...rest } = args; return model.complete(db, { prompt, ...rest }); }
    case 'wb_stats': return board.flowStats(db);
    case 'wb_record_run': return board.recordRun(db, args);
    case 'wb_ledger': return board.ledgerSummary(db);
    case 'wb_audit': return board.auditTrail(db, args.limit || 100);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

export function startMcp(db) {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  const rpcError = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');

  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const { id, method, params } = msg;
    try {
      switch (method) {
        case 'initialize':
          reply(id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'workbench', version: '0.1.0' } });
          break;
        case 'notifications/initialized':
          break;
        case 'ping':
          reply(id, {});
          break;
        case 'tools/list':
          reply(id, { tools: TOOLS });
          break;
        case 'tools/call': {
          const result = await dispatch(params.name, params.arguments || {}, db);
          reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
          break;
        }
        default:
          if (id != null) rpcError(id, -32601, `Method not found: ${method}`);
      }
    } catch (e) {
      if (id != null) reply(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
    }
  });
}
