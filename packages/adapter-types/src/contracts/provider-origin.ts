import type { AdapterProviderId } from "./provider.js";

/**
 * Coarse closed roll-up of `originKey`, used ONLY for the cross-family check.
 * `'unknown'` fails closed — it is never treated as "different".
 */
export type ModelOriginFamily =
  | "anthropic"
  | "openai"
  | "google"
  | "qwen"
  | "unknown";

/** How an origin was resolved; `unmapped`/`nondeterministic` both escalate. */
export type ResolutionSource =
  | "origin-map"
  | "model-catalog"
  | "unmapped"
  | "nondeterministic";

/**
 * Pure resolution of a provider/model to its origin family.
 * `originKey` is catalog-driven and OPEN-ENDED (e.g. 'anthropic:claude',
 * 'openai:gpt', 'mistral:large'). Only `modelOriginFamily` is a closed union.
 * `resolvedAt` is injected by the caller so resolution stays pure (T14).
 */
export interface ProviderResolution {
  resolverVersion: string;
  executionProviderId: AdapterProviderId;
  requestedModel?: string;
  resolvedModelId?: string;
  originKey: string;
  modelOriginFamily: ModelOriginFamily;
  resolutionSource: ResolutionSource;
  /** Calibrated confidence in the resolution, 0..1. */
  resolutionConfidence: number;
  sourceEvidence: string;
  /** ISO timestamp, INJECTED — never read from a clock inside the resolver. */
  resolvedAt: string;
  catalogVersion: string;
}

interface OriginEntry {
  originKey: string;
  modelOriginFamily: ModelOriginFamily;
}

/** Injected snapshots — the resolver performs no I/O. */
export interface ResolverCatalogs {
  providerOriginMap: Record<string, OriginEntry>;
  modelOriginCatalog: Record<string, OriginEntry>;
  resolverVersion: string;
  catalogVersion: string;
}

export interface ResolveInput {
  executionProviderId: AdapterProviderId;
  requestedModel?: string;
  /** Injected ISO timestamp for the resulting `resolvedAt`. */
  resolvedAt: string;
}

export function resolveProviderOrigin(
  input: ResolveInput,
  catalogs: ResolverCatalogs,
): ProviderResolution {
  const base = {
    resolverVersion: catalogs.resolverVersion,
    executionProviderId: input.executionProviderId,
    catalogVersion: catalogs.catalogVersion,
    resolvedAt: input.resolvedAt,
    ...(input.requestedModel !== undefined
      ? { requestedModel: input.requestedModel }
      : {}),
  };

  // 1. Model catalog wins when a requestedModel is explicitly mapped.
  if (input.requestedModel) {
    const modelEntry = catalogs.modelOriginCatalog[input.requestedModel];
    if (modelEntry) {
      return {
        ...base,
        resolvedModelId: input.requestedModel,
        originKey: modelEntry.originKey,
        modelOriginFamily: modelEntry.modelOriginFamily,
        resolutionSource: "model-catalog",
        resolutionConfidence: 1,
        sourceEvidence: `modelOriginCatalog[${input.requestedModel}]`,
      };
    }
  }

  // 2. Provider origin map.
  const providerEntry = catalogs.providerOriginMap[input.executionProviderId];
  if (providerEntry && providerEntry.modelOriginFamily !== "unknown") {
    return {
      ...base,
      originKey: providerEntry.originKey,
      modelOriginFamily: providerEntry.modelOriginFamily,
      resolutionSource: "origin-map",
      resolutionConfidence: 1,
      sourceEvidence: `providerOriginMap[${input.executionProviderId}]`,
    };
  }

  // 3. Fail closed. A provider mapped to 'unknown' (e.g. a router) or an
  //    entirely unmapped provider both resolve to unknown → escalate.
  return {
    ...base,
    originKey:
      providerEntry?.originKey ?? `${input.executionProviderId}:unknown`,
    modelOriginFamily: "unknown",
    resolutionSource: "unmapped",
    resolutionConfidence: 0,
    sourceEvidence: providerEntry
      ? `providerOriginMap[${input.executionProviderId}] mapped to unknown family`
      : `no catalog entry for ${input.executionProviderId}`,
  };
}

/**
 * Cross-family iff BOTH sides resolved to a known (non-unknown) family AND the
 * families differ. Unknown on either side fails closed (returns false).
 */
export function isCrossFamily(
  a: ProviderResolution,
  b: ProviderResolution,
): boolean {
  if (a.modelOriginFamily === "unknown" || b.modelOriginFamily === "unknown") {
    return false;
  }
  return a.modelOriginFamily !== b.modelOriginFamily;
}
