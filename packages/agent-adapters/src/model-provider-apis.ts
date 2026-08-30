/**
 * Provider model-list APIs.
 *
 * Talks to the provider's own model endpoints — the Codex app-server page
 * protocol, the OpenAI and Anthropic list-models APIs, and the Anthropic alias
 * resolution built on top of them. Everything here performs I/O; the pure
 * assembly of those answers into a catalog snapshot lives in
 * `model-catalog-builders.ts`.
 *
 * @module model-provider-apis
 */

import type {
  ModelDiscoveryDependencies,
  ProviderModelCatalogEntry,
} from "./model-discovery-types.js";
import {
  assertOk,
  booleanValue,
  numberValue,
  stringArray,
  objectValue,
  stringValue,
} from "./model-discovery-values.js";
import {
  anthropicModelEntry,
  defaultLoadCodexPage,
  fetchWithTimeout,
} from "./model-catalog-builders.js";

export async function listCodexAppServerModels(input: {
  cliPath: string;
  includeHidden: boolean;
  timeoutMs: number;
  dependencies: ModelDiscoveryDependencies;
}): Promise<ProviderModelCatalogEntry[]> {
  const loadPage = input.dependencies.loadCodexPage ?? defaultLoadCodexPage;
  const entries: ProviderModelCatalogEntry[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await loadPage({ ...input, cursor });
    for (const raw of page.data) {
      const model = objectValue(raw);
      const id = stringValue(model["id"]) ?? stringValue(model["model"]);
      if (!id) continue;
      const efforts = Array.isArray(model["supportedReasoningEfforts"])
        ? model["supportedReasoningEfforts"]
            .map((item) => stringValue(objectValue(item)["reasoningEffort"]))
            .filter((value): value is string => Boolean(value))
        : undefined;
      const modalities = stringArray(model["inputModalities"]);
      entries.push({
        providerId: "codex",
        id,
        displayName: stringValue(model["displayName"]) ?? id,
        ...(booleanValue(model["isDefault"]) !== undefined
          ? { isDefault: booleanValue(model["isDefault"]) }
          : {}),
        ...(booleanValue(model["hidden"]) !== undefined
          ? { hidden: booleanValue(model["hidden"]) }
          : {}),
        ...(stringValue(model["defaultReasoningEffort"])
          ? { defaultReasoningEffort: stringValue(model["defaultReasoningEffort"]) }
          : {}),
        ...(efforts?.length ? { supportedReasoningEfforts: efforts } : {}),
        ...(modalities.length ? { inputModalities: modalities } : {}),
        ...(booleanValue(model["supportsPersonality"]) !== undefined
          ? { supportsPersonality: booleanValue(model["supportsPersonality"]) }
          : {}),
        ...(stringValue(model["upgrade"])
          ? { upgrade: stringValue(model["upgrade"]) }
          : {}),
      });
    }
    cursor = page.nextCursor;
    if (cursor) {
      if (seenCursors.has(cursor)) throw new Error("Codex model pagination cursor repeated");
      seenCursors.add(cursor);
    }
  } while (cursor);
  return entries;
}

export async function listOpenAiApiModels(input: {
  apiKey: string;
  apiBaseUrl: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<ProviderModelCatalogEntry[]> {
  const response = await fetchWithTimeout(
    `${input.apiBaseUrl.replace(/\/+$/u, "")}/models`,
    {
      headers: { Authorization: `Bearer ${input.apiKey}` },
    },
    input.timeoutMs,
    input.fetchImpl,
  );
  assertOk(response, "OpenAI Models API");
  const payload = objectValue(await response.json());
  const rows = Array.isArray(payload["data"]) ? payload["data"] : [];
  return rows.flatMap((raw): ProviderModelCatalogEntry[] => {
    const model = objectValue(raw);
    const id = stringValue(model["id"]);
    if (!id) return [];
    const created = numberValue(model["created"]);
    return [
      {
        providerId: "codex",
        id,
        displayName: id,
        ...(created !== undefined
          ? { createdAt: new Date(created * 1000).toISOString() }
          : {}),
      },
    ];
  });
}

export async function listAnthropicApiModels(input: {
  apiKey: string;
  apiBaseUrl: string;
  anthropicVersion: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<ProviderModelCatalogEntry[]> {
  const entries: ProviderModelCatalogEntry[] = [];
  const seenCursors = new Set<string>();
  let afterId: string | null = null;
  for (;;) {
    const url = new URL(`${input.apiBaseUrl.replace(/\/+$/u, "")}/v1/models`);
    url.searchParams.set("limit", "1000");
    if (afterId) url.searchParams.set("after_id", afterId);
    const response = await fetchWithTimeout(
      url.href,
      {
        headers: {
          "x-api-key": input.apiKey,
          "anthropic-version": input.anthropicVersion,
        },
      },
      input.timeoutMs,
      input.fetchImpl,
    );
    assertOk(response, "Anthropic Models API");
    const payload = objectValue(await response.json());
    const rows = Array.isArray(payload["data"]) ? payload["data"] : [];
    for (const raw of rows) {
      const entry = anthropicModelEntry(raw);
      if (entry) entries.push(entry);
    }
    if (payload["has_more"] !== true) break;
    const lastId = stringValue(payload["last_id"]);
    if (!lastId || seenCursors.has(lastId)) {
      throw new Error("Anthropic model pagination returned an invalid cursor");
    }
    seenCursors.add(lastId);
    afterId = lastId;
  }
  return entries;
}

export async function resolveAnthropicApiModelAliases(input: {
  models: readonly ProviderModelCatalogEntry[];
  requestedModelIds: readonly string[];
  apiKey: string;
  apiBaseUrl: string;
  anthropicVersion: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<ProviderModelCatalogEntry[]> {
  const entries = [...input.models];
  const knownIds = new Set(entries.map((model) => model.id.toLowerCase()));
  const requestedIds = [...new Set(input.requestedModelIds)]
    .map((id) => id.trim())
    .filter(
      (id) =>
        /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(id) &&
        !knownIds.has(id.toLowerCase()),
    );
  for (const requestedId of requestedIds) {
    const response = await fetchWithTimeout(
      `${input.apiBaseUrl.replace(/\/+$/u, "")}/v1/models/${encodeURIComponent(requestedId)}`,
      {
        headers: {
          "x-api-key": input.apiKey,
          "anthropic-version": input.anthropicVersion,
        },
      },
      input.timeoutMs,
      input.fetchImpl,
    );
    if (response.status === 404) continue;
    assertOk(response, "Anthropic Models Retrieve API");
    const canonical = anthropicModelEntry(await response.json());
    if (!canonical) {
      throw new Error(
        "Anthropic Models Retrieve API returned an invalid model object",
      );
    }
    if (!knownIds.has(canonical.id.toLowerCase())) {
      entries.push(canonical);
      knownIds.add(canonical.id.toLowerCase());
    }
    entries.push({
      ...canonical,
      id: requestedId,
      alias: true,
      canonicalId: canonical.id,
    });
    knownIds.add(requestedId.toLowerCase());
  }
  return entries;
}
