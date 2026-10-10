// System-wide constants

// Request and response limits
export const REQUEST_BODY_MAX_BYTES = 1e6; // 1MB
export const DEP_OUTPUT_LIMIT_CHARS = 10 * 1024 * 1024; // 10MB

// Task execution defaults
export const DEFAULT_LEASE_MINUTES = 10;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_TASK_LIMIT = 500;

// Time intervals (milliseconds)
export const LEASE_RENEWAL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
export const WORKER_POLL_DEFAULT_MS = 4000; // 4 seconds
export const SYNC_INTERVAL_DEFAULT_MS = 60_000; // 60 seconds
export const SSE_HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds
export const SSE_CLIENT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Comment limits
export const COMMENT_LIST_DEFAULT_LIMIT = 1000;
