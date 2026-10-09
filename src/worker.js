import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';
import * as board from './board.js';
import * as git from './git.js';
import * as github from './github.js';
import { complete } from './model.js';

const execFileP = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How much of a dependency's recorded output to feed the next task.
const DEP_OUTPUT_LIMIT = 4000;

// A chained follow-up used to see only "Depends on: t_abc123" — a bare id that
// tells the agent nothing, so it came back with clarifying questions and the
// worker still marked it done. Pull the dependency's actual result instead.
export function depContext(db, ids, { limit = DEP_OUTPUT_LIMIT } = {}) {
  return ids.map((id) => {
    let t;
    try { t = board.getTask(db, id); } catch { return `### Dependency ${id}\n(the task no longer exists)`; }
    const comments = board.listComments(db, id);
    const completed = [...comments].reverse().find((c) => c.body.startsWith('completed:'));
    const output = completed ? completed.body.replace(/^completed:\s*/, '') : '(no output was recorded)';
    const trimmed = output.length > limit
      ? `${output.slice(0, limit)}\n…[truncated, ${output.length - limit} more chars]`
      : output;
    return `### ${t.title} (${t.id}, now ${t.column_name})\n`
      + `${t.description ? `${t.description}\n\n` : ''}${trimmed}`;
  }).join('\n\n');
}

// The acceptance clause has to match the execution mode, or it actively fights
// the agent. In pooled mode there is no filesystem — the text IS the
// deliverable. In exec mode that same instruction is backwards: the agent was
// told the deliverable must be in its final message and not to describe files
// it hadn't written, so it complied by writing a full spec into a comment and
// committing nothing to the repo. Green task, empty repository.
export function buildPrompt(task, deps = '', { mode = 'pooled' } = {}) {
  const parts = [`Task: ${task.title}`];
  if (task.description) parts.push(`\nDescription:\n${task.description}`);
  if (task.labels?.length) parts.push(`\nLabels: ${task.labels.join(', ')}`);
  if (task.deps?.length) {
    parts.push(deps
      ? `\n## Depends on (already completed)\n${deps}`
      : `\nDepends on (already completed): ${task.deps.join(', ')}`);
  }
  // A pooled model asked for a comparison table will fill gaps rather than
  // admit them: it produced a doc recommending GROQ_MODEL=groq-2-turbo, a
  // model that has never existed, and invented an entire "pre-2025 free
  // tier" column the research never covered. Every specific is verifiable,
  // so pin the model to its evidence instead of hoping it self-edits.
  const evidenceRules =
    '\nGround rules: draw only on the evidence above. Where a needed fact is missing, '
    + 'write "not recorded" rather than estimating — a stated gap is useful, a guessed '
    + 'number is worse than none. Keep every source citation from the research verbatim; '
    + 'never invent model names, prices, limits, or dates, and never present a comparison '
    + 'for a column you have no evidence about.';

  if (mode === 'exec') {
    parts.push(
      '\n\nAcceptance: the work described above is complete and committed to this repository. '
      + 'Write the deliverable into real files, then commit them with a message stating what '
      + 'changed and why. Do not push. Your final message lists the files you created or '
      + 'changed and the commit hash — a summary of work that exists on disk, never a '
      + 'substitute for it. If you cannot write a file, say so explicitly instead of '
      + 'describing work you did not do.',
    );
  } else {
    parts.push(
      '\n\nAcceptance: the work described above is complete. Your final message must contain '
      + 'the deliverable itself — do not describe a file or document you did not actually write. '
      + 'Report exactly what you did.',
    );
  }
  parts.push(evidenceRules);
  return parts.join('\n');
}

// WORKBENCH_WORKER_EXEC lets the worker shell out to a real coding agent
// (Claude Code, OpenCode, Aider, ...) instead of doing plain LLM completion.
// {prompt} in the template is replaced with a safely-quoted prompt.

// POSIX single-quoting: the payload arrives byte-for-byte — real newlines stay
// real, and `$`, backticks and quotes can't be interpreted by the shell.
export const shQuote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

