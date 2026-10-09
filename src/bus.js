// Tiny pub/sub so the domain layer can fan out events (SSE + webhooks) without knowing about HTTP.
const listeners = new Set();

export function onEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(event, data) {
  for (const fn of listeners) {
    try {
      fn(event, data);
    } catch {
      // listener errors must never break board operations
    }
  }
}
