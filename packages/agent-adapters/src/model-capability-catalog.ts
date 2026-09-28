import type {
  ProviderRouteBinding, ProviderRouteCapability, ProviderRouteModelCapabilityEvidence,
} from "./model-discovery-types.js";

interface FixtureCapabilityCatalogEntry {
  route: ProviderRouteBinding["route"];
  modelId: string;
  connectorVersion: string;
  qualification: "fixture";
  capabilities: Readonly<Record<ProviderRouteCapability, "supported" | "unsupported" | "unknown">>;
}

/**
 * Reviewed provider-free connector fixtures. These synthetic identities cannot
 * qualify an installed connector or production model. Live qualification is a
 * separate operator step, represented distinctly in route evidence.
 */
const MODEL_CAPABILITY_CATALOG: readonly FixtureCapabilityCatalogEntry[] = [
  { route: "codex-cli", modelId: "model-a", connectorVersion: "fixture-1", qualification: "fixture",
    capabilities: { "tool.use/v1": "supported", "streaming/v1": "supported" } },
  { route: "openai-api", modelId: "model-a", connectorVersion: "fixture-1", qualification: "fixture",
    capabilities: { "tool.use/v1": "supported", "streaming/v1": "supported" } },
];

const unknownCapabilities = (): Record<ProviderRouteCapability, ProviderRouteModelCapabilityEvidence> => ({
  "tool.use/v1": { support: "unknown" },
  "streaming/v1": { support: "unknown" },
});

/** Never projects support without an exact route, model and connector version match. */
export function qualifiedModelCapabilities(
  route: ProviderRouteBinding["route"], version: string | null, modelId: string,
): Record<ProviderRouteCapability, ProviderRouteModelCapabilityEvidence> | undefined {
  if (version === null) return undefined;
  const entry = MODEL_CAPABILITY_CATALOG.find(item =>
    item.route === route && item.modelId === modelId && item.connectorVersion === version);
  if (!entry) return unknownCapabilities();
  return {
    "tool.use/v1": { support: entry.capabilities["tool.use/v1"], qualification: entry.qualification,
      qualifiedConnectorVersion: entry.connectorVersion },
    "streaming/v1": { support: entry.capabilities["streaming/v1"], qualification: entry.qualification,
      qualifiedConnectorVersion: entry.connectorVersion },
  };
}
