import { describe, expect, test } from "bun:test";
import { classifyLimit, type ClassifyInput, type LimitVerdict } from "../src/classify.ts";

const NOW = new Date(2026, 0, 5, 12, 0, 0).getTime();
const TEXT_RESET_BUFFER_MS = 30_000;
const reset = (msFromNow: number, source: "header" | "text"): LimitVerdict => ({
  kind: "reset",
  resetAt: NOW + msFromNow,
  source,
});

const cases: Array<[string, ClassifyInput, LimitVerdict | null]> = [
  [
    "Codex usage limit adds a 30s buffer",
    { stopReason: "error", errorMessage: "You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min." },
    reset(42 * 60_000 + TEXT_RESET_BUFFER_MS, "text"),
  ],
  [
    "pi's Server requested delay has no buffer",
    { stopReason: "error", errorMessage: "Server requested 300s retry delay (max: 60s). rate limit reached" },
    reset(300_000, "text"),
  ],
  [
    "429 retry-after seconds",
    { stopReason: "error", status: 429, headers: { "retry-after": "120" }, errorMessage: "rate limit reached" },
    reset(120_000, "header"),
  ],
  [
    "429 retry-after-ms",
    { stopReason: "error", status: 429, headers: { "retry-after-ms": "45000" } },
    reset(45_000, "header"),
  ],
  [
    "header wins over text",
    {
      stopReason: "error",
      status: 429,
      headers: { "retry-after-ms": "45000" },
      errorMessage: "Rate limit reached. Please try again in 2m30s.",
    },
    reset(45_000, "header"),
  ],
  [
    "retry-after-ms wins over retry-after",
    { stopReason: "error", status: 429, headers: { "retry-after": "120", "retry-after-ms": "45000" } },
    reset(45_000, "header"),
  ],
  [
    "retry-after HTTP-date",
    { stopReason: "error", status: 429, headers: { "retry-after": new Date(NOW + 90_000).toUTCString() } },
    reset(90_000, "header"),
  ],
  [
    "retry-after HTTP-date in the past keeps the past timestamp",
    { stopReason: "error", status: 429, headers: { "retry-after": new Date(NOW - 60_000).toUTCString() } },
    reset(-60_000, "header"),
  ],
  [
    "R4 gate: stray header on unrelated error is ignored",
    { stopReason: "error", status: 500, headers: { "retry-after": "120" }, errorMessage: "internal server error" },
    null,
  ],
  [
    "R4 gate: limit-like text allows the header",
    { stopReason: "error", status: 500, headers: { "retry-after": "120" }, errorMessage: "overloaded" },
    reset(120_000, "header"),
  ],
  ["aborted never resumes", { stopReason: "aborted", errorMessage: "rate limit reached" }, null],
  ["header names are case-insensitive", { stopReason: "error", status: 429, headers: { "Retry-After": "60" } }, reset(60_000, "header")],
  ["non-error stop reason is ignored even with headers", { stopReason: "stop", status: 429, headers: { "retry-after": "60" } }, null],
];

describe("classifyLimit: reset extraction", () => {
  test.each(cases)("%s", (_name, input, expected) => {
    expect(classifyLimit(input, NOW)).toEqual(expected);
  });
});
