/**
 * Leaf value helpers for provider model discovery.
 *
 * Shape checks, coercions and normalizers over untrusted provider output: no
 * knowledge of any particular provider's discovery flow, and no imports from
 * the discovery or catalog-building modules.
 *
 * @module model-discovery-values
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  CrushUnderlyingProviderId,
  DiscoverableProviderId,
  ProviderModelCatalogEntry,
  ProviderModelCatalogSourceEvidence,
} from "./model-discovery-types.js";

/** Shared promisified `execFile` for every provider probe. */
export const execFileAsync = promisify(execFile);

export function assertOk(response: Response, label: string): void {
  if (!response.ok) {
    throw new Error(`${label} request failed with HTTP ${response.status}`);
  }
}

export function normalizeCatalogModels(
  providerId: DiscoverableProviderId,
  entries: readonly ProviderModelCatalogEntry[],
  allowEmpty = false,
): ProviderModelCatalogEntry[] {
  const byId = new Map<string, ProviderModelCatalogEntry>();
  for (const [index, entry] of entries.entries()) {
    const label = `${providerDisplayName(providerId)} catalog model at index ${index}`;
    if (entry.providerId !== providerId) {
      throw new Error(`${label} has a mismatched providerId`);
    }
    const id = modelIdentifier(entry.id, `${label}.id`);
    if (!id) throw new Error(`${label} omitted id`);
    const displayName = boundedText(entry.displayName, `${label}.displayName`, 256);
    if (!displayName) throw new Error(`${label} omitted displayName`);
    const supportedReasoningEfforts = normalizeIdentifierList(
      entry.supportedReasoningEfforts,
      `${label}.supportedReasoningEfforts`,
    );
    const defaultReasoningEffort = modelIdentifier(
      entry.defaultReasoningEffort,
      `${label}.defaultReasoningEffort`,
      true,
    );
    if (
      defaultReasoningEffort &&
      supportedReasoningEfforts.length > 0 &&
      !supportedReasoningEfforts.some(
        (effort) => effort.toLowerCase() === defaultReasoningEffort.toLowerCase(),
      )
    ) {
      throw new Error(
        `${label} has a default reasoning effort outside its supported efforts`,
      );
    }
    const inputModalities = normalizeIdentifierList(
      entry.inputModalities,
      `${label}.inputModalities`,
    );
    const canonicalId = modelIdentifier(
      entry.canonicalId,
      `${label}.canonicalId`,
      true,
    );
    const upgrade = modelIdentifier(entry.upgrade, `${label}.upgrade`, true);
    const maxInputTokens = positiveInteger(
      entry.maxInputTokens,
      `${label}.maxInputTokens`,
    );
    const maxOutputTokens = positiveInteger(
      entry.maxOutputTokens,
      `${label}.maxOutputTokens`,
    );
    const normalized: ProviderModelCatalogEntry = {
      ...entry,
      providerId,
      id,
      displayName,
    };
    if (canonicalId) normalized.canonicalId = canonicalId;
    else delete normalized.canonicalId;
    if (upgrade) normalized.upgrade = upgrade;
    else delete normalized.upgrade;
    if (defaultReasoningEffort) {
      normalized.defaultReasoningEffort = defaultReasoningEffort;
    } else delete normalized.defaultReasoningEffort;
    if (supportedReasoningEfforts.length) {
      normalized.supportedReasoningEfforts = supportedReasoningEfforts;
    } else delete normalized.supportedReasoningEfforts;
    if (inputModalities.length) normalized.inputModalities = inputModalities;
    else delete normalized.inputModalities;
    if (maxInputTokens !== undefined) normalized.maxInputTokens = maxInputTokens;
    else delete normalized.maxInputTokens;
    if (maxOutputTokens !== undefined) normalized.maxOutputTokens = maxOutputTokens;
    else delete normalized.maxOutputTokens;
    const key = id.toLowerCase();
    const prior = byId.get(key);
    if (!prior) {
      byId.set(key, normalized);
      continue;
    }
    if (stableJson(prior) !== stableJson(normalized)) {
      throw new Error(
        `${providerDisplayName(providerId)} catalog contains conflicting duplicate model IDs`,
      );
    }
  }
  if (byId.size === 0 && !allowEmpty) {
    throw new Error(`${providerDisplayName(providerId)} catalog contained no models`);
  }
  const models = [...byId.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  if (models.filter((model) => model.isDefault === true).length > 1) {
    throw new Error(
      `${providerDisplayName(providerId)} catalog advertised multiple default models`,
    );
  }
  return models;
}

export function normalizeIdentifierList(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const result: string[] = [];
  const seen = new Map<string, string>();
  for (const [index, item] of value.entries()) {
    const id = modelIdentifier(item, `${label}[${index}]`);
    if (!id) throw new Error(`${label}[${index}] must not be empty`);
    const key = id.toLowerCase();
    const prior = seen.get(key);
    if (prior && prior !== id) {
      throw new Error(`${label} contains ambiguous case-variant identifiers`);
    }
    if (!prior) {
      seen.set(key, id);
      result.push(id);
    }
  }
  return result;
}

export function normalizeSourceEvidence(
  evidence?: ProviderModelCatalogSourceEvidence,
): ProviderModelCatalogSourceEvidence | undefined {
  if (!evidence) return undefined;
  return {
    installationId: sourceIdentity(
      evidence.installationId,
      "catalog source installationId",
    ),
    backendId: sourceIdentity(evidence.backendId, "catalog source backendId"),
    ...(evidence.sourceRevision
      ? {
          sourceRevision: sourceRevisionValue(
            evidence.sourceRevision,
            "catalog sourceRevision",
          ),
        }
      : {}),
  };
}

export function mergeObservedSourceRevision(
  evidence: ProviderModelCatalogSourceEvidence | undefined,
  observedRevision: string | undefined,
): ProviderModelCatalogSourceEvidence | undefined {
  const normalizedObservedRevision = observedRevision
    ? sourceRevisionValue(observedRevision, "observed CLI sourceRevision")
    : undefined;
  if (!evidence) return undefined;
  const normalized = normalizeSourceEvidence(evidence);
  if (
    normalized?.sourceRevision &&
    normalizedObservedRevision &&
    normalized.sourceRevision !== normalizedObservedRevision
  ) {
    throw new Error("Configured and observed CLI source revisions do not match");
  }
  return {
    ...normalized,
    ...(normalizedObservedRevision
      ? { sourceRevision: normalizedObservedRevision }
      : {}),
  } as ProviderModelCatalogSourceEvidence;
}

export function providerDisplayName(providerId: DiscoverableProviderId): string {
  return providerId === "codex"
    ? "Codex"
    : providerId === "claude"
      ? "Claude"
      : providerId === "gemini"
        ? "Gemini"
        : providerId === "qwen"
          ? "Qwen"
          : "Crush";
}

export function crushUnderlyingProviderId(value: unknown): CrushUnderlyingProviderId {
  if (
    value !== "codex" &&
    value !== "claude" &&
    value !== "gemini" &&
    value !== "qwen"
  ) {
    throw new Error("Crush profile named an unsupported underlying provider");
  }
  return value;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Provider catalog discovery was cancelled");
  }
}

export function strictObjectValue(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function modelIdentifier(
  value: unknown,
  label: string,
  optional = false,
): string | undefined {
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw new Error(`${label} must be a non-empty identifier`);
  }
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:/()+@=-]{0,255}$/u.test(normalized) ||
    normalized.includes("://") ||
    /^[A-Za-z]:\//u.test(normalized)
  ) {
    throw new Error(`${label} must be a safe provider identifier`);
  }
  return normalized;
}

export function boundedText(
  value: unknown,
  label: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maxLength ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)
  ) {
    throw new Error(`${label} must be bounded printable text`);
  }
  return normalized;
}

export function positiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value as number;
}

export function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

export function sourceIdentity(value: unknown, label: string): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id)) {
    throw new Error(`${label} must be a safe opaque identifier`);
  }
  return id;
}

export function sourceRevisionValue(value: unknown, label: string): string {
  const revision = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._+@=-]{0,127}$/u.test(revision)) {
    throw new Error(`${label} must be a safe bounded revision`);
  }
  return revision;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function objectValueOrUndefined(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  const result = objectValue(value);
  return Object.keys(result).length > 0 ? result : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
