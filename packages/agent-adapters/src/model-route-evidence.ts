import { createHash } from "node:crypto";
import type {
  ProviderModelCatalogEntry, ProviderRouteBinding, ProviderRouteDiscoveryOptions,
  ProviderRouteEvidence, ProviderRouteEvidenceReason, ProviderRouteModelEvidence,
  ProviderRouteObservation, ProviderRouteSelection, ProviderRouteSelectionAssessment,
} from "./model-discovery-types.js";
import { listCodexAppServerModels, listOpenAiApiModels } from "./model-provider-apis.js";
import { modelIdentifier, sourceIdentity, sourceRevisionValue, stableJson } from "./model-discovery-values.js";

const fact = (value: unknown): boolean | null => value === true ? true : value === false ? false : null;
const sameBinding = (left: ProviderRouteBinding, right: ProviderRouteBinding): boolean =>
  left.route === right.route && left.sourceId === right.sourceId && left.sourceRevision === right.sourceRevision;

function bindingValue(value: ProviderRouteBinding): ProviderRouteBinding {
  if (value.route !== "codex-cli" && value.route !== "openai-api") throw new Error("PROVIDER_ROUTE_INVALID");
  return { route: value.route, sourceId: sourceIdentity(value.sourceId, "sourceId"),
    sourceRevision: sourceRevisionValue(value.sourceRevision, "sourceRevision") };
}

function efforts(value: readonly string[] | undefined): string[] | null {
  return value === undefined ? null : [...new Set(value.map(item => modelIdentifier(item, "effort")!))];
}

function qualifiedOperations(observation: ProviderRouteObservation | undefined): Map<string, ProviderRouteModelEvidence["operations"]> {
  const result = new Map<string, ProviderRouteModelEvidence["operations"]>();
  // No capability claim without an independently qualified connector version.
  if (!observation?.version) return result;
  for (const item of observation.models ?? []) {
    const modelId = modelIdentifier(item.modelId, "modelId")!;
    if (item.operation !== "agent.run" && item.operation !== "chat.generate") throw new Error("PROVIDER_OPERATION_INVALID");
    const entries = result.get(modelId) ?? [];
    if (entries.some(entry => entry.operation === item.operation)) throw new Error("PROVIDER_OPERATION_DUPLICATE");
    entries.push({ operation: item.operation,
      support: item.support === "supported" || item.support === "unsupported" ? item.support : "unknown",
      supportedReasoningEfforts: efforts(item.supportedReasoningEfforts),
      providerDefaultSupported: fact(item.providerDefaultSupported) });
    result.set(modelId, entries);
  }
  return result;
}

function publicModels(rows: ProviderModelCatalogEntry[], operations: Map<string, ProviderRouteModelEvidence["operations"]>): ProviderRouteModelEvidence[] {
  const seen = new Set<string>();
  return rows.filter(row => row.hidden !== true).map(row => {
    const modelId = modelIdentifier(row.id, "modelId")!;
    if (seen.has(modelId)) throw new Error("PROVIDER_MODEL_DUPLICATE");
    seen.add(modelId);
    return { modelId, supportedReasoningEfforts: efforts(row.supportedReasoningEfforts),
      operations: operations.get(modelId) ?? [] };
  });
}

/**
 * Observes exactly one route through existing, non-generative metadata loaders.
 * The caller owns configuration, scoped connector observations and revisions.
 * No automatic route switch, credential lookup, login or generation is performed.
 */
