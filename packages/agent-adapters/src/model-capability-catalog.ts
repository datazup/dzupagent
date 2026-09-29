import type {
  ProviderRouteBinding, ProviderRouteCapability, ProviderRouteModelCapabilityEvidence,
} from "./model-discovery-types.js";

export interface ModelCapabilityCatalogEntry {
  route: ProviderRouteBinding["route"];
  modelId: string;
  connectorVersion: string;
  qualification: "fixture";
  capabilities: Readonly<Record<ProviderRouteCapability, "supported" | "unsupported" | "unknown">>;
}

/**
 * Reviewed production entries only. No connector/model has been independently
 * qualified for production use yet. Tests inject synthetic entries explicitly.
 */
const MODEL_CAPABILITY_CATALOG: readonly ModelCapabilityCatalogEntry[] = [];

const unknownCapabilities = (): Record<ProviderRouteCapability, ProviderRouteModelCapabilityEvidence> => ({
  "tool.use/v1": { support: "unknown" },
  "streaming/v1": { support: "unknown" },
});

/** Never projects support without an exact route, model and connector version match. */
export function qualifiedModelCapabilities(
  route: ProviderRouteBinding["route"], version: string | null, modelId: string,
  catalog: readonly ModelCapabilityCatalogEntry[] = MODEL_CAPABILITY_CATALOG,
): Record<ProviderRouteCapability, ProviderRouteModelCapabilityEvidence> | undefined {
  if (version === null) return undefined;
  const entry = catalog.find(item =>
    item.route === route && item.modelId === modelId && item.connectorVersion === version);
  if (!entry) return unknownCapabilities();
  return {
    "tool.use/v1": { support: entry.capabilities["tool.use/v1"], qualification: entry.qualification,
      qualifiedConnectorVersion: entry.connectorVersion },
    "streaming/v1": { support: entry.capabilities["streaming/v1"], qualification: entry.qualification,
      qualifiedConnectorVersion: entry.connectorVersion },
  };
}
