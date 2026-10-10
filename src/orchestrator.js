// Multi-agent orchestrator - manages multiple workers with different roles

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { startWorker } from './worker.js';
import { info, warn, error as logError } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'agents.json');

/**
 * Load agent configuration from agents.json
 */
export function loadAgentConfig() {
  try {
    const content = readFileSync(CONFIG_PATH, 'utf8');
    const config = JSON.parse(content);
    return config.agents || {};
  } catch (e) {
    if (e.code === 'ENOENT') {
      warn('No agents.json found, using default single agent', { path: CONFIG_PATH });
      return {
        'default': {
          description: 'Default worker agent',
          model: 'free:smart',
          exec: null,
          filters: {},
          system_prompt: 'You are an autonomous worker agent. Complete the task and report concisely what you did.',
          max_retries: 3,
          lease_minutes: 30
        }
      };
    }
    logError(e, { context: 'load_agent_config', path: CONFIG_PATH });
    throw e;
  }
}

/**
 * Check if a task matches an agent's filters
 * @param {Object} task - Task object from board.getTask()
 * @param {Object} filters - Agent filter configuration
 * @returns {boolean} True if task matches filters
 */
export function matchesFilters(task, filters = {}) {
  if (!filters || Object.keys(filters).length === 0) return true;

  // Column filter
  if (filters.column && task.column_name !== filters.column) {
    return false;
  }

  // Priority filters
  if (filters.priority_min !== undefined && task.priority < filters.priority_min) {
    return false;
  }
  if (filters.priority_max !== undefined && task.priority > filters.priority_max) {
    return false;
  }

  // Project filter
  if (filters.project_id && task.project_id !== filters.project_id) {
    return false;
  }

  // Label filters (task must have at least ONE of the specified labels)
  if (filters.labels && filters.labels.length > 0) {
    const taskLabels = task.labels || [];
    const hasMatchingLabel = filters.labels.some(filterLabel =>
      taskLabels.includes(filterLabel)
    );
    if (!hasMatchingLabel) {
      return false;
    }
  }

  // Exclude labels (task must NOT have ANY of these labels)
  if (filters.exclude_labels && filters.exclude_labels.length > 0) {
    const taskLabels = task.labels || [];
    const hasExcludedLabel = filters.exclude_labels.some(excludeLabel =>
      taskLabels.includes(excludeLabel)
    );
    if (hasExcludedLabel) {
      return false;
    }
  }

  return true;
}

/**
 * Create a custom nextTask function that respects agent filters
 */
export function createFilteredNextTask(db, agentName, filters) {
  return (originalNextTask) => {
    // Get next task from board
    const task = originalNextTask(db, agentName);

    if (!task || task.empty) {
      return task;
    }

    // Check if it matches our filters
    if (matchesFilters(task, filters)) {
      return task;
    }

    // Task doesn't match filters, release it and try again
    // (In practice, we'd need to track attempts to avoid infinite loops)
    return { empty: true };
  };
}

/**
 * Start all configured agents
 */
export async function startAllAgents(db) {
  const config = loadAgentConfig();
  const agents = Object.entries(config)
    .filter(([_, cfg]) => cfg.enabled !== false)
    .map(([name, cfg]) => ({ name, ...cfg }));

  if (agents.length === 0) {
    warn('No agents configured');
    return [];
  }

  info(`Starting ${agents.length} agents`, {
    agents: agents.map(a => a.name)
  });

  const workers = [];

  for (const agent of agents) {
    const {
      name,
      description,
      model = 'free:smart',
      exec = null,
      filters = {},
      system_prompt,
      max_retries = 3,
      lease_minutes = 30,
      poll_ms = 4000
    } = agent;

    info(`Starting agent: ${name}`, {
      agent: name,
      description,
      model,
      exec: exec ? 'exec mode' : 'pooled mode',
      filters
    });

    // Start worker in background (don't await - they run in parallel)
    const workerPromise = startWorker(db, {
      agent: name,
      pollMs: poll_ms,
      leaseMinutes: lease_minutes,
      exec,
      cwd: process.env.WORKBENCH_WORKER_CWD,
      filters,
      systemPrompt: system_prompt,
    }).catch(err => {
      logError(err, { context: 'worker_crash', agent: name });
    });

    workers.push({
      name,
      description,
      model,
      filters,
      promise: workerPromise
    });
  }

  return workers;
}

/**
 * Start orchestrator with graceful shutdown
 */
export async function startOrchestrator(db) {
  info('Workbench Multi-Agent Orchestrator starting');

  const workers = await startAllAgents(db);

  // Graceful shutdown
  const shutdown = async (signal) => {
    info(`Received ${signal}, shutting down agents...`);
    // Workers will stop on their own when process exits
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  info(`Orchestrator running with ${workers.length} agents`, {
    agents: workers.map(w => w.name)
  });

  // Wait for all workers (they run forever)
  await Promise.all(workers.map(w => w.promise));
}
