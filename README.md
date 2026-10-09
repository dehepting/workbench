# Workbench

A production task board for agentic software factories. Zero dependencies (Node stdlib + SQLite), MCP-native, built so fleets of cheap agents can share one board without collisions.

## What it does

- **Kanban board** — `backlog → todo → doing → review → done` (+ `failed` with auto-retry)
- **DAG dependencies** — tasks can't start `doing` until their deps are `done`; cycle detection on create/update
- **WIP limits** — per-project, per-column caps (configurable via API/MCP)
- **Lease claims** — agents atomically claim tasks with time-limited leases; expired leases are reclaimable, so a crashed agent never wedges a task
- **Quality gates** — `requires_review` tasks must pass through `review` before `done`
- **Auto-retry** — moving a task to `failed` bounces it back to `todo` up to `max_retries`
- **Task chaining** — completing a task can auto-create a follow-up
- **Audit trail** — every mutation logged (who, what, when)
- **Cost ledger** — per-run token/cost accounting with per-agent and per-model breakdowns
- **Flow metrics** — throughput/day, median cycle time, created-vs-finished, slowest tasks
- **Live dashboard** — real-time UI over SSE at `http://localhost:3000`
- **Inference pooling** — 15 free/cheap OpenAI-compatible providers, automatic fallback on rate limits (`free:smart` / `free:fast` / `free:cheap` aliases)
- **Worker mode** — autonomous agent loop: pull a task, execute (LLM or shell out to a coding agent), verify, advance the board, log cost
- **MCP server** — 21 tools so any MCP client (OpenCode, Claude Code, etc.) can drive the board
- **Webhooks** — signed outbound events on every board change

## Quickstart

```bash
cd ~/workbench
cp .env.example .env     # fill in any subset of provider keys (optional but recommended)
PORT=4173 npm start      # dashboard (port 3000 is often taken)
```

Open http://localhost:4173, create a project, add tasks.

## Inference pooling

The router (`src/providers.js`) pools every provider key found in `.env`/env vars and
falls back automatically when one rate-limits (429), runs out of credits (402), or
errors (5xx). Model aliases:

| Alias | Behavior |
|---|---|
| `free:smart` (default) | Best available tier (A→B→C), then lowest measured latency |
| `free:fast` | Lowest rolling latency |
| `free:cheap` | Provider with fewest recent failures |
| `free:a` / `free:s` | Lock to tier A / tier B |
| `groq/llama-3.3-70b-versatile` | Explicit provider + model |

Providers that fail 3 requests in a row get a 60s cooldown. The dashboard's
**⚡ Providers** panel shows health — keys are never displayed or stored.

## Worker mode

An autonomous agent loop. Pull a task atomically, execute, advance the board:

```bash
# plain LLM worker (pooled free tiers, cost logged automatically)
node bin/workbench.js --worker coder-1

# shell out to a real coding agent instead
WORKBENCH_WORKER_EXEC='claude -p "{prompt}"' node bin/workbench.js --worker coder-1
```

The worker: `wb_next_task` → comment "picked up" → move to `doing` → execute →
comment output → move to `review` (if `requires_review`) or `done` → on failure,
move to `failed` (auto-retry applies). Leases auto-renew every 60s while working.

## GitHub sync

Tasks and GitHub issues stay in lockstep. Auth uses your existing
`gh` login if present, otherwise a token stored in the macOS
Keychain (the dashboard prompts on first use — tokens never touch
the DB, `.env`, or logs).

- **Task → issue**: `POST /api/tasks/:id/github {repo}` creates the
  issue, links it on the task card, and comments back on the issue
- **Issue → task**: configure a webhook (GitHub → repo settings →
  webhooks → `http://your-host:4173/api/github/webhook`, secret in
  `GITHUB_WEBHOOK_SECRET`); issues opened become board tasks,
  issues closed complete them
- MCP: `wb_github_status`, `wb_github_link_task`

Inbound webhooks from GitHub need a reachable host (a tunnel like
`cloudflared tunnel --url http://localhost:4173` works for local
development).

## MCP setup

