/** Pure retry/backoff helpers (no IO) so they are trivially testable. */

export interface BackoffConfig { baseMs: number; capMs: number; jitter: number }
export const DEFAULT_BACKOFF: BackoffConfig = { baseMs: 5_000, capMs: 60 * 60_000, jitter: 0.2 };

/**
 * Exponential backoff: base * 2^(attempt-1), capped, with +/- jitter fraction.
 * `attempt` is the number of attempts already made (1 = first failure).
 * `rand` is injectable for deterministic tests.
 */
export function backoffDelay(attempt: number, cfg: BackoffConfig = DEFAULT_BACKOFF, rand: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempt));
  const raw = Math.min(cfg.capMs, cfg.baseMs * 2 ** (n - 1));
  const spread = raw * cfg.jitter;
  const jittered = raw + (rand() * 2 - 1) * spread;
  return Math.max(0, Math.round(Math.min(cfg.capMs, jittered)));
}

/** True when the attempt that just failed was the last permitted one (-> dead letter). */
export function isFinalAttempt(attemptsMade: number, maxAttempts: number): boolean {
  return attemptsMade + 1 >= maxAttempts;
}

/** Idempotency key builder for notification_log.dedupe_key. Stable regardless of part order sensitivity (order is meaningful). */
export function dedupeKey(...parts: (string | number | null | undefined)[]): string {
  return parts.filter((p) => p !== null && p !== undefined && p !== "").map(String).join(":");
}
