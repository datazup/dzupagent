import type { ModelCapabilityCatalogEntry } from "../../model-capability-catalog.js";

/** Synthetic connector/model qualification for provider-free route tests only. */
export const FIXTURE_MODEL_CAPABILITY_CATALOG: readonly ModelCapabilityCatalogEntry[] = [
  { route: "codex-cli", modelId: "model-a", connectorVersion: "fixture-1", qualification: "fixture",
    capabilities: { "tool.use/v1": "supported", "streaming/v1": "supported" } },
  { route: "openai-api", modelId: "model-a", connectorVersion: "fixture-1", qualification: "fixture",
    capabilities: { "tool.use/v1": "supported", "streaming/v1": "supported" } },
];
