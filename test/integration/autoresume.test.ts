import { expect, test } from "bun:test";
import { RpcSession } from "../support/rpc.ts";

const AUTORESUME = new URL("../../extensions/autoresume.ts", import.meta.url).pathname;
const STUB = new URL("./stub-provider.ts", import.meta.url).pathname;

test("command surface reports and toggles state", async () => {
  const rpc = await RpcSession.start({ extensionPaths: [AUTORESUME, STUB] });
  const notify = (substring: string) =>
    rpc.records.find(
      (r) => r.type === "extension_ui_request" && r.method === "notify" &&
        String(r.message).includes(substring),
    );
  try {
    expect(await rpc.prompt("/autoresume status")).toBe("handled");
    expect(notify("autoresume · enabled")).toBeDefined();
    expect(await rpc.prompt("/autoresume off")).toBe("handled");
    expect(notify("disabled for this session")).toBeDefined();
    expect(await rpc.prompt("/autoresume on")).toBe("handled");
    expect(notify("enabled for this session")).toBeDefined();
    expect(await rpc.prompt("/autoresume cancel")).toBe("handled");
    expect(notify("nothing pending")).toBeDefined();
    expect(await rpc.prompt("/autoresume bogus")).toBe("handled");
    expect(notify("Usage: /autoresume")).toBeDefined();
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
