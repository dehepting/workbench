// Structured logging utilities

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

const currentLevel = LOG_LEVELS[process.env.WORKBENCH_LOG_LEVEL] ?? LOG_LEVELS.info;
const format = process.env.WORKBENCH_LOG_FORMAT || 'human'; // 'json' or 'human'

function shouldLog(level) {
  return LOG_LEVELS[level] >= currentLevel;
}

function formatLog(level, message, context = {}) {
  const timestamp = new Date().toISOString();

  if (format === 'json') {
    return JSON.stringify({
      timestamp,
      level,
      message,
      ...context
    });
  }

  // Human-readable format
  const contextStr = Object.keys(context).length > 0
    ? ' ' + JSON.stringify(context)
    : '';
  return `[${timestamp}] ${level.toUpperCase()}: ${message}${contextStr}`;
}

export function debug(message, context) {
  if (shouldLog('debug')) {
    console.log(formatLog('debug', message, context));
  }
}

export function info(message, context) {
  if (shouldLog('info')) {
    console.log(formatLog('info', message, context));
  }
}

export function warn(message, context) {
  if (shouldLog('warn')) {
    console.warn(formatLog('warn', message, context));
  }
}

export function error(message, context) {
  if (shouldLog('error')) {
    console.error(formatLog('error', message, context));
  }
}

// Specialized logging helpers

export function logTaskEvent(event, taskId, details = {}) {
  info(`Task ${event}`, { taskId, ...details });
}

export function logGithubEvent(event, details = {}) {
  info(`GitHub ${event}`, details);
}

export function logWorkerEvent(event, details = {}) {
  info(`Worker ${event}`, details);
}

export function logError(err, context = {}) {
  error(err.message, {
    error: err.name,
    stack: err.stack,
    ...context
  });
}
