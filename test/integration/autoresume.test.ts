import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { RpcSession } from "../support/rpc.ts";

const AUTORESUME = fileURLToPath(new URL("../../extensions/autoresume.ts", import.meta.url));
const STUB = fileURLToPath(new URL("./stub-provider.ts", import.meta.url));

function notification(rpc: RpcSession, substring: string) {
  return rpc.records.find(
    (r) => r.type === "extension_ui_request" && r.method === "notify" &&
      String(r.message).includes(substring),
  );
}

test("command surface reports and toggles state", async () => {
  const rpc = await RpcSession.start({ extensionPaths: [AUTORESUME, STUB] });
  try {
    expect(await rpc.prompt("/autoresume status")).toBe("handled");
    expect(notification(rpc, "autoresume · enabled")).toBeDefined();
    expect(await rpc.prompt("/autoresume off")).toBe("handled");
    expect(notification(rpc, "disabled for this session")).toBeDefined();
    expect(await rpc.prompt("/autoresume on")).toBe("handled");
    expect(notification(rpc, "enabled for this session")).toBeDefined();
    expect(await rpc.prompt("/autoresume cancel")).toBe("handled");
    expect(notification(rpc, "nothing pending")).toBeDefined();
    expect(await rpc.prompt("/autoresume bogus")).toBe("handled");
    expect(notification(rpc, "Usage: /autoresume")).toBeDefined();
  } finally {
    await rpc.stop();
  }
}, 30_000);

test("uses Retry-After from an OpenAI-compatible HTTP 429", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions") {
        return new Response(null, { status: 404 });
      }
      return Response.json(
        { error: { message: "Rate limit reached.", type: "rate_limit_error" } },
        { status: 429, headers: { "Retry-After": "120" } },
      );
    },
  });
  try {
    const rpc = await RpcSession.start({
      extensionPaths: [AUTORESUME],
      models: {
        providers: {
          "local-test": {
            baseUrl: new URL("/v1", server.url).href,
            api: "openai-completions",
            apiKey: "local-test-key",
            models: [{ id: "http-limit" }],
          },
        },
      },
    });
    try {
      await rpc.send({ type: "set_model", provider: "local-test", modelId: "http-limit" });
      const start = rpc.records.length;
      expect(await rpc.prompt("hello")).toBe("started");
      await rpc.waitForNext((r) => r.type === "agent_settled", 15_000, start);
      expect(await rpc.prompt("/autoresume status")).toBe("handled");
      expect(notification(rpc, "autoresume · enabled · waiting · local-test")?.message)
        .toContain("(header)");
    } finally {
      await rpc.stop();
    }
  } finally {
    server.stop(true);
  }
}, 30_000);

test("does not arm autoresume when Pi reports an aborted run", async () => {
  const rpc = await RpcSession.start({
    extensionPaths: [AUTORESUME, STUB],
    retry: { enabled: true, baseDelayMs: 10_000 },
  });
  try {
    await rpc.send({ type: "set_model", provider: "stub", modelId: "stub-limit" });
    const start = rpc.records.length;
    expect(await rpc.prompt("hello")).toBe("started");
    await rpc.waitForNext((r) => r.type === "auto_retry_start", 15_000, start);
    await rpc.send({ type: "abort" });
    const settled = await rpc.waitForNext((r) => r.type === "agent_settled", 15_000, start);
    expect(settled.aborted).toBe(true);
    expect(await rpc.prompt("/autoresume status")).toBe("handled");
    expect(notification(rpc, "autoresume · enabled · idle")).toBeDefined();
  } finally {
    await rpc.stop();
  }
}, 30_000);

test("waits for the limit reset and resumes the session", async () => {
  const rpc = await RpcSession.start({ extensionPaths: [AUTORESUME, STUB] });
  try {
    await rpc.send({ type: "set_auto_retry", enabled: false });
    await rpc.send({ type: "set_model", provider: "stub", modelId: "stub-limit" });
    const firstRunMark = rpc.records.length;
    expect(await rpc.prompt("hello")).toBe("started");
    await rpc.waitForNext((r) => r.type === "agent_settled", 30_000, firstRunMark);
    const resumeMark = rpc.records.length;

    const notice = rpc.records.find(
      (r) => r.type === "message_end" && r.message?.role === "custom" &&
        r.message?.customType === "autoresume" && String(r.message.content).includes("limit hit"),
    );
    expect(notice).toBeDefined();

    const footer = rpc.records.find(
      (r) => r.type === "extension_ui_request" && r.method === "setStatus" &&
        r.statusKey === "autoresume" && String(r.statusText).startsWith("⏳ resume"),
    );
    expect(footer).toBeDefined();

    await rpc.waitForNext((r) => r.type === "agent_settled", 90_000, resumeMark);
    expect(await rpc.getLastAssistantText()).toBe("RESUMED-OK");

    const cleared = rpc.records.some(
      (r) => r.type === "extension_ui_request" && r.method === "setStatus" &&
        r.statusKey === "autoresume" && (r.statusText === undefined || r.statusText === null),
    );
    expect(cleared).toBe(true);
  } finally {
    await rpc.stop();
  }
}, 120_000);

test("stream error without reset text waits for the event reset", async () => {
  const rpc = await RpcSession.start({ extensionPaths: [AUTORESUME, STUB] });
  try {
    await rpc.send({ type: "set_auto_retry", enabled: false });
    await rpc.send({ type: "set_model", provider: "stub", modelId: "stub-stream-limit" });
    const firstRunMark = rpc.records.length;
    expect(await rpc.prompt("hello")).toBe("started");
    await rpc.waitForNext((r) => r.type === "agent_settled", 30_000, firstRunMark);
    const resumeMark = rpc.records.length;

    const notice = rpc.records.find(
      (r) => r.type === "message_end" && r.message?.role === "custom" &&
        r.message?.customType === "autoresume" && String(r.message.content).includes("limit hit"),
    );
    expect(notice).toBeDefined();
    expect(String(notice?.message.content)).toContain("limit hit · resume");

    const footer = rpc.records.find(
      (r) => r.type === "extension_ui_request" && r.method === "setStatus" &&
        r.statusKey === "autoresume" && String(r.statusText).startsWith("⏳ resume"),
    );
    expect(footer).toBeDefined();

    const backoffFooter = rpc.records.some(
      (r) => r.type === "extension_ui_request" && r.method === "setStatus" &&
        r.statusKey === "autoresume" && String(r.statusText).startsWith("⏳ retry"),
    );
    expect(backoffFooter).toBe(false);

    await rpc.waitForNext((r) => r.type === "agent_settled", 90_000, resumeMark);
    expect(await rpc.getLastAssistantText()).toBe("RESUMED-OK");
  } finally {
    await rpc.stop();
  }
}, 120_000);
