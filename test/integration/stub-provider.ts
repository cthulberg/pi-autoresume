// Test-only fixture — not product code.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createFauxCore,
  createProvider,
  fauxAssistantMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

const LIMIT_TEXT =
  process.env.STUB_LIMIT_TEXT ?? "Rate limit reached. Please try again in 5s.";
const STREAM_LIMIT_TEXT = "Codex error: The usage limit has been reached";
const STREAM_RESET_SECONDS = 5;
const RESUME_MARKER = "resuming after limit reset";

const core = createFauxCore({
  provider: "stub",
  models: [
    { id: "stub-limit", name: "Stub Limit" },
    { id: "stub-stream-limit", name: "Stub Stream Limit" },
  ],
});

function pickResponse(context: TranscriptContext, model: (typeof core.models)[number]) {
  if (JSON.stringify(context.messages).includes(RESUME_MARKER)) {
    return fauxAssistantMessage("RESUMED-OK");
  }
  if (model.id === "stub-stream-limit") {
    return fauxAssistantMessage(STREAM_LIMIT_TEXT, {
      stopReason: "error",
      errorMessage: STREAM_LIMIT_TEXT,
    });
  }
  return fauxAssistantMessage(LIMIT_TEXT, { stopReason: "error", errorMessage: LIMIT_TEXT });
}

const streamSimple = (
  model: Parameters<typeof core.streamSimple>[0],
  context: TranscriptContext,
  options?: Parameters<typeof core.streamSimple>[2],
) => {
  const resumed = JSON.stringify(context.messages).includes(RESUME_MARKER);
  if (model.id === "stub-stream-limit" && !resumed) {
    // Codex reports usage limits on the stream path with an in-band error event
    // that carries the reset; the thrown message alone has no reset text.
    void options?.onProviderStreamEvent?.(
      {
        type: "error",
        error: {
          type: "usage_limit_reached",
          message: "The usage limit has been reached",
          plan_type: "plus",
          resets_at: Math.floor(Date.now() / 1000) + STREAM_RESET_SECONDS,
          resets_in_seconds: STREAM_RESET_SECONDS,
        },
        status_code: 429,
      },
      model,
    );
  }
  core.setResponses([pickResponse(context, model)]);
  return core.streamSimple(model, context, options);
};

const provider = createProvider({
  id: "stub",
  name: "Stub",
  auth: { apiKey: { name: "Stub", resolve: async () => ({ auth: {} }) } },
  models: core.models,
  api: { stream: streamSimple, streamSimple },
});

export default function (pi: ExtensionAPI) {
  pi.registerProvider(provider);
}
