// Centralized error handling utilities

import { error as logError } from './logger.js';

/**
 * Base error class for board operations
 */
export class BoardError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = 'BoardError';
    this.context = context;
  }
}

/**
 * Validation error with field context
 */
export class ValidationError extends BoardError {
  constructor(message, field = null) {
    super(message, { field });
    this.name = 'ValidationError';
    this.field = field;
  }
}

/**
 * Resource not found error
 */
export class NotFoundError extends BoardError {
  constructor(resource, id) {
    super(`${resource} not found: ${id}`, { resource, id });
    this.name = 'NotFoundError';
    this.resource = resource;
    this.id = id;
  }
}

/**
 * Conflict error (e.g., concurrent updates)
 */
export class ConflictError extends BoardError {
  constructor(message, context = {}) {
    super(message, context);
    this.name = 'ConflictError';
  }
}

/**
 * Safe JSON parsing with fallback
 * @param {string} str - JSON string to parse
 * @param {*} fallback - Fallback value if parsing fails
 * @returns {*} Parsed object or fallback
 */
export function parseJsonSafe(str, fallback = {}) {
  try {
    return JSON.parse(str);
  } catch (e) {
    return fallback;
  }
}

/**
 * Wraps an async function with error context enrichment
 * @param {Function} fn - Async function to wrap
 * @param {Object} context - Context to add to errors
 * @returns {Function} Wrapped function
 */
export function withErrorContext(fn, context) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof BoardError) {
        err.context = { ...err.context, ...context };
        throw err;
      }
      throw new BoardError(err.message, { ...context, originalError: err.name });
    }
  };
}

/**
 * Fire-and-forget promise execution with error logging
 * Useful for non-critical operations that shouldn't block
 * @param {Promise} promise - Promise to execute
 * @param {Object} context - Context for error logging
 */
export function fireAndForget(promise, context = {}) {
  promise.catch(err => {
    logError(err, {
      type: 'fire_and_forget',
      ...context
    });
  });
}
