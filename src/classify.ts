import { MAX_RESET_HORIZON_MS } from "./schedule.ts";

/** A turn can only have been cut short by a provider limit when it errored. */
const RESUMABLE_STOP_REASON = "error";

/**
 * The R4 gate: a retry header is only trusted when the status or the error
 * text makes it plausible that this was a provider limit rather than some
 * unrelated failure that happened to carry a retry header.
 */
const LIMIT_LIKE =
  /usage.?limit|rate.?limit|too many requests|\b429\b|resource.?exhausted|overloaded|quota/i;

/** R3.3: pi's own retry notice, already in seconds and needing no buffer. */
const SERVER_DELAY = /server requested (\d+(?:\.\d+)?)s retry delay/i;

/** R3.4: Codex-style "Try again in ~42 min", rounded down by the provider. */
const TRY_AGAIN_MIN = /try again in ~?(\d+(?:\.\d+)?)\s*min/i;

/** R3.4 adds 30s so a reset that lands slightly early is retried safely. */
const TEXT_RESET_BUFFER_MS = 30_000;

const RETRY_AFTER_MS_HEADER = "retry-after-ms";
const RETRY_AFTER_HEADER = "retry-after";
const SECONDS_PATTERN = /^\d+(?:\.\d+)?$/;

export interface ClassifyInput {
  errorMessage?: string;
  headers?: Record<string, string>;
  status?: number;
  stopReason?: string;
}

export type ResetSource = "header" | "text";

export type LimitVerdict =
  | { kind: "reset"; resetAt: number; source: ResetSource }
  | { kind: "backoff" };

/**
 * Classifies a finished turn as a provider limit with a known reset time.
 *
 * Returns `null` when the input does not describe a limit, which is also the
 * current placeholder for the paths that are not implemented yet.
 */
export function classifyLimit(input: ClassifyInput, now: number): LimitVerdict | null {
  if (input.stopReason !== RESUMABLE_STOP_REASON) return null;

  const errorMessage = input.errorMessage ?? "";

  // R4: headers are only trusted for 429s or limit-like error text.
  if (input.status === 429 || LIMIT_LIKE.test(errorMessage)) {
    const headerResetAt = headerResetAtMs(input.headers, now);
    if (headerResetAt !== null && withinHorizon(headerResetAt, now)) {
      return { kind: "reset", resetAt: headerResetAt, source: "header" };
    }
  }

  const serverDelay = SERVER_DELAY.exec(errorMessage);
  if (serverDelay) {
    const resetAt = now + Number(serverDelay[1]) * 1000;
    if (withinHorizon(resetAt, now)) return { kind: "reset", resetAt, source: "text" };
  }

  const tryAgainMin = TRY_AGAIN_MIN.exec(errorMessage);
  if (tryAgainMin) {
    const resetAt = now + Number(tryAgainMin[1]) * 60_000 + TEXT_RESET_BUFFER_MS;
    if (withinHorizon(resetAt, now)) return { kind: "reset", resetAt, source: "text" };
  }

  return null;
}

function withinHorizon(resetAt: number, now: number): boolean {
  return resetAt - now <= MAX_RESET_HORIZON_MS;
}

/** Case-insensitive lookup; header names are matched on their lowercase form. */
function getHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

/**
 * Resolves the reset time advertised by the retry headers, if any. A relative
 * `retry-after-ms` wins over a `retry-after` that is either absolute seconds or
 * an HTTP-date; an unparseable header contributes nothing.
 */
function headerResetAtMs(headers: Record<string, string> | undefined, now: number): number | null {
  const retryAfterMs = getHeader(headers, RETRY_AFTER_MS_HEADER);
  if (retryAfterMs !== undefined && retryAfterMs.trim() !== "") {
    const ms = Number(retryAfterMs);
    if (Number.isFinite(ms)) return now + ms;
  }

  const retryAfter = getHeader(headers, RETRY_AFTER_HEADER);
  if (retryAfter !== undefined) {
    const value = retryAfter.trim();
    if (SECONDS_PATTERN.test(value)) return now + Number(value) * 1000;
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }

  return null;
}
