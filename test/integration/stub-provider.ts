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
const RESUME_MARKER = "resuming after limit reset";

const core = createFauxCore({ provider: "stub", models: [{ id: "stub-limit", name: "Stub Limit" }] });

function pickResponse(context: TranscriptContext) {
  return JSON.stringify(context.messages).includes(RESUME_MARKER)
    ? fauxAssistantMessage("RESUMED-OK")
    : fauxAssistantMessage(LIMIT_TEXT, { stopReason: "error", errorMessage: LIMIT_TEXT });
}

const streamSimple = (
  model: Parameters<typeof core.streamSimple>[0],
  context: TranscriptContext,
  options?: Parameters<typeof core.streamSimple>[2],
) => {
  core.setResponses([pickResponse(context)]);
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
