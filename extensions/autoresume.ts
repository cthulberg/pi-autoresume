import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

import {
  classifyLimit,
  streamResetAt,
  type ClassifyInput,
  type LimitVerdict,
  type ResetSource,
} from "../src/classify.ts";
import { formatClock, formatDuration, renderTemplate } from "../src/format.ts";
import {
  MAX_BACKOFF_ATTEMPTS,
  nextBackoffDelayMs,
  nextChunkDelayMs,
} from "../src/schedule.ts";

/** Footer slot and custom-message type owned by this extension. */
const STATUS_KEY = "autoresume";
const CUSTOM_TYPE = "autoresume";

/** R10: while a wait is armed the footer countdown is refreshed every minute. */
const FOOTER_REFRESH_MS = 60_000;

/** R11: English defaults, overridable through the `autoresume.templates` setting. */
const DEFAULT_TEMPLATES = {
  waiting: "◦ limit hit · resume {reset_abs} · [autoresume]",
  waiting_backoff: "◦ limit hit · retry in {retry_in} · [autoresume {attempt}/{max}]",
  resuming: "▶ resuming after limit reset",
  exhausted: "■ autoresume stopped · {max} attempts exhausted",
} as const;

type TemplateKey = keyof typeof DEFAULT_TEMPLATES;

/** `suppressed` is entered by the `/autoresume off` command. */
type State = "idle" | "waiting" | "suppressed";

type WaitSource = ResetSource | "backoff";

interface WaitState {
  /** Absolute fire time (ms). */
  targetAt: number;
  source: WaitSource;
  /** 0 for reset-based waits, 1..5 for backoff attempts. */
  attempt: number;
  /** When arming happened. */
  detectedAt: number;
  provider?: string;
  model?: string;
}

interface LastAssistant {
  errorMessage?: string;
  stopReason?: string;
  provider?: string;
  model?: string;
  response?: { status: number; headers: Record<string, string> };
}

interface AutoresumeSettings {
  enabled?: boolean;
  templates?: Partial<Record<TemplateKey, string>>;
}

/**
 * Arms a chunked wait when a settled run looks like a provider limit, shows the
 * wait in the footer, and continues the session once the reset time (or the
 * backoff delay) has passed. All state is in-session and lives in this closure.
 */
