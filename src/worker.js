import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as board from './board.js';
import { complete } from './model.js';

const execFileP = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildPrompt(task) {
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
async function runExec(template, prompt) {
  const shellCmd = template.replaceAll('{prompt}', JSON.stringify(prompt));
  const { stdout, stderr } = await execFileP('/bin/sh', ['-lc', shellCmd], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30 * 60 * 1000, // 30 min hard cap
  });
  return (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).trim() || '(no output)';
}

export async function startWorker(db, {
  agent = 'worker-1',
  pollMs = +(process.env.WORKBENCH_POLL_MS || 4000),
  leaseMinutes = 30,
  exec = process.env.WORKBENCH_WORKER_EXEC || null,
} = {}) {
  console.log(`worker "${agent}" started — exec: ${exec ? exec : 'pooled LLM (free:smart)'}`);

  while (true) {
    let task = null;
    try {
      task = board.nextTask(db, agent, { minutes: leaseMinutes });
    } catch (e) {
      console.error(`[${agent}] pull failed: ${e.message}`);
      await sleep(pollMs);
      continue;
    }

    if (!task || task.empty) {
      await sleep(pollMs);
      continue;
    }

    // Keep the lease alive while working, so a long task isn't re-claimed mid-flight.
    const renew = setInterval(() => {
      try { board.renewLease(db, task.id, agent, leaseMinutes); } catch { /* task may have moved on */ }
    }, 60_000);

    try {
      await board.addTaskComment(db, task.id, agent, `picked up by ${agent}`);
      await board.moveTask(db, task.id, 'doing', { actor: agent });

      let output;
      if (exec) {
        output = await runExec(exec, buildPrompt(task));
      } else {
        const r = await complete(db, { prompt: buildPrompt(task), agent, task_id: task.id });
        output = `${r.text}\n\n(model: ${r.model} via ${r.provider} — ${r.tokens_in}in/${r.tokens_out}out tokens, est. $${r.cost})`;
      }

      await board.addTaskComment(db, task.id, agent, `completed:\n${output}`);
      await board.moveTask(db, task.id, task.requires_review ? 'review' : 'done', { actor: agent });
      console.log(`[${agent}] done: ${task.id} "${task.title}"`);
    } catch (e) {
      await board.addTaskComment(db, task.id, agent, `failed: ${e.message}`).catch(() => {});
      try {
        // moving to failed auto-retries (up to max_retries) or lands in failed
        await board.moveTask(db, task.id, 'failed', { actor: agent });
      } catch { /* already terminal */ }
      console.error(`[${agent}] failed: ${task.id} "${task.title}" — ${e.message}`);
    } finally {
      clearInterval(renew);
    }
  }
}