export async function discoverProviderRouteEvidence(options: ProviderRouteDiscoveryOptions): Promise<ProviderRouteEvidence> {
  const binding = bindingValue(options.binding);
  const api = binding.route === "openai-api";
  const dependencies = options.dependencies ?? {};
  const started = (dependencies.now ?? (() => new Date()))().getTime();
  const ttlMs = options.ttlMs ?? 60_000;
  if (!Number.isFinite(started) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 300_000) {
    throw new Error("PROVIDER_EVIDENCE_TIME_INVALID");
  }
  const observation = options.observation;
  const configured = options.configured === true && (!api || Boolean(options.apiKey?.trim()));
  const evidence: ProviderRouteEvidence = {
    schemaVersion: "dzupagent/provider-route-evidence/v1",
    providerId: api ? "openai" : "codex", binding,
    observedAt: new Date(started).toISOString(), expiresAt: new Date(started + ttlMs).toISOString(),
    version: null, source: null,
    facts: { configured, installed: null, authenticated: null, healthy: null, modelCatalog: null },
    models: [], reasons: [], fingerprint: "",
  };
  const finish = (): ProviderRouteEvidence => {
    const { fingerprint: _fingerprint, ...payload } = evidence;
    evidence.fingerprint = createHash("sha256").update(stableJson(payload)).digest("hex");
    return evidence;
  };
  if (observation) {
    if (!sameBinding(binding, observation.binding)) {
      evidence.reasons.push("observation_mismatch");
      return finish();
    }
    const observedAt = Date.parse(observation.observedAt);
    const expiresAt = Date.parse(observation.expiresAt);
    if (!Number.isFinite(observedAt) || !Number.isFinite(expiresAt) || observedAt > started || expiresAt <= started || expiresAt <= observedAt) {
      evidence.reasons.push("observation_stale");
      return finish();
    }
    evidence.expiresAt = new Date(Math.min(started + ttlMs, expiresAt)).toISOString();
    evidence.version = observation.version ? sourceRevisionValue(observation.version, "version") : null;
    evidence.facts.installed = fact(observation.installed);
    evidence.facts.authenticated = fact(observation.authenticated);
    evidence.facts.healthy = fact(observation.healthy);
  }
  if (options.signal?.aborted) {
    evidence.reasons.push("discovery_cancelled");
    return finish();
  }
  if (!configured || [evidence.facts.installed, evidence.facts.authenticated, evidence.facts.healthy].includes(false)) return finish();
  // Copy qualified facts before the asynchronous probe so refreshes cannot relabel it.
  const operations = qualifiedOperations(observation);
  try {
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("PROVIDER_PROBE_TIMEOUT_INVALID");
    const rows = api
      ? await listOpenAiApiModels({ apiKey: options.apiKey!,
          apiBaseUrl: options.apiBaseUrl ?? "https://api.openai.com/v1", timeoutMs,
          fetchImpl: dependencies.fetch ?? fetch })
      : await listCodexAppServerModels({ cliPath: options.cliPath ?? "codex", includeHidden: false,
          timeoutMs, env: { ...(options.env ?? {}) }, dependencies });
    if (options.signal?.aborted) {
      evidence.reasons.push("discovery_cancelled");
      return finish();
    }
    evidence.models = publicModels(rows, operations);
    evidence.source = api ? "openai-models-api" : "codex-app-server";
    evidence.facts.modelCatalog = true;
    evidence.facts.installed = true;
    if (api) {
      // A successful credentialed metadata request proves only API reachability/auth.
      evidence.facts.authenticated = true;
      evidence.facts.healthy = true;
    }
  } catch {
    // Provider diagnostics can contain private paths, credentials or response bodies.
    evidence.facts.modelCatalog = false;
    evidence.reasons.push(options.signal?.aborted ? "discovery_cancelled" : "catalog_unavailable");
  }
  return finish();
}

/** Pure qualification of an exact selection. Apps still own authorization/dispatch. */
export function assessProviderRouteSelection(
  evidence: ProviderRouteEvidence, selection: ProviderRouteSelection, now: Date = new Date(),
): ProviderRouteSelectionAssessment {
  const reasons: ProviderRouteEvidenceReason[] = [...evidence.reasons];
  if (!sameBinding(evidence.binding, selection.binding)) reasons.push("binding_mismatch");
  const at = now.getTime();
  const observedAt = Date.parse(evidence.observedAt);
  const expiresAt = Date.parse(evidence.expiresAt);
  if (!Number.isFinite(at) || !Number.isFinite(observedAt) || !Number.isFinite(expiresAt) || at < observedAt || at >= expiresAt) reasons.push("evidence_stale");
  if (evidence.schemaVersion !== "dzupagent/provider-route-evidence/v1" ||
    ![evidence.facts.configured, evidence.facts.installed, evidence.facts.authenticated,
      evidence.facts.healthy, evidence.facts.modelCatalog].every(value => value === true)) reasons.push("route_unqualified");
  const model = evidence.models.find(item => item.modelId === selection.modelId);
  if (!model) reasons.push("model_unlisted");
  else {
    const operation = model.operations.find(item => item.operation === selection.operation);
    if (operation?.support !== "supported") reasons.push("operation_unqualified");
    if (selection.effort === null) {
      if (operation?.providerDefaultSupported !== true) reasons.push("effort_unqualified");
    } else {
      const qualifiedEfforts = operation?.supportedReasoningEfforts ?? model.supportedReasoningEfforts;
      if (!qualifiedEfforts?.includes(selection.effort) ||
        (model.supportedReasoningEfforts !== null && !model.supportedReasoningEfforts.includes(selection.effort))) reasons.push("effort_unqualified");
    }
  }
  return { qualified: reasons.length === 0, reasons: [...new Set(reasons)] };
}