// Templates may quote the placeholder (`claude -p "{prompt}"`, as the README
// used to show) or leave it bare (`claude -p {prompt}`). Strip the template's
// own quotes before substituting ours, so quoting never nests.
export function substitutePrompt(template, prompt) {
  const q = shQuote(prompt);
  if (template.includes('"{prompt}"')) return template.replace('"{prompt}"', q);
  if (template.includes("'{prompt}'")) return template.replace("'{prompt}'", q);
  return template.replaceAll('{prompt}', q);
}

// execFile hands the child an open stdin pipe it never closes, so any tool
// that reads stdin — `claude -p` does whenever stdin isn't a TTY — blocks
// forever waiting for EOF, and the worker's 30-min timeout is the only thing
// that would ever end it. Run the command in a subshell with stdin from
// /dev/null; a command's own redirect (or a pipe) still wins.
export function shellCommand(template, prompt) {
  return `(${substitutePrompt(template, prompt)}) < /dev/null`;
}

export async function runExec(template, prompt, { cwd = process.env.WORKBENCH_WORKER_CWD || undefined } = {}) {
  const shellCmd = shellCommand(template, prompt);
  const { stdout, stderr } = await execFileP('/bin/sh', ['-lc', shellCmd], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30 * 60 * 1000, // 30 min hard cap
    cwd, // exec agents complained "the working directory is empty" otherwise
  });
  return (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).trim() || '(no output)';
}

// One pull → work → advance cycle. Exported so the failure path is testable:
// it used to crash the whole worker, which meant auto-retry never ran.
// Returns the task it worked on, or null when the queue is empty.
// Agents emit whatever their --format says. A JSONL event stream is useful
// machine output but catastrophic as a task comment: the first run stored
// 188KB of step_start/tool_use events, which buries the one paragraph a
// reviewer actually needs. Collapse JSONL to its final text message; pass
// anything else through untouched.
export function normalizeAgentOutput(raw) {
  const text = String(raw ?? '').trim();
  if (!text.startsWith('{')) return text;

  const events = text.split('\n').map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  // Only treat it as an event stream if every line parsed — a lone JSON blob
  // (an error body, say) is not one.
  if (events.length !== text.split('\n').filter((l) => l.trim()).length) return text;

  const texts = events
    .filter((e) => e.type === 'text' && typeof e.part?.text === 'string')
    .map((e) => e.part.text);
  if (!texts.length) return text;

  const last = texts[texts.length - 1].trim();
  const cost = events.find((e) => e.type === 'step_finish')?.cost;
  return cost != null ? `${last}\n\n(agent reported est. $${Number(cost).toFixed(4)} of model spend)` : last;
}

// Prepare a worktree for an exec-mode agent. Each task in review gets its own
// branch and worktree cut from origin/main, so the agent's changes are always
// diffable against the base, and two tasks never stomp each other's working tree.
// The return value has .cloneDir (the repo clone) and .dir (the worktree) and
// .base (the branch the worktree was cut from). If the task has no bound repo,
// returns null.
export async function prepareWorktree(project, task) {
  const repo = project.repo;
  if (!repo) return null;

  const reposDir = join(homedir(), '.workbench', 'repos');
  const cloneDir = await git.ensureClone(repo, reposDir);

  const work = await git.createWorktree(cloneDir, task.id, { worktreesDir: join(homedir(), '.workbench', 'worktrees') });
  return { cloneDir, dir: work.dir, base: work.base };
}

// Open a PR for the work the agent just finished. The PR title and body carry
// the task's ID and title so a reviewer can find the originating task without
// chasing comments.
export async function openPullRequest(project, task, work, output) {
  const token = await github.getToken();
  if (!token) return null;

  const body = [
    output || '',
    '',
    `---`,
    `_Workbench task \`${task.id}\` — ${project.repo} — ${project.name || ''}_`,
  ].join('\n');

  // The branch exists only locally until we push it. GitHub will reject the
  // PR (422 `head` invalid) if the ref isn't visible on origin.
  await git.pushBranch(work.dir, git.branchFor(task.id), { token });

  const pr = await github.createPullRequest(token, project.repo, {
    title: task.title,
    body,
    head: git.branchFor(task.id),
    base: project.base || 'main',
  });

  // If the task's merge status changes before a human reviews it, that's
  // visible in the PR itself; we only record that a PR was created.
  return pr;
}

