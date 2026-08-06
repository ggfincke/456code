// packages/client-runtime/src/state/threads/threadRetention.ts
// state across short subscriber gaps without keeping every opened thread alive
export const THREAD_STATE_IDLE_TTL_MS = 5 * 60_000
