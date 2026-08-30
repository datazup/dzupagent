/**
 * Catalog assembly for provider model discovery.
 *
 * Turns raw provider observations — ACP catalog payloads, Anthropic model
 * records, CLI output — into validated `ProviderModelCatalog` snapshots. Kept
 * separate from `model-discovery.ts`, which owns how each provider is
 * interrogated, so "how we ask" and "how we assemble the answer" can change
 * independently.
 *
 * @module model-catalog-builders
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type {
  AcpCatalogProviderId,
  CodexPageResult,
  CommandResult,
  DiscoverableProviderId,
  ProviderDefaultExecutionEvidence,
  ProviderModelCatalog,
  ProviderModelCatalogCompleteness,
  ProviderModelCatalogEntry,
  ProviderModelCatalogSource,
  ProviderModelCatalogSourceEvidence,
} from "./model-discovery-types.js";
import {
  booleanValue,
  boundedText,
  crushUnderlyingProviderId,
  execFileAsync,
  modelIdentifier,
  normalizeCatalogModels,
  normalizeIdentifierList,
  normalizeSourceEvidence,
  numberValue,
  objectValue,
  objectValueOrUndefined,
  optionalBoolean,
  positiveInteger,
  providerDisplayName,
  sourceRevisionValue,
  stableJson,
  strictObjectValue,
  stringValue,
} from "./model-discovery-values.js";

export function acpModelEntry(
  providerId: AcpCatalogProviderId,
  raw: unknown,
  index: number,
): ProviderModelCatalogEntry {
  const label = `${providerDisplayName(providerId)} ACP model at index ${index}`;
  const model = strictObjectValue(raw, label);
  const id = modelIdentifier(model["modelId"], `${label}.modelId`);
  if (!id) throw new Error(`${label} omitted modelId`);
  const displayName = boundedText(model["name"], `${label}.name`, 256);
  if (!displayName) throw new Error(`${label} omitted name`);
  const meta =
    model["_meta"] === undefined || model["_meta"] === null
      ? {}
      : strictObjectValue(model["_meta"], `${label}._meta`);
  const supportedReasoningEfforts = normalizeIdentifierList(
    meta["supportedReasoningEfforts"],
    `${label}._meta.supportedReasoningEfforts`,
  );
  const defaultReasoningEffort = modelIdentifier(
    meta["defaultReasoningEffort"],
    `${label}._meta.defaultReasoningEffort`,
    true,
  );
  if (
    defaultReasoningEffort &&
    !supportedReasoningEfforts.some(
      (effort) => effort.toLowerCase() === defaultReasoningEffort.toLowerCase(),
    )
  ) {
    throw new Error(
      `${label} advertised a default reasoning effort outside its supported efforts`,
    );
  }
  const inputModalities = normalizeIdentifierList(
    meta["inputModalities"],
    `${label}._meta.inputModalities`,
  );
  const maxInputTokens = positiveInteger(
    meta["contextLimit"] ?? meta["maxInputTokens"],
    `${label}._meta.contextLimit`,
  );
  const maxOutputTokens = positiveInteger(
    meta["maxOutputTokens"],
    `${label}._meta.maxOutputTokens`,
  );
  const isDefault = optionalBoolean(meta["isDefault"], `${label}._meta.isDefault`);
  const hidden = optionalBoolean(meta["hidden"], `${label}._meta.hidden`);
  return {
    providerId,
    id,
    displayName,
    ...(isDefault !== undefined ? { isDefault } : {}),
    ...(hidden !== undefined ? { hidden } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(supportedReasoningEfforts.length
      ? { supportedReasoningEfforts }
      : {}),
    ...(inputModalities.length ? { inputModalities } : {}),
    ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  };
}

export function createCatalog(input: {
  providerId: DiscoverableProviderId;
  source: ProviderModelCatalogSource;
  completeness: ProviderModelCatalogCompleteness;
  authenticated: boolean | null;
  sourceEvidence?: ProviderModelCatalogSourceEvidence | undefined;
  models: readonly ProviderModelCatalogEntry[];
  providerDefaultExecution?: ProviderDefaultExecutionEvidence | undefined;
  warnings: readonly string[];
  now?: (() => Date) | undefined;
}): ProviderModelCatalog {
  const sourceEvidence = normalizeSourceEvidence(input.sourceEvidence);
  const models = normalizeCatalogModels(
    input.providerId,
    input.models,
    input.completeness === "provider-default",
  );
  const providerDefaultExecution = input.providerDefaultExecution
    ? {
        qualifiedVersion: sourceRevisionValue(
          input.providerDefaultExecution.qualifiedVersion,
          "provider-default qualifiedVersion",
        ),
        ...(input.providerDefaultExecution.underlyingProviderId
          ? {
              underlyingProviderId: crushUnderlyingProviderId(
                input.providerDefaultExecution.underlyingProviderId,
              ),
            }
          : {}),
      }
    : undefined;
  if (input.completeness === "provider-default" && !providerDefaultExecution) {
    throw new Error("Provider-default catalogs require qualified capability evidence");
  }
  const identity = {
    schemaVersion: "dzupagent/provider-model-catalog/v1" as const,
    providerId: input.providerId,
    source: input.source,
    completeness: input.completeness,
    ...(sourceEvidence ?? {}),
    ...(providerDefaultExecution ? { providerDefaultExecution } : {}),
    models,
  };
  return {
    ...identity,
    discoveredAt: (input.now ?? (() => new Date()))().toISOString(),
    authenticated: input.authenticated,
    warnings: [...input.warnings],
    fingerprint: `sha256:${createHash("sha256").update(stableJson(identity)).digest("hex")}`,
  };
}

export function anthropicModelEntry(
  raw: unknown,
): ProviderModelCatalogEntry | null {
  const model = objectValue(raw);
  const id = stringValue(model["id"]);
  if (!id) return null;
  const capabilities = objectValueOrUndefined(model["capabilities"]);
  const effortCapabilities = objectValueOrUndefined(
    capabilities?.["effort"],
  );
  const supportedReasoningEfforts = effortCapabilities
    ? Object.entries(effortCapabilities)
        .filter(
          ([name, value]) =>
            name !== "supported" &&
            booleanValue(objectValue(value)["supported"]) === true,
        )
        .map(([name]) => name)
        .sort()
    : [];
  return {
    providerId: "claude",
    id,
    displayName: stringValue(model["display_name"]) ?? id,
    ...(stringValue(model["created_at"])
      ? { createdAt: stringValue(model["created_at"]) }
      : {}),
    ...(numberValue(model["max_input_tokens"]) !== undefined
      ? { maxInputTokens: numberValue(model["max_input_tokens"]) }
      : {}),
    ...(numberValue(model["max_tokens"]) !== undefined
      ? { maxOutputTokens: numberValue(model["max_tokens"]) }
      : {}),
    ...(supportedReasoningEfforts.length
      ? { supportedReasoningEfforts }
      : {}),
    ...(capabilities ? { capabilities } : {}),
  };
}

export async function defaultRunCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandResult> {
  const result = await execFileAsync(command, [...args], {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

export async function defaultLoadCodexPage(input: {
  cliPath: string;
  cursor: string | null;
  includeHidden: boolean;
  timeoutMs: number;
}): Promise<CodexPageResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.cliPath, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdoutBuffer = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, page?: CodexPageResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(page ?? { data: [], nextCursor: null });
    };
    const timer = setTimeout(
      () => finish(new Error("Codex app-server model discovery timed out")),
      input.timeoutMs,
    );
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (!settled) {
        finish(
          new Error(
            `Codex app-server exited before model discovery completed (code ${code ?? "unknown"}${stderr ? `: ${stderr.slice(0, 512)}` : ""})`,
          ),
        );
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 2048) stderr += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      for (;;) {
        const boundary = stdoutBuffer.indexOf("\n");
        if (boundary < 0) break;
        const line = stdoutBuffer.slice(0, boundary);
        stdoutBuffer = stdoutBuffer.slice(boundary + 1);
        let message: Record<string, unknown>;
        try {
          message = objectValue(JSON.parse(line));
        } catch {
          continue;
        }
        if (message["id"] === 0 && message["result"]) {
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`,
          );
          child.stdin.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              method: "model/list",
              id: 1,
              params: {
                limit: 100,
                includeHidden: input.includeHidden,
                ...(input.cursor ? { cursor: input.cursor } : {}),
              },
            })}\n`,
          );
        } else if (message["id"] === 1) {
          if (message["error"]) {
            finish(
              new Error(
                `Codex app-server model/list failed: ${stringValue(objectValue(message["error"])["message"]) ?? "unknown error"}`,
              ),
            );
            return;
          }
          const result = objectValue(message["result"]);
          finish(undefined, {
            data: Array.isArray(result["data"]) ? result["data"] : [],
            nextCursor: stringValue(result["nextCursor"]) ?? null,
          });
          return;
        }
      }
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        id: 0,
        params: {
          clientInfo: {
            name: "dzupagent_model_discovery",
            title: "DzupAgent Model Discovery",
            version: "0.2.0",
          },
        },
      })}\n`,
    );
  });
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
