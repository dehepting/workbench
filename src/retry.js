// Retry logic for GitHub API calls with exponential backoff

import { warn, error } from './logger.js';

const DEFAULT_MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000; // 1 second
const MAX_DELAY_MS = 10000; // 10 seconds
const JITTER_FACTOR = 0.2; // ±20%

/**
 * Determine if an error is retryable
 * @param {Error} err - Error to check
 * @param {Response} response - Fetch response object
 * @returns {boolean} True if error should be retried
 */
function isRetryable(err, response) {
  // Network errors
  if (err && (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND')) {
    return true;
  }

  // No response means network error
  if (!response) {
    return true;
  }

  const status = response.status;

  // Retry on server errors (5xx)
  if (status >= 500) {
    return true;
  }

  // Retry on rate limit (429)
  if (status === 429) {
    return true;
  }

  // Retry on secondary rate limit (403 with specific message)
  if (status === 403) {
    // GitHub sends 403 for secondary rate limits
    return true;
  }

  // Don't retry client errors (4xx except 429)
  return false;
}

/**
 * Get delay before next retry with exponential backoff and jitter
 * @param {number} attempt - Current attempt number (0-indexed)
 * @param {Response} response - Fetch response object (may have Retry-After header)
 * @returns {number} Delay in milliseconds
 */
function getRetryDelay(attempt, response) {
  // Check for Retry-After header
  if (response && response.headers && typeof response.headers.has === 'function' && response.headers.has('Retry-After')) {
    const retryAfter = response.headers.get('Retry-After');
    const retryAfterSeconds = parseInt(retryAfter, 10);
    if (!isNaN(retryAfterSeconds)) {
      return Math.min(retryAfterSeconds * 1000, MAX_DELAY_MS);
    }
  }

  // Exponential backoff: 1s, 2s, 4s, 8s (capped at 10s)
  const exponentialDelay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);

  // Add jitter: ±20%
  const jitter = exponentialDelay * JITTER_FACTOR * (Math.random() * 2 - 1);
  return Math.floor(exponentialDelay + jitter);
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry an async function with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {Object} options - Retry options
 * @param {number} options.maxRetries - Maximum number of retries
 * @param {Object} options.context - Context for logging
 * @returns {Promise<*>} Result of successful function call
 * @throws {Error} Last error if all retries exhausted
 */
export async function withRetry(fn, { maxRetries = DEFAULT_MAX_RETRIES, context = {} } = {}) {
  let lastError;
  let lastResponse;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      lastResponse = err.response; // fetch errors may have response attached

      // Don't retry if this is the last attempt
      if (attempt === maxRetries) {
        break;
      }

      // Check if error is retryable
      if (!isRetryable(err, lastResponse)) {
        warn('Non-retryable error, failing immediately', {
          ...context,
          error: err.message,
          status: lastResponse?.status
        });
        throw err;
      }

      // Calculate delay and log retry
      const delay = getRetryDelay(attempt, lastResponse);
      warn('Retrying after error', {
        ...context,
        attempt: attempt + 1,
        maxRetries,
        delayMs: delay,
        error: err.message,
        status: lastResponse?.status
      });

      await sleep(delay);
    }
  }

  // All retries exhausted
  error('All retries exhausted', {
    ...context,
    attempts: maxRetries + 1,
    lastError: lastError.message,
    status: lastResponse?.status
  });

  throw lastError;
}
