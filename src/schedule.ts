export const BACKOFF_DELAYS_MS: readonly number[] = [
  300_000,
  900_000,
  1_800_000,
  3_600_000,
  7_200_000,
];

export const MAX_BACKOFF_ATTEMPTS: number = 5;

export const MIN_WAIT_MS = 30_000;
export const MAX_CHUNK_MS = 3_600_000;
export const MAX_RESET_HORIZON_MS = 604_800_000;

/**
 * Returns the backoff delay for a 1-based attempt number, or `undefined` once
 * the attempt budget is exhausted.
 */
export function nextBackoffDelayMs(attempt: number): number | undefined {
  if (attempt < 1 || attempt > MAX_BACKOFF_ATTEMPTS) return undefined;
  return BACKOFF_DELAYS_MS[attempt - 1];
}

/**
 * Returns how long to wait before checking again, clamped so a single timer
 * always sleeps between 30s and 60min.
 */
export function nextChunkDelayMs(now: number, targetAt: number): number {
  return Math.min(Math.max(targetAt - now, MIN_WAIT_MS), MAX_CHUNK_MS);
}