export default function autoresume(pi: ExtensionAPI): void {
  const piRef = pi;

  let state: State = "idle";
  let wait: WaitState | undefined;
  let backoffCount = 0;
  let sessionOff = false;
  let lastAssistant: LastAssistant | undefined;
  let responseSnapshot: LastAssistant["response"];
  /** Reset carried by a raw provider stream error event in the current run. */
  let streamResetAtMs: number | undefined;
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  let footerTimer: ReturnType<typeof setInterval> | undefined;
  /** Captured at arm time so timer callbacks can still update the UI. */
  let uiRef: ExtensionUIContext | undefined;

  /** R11: unknown top-level settings keys survive at runtime, so narrow-cast here. */
  function readSettings(): AutoresumeSettings {
    const settings = piRef.getSettings() as unknown as { autoresume?: AutoresumeSettings };
    return settings.autoresume ?? {};
  }

  /** Effective enabled state for this session (settings kill-switch + `/autoresume off`). */
  function isEnabled(): boolean {
    return readSettings().enabled !== false && !sessionOff;
  }

  function templateFor(key: TemplateKey): string {
    const configured = readSettings().templates?.[key];
    return typeof configured === "string" ? configured : DEFAULT_TEMPLATES[key];
  }

  function templateVars(
    current: WaitState | undefined,
    armingDelayMs: number,
  ): Record<string, string> {
    const resetWait = current !== undefined && current.source !== "backoff" ? current : undefined;
    return {
      provider: current?.provider ?? lastAssistant?.provider ?? "unknown",
      model: current?.model ?? lastAssistant?.model ?? "unknown",
      when: current !== undefined ? formatClock(current.detectedAt) : "",
      reset_abs: resetWait !== undefined ? formatClock(resetWait.targetAt) : "",
      reset_rel:
        resetWait !== undefined ? `~${formatDuration(resetWait.targetAt - Date.now())}` : "",
      retry_in: current !== undefined ? formatDuration(armingDelayMs) : "",
      attempt: current !== undefined ? String(current.attempt) : "",
      max: String(MAX_BACKOFF_ATTEMPTS),
      reason: current?.source ?? "",
    };
  }

  /** `resuming` is the only message that may start a new run by itself (R7). */
  function sendTemplate(
    key: TemplateKey,
    vars: Record<string, string>,
    triggerTurn: boolean,
  ): void {
    const text = renderTemplate(templateFor(key), vars);
    piRef.sendMessage({ customType: CUSTOM_TYPE, content: text, display: true }, { triggerTurn });
  }

  /** R10: `⏳ resume HH:MM` for resets, `⏳ retry in Xm · n/5` for backoff. */
  function renderFooter(current: WaitState): string {
    if (current.source === "backoff") {
      const remainingMs = Math.max(0, current.targetAt - Date.now());
      const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
      return `⏳ retry in ${minutes}m · ${current.attempt}/${MAX_BACKOFF_ATTEMPTS}`;
    }
    return `⏳ resume ${formatClock(current.targetAt)}`;
  }

  function refreshFooter(): void {
    if (wait === undefined || uiRef === undefined) return;
    uiRef.setStatus(STATUS_KEY, renderFooter(wait));
  }

  function clearFooter(): void {
    uiRef?.setStatus(STATUS_KEY, undefined);
  }

  function clearWaitTimers(): void {
    if (resumeTimer !== undefined) {
      clearTimeout(resumeTimer);
      resumeTimer = undefined;
    }
    if (footerTimer !== undefined) {
      clearInterval(footerTimer);
      footerTimer = undefined;
    }
  }

  /**
   * Clears timers, footer and the pending wait while keeping the session
   * enabled and the backoff counter intact. Idempotent, so it is safe on
   * `input` (R8), on `/autoresume cancel` and during shutdown (R12).
   */
  function cancelWait(): void {
    clearWaitTimers();
    clearFooter();
    wait = undefined;
    state = "idle";
  }

  /**
   * The only internal path that clears the consecutive-backoff counter; also
   * called by `/autoresume off` as a deliberate reset of automation.
   */
  function resetBackoffCount(): void {
    backoffCount = 0;
  }

  /** R7/R9: state is cleared before the send so a throwing send cannot wedge us. */
  function fire(): void {
    const fired = wait;
    if (fired === undefined) return;

    clearWaitTimers();
    clearFooter();
    state = "idle";
    wait = undefined;

    try {
      sendTemplate("resuming", templateVars(fired, fired.targetAt - fired.detectedAt), true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      uiRef?.notify(`autoresume · failed to resume: ${message}`, "error");
    }
  }

  /** R6: re-check at every chunk boundary so sleep and clock jumps are tolerated. */
  function onChunk(): void {
    if (wait === undefined) return;
    const now = Date.now();
    if (now < wait.targetAt) {
      resumeTimer = setTimeout(onChunk, nextChunkDelayMs(now, wait.targetAt));
      return;
    }
    fire();
  }

  function armWait(
    ctx: ExtensionContext,
    targetAt: number,
    source: WaitSource,
    attempt: number,
    armingDelayMs: number,
  ): void {
    uiRef = ctx.ui;
    clearWaitTimers();

    const armedAt = Date.now();
    const armed: WaitState = {
      targetAt,
      source,
      attempt,
      detectedAt: armedAt,
      provider: lastAssistant?.provider,
      model: lastAssistant?.model,
    };
    wait = armed;
    state = "waiting";

    sendTemplate(
      source === "backoff" ? "waiting_backoff" : "waiting",
      templateVars(armed, armingDelayMs),
      false,
    );
    refreshFooter();
    footerTimer = setInterval(refreshFooter, FOOTER_REFRESH_MS);
    resumeTimer = setTimeout(onChunk, nextChunkDelayMs(armedAt, targetAt));
  }

  // R2/R3: remember the latest provider response; `message_end` snapshots it
  // onto the assistant message it belongs to.
  pi.on("after_provider_response", (event) => {
    responseSnapshot = { status: event.status, headers: event.headers };
  });

  // Codex reports usage limits on the streamed (WebSocket/SSE) path with an
  // in-band error event whose reset never reaches the error text; remember it
  // for the settle decision (R1).
  pi.on("provider_stream_event", (event) => {
    const resetAt = streamResetAt(event.data, Date.now());
    if (resetAt !== null) streamResetAtMs = resetAt;
  });

  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    lastAssistant = {
      errorMessage: message.errorMessage,
      stopReason: message.stopReason,
      provider: message.provider,
      model: message.model,
      response: responseSnapshot,
    };
  });

  pi.on("agent_start", () => {
    lastAssistant = undefined;
    responseSnapshot = undefined;
    streamResetAtMs = undefined;
  });

  // R1: the only arming point, once pi's own retry/compaction work has settled.
  pi.on("agent_settled", (_event, ctx) => {
    if (state !== "idle" || !isEnabled()) return;

    const assistant = lastAssistant;
    if (assistant === undefined) {
      resetBackoffCount();
      return;
    }

    const now = Date.now();
    const input: ClassifyInput = {
      errorMessage: assistant.errorMessage,
      headers: assistant.response?.headers,
      status: assistant.response?.status,
      stopReason: assistant.stopReason,
    };
    const verdict: LimitVerdict | null = classifyLimit(input, now);

    // R5: any settled run that is not a limit error clears the backoff streak.
    if (verdict === null) {
      resetBackoffCount();
      return;
    }

    if (verdict.kind === "reset") {
      // A known reset time does not consume a backoff attempt (D10).
      armWait(ctx, verdict.resetAt, verdict.source, 0, verdict.resetAt - now);
      return;
    }

    // The streamed error event may carry the reset that the error text lacks.
    // Only a `backoff` verdict (limit-like, not a hard stop) can be upgraded.
    if (streamResetAtMs !== undefined) {
      armWait(ctx, streamResetAtMs, "event", 0, streamResetAtMs - now);
      return;
    }

    const attempt = backoffCount + 1;
    const delayMs = nextBackoffDelayMs(attempt);
    if (delayMs === undefined) {
      sendTemplate("exhausted", templateVars(undefined, 0), false);
      resetBackoffCount();
      return;
    }

    backoffCount = attempt;
    armWait(ctx, now + delayMs, "backoff", attempt, delayMs);
  });

  // R8: user activity wins over a pending wait; extension-sourced input (the
  // resume message itself) must not cancel anything.
  pi.on("input", (event) => {
    if (state !== "waiting") return;
    if (event.source === "extension") return;
    cancelWait();
  });

  /** R9: one-line report of the current wait, or of why autoresume is off. */
  function statusLine(): string {
    if (sessionOff) return "autoresume · disabled (session) · idle";
    if (!isEnabled()) return "autoresume · disabled (settings) · idle";
    if (wait === undefined) return "autoresume · enabled · idle";

    const remaining = Math.max(0, wait.targetAt - Date.now());
    if (wait.source === "backoff") {
      return `autoresume · enabled · waiting · ${wait.provider ?? "unknown"} · backoff ${wait.attempt}/${MAX_BACKOFF_ATTEMPTS} · retry in ${formatDuration(remaining)}`;
    }
    return `autoresume · enabled · waiting · ${wait.provider ?? "unknown"} · resume ${formatClock(wait.targetAt)} (${wait.source}) · in ${formatDuration(remaining)}`;
  }

  // R9: `/autoresume` reports state and toggles the session-level switch.
  pi.registerCommand("autoresume", {
    description: "Control automatic resume after provider limits",
    getArgumentCompletions: (prefix) => {
      const subcommands = ["status", "cancel", "off", "on"];
      const trimmed = prefix.trim().toLowerCase();
      return subcommands
        .filter((subcommand) => subcommand.startsWith(trimmed))
        .map((subcommand) => ({ value: subcommand, label: subcommand }));
    },
    handler: async (args, ctx) => {
      const subcommand = args.trim().toLowerCase();
      switch (subcommand) {
        case "":
        case "status":
          ctx.ui.notify(statusLine(), "info");
          return;
        case "cancel": {
          const pending = wait !== undefined;
          cancelWait();
          ctx.ui.notify(
            pending ? "autoresume · wait cancelled" : "autoresume · nothing pending",
            "info",
          );
          return;
        }
        case "off":
          cancelWait();
          sessionOff = true;
          state = "suppressed";
          resetBackoffCount();
          ctx.ui.notify("autoresume · disabled for this session", "info");
          return;
        case "on":
          sessionOff = false;
          state = wait === undefined ? "idle" : "waiting";
          ctx.ui.notify(
            isEnabled()
              ? "autoresume · enabled for this session"
              : "autoresume · settings disabled · autoresume remains off",
            "info",
          );
          return;
        default:
          ctx.ui.notify("Usage: /autoresume [status|cancel|off|on]", "info");
      }
    },
  });

  // R12: idempotent cleanup; state never survives the session.
  pi.on("session_shutdown", () => {
    cancelWait();
    lastAssistant = undefined;
    responseSnapshot = undefined;
    streamResetAtMs = undefined;
    resetBackoffCount();
    sessionOff = false;
    uiRef = undefined;
  });
}
