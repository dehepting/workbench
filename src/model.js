import * as board from './board.js';
import { chat } from './providers.js';

// One model call, automatically logged to the cost ledger.
// This is the only place agents should be hitting inference from — it keeps
// token/cost accounting honest without every caller remembering to log.
export async function complete(db, {
  prompt,
  agent = 'agent',
  task_id = null,
  model = 'free:smart',
  max_tokens = 2048,
  system = 'You are an autonomous worker agent. Complete the task and report concisely what you did.',
}) {
  if (!prompt?.trim()) {
    const e = new Error('prompt required');
    e.code = 'bad_request';
    throw e;
  }
  const result = await chat([
    { role: 'system', content: system },
    { role: 'user', content: prompt },
  ], { model, max_tokens });

  board.recordRun(db, {
    agent,
    model: result.model,
    tokens_in: result.tokens_in,
    tokens_out: result.tokens_out,
    cost: result.cost,
    task_id,
  });

  return result;
}
