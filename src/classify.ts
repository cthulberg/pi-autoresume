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
const TRY_AGAIN_MIN = /try again in ~?(\d+(?:\.\d+)?)\s*min\b/i;

/** R3.4 adds 30s so a reset that lands slightly early is retried safely. */
const TEXT_RESET_BUFFER_MS = 30_000;

/**
 * Refinement 2: hard stops that no amount of waiting can fix. They are
 * checked before every reset and backoff path so limit-like wording in the
 * same message cannot turn them into a resumable verdict.
 */
const NON_RESUMABLE =
  /invalid.?api.?key|unauthorized|forbidden|authentication|auth.?error|billing|insufficient_quota|out of budget|credit/i;

/** R3.5a: one or more "<N unit>" segments following "in", e.g. "2m30s". */
const DURATION_EXPR =
  /in\s+((?:\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours)\s*)+)/i;

/** R3.5a: every duration segment inside the `DURATION_EXPR` capture, summed. */
const DURATION_UNIT = /(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours)/gi;

/** R3.5b: "try again at 3:00 pm" / "resets at 09:30[:SS]". */
const CLOCK_TIME = /(?:try again|resets?)\s+at\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i;

const MS_PER_DAY = 86_400_000;

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
 * Returns `null` for hard stops and for errors that are not limit-like, and
 * `{ kind: "backoff" }` when the turn was limit-like but advertised no usable
 * reset within the horizon.
 */
export function classifyLimit(input: ClassifyInput, now: number): LimitVerdict | null {
  if (input.stopReason !== RESUMABLE_STOP_REASON) return null;

  const errorMessage = input.errorMessage ?? "";

  // Refinement 2: hard stops outrank any reset-looking text or header.
  if (NON_RESUMABLE.test(errorMessage)) return null;

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

  // R3.5a: generic "in 90 seconds" / "in 2m30s" durations.
  const durationResetAt = durationResetAtMs(errorMessage, now);
  if (durationResetAt !== null && withinHorizon(durationResetAt, now)) {
    return { kind: "reset", resetAt: durationResetAt, source: "text" };
  }

  // R3.5b: wall-clock "try again at 3:00 pm" / "resets at 09:30".
  const clockResetAt = clockResetAtMs(errorMessage, now);
  if (clockResetAt !== null) return { kind: "reset", resetAt: clockResetAt, source: "text" };

  // Limit-like but without a usable reset: wait a computed backoff instead.
  if (input.status === 429 || LIMIT_LIKE.test(errorMessage)) return { kind: "backoff" };

  return null;
}

/**
 * R3.5a: sums every duration segment that follows "in" ("2m30s" -> 150 s).
 * Returns `null` when no segment could be parsed.
 */
function durationResetAtMs(errorMessage: string, now: number): number | null {
  const expression = DURATION_EXPR.exec(errorMessage);
  if (!expression) return null;

  let totalMs = 0;
  let matched = false;
  DURATION_UNIT.lastIndex = 0;
  for (
    let match = DURATION_UNIT.exec(expression[1]);
    match !== null;
    match = DURATION_UNIT.exec(expression[1])
  ) {
    totalMs += Number(match[1]) * unitToMs(match[2]);
    matched = true;
  }

  return matched ? now + totalMs : null;
}

/** R3.5b: the next local occurrence of a wall-clock reset time. */
function clockResetAtMs(errorMessage: string, now: number): number | null {
  const clock = CLOCK_TIME.exec(errorMessage);
  if (!clock) return null;

  let hours = Number(clock[1]);
  const minutes = Number(clock[2]);
  const seconds = clock[3] === undefined ? 0 : Number(clock[3]);
  const meridiem = clock[4]?.toLowerCase();

  if (meridiem === "am" && hours === 12) hours = 0;
  else if (meridiem === "pm" && hours !== 12) hours += 12;

  const today = new Date(now);
  let resetAt = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
    hours,
    minutes,
    seconds,
  ).getTime();
  if (resetAt <= now) resetAt += MS_PER_DAY;

  return withinHorizon(resetAt, now) ? resetAt : null;
}

function unitToMs(unit: string): number {
  switch (unit.toLowerCase()) {
    case "ms":
      return 1;
    case "s":
    case "sec":
    case "secs":
    case "seconds":
      return 1_000;
    case "m":
    case "min":
    case "mins":
    case "minutes":
      return 60_000;
    default: // h, hr, hrs, hours
      return 3_600_000;
  }
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
