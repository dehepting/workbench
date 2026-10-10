import * as board from './board.js';
import { chat } from './providers.js';
import { FILE_TOOLS, executeTool, formatToolResult } from './tools.js';

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
  tools = null,
  cwd = null,
}) {
  if (!prompt?.trim()) {
    const e = new Error('prompt required');
    e.code = 'bad_request';
    throw e;
  }
  const result = await chat([
    { role: 'system', content: system },
    { role: 'user', content: prompt },
  ], { model, max_tokens, tools });

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

// Agent loop with tool use support - runs until agent says it's done (no more tool calls)
export async function completeWithTools(db, {
  prompt,
  agent = 'agent',
  task_id = null,
  model = 'free:smart',
  max_tokens = 2048,
  system = 'You are an autonomous worker agent. Complete the task and report concisely what you did.',
  tools = FILE_TOOLS,
  cwd = process.cwd(),
  maxTurns = 25,
}) {
  if (!prompt?.trim()) {
    const e = new Error('prompt required');
    e.code = 'bad_request';
    throw e;
  }

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: prompt },
  ];

  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCost = 0;
  let turns = 0;
  let finalText = '';

  while (turns < maxTurns) {
    turns++;

    const result = await chat(messages, { model, max_tokens, tools });

    totalTokensIn += result.tokens_in;
    totalTokensOut += result.tokens_out;
    totalCost += result.cost;

    // Add assistant message to conversation
    messages.push({
      role: 'assistant',
      content: result.text || null,
      tool_calls: result.tool_calls || undefined
    });

    // If no tool calls, agent is done
    if (!result.tool_calls || result.tool_calls.length === 0) {
      finalText = result.text;
      break;
    }

    // Execute tool calls and add results to conversation
    const toolResults = [];
    for (const toolCall of result.tool_calls) {
      const toolName = toolCall.function.name;
      const toolArgs = JSON.parse(toolCall.function.arguments);

      const toolResult = executeTool(toolName, toolArgs, { cwd });
      toolResults.push({
        tool_call_id: toolCall.id,
        role: 'tool',
        name: toolName,
        content: formatToolResult(toolResult)
      });
    }

    // Add tool results to messages
    messages.push(...toolResults);
  }

  // Record aggregated run to ledger
  board.recordRun(db, {
    agent,
    model: `${model} (${turns} turns)`,
    tokens_in: totalTokensIn,
    tokens_out: totalTokensOut,
    cost: totalCost,
    task_id,
  });

  return {
    text: finalText,
    tokens_in: totalTokensIn,
    tokens_out: totalTokensOut,
    model,
    provider: 'pooled-with-tools',
    cost: totalCost,
    turns,
  };
}
