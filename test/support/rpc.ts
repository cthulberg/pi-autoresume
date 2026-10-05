import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One record from pi's RPC protocol. The protocol is deliberately open-ended:
 * commands, responses, session events, and extension UI requests all share the
 * wire, so only `type` is guaranteed.
 */
export interface JsonRecord {
  type: string;
  // The protocol has too many record variants to model precisely here.
  [key: string]: any;
}

const SEND_TIMEOUT_MS = 15_000;
const WAIT_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 5_000;

interface PendingSend {
  resolve: (record: JsonRecord) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Waiter {
  predicate: (record: JsonRecord) => boolean;
  resolve: (record: JsonRecord) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Drives one `pi --mode rpc` subprocess over strict JSONL on stdout.
 *
 * Every session gets its own temp working directory and agent directory, so
 * sessions never share sessions, settings, or credentials. stdout is framed
 * only on `"\n"` (with an optional preceding `"\r"`); the session must be
 * stopped to release the process and its temp directories.
 */
export class RpcSession {
  readonly records: JsonRecord[] = [];

  private readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private readonly stdout: ReadableStream<Uint8Array>;
  private readonly stdin: Bun.FileSink;
  private readonly cwd: string;
  private readonly agentDir: string;
  private readonly pending = new Map<string, PendingSend>();
  private readonly waiters = new Set<Waiter>();
  private readonly stderrChunks: string[] = [];
  private requestCounter = 0;
  private stopped = false;
  private exited = false;

  private constructor(
    child: Bun.Subprocess<"pipe", "pipe", "pipe">,
    cwd: string,
    agentDir: string,
  ) {
    this.child = child;
    this.stdout = child.stdout;
    this.stdin = child.stdin;
    this.cwd = cwd;
    this.agentDir = agentDir;
    void child.exited.then((code) => {
      this.exited = true;
      this.failAll(new Error(`pi RPC process exited with code ${code}${this.diagnosticsSuffix()}`));
    });
  }

  /**
   * Starts `pi --mode rpc` with only the given extensions loaded, isolated
   * from the real agent directory and offline.
   */
  static async start(options: { extensionPaths: string[] }): Promise<RpcSession> {
    const cwd = await mkdtemp(join(tmpdir(), "pi-autoresume-cwd-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-autoresume-agent-"));
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ retry: { enabled: false } }),
      "utf8",
    );