export async function runOnce(db, agent, { exec = null, leaseMinutes = 30, cwd = undefined } = {}) {
  const task = board.nextTask(db, agent, { minutes: leaseMinutes });
  if (!task || task.empty) return null;

  // Hand the agent its predecessors' actual results, not bare task ids.
  const deps = task.deps?.length ? depContext(db, task.deps) : '';

  // Keep the lease alive while working, so a long task isn't re-claimed mid-flight.
  const renew = setInterval(() => {
    try { board.renewLease(db, task.id, agent, leaseMinutes); } catch { /* task may have moved on */ }
  }, 60_000);

  try {
    board.addTaskComment(db, task.id, agent, `picked up by ${agent}`);
    board.moveTask(db, task.id, 'doing', { actor: agent });

    let output;
    let pr = null;
    if (exec) {
      const project = board.getProject(db, task.project_id);
      const work = project.repo ? await prepareWorktree(project, task) : null;

      try {
        output = normalizeAgentOutput(
          await runExec(exec, buildPrompt(task, deps, { mode: 'exec' }), { cwd: work?.dir ?? cwd }),
        );
        // Only raise a PR for repo work. A task with no repo bound, or one the
        // agent ran outside a worktree, has nothing to diff.
        if (work) pr = await openPullRequest(project, task, work, output);
      } finally {
        // Cleanup must not depend on the try block succeeding — a failed agent
        // still leaves a worktree behind, and leaked worktrees accumulate until
        // `git worktree prune` is someone's problem.
        if (work) await git.removeWorktree(work.cloneDir, work.dir).catch(() => {});
      }
    } else {
      const r = await complete(db, { prompt: buildPrompt(task, deps), agent, task_id: task.id });
      output = `${r.text}\n\n(model: ${r.model} via ${r.provider} — ${r.tokens_in}in/${r.tokens_out}out tokens, est. $${r.cost})`;
    }

    board.addTaskComment(db, task.id, agent, `completed:\n${output}`);
    board.moveTask(db, task.id, task.requires_review ? 'review' : 'done', { actor: agent });
    console.log(`[${agent}] done: ${task.id} "${task.title}"${pr ? ` (PR #${pr.number})` : ''}`);
  } catch (e) {
    // addTaskComment is synchronous: this line was `.catch(() => {})`, which threw
    // a TypeError and took down the worker before retry handling could run.
    try { board.addTaskComment(db, task.id, agent, `failed: ${e.message}`); } catch { /* task may be gone */ }
    try {
      // moving to failed auto-retries (up to max_retries) or lands in failed
      board.moveTask(db, task.id, 'failed', { actor: agent });
    } catch { /* already terminal */ }
    console.error(`[${agent}] failed: ${task.id} "${task.title}" — ${e.message}`);
  } finally {
    clearInterval(renew);
  }
  return task;
}

export async function startWorker(db, {
  agent = 'worker-1',
  pollMs = +(process.env.WORKBENCH_POLL_MS || 4000),
  leaseMinutes = 30,
  exec = process.env.WORKBENCH_WORKER_EXEC || null,
  cwd = process.env.WORKBENCH_WORKER_CWD || undefined,
} = {}) {
  console.log(`worker "${agent}" started — exec: ${exec ? exec : 'pooled LLM (free:smart)'}${cwd ? ` (cwd: ${cwd})` : ''}`);

  while (true) {
    let worked = null;
    try {
      worked = await runOnce(db, agent, { exec, leaseMinutes, cwd });
    } catch (e) {
      // A failed pull must not escape — that would kill the loop for good.
      console.error(`[${agent}] pull failed: ${e.message}`);
    }
    if (!worked) await sleep(pollMs);
  }
}
