import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as board from './board.js';
import { complete } from './model.js';

const execFileP = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function buildPrompt(task) {
  const parts = [`Task: ${task.title}`];
  if (task.description) parts.push(`\nDescription:\n${task.description}`);
  if (task.labels?.length) parts.push(`\nLabels: ${task.labels.join(', ')}`);
  if (task.deps?.length) parts.push(`\nDepends on (already completed): ${task.deps.join(', ')}`);
  parts.push('\n\nAcceptance: the work described above is complete. Report exactly what you did.');
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

export async function runExec(template, prompt) {
  const shellCmd = shellCommand(template, prompt);
  const { stdout, stderr } = await execFileP('/bin/sh', ['-lc', shellCmd], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30 * 60 * 1000, // 30 min hard cap
  });
  return (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).trim() || '(no output)';
}

// One pull → work → advance cycle. Exported so the failure path is testable:
// it used to crash the whole worker, which meant auto-retry never ran.
// Returns the task it worked on, or null when the queue is empty.
export async function runOnce(db, agent, { exec = null, leaseMinutes = 30 } = {}) {
  const task = board.nextTask(db, agent, { minutes: leaseMinutes });
  if (!task || task.empty) return null;

  // Keep the lease alive while working, so a long task isn't re-claimed mid-flight.
  const renew = setInterval(() => {
    try { board.renewLease(db, task.id, agent, leaseMinutes); } catch { /* task may have moved on */ }
  }, 60_000);

  try {
    board.addTaskComment(db, task.id, agent, `picked up by ${agent}`);
    board.moveTask(db, task.id, 'doing', { actor: agent });

    let output;
    if (exec) {
      output = await runExec(exec, buildPrompt(task));
    } else {
      const r = await complete(db, { prompt: buildPrompt(task), agent, task_id: task.id });
      output = `${r.text}\n\n(model: ${r.model} via ${r.provider} — ${r.tokens_in}in/${r.tokens_out}out tokens, est. $${r.cost})`;
    }

    board.addTaskComment(db, task.id, agent, `completed:\n${output}`);
    board.moveTask(db, task.id, task.requires_review ? 'review' : 'done', { actor: agent });
    console.log(`[${agent}] done: ${task.id} "${task.title}"`);
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
} = {}) {
  console.log(`worker "${agent}" started — exec: ${exec ? exec : 'pooled LLM (free:smart)'}`);

  while (true) {
    let worked = null;
    try {
      worked = await runOnce(db, agent, { exec, leaseMinutes });
    } catch (e) {
      // A failed pull must not escape — that would kill the loop for good.
      console.error(`[${agent}] pull failed: ${e.message}`);
    }
    if (!worked) await sleep(pollMs);
  }
}
