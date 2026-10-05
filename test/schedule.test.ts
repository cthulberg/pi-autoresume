import { describe, expect, test } from "bun:test";
import {
  BACKOFF_DELAYS_MS,
  MAX_BACKOFF_ATTEMPTS,
  MAX_CHUNK_MS,
  MAX_RESET_HORIZON_MS,
  MIN_WAIT_MS,
  nextBackoffDelayMs,
  nextChunkDelayMs,
} from "../src/schedule.ts";

const NOW = new Date(2026, 0, 5, 12, 0, 0).getTime();

describe("backoff", () => {
  test("sequence is 5m/15m/30m/1h/2h with max 5 attempts", () => {
    expect(BACKOFF_DELAYS_MS).toEqual([300_000, 900_000, 1_800_000, 3_600_000, 7_200_000]);
    expect(MAX_BACKOFF_ATTEMPTS).toBe(5);
    expect([1, 2, 3, 4, 5].map(nextBackoffDelayMs)).toEqual([
      300_000, 900_000, 1_800_000, 3_600_000, 7_200_000,
    ]);
    expect(nextBackoffDelayMs(6)).toBeUndefined();
    expect(nextBackoffDelayMs(0)).toBeUndefined();
  });
});

describe("chunking", () => {
  test("clamps to [30s, 60min] and tolerates past or huge targets", () => {
    expect(MIN_WAIT_MS).toBe(30_000);
    expect(MAX_CHUNK_MS).toBe(3_600_000);
    expect(MAX_RESET_HORIZON_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(nextChunkDelayMs(NOW, NOW + 5_000)).toBe(30_000);
    expect(nextChunkDelayMs(NOW, NOW)).toBe(30_000);
    expect(nextChunkDelayMs(NOW, NOW - 60_000)).toBe(30_000);
    expect(nextChunkDelayMs(NOW, NOW + 600_000)).toBe(600_000);
    expect(nextChunkDelayMs(NOW, NOW + 2 * 24 * 3_600_000)).toBe(3_600_000);
  });
});
