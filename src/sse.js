import { openStore } from './store.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SSE_HEARTBEAT_INTERVAL_MS } from './constants.js';

const db = openStore(process.env.WORKBENCH_DATA || join(homedir(), '.workbench'));

// SSE client registry: taskId -> Set of response objects
const clients = new Map();

export function addClient(taskId, res) {
  if (!clients.has(taskId)) clients.set(taskId, new Set());
  clients.get(taskId).add(res);
  // Send current state immediately
  sendCurrentState(taskId, res);
}

export function removeClient(taskId, res) {
  const set = clients.get(taskId);
  if (set) {
    set.delete(res);
    // Clean up empty map entries
    if (set.size === 0) {
      clients.delete(taskId);
    }
  }
}

function sendCurrentState(taskId, res) {
  const task = getTask(taskId);
  if (task) {
    res.write(`data: ${JSON.stringify({ type: 'state', payload: task })}\n\n`);
  }
}

function getTask(taskId) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
}

// Called by worker when task state changes
export function broadcast(taskId, event) {
  const set = clients.get(taskId);
  if (set) {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of set) {
      // Check connection state before writing
      if (res.destroyed || res.writableEnded) {
        set.delete(res);
        continue;
      }
      try {
        res.write(data);
      } catch (e) {
        set.delete(res);
      }
    }
    // Clean up empty map entries
    if (set.size === 0) {
      clients.delete(taskId);
    }
  }
}

// SSE handler for Express/connect
export function sseHandler(req, res, taskId) {
  if (!taskId) {
    res.statusCode = 400;
    res.end('taskId required');
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  addClient(taskId, res);

  // Heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    // Check connection state before writing
    if (res.destroyed || res.writableEnded) {
      clearInterval(heartbeat);
      return;
    }
    try {
      res.write(': heartbeat\n\n');
    } catch (e) {
      clearInterval(heartbeat);
    }
  }, SSE_HEARTBEAT_INTERVAL_MS);

  // Cleanup on all termination paths
  const cleanup = () => {
    clearInterval(heartbeat);
    removeClient(taskId, res);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);
  res.on('finish', cleanup);
}