Workbench speaks the Model Context Protocol over stdio. The V2 config format
puts servers under `mcp.servers` — global config lives at
`~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "workbench": {
        "type": "local",
        "command": ["node", "/Users/davidhepting/workbench/bin/workbench.js", "--mcp"],
        "cwd": "/Users/davidhepting/workbench"
      }
    }
  }
}
```

`cwd` matters: the MCP server loads `.env` from that directory, so provider
keys you put in `~/workbench/.env` are available to `wb_complete` calls made
from the chat. Both the dashboard server and the MCP server default to the
same DB (`~/.workbench`), so the board stays in sync. If you run the server
with a custom `WORKBENCH_DATA`, mirror it in an `"environment"` block.

Or add it with the CLI (writes to your project config):

```bash
opencode2 mcp add workbench -- node ~/workbench/bin/workbench.js --mcp
```

**Claude Code** (`.mcp.json`) uses the flat format instead:

```json
{
  "mcpServers": {
    "workbench": {
      "command": "node",
      "args": ["/Users/davidhepting/workbench/bin/workbench.js", "--mcp"]
    }
  }
}
```

## Agent loop (the intended pattern)

```js
// 1. pull work atomically — no two agents get the same task
const task = await wb('wb_next_task', { agent: 'coder-1' });

// 2. do the work, then comment progress
await wb('wb_add_comment', { task_id: task.id, author: 'coder-1', body: 'implemented, tests pass' });

// 3. advance the board — gates enforce your process
await wb('wb_move_task', { task_id: task.id, column: 'doing', actor: 'coder-1' });
// ... later
await wb('wb_move_task', { task_id: task.id, column: 'review', actor: 'coder-1' });

// 4. log the cost
await wb('wb_record_run', { agent: 'coder-1', model: 'groq/llama-3.3-70b', tokens_in: 4200, tokens_out: 9000, task_id: task.id });
```

## API cheat sheet

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/api/projects` | list / create |
| GET | `/api/projects/:id` | project + tasks + WIP limits |
| PUT | `/api/projects/:id/wip` | set WIP limit `{column, limit}` |
| GET/POST | `/api/tasks` | list (filters: `project_id`, `column`, `assignee`, `label`) / create |
| POST | `/api/tasks/next` | atomic pull+claim `{agent}` |
| GET/PATCH/DELETE | `/api/tasks/:id` | fetch / update / delete |
| POST | `/api/tasks/:id/move` | move `{column, force?, actor?}` |
| POST | `/api/tasks/:id/claim` | claim lease `{agent, minutes?}` |
| POST | `/api/tasks/:id/release` | release lease `{agent}` |
| GET/POST | `/api/tasks/:id/comments` | comments |
| POST | `/api/runs` | record a run (tokens/cost) |
| GET | `/api/ledger` | spend breakdown |
| GET | `/api/providers` | inference provider health (keys never exposed) |
| GET | `/api/stats` | flow metrics |
| GET | `/api/audit` | audit trail |
| GET | `/events` | SSE stream |

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | dashboard port |
| `WORKBENCH_DATA` | `~/.workbench` | DB directory |
| `WORKBENCH_API_KEY` | — | require Bearer auth on `/api/*` |
| `WORKBENCH_WEBHOOK_URL` | — | outbound webhook on events |
| `WORKBENCH_WEBHOOK_SECRET` | — | HMAC-SHA256 signing secret (`X-Workbench-Signature`) |
| `WORKBENCH_WORKER_EXEC` | — | worker command template (`{prompt}` placeholder) |
| `WORKBENCH_AGENT` | `worker-1` | default worker agent name |
| `WORKBENCH_POLL_MS` | `4000` | worker idle poll interval |

## Tests

```bash
npm test        # zero dependencies — node's built-in test runner
```

Covers the dashboard script (a single unbalanced brace once made every click
in the UI a no-op), the board's gates (DAG deps, WIP limits, review gate,
leases, auto-retry, chaining), the cost ledger's price resolution, SSE, and the
worker's shell-quoting. CI runs the same suite plus a compile of the menu-bar
app on every push (`.github/workflows/ci.yml`).

## Roadmap

- [ ] Per-agent API keys with roles
- [ ] Recurring/scheduled tasks (cron)
- [ ] Optional Postgres backend for multi-machine fleets
- [ ] Agent registry UI (names, models, concurrency — non-secret config only)

MIT