    const args = [
      "pi",
      "--mode",
      "rpc",
      "--no-session",
      "-ne",
      ...options.extensionPaths.flatMap((path) => ["-e", path]),
    ];
    const child = Bun.spawn(args, {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
      },
    });

    const session = new RpcSession(child, cwd, agentDir);
    void session.pumpStdout();
    void session.pumpStderr();
    return session;
  }

  /**
   * Sends a command and resolves the matching `type: "response"` record. The
   * session assigns the id, so callers never correlate by hand. Rejects when
   * pi reports `success: false` or the response does not arrive in time.
   */
  send(command: Record<string, unknown>): Promise<JsonRecord> {
    const id = `req_${++this.requestCounter}`;
    const payload = { id, ...command };

    return new Promise<JsonRecord>((resolve, reject) => {
      if (this.stopped || this.exited) {
        reject(new Error(`pi RPC session is not running${this.diagnosticsSuffix()}`));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `pi RPC command ${String(command.type)} timed out after ${SEND_TIMEOUT_MS}ms${this.diagnosticsSuffix()}`,
          ),
        );
      }, SEND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });

      void this.write(payload).catch((error: unknown) => {
        const entry = this.pending.get(id);
        if (entry === undefined) return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        entry.reject(toError(error));
      });
    });
  }

  /**
   * Resolves on the first matching record at index `>= fromIndex`, including
   * records already present at that index. Capture `fromIndex` before
   * triggering work so fast events cannot be missed.
   */
  waitForNext(
    predicate: (record: JsonRecord) => boolean,
    timeoutMs: number = WAIT_TIMEOUT_MS,
    fromIndex: number = this.records.length,
  ): Promise<JsonRecord> {
    for (let index = Math.max(0, fromIndex); index < this.records.length; index++) {
      const record = this.records[index];
      if (record !== undefined && predicate(record)) return Promise.resolve(record);
    }

    return new Promise<JsonRecord>((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve: (record: JsonRecord) => {
          clearTimeout(waiter.timer);
          resolve(record);
        },
        reject: (error: Error) => {
          clearTimeout(waiter.timer);
          reject(error);
        },
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
      };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(
          new Error(
            `pi RPC waitForNext timed out after ${timeoutMs}ms${this.diagnosticsSuffix()}`,
          ),
        );
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  /** Sends a prompt and returns `data.disposition`. */
  async prompt(text: string): Promise<string | undefined> {
    const response = await this.send({ type: "prompt", message: text });
    const disposition: unknown = response.data?.disposition;
    return typeof disposition === "string" ? disposition : undefined;
  }

  /** Returns the last assistant message's text, or `null` when there is none. */
  async getLastAssistantText(): Promise<string | null> {
    const response = await this.send({ type: "get_last_assistant_text" });
    const text: unknown = response.data?.text;
    return typeof text === "string" ? text : null;
  }

  /** Ends stdin, waits for a graceful exit, kills if needed, removes temp dirs. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    this.failWaiters(new Error(`pi RPC session stopped${this.diagnosticsSuffix()}`));

    try {
      this.stdin.end();
    } catch {
      // The sink may already be closed by a crashed process.
    }

    const exitedGracefully = await Promise.race([
      this.child.exited.then(() => true),
      sleep(STOP_TIMEOUT_MS).then(() => false),
    ]);
    if (!exitedGracefully) {
      try {
        this.child.kill();
      } catch {
        // The process may have exited between the timeout and the kill.
      }
      await Promise.race([this.child.exited, sleep(STOP_TIMEOUT_MS)]);
    }

    await rm(this.cwd, { recursive: true, force: true, maxRetries: 3 });
    await rm(this.agentDir, { recursive: true, force: true, maxRetries: 3 });
  }

  private async write(payload: Record<string, unknown>): Promise<void> {
    this.stdin.write(JSON.stringify(payload) + "\n");
    await this.stdin.flush();
  }

  private async pumpStdout(): Promise<void> {
    const reader = this.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = this.drain(buffer);
      }
      buffer += decoder.decode();
      this.drain(buffer, true);
    } catch (error) {
      this.failAll(toError(error));
    } finally {
      reader.releaseLock();
      this.failAll(new Error("pi RPC stdout stream ended"));
    }
  }

  private async pumpStderr(): Promise<void> {
    const reader = this.child.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.stderrChunks.push(decoder.decode(value, { stream: true }));
      }
      this.stderrChunks.push(decoder.decode());
    } catch {
      // stderr diagnostics are best-effort only.
    } finally {
      reader.releaseLock();
    }
  }

  /** Splits complete `"\n"`-terminated lines out of `buffer`. */
  private drain(buffer: string, flush = false): string {
    let start = 0;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      this.handleLine(buffer.slice(start, index));
      start = index + 1;
      index = buffer.indexOf("\n", start);
    }
    const remainder = buffer.slice(start);
    if (flush && remainder !== "") this.handleLine(remainder);
    return flush ? "" : remainder;
  }

  private handleLine(rawLine: string): void {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") return;

    let record: JsonRecord;
    try {
      record = JSON.parse(line) as JsonRecord;
    } catch (error) {
      record = { type: "parse_error", line, error: toError(error).message };
    }

    this.records.push(record);
    this.settleResponse(record);
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(record)) continue;
      this.waiters.delete(waiter);
      waiter.resolve(record);
    }
  }

  private settleResponse(record: JsonRecord): void {
    if (record.type !== "response" || typeof record.id !== "string") return;
    const entry = this.pending.get(record.id);
    if (entry === undefined) return;

    this.pending.delete(record.id);
    clearTimeout(entry.timer);
    if (record.success === false) {
      entry.reject(
        new Error(
          `pi RPC command ${String(record.command)} failed: ${String(record.error)}${this.diagnosticsSuffix()}`,
        ),
      );
      return;
    }
    entry.resolve(record);
  }

  private failWaiters(error: Error): void {
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private failAll(error: Error): void {
    for (const entry of [...this.pending.values()]) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.failWaiters(error);
  }

  private diagnosticsSuffix(): string {
    const text = this.stderrChunks.join("").trim();
    if (text === "") return "";
    return `\npi stderr:\n${text.slice(-2000)}`;
  }
}
