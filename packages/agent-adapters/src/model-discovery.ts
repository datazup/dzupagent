import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { promisify } from "node:util";

import {
  validateProviderCatalogSnapshotV2,
  type ProviderCapabilitySupport,
  type ProviderCatalogSnapshotV2,
} from "@dzupagent/adapter-types/provider-session-explorer";

const execFileAsync = promisify(execFile);

export type DiscoverableProviderId = "codex" | "claude" | "gemini" | "qwen";
export type AcpCatalogProviderId = "gemini" | "qwen";
export type ProviderModelCatalogSource =
  | "codex-app-server"
  | "openai-models-api"
  | "anthropic-models-api"
  | "claude-cli"
  | "gemini-cli-acp"
  | "qwen-cli-acp";
export type ProviderModelCatalogCompleteness =
  | "account-catalog"
  | "runtime-catalog"
  | "aliases-only";

export interface ProviderModelCatalogEntry {
  providerId: DiscoverableProviderId;
  id: string;
  displayName: string;
  createdAt?: string | undefined;
  isDefault?: boolean | undefined;
  hidden?: boolean | undefined;
  alias?: boolean | undefined;
  canonicalId?: string | undefined;
  defaultReasoningEffort?: string | undefined;
  supportedReasoningEfforts?: readonly string[] | undefined;
  inputModalities?: readonly string[] | undefined;
  supportsPersonality?: boolean | undefined;
  upgrade?: string | undefined;
  maxInputTokens?: number | undefined;
  maxOutputTokens?: number | undefined;
  capabilities?: Readonly<Record<string, unknown>> | undefined;
}

export interface ProviderModelCatalog {
  schemaVersion: "dzupagent/provider-model-catalog/v1";
  providerId: DiscoverableProviderId;
  source: ProviderModelCatalogSource;
  completeness: ProviderModelCatalogCompleteness;
  discoveredAt: string;
  authenticated: boolean | null;
  installationId?: string | undefined;
  backendId?: string | undefined;
  sourceRevision?: string | undefined;
  models: readonly ProviderModelCatalogEntry[];
  warnings: readonly string[];
  fingerprint: string;
}

/**
 * Safe identity for the provider installation/backend that produced a catalog.
 * Raw executable paths, environment values, and CLI output never belong here.
 */
export interface ProviderModelCatalogSourceEvidence {
  installationId: string;
  backendId: string;
  sourceRevision?: string | undefined;
}

export interface ProviderCatalogV2ProjectionOptions {
  /** Bounded freshness selected by the product policy; ISO-8601. */
  expiresAt: string;
  /** Connector-qualified resume truth. Unknown is the fail-closed default. */
  nativeResumeSupport?: ProviderCapabilitySupport | undefined;
  nativeResumeQualifiedVersion?: string | undefined;
}

/**
 * Projects provider discovery into the shared browser-safe catalog boundary.
 * Returns null when installation identity, timestamps, or public fields do not
 * satisfy that boundary; it never invents a model, effort, or resume claim.
 */
export function projectProviderModelCatalogV2(
  catalog: ProviderModelCatalog,
  options: ProviderCatalogV2ProjectionOptions,
): ProviderCatalogSnapshotV2 | null {
  if (!catalog.installationId || !catalog.backendId) return null;
  const nativeResumeSupport = options.nativeResumeSupport ?? "unknown";
  const models = catalog.models.map((model) => {
    const efforts = (model.supportedReasoningEfforts ?? []).map((effort) => ({
      effortId: effort,
      displayName: effort,
      nativeValue: effort,
      source: catalog.source,
      confidence: "observed" as const,
    }));
    const defaultEffortId =
      model.defaultReasoningEffort && efforts.some((effort) => effort.effortId === model.defaultReasoningEffort)
        ? model.defaultReasoningEffort
        : undefined;
    return {
      modelId: model.id,
      displayName: model.displayName,
      isDefault: model.isDefault === true,
      ...(model.hidden !== undefined ? { hidden: model.hidden } : {}),
      efforts,
      ...(defaultEffortId ? { defaultEffortId } : {}),
      ...(model.maxInputTokens !== undefined ? { maxInputTokens: model.maxInputTokens } : {}),
      ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
    };
  });
  const modelCatalogSupport: ProviderCapabilitySupport =
    catalog.authenticated === true && models.length > 0 ? "supported" : "unknown";
  const projected: ProviderCatalogSnapshotV2 = {
    schemaVersion: "codev/provider-catalog/v2",
    providerId: catalog.providerId,
    installationId: catalog.installationId,
    backendId: catalog.backendId,
    source: catalog.source,
    ...(catalog.sourceRevision ? { sourceRevision: catalog.sourceRevision } : {}),
    observedAt: catalog.discoveredAt,
    expiresAt: options.expiresAt,
    fingerprint: catalog.fingerprint,
    authenticated: catalog.authenticated,
    completeness:
      catalog.completeness === "account-catalog"
        ? "account"
        : catalog.completeness === "runtime-catalog"
          ? "runtime"
          : "aliases",
    confidence: "observed",
    models,
    capabilities: {
      modelCatalog: {
        support: modelCatalogSupport,
        source: catalog.source,
        observedAt: catalog.discoveredAt,
        expiresAt: options.expiresAt,
      },
      native_resume: {
        support: nativeResumeSupport,
        source: catalog.source,
        observedAt: catalog.discoveredAt,
        expiresAt: options.expiresAt,
        ...(options.nativeResumeQualifiedVersion
          ? { qualifiedVersion: options.nativeResumeQualifiedVersion }
          : {}),
      },
    },
    warnings: catalog.warnings,
  };
  return validateProviderCatalogSnapshotV2(projected).valid ? projected : null;
}

export interface ModelAvailabilityAssessment {
  status: "available" | "unavailable" | "unverified" | "provider-default";
  requestedModel?: string | undefined;
  matchedModel?: ProviderModelCatalogEntry | undefined;
  reason: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface ProviderCliCatalogObservation extends CommandResult {
  authenticated?: boolean | null | undefined;
  sourceRevision?: string | undefined;
}

interface CodexPageResult {
  data: unknown[];
  nextCursor: string | null;
}

export interface ModelDiscoveryDependencies {
  fetch?: typeof fetch | undefined;
  runCommand?: (
    command: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<CommandResult>;
  loadCodexPage?: (input: {
    cliPath: string;
    cursor: string | null;
    includeHidden: boolean;
    timeoutMs: number;
  }) => Promise<CodexPageResult>;
  /**
   * Loads a bounded ACP catalog observation from an already-qualified CLI
   * connector. There is deliberately no implicit subprocess fallback: Gemini
   * and Qwen ACP catalog reads currently require session-oriented execution,
   * so callers must inject a connector that owns those lifecycle effects.
   */
  loadCliCatalog?: (input: {
    providerId: AcpCatalogProviderId;
    cliPath: string;
    timeoutMs: number;
    sourceEvidence?: ProviderModelCatalogSourceEvidence | undefined;
  }) => Promise<ProviderCliCatalogObservation>;
  now?: (() => Date) | undefined;
}

interface SourceScopedModelDiscoveryOptions {
  sourceEvidence?: ProviderModelCatalogSourceEvidence | undefined;
}

export interface CodexModelDiscoveryOptions extends SourceScopedModelDiscoveryOptions {
  source?: "auto" | "app-server" | "openai-api" | undefined;
  cliPath?: string | undefined;
  apiKey?: string | undefined;
  apiBaseUrl?: string | undefined;
  includeHidden?: boolean | undefined;
  timeoutMs?: number | undefined;
  env?: Readonly<Record<string, string | undefined>> | undefined;
  dependencies?: ModelDiscoveryDependencies | undefined;
}

export interface ClaudeModelDiscoveryOptions extends SourceScopedModelDiscoveryOptions {
  source?: "auto" | "anthropic-api" | "cli" | undefined;
  cliPath?: string | undefined;
  apiKey?: string | undefined;
  apiBaseUrl?: string | undefined;
  anthropicVersion?: string | undefined;
  resolveModelIds?: readonly string[] | undefined;
  timeoutMs?: number | undefined;
  env?: Readonly<Record<string, string | undefined>> | undefined;
  dependencies?: ModelDiscoveryDependencies | undefined;
}

export interface GeminiModelDiscoveryOptions extends SourceScopedModelDiscoveryOptions {
  source?: "acp" | undefined;
  cliPath?: string | undefined;
  timeoutMs?: number | undefined;
  dependencies?: ModelDiscoveryDependencies | undefined;
}

export interface QwenModelDiscoveryOptions extends SourceScopedModelDiscoveryOptions {
  source?: "acp" | undefined;
  cliPath?: string | undefined;
  timeoutMs?: number | undefined;
  dependencies?: ModelDiscoveryDependencies | undefined;
}

export type ProviderModelDiscoveryOptions =
  | CodexModelDiscoveryOptions
  | ClaudeModelDiscoveryOptions
  | GeminiModelDiscoveryOptions
  | QwenModelDiscoveryOptions;

export async function discoverProviderModels(
  providerId: "codex",
  options?: CodexModelDiscoveryOptions,
): Promise<ProviderModelCatalog>;
export async function discoverProviderModels(
  providerId: "claude",
  options?: ClaudeModelDiscoveryOptions,
): Promise<ProviderModelCatalog>;
export async function discoverProviderModels(
  providerId: "gemini",
  options?: GeminiModelDiscoveryOptions,
): Promise<ProviderModelCatalog>;
export async function discoverProviderModels(
  providerId: "qwen",
  options?: QwenModelDiscoveryOptions,
): Promise<ProviderModelCatalog>;
export async function discoverProviderModels(
  providerId: DiscoverableProviderId,
  options: ProviderModelDiscoveryOptions = {},
): Promise<ProviderModelCatalog> {
  switch (providerId) {
    case "codex":
      return discoverCodexModels(options as CodexModelDiscoveryOptions);
    case "claude":
      return discoverClaudeModels(options as ClaudeModelDiscoveryOptions);
    case "gemini":
      return discoverGeminiModels(options as GeminiModelDiscoveryOptions);
    case "qwen":
      return discoverQwenModels(options as QwenModelDiscoveryOptions);
  }
}

export async function discoverCodexModels(
  options: CodexModelDiscoveryOptions = {},
): Promise<ProviderModelCatalog> {
  const source = options.source ?? "auto";
  // App-server startup (bundled sandbox bootstrap) can exceed 10s on a loaded
  // host; a timeout here fails provider preflight for otherwise-healthy runs.
  const timeoutMs = options.timeoutMs ?? 30_000;
  const dependencies = options.dependencies ?? {};
  const sourceEvidence = normalizeSourceEvidence(options.sourceEvidence);
  const warnings: string[] = [];

  if (source === "auto" || source === "app-server") {
    try {
      const models = await listCodexAppServerModels({
        cliPath: options.cliPath ?? "codex",
        includeHidden: options.includeHidden ?? false,
        timeoutMs,
        dependencies,
      });
      return createCatalog({
        providerId: "codex",
        source: "codex-app-server",
        completeness: "runtime-catalog",
        authenticated: true,
        sourceEvidence,
        models,
        warnings,
        now: dependencies.now,
      });
    } catch (error) {
      if (source === "app-server") throw error;
      warnings.push(`Codex app-server discovery failed: ${errorMessage(error)}`);
    }
  }

  const env = options.env ?? process.env;
  const apiKey = options.apiKey ?? env["OPENAI_API_KEY"];
  if ((source === "auto" || source === "openai-api") && apiKey) {
    const models = await listOpenAiApiModels({
      apiKey,
      apiBaseUrl: options.apiBaseUrl ?? env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1",
      timeoutMs,
      fetchImpl: dependencies.fetch ?? fetch,
    });
    return createCatalog({
      providerId: "codex",
      source: "openai-models-api",
      completeness: "account-catalog",
      authenticated: true,
      sourceEvidence,
      models,
      warnings: [
        ...warnings,
        "OpenAI Models API availability does not by itself prove Codex runtime compatibility.",
      ],
      now: dependencies.now,
    });
  }

  if (source === "openai-api") {
    throw new Error("OPENAI_API_KEY is required for OpenAI Models API discovery");
  }
  throw new Error(
    warnings[0] ??
      "Codex model discovery requires an authenticated Codex app-server or OPENAI_API_KEY",
  );
}

export async function discoverClaudeModels(
  options: ClaudeModelDiscoveryOptions = {},
): Promise<ProviderModelCatalog> {
  const source = options.source ?? "auto";
  const timeoutMs = options.timeoutMs ?? 10_000;
  const dependencies = options.dependencies ?? {};
  const sourceEvidence = normalizeSourceEvidence(options.sourceEvidence);
  const env = options.env ?? process.env;
  const apiKey = options.apiKey ?? env["ANTHROPIC_API_KEY"];
  const warnings: string[] = [];

  if ((source === "auto" || source === "anthropic-api") && apiKey) {
    try {
      const models = await listAnthropicApiModels({
        apiKey,
        apiBaseUrl:
          options.apiBaseUrl ??
          env["ANTHROPIC_BASE_URL"] ??
          "https://api.anthropic.com",
        anthropicVersion: options.anthropicVersion ?? "2023-06-01",
        timeoutMs,
        fetchImpl: dependencies.fetch ?? fetch,
      });
      const resolvedModels = await resolveAnthropicApiModelAliases({
        models,
        requestedModelIds: options.resolveModelIds ?? [],
        apiKey,
        apiBaseUrl:
          options.apiBaseUrl ??
          env["ANTHROPIC_BASE_URL"] ??
          "https://api.anthropic.com",
        anthropicVersion: options.anthropicVersion ?? "2023-06-01",
        timeoutMs,
        fetchImpl: dependencies.fetch ?? fetch,
      });
      return createCatalog({
        providerId: "claude",
        source: "anthropic-models-api",
        completeness: "account-catalog",
        authenticated: true,
        sourceEvidence,
        models: resolvedModels,
        warnings,
        now: dependencies.now,
      });
    } catch (error) {
      if (source === "anthropic-api") throw error;
      warnings.push(`Anthropic Models API discovery failed: ${errorMessage(error)}`);
    }
  } else if (source === "anthropic-api") {
    throw new Error("ANTHROPIC_API_KEY is required for Anthropic Models API discovery");
  }

  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const cliPath = options.cliPath ?? "claude";
  let authenticated = false;
  try {
    await runCommand(cliPath, ["auth", "status"], timeoutMs);
    authenticated = true;
  } catch (error) {
    warnings.push(`Claude CLI authentication probe failed: ${errorMessage(error)}`);
  }
  const help = await runCommand(cliPath, ["--help"], timeoutMs);
  const models = parseClaudeCliModelAliases(help.stdout);
  if (models.length === 0) {
    throw new Error("Claude CLI help did not advertise any provider-maintained model aliases");
  }
  warnings.push(
    "Claude CLI discovery exposes provider-maintained aliases only; use ANTHROPIC_API_KEY for the complete account model catalog.",
  );
  return createCatalog({
    providerId: "claude",
    source: "claude-cli",
    completeness: "aliases-only",
    authenticated,
    sourceEvidence,
    models,
    warnings,
    now: dependencies.now,
  });
}

export async function discoverGeminiModels(
  options: GeminiModelDiscoveryOptions = {},
): Promise<ProviderModelCatalog> {
  return discoverAcpCliModels("gemini", options);
}

export async function discoverQwenModels(
  options: QwenModelDiscoveryOptions = {},
): Promise<ProviderModelCatalog> {
  return discoverAcpCliModels("qwen", options);
}

async function discoverAcpCliModels(
  providerId: AcpCatalogProviderId,
  options: GeminiModelDiscoveryOptions | QwenModelDiscoveryOptions,
): Promise<ProviderModelCatalog> {
  if (options.source !== undefined && options.source !== "acp") {
    throw new Error(
      `${providerDisplayName(providerId)} model discovery supports ACP observations only`,
    );
  }
  const dependencies = options.dependencies ?? {};
  const loadCliCatalog = dependencies.loadCliCatalog;
  if (!loadCliCatalog) {
    throw new Error(
      `${providerDisplayName(providerId)} CLI catalog discovery requires an injected ACP catalog loader`,
    );
  }
  const configuredSourceEvidence = normalizeSourceEvidence(
    options.sourceEvidence,
  );
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? 10_000,
    `${providerDisplayName(providerId)} catalog timeoutMs`,
  );
  const observation = await loadCliCatalog({
    providerId,
    cliPath: options.cliPath ?? providerId,
    timeoutMs: timeoutMs ?? 10_000,
    ...(configuredSourceEvidence
      ? { sourceEvidence: configuredSourceEvidence }
      : {}),
  });
  if (
    typeof observation.stdout !== "string" ||
    typeof observation.stderr !== "string"
  ) {
    throw new Error(
      `${providerDisplayName(providerId)} CLI catalog loader returned an invalid observation`,
    );
  }
  if (
    observation.authenticated !== undefined &&
    observation.authenticated !== null &&
    typeof observation.authenticated !== "boolean"
  ) {
    throw new Error(
      `${providerDisplayName(providerId)} CLI catalog loader returned invalid authentication evidence`,
    );
  }
  const models = parseAcpModelCatalogObservation(providerId, observation.stdout);
  const warnings: string[] = [];
  if (observation.stderr.trim()) {
    warnings.push(
      `${providerDisplayName(providerId)} CLI catalog observation emitted diagnostics; raw diagnostics were not retained.`,
    );
  }
  const sourceEvidence = mergeObservedSourceRevision(
    configuredSourceEvidence,
    observation.sourceRevision,
  );
  if (observation.sourceRevision && !sourceEvidence) {
    warnings.push(
      `${providerDisplayName(providerId)} CLI source revision was observed without installation/backend scope and was not retained.`,
    );
  }
  return createCatalog({
    providerId,
    source: providerId === "gemini" ? "gemini-cli-acp" : "qwen-cli-acp",
    completeness: "runtime-catalog",
    authenticated: observation.authenticated ?? null,
    sourceEvidence,
    models,
    warnings,
    now: dependencies.now,
  });
}

export function assessModelAvailability(
  catalog: ProviderModelCatalog,
  requestedModel?: string,
): ModelAvailabilityAssessment {
  const normalized = requestedModel?.trim();
  if (!normalized) {
    const defaultModel = catalog.models.find((model) => model.isDefault === true);
    return {
      status: "provider-default",
      ...(defaultModel ? { matchedModel: defaultModel } : {}),
      reason: defaultModel
        ? `Provider runtime advertises ${defaultModel.id} as its default model`
        : "No model was pinned; selection remains owned by the provider runtime",
    };
  }
  const matchedModel = catalog.models.find(
    (model) => model.id.toLowerCase() === normalized.toLowerCase(),
  );
  if (matchedModel) {
    return {
      status: "available",
      requestedModel: normalized,
      matchedModel,
      reason: `Model is present in the ${catalog.source} catalog`,
    };
  }
  if (catalog.completeness === "aliases-only") {
    return {
      status: "unverified",
      requestedModel: normalized,
      reason:
        "The local Claude catalog contains aliases only; absence does not prove the full model ID is unavailable",
    };
  }
  if (catalog.source === "openai-models-api") {
    return {
      status: "unverified",
      requestedModel: normalized,
      reason:
        "The OpenAI account catalog does not prove which models the Codex runtime accepts",
    };
  }
  return {
    status: "unavailable",
    requestedModel: normalized,
    reason: `Model is absent from the complete ${catalog.source} catalog`,
  };
}

export function parseClaudeCliModelAliases(
  helpText: string,
): ProviderModelCatalogEntry[] {
  const modelSection = helpText.match(
    /--model <model>([\s\S]*?)(?=\n\s{2,}--[a-zA-Z]|\nCommands:|$)/u,
  )?.[1];
  if (!modelSection) return [];
  const candidates = [
    ...modelSection.matchAll(
      /'([A-Za-z0-9][A-Za-z0-9._:/-]{0,127})'/gu,
    ),
  ].map((match) => match[1] ?? "");
  return [...new Set(candidates)].map((id) => ({
    providerId: "claude" as const,
    id,
    displayName: id,
    alias: !id.startsWith("claude-"),
  }));
}

/**
 * Parses the JSON-RPC/NDJSON session model projection emitted by Gemini and
 * Qwen ACP connectors. The current model is intentionally not promoted to a
 * provider default: it is mutable session state, not catalog-default evidence.
 */
export function parseAcpModelCatalogObservation(
  providerId: AcpCatalogProviderId,
  output: string,
): ProviderModelCatalogEntry[] {
  if (Buffer.byteLength(output, "utf8") > 1024 * 1024) {
    throw new Error(`${providerDisplayName(providerId)} ACP catalog output exceeded 1 MiB`);
  }
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new Error(`${providerDisplayName(providerId)} ACP catalog output was empty`);
  }

  const candidates: Record<string, unknown>[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(
        `${providerDisplayName(providerId)} ACP catalog output contained malformed JSON`,
      );
    }
    const message = strictObjectValue(
      parsed,
      `${providerDisplayName(providerId)} ACP message`,
    );
    if (message["jsonrpc"] !== "2.0") {
      throw new Error(
        `${providerDisplayName(providerId)} ACP catalog output contained a non-JSON-RPC message`,
      );
    }
    if (message["error"] !== undefined) {
      throw new Error(
        `${providerDisplayName(providerId)} ACP catalog observation reported an error`,
      );
    }
    if (message["result"] === undefined) continue;
    if (
      (typeof message["id"] !== "string" &&
        typeof message["id"] !== "number") ||
      (typeof message["id"] === "number" && !Number.isSafeInteger(message["id"]))
    ) {
      throw new Error(
        `${providerDisplayName(providerId)} ACP result omitted a valid response id`,
      );
    }
    const result = strictObjectValue(
      message["result"],
      `${providerDisplayName(providerId)} ACP result`,
    );
    if (result["models"] === undefined || result["models"] === null) continue;
    candidates.push(
      strictObjectValue(
        result["models"],
        `${providerDisplayName(providerId)} ACP models result`,
      ),
    );
  }
  if (candidates.length !== 1) {
    throw new Error(
      candidates.length === 0
        ? `${providerDisplayName(providerId)} ACP output did not contain a model catalog`
        : `${providerDisplayName(providerId)} ACP output contained ambiguous model catalogs`,
    );
  }

  const catalog = candidates[0] ?? {};
  const currentModelId = modelIdentifier(
    catalog["currentModelId"],
    `${providerDisplayName(providerId)} ACP currentModelId`,
  );
  if (!currentModelId) {
    throw new Error(
      `${providerDisplayName(providerId)} ACP model catalog omitted currentModelId`,
    );
  }
  if (!Array.isArray(catalog["availableModels"])) {
    throw new Error(
      `${providerDisplayName(providerId)} ACP model catalog omitted availableModels`,
    );
  }
  const entries = catalog["availableModels"].map((raw, index) =>
    acpModelEntry(providerId, raw, index),
  );
  return normalizeCatalogModels(providerId, entries);
}

function acpModelEntry(
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

function createCatalog(input: {
  providerId: DiscoverableProviderId;
  source: ProviderModelCatalogSource;
  completeness: ProviderModelCatalogCompleteness;
  authenticated: boolean | null;
  sourceEvidence?: ProviderModelCatalogSourceEvidence | undefined;
  models: readonly ProviderModelCatalogEntry[];
  warnings: readonly string[];
  now?: (() => Date) | undefined;
}): ProviderModelCatalog {
  const sourceEvidence = normalizeSourceEvidence(input.sourceEvidence);
  const models = normalizeCatalogModels(input.providerId, input.models);
  const identity = {
    schemaVersion: "dzupagent/provider-model-catalog/v1" as const,
    providerId: input.providerId,
    source: input.source,
    completeness: input.completeness,
    ...(sourceEvidence ?? {}),
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

async function listCodexAppServerModels(input: {
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

async function listOpenAiApiModels(input: {
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

async function listAnthropicApiModels(input: {
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

async function resolveAnthropicApiModelAliases(input: {
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

function anthropicModelEntry(
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

async function defaultRunCommand(
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

async function defaultLoadCodexPage(input: {
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

async function fetchWithTimeout(
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

function assertOk(response: Response, label: string): void {
  if (!response.ok) {
    throw new Error(`${label} request failed with HTTP ${response.status}`);
  }
}

function normalizeCatalogModels(
  providerId: DiscoverableProviderId,
  entries: readonly ProviderModelCatalogEntry[],
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
  if (byId.size === 0) {
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

function normalizeIdentifierList(value: unknown, label: string): string[] {
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

function normalizeSourceEvidence(
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

function mergeObservedSourceRevision(
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

function providerDisplayName(providerId: DiscoverableProviderId): string {
  return providerId === "codex"
    ? "Codex"
    : providerId === "claude"
      ? "Claude"
      : providerId === "gemini"
        ? "Gemini"
        : "Qwen";
}

function strictObjectValue(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function modelIdentifier(
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

function boundedText(
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

function positiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function sourceIdentity(value: unknown, label: string): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id)) {
    throw new Error(`${label} must be a safe opaque identifier`);
  }
  return id;
}

function sourceRevisionValue(value: unknown, label: string): string {
  const revision = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._+@=-]{0,127}$/u.test(revision)) {
    throw new Error(`${label} must be a safe bounded revision`);
  }
  return revision;
}

function stableJson(value: unknown): string {
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

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function objectValueOrUndefined(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  const result = objectValue(value);
  return Object.keys(result).length > 0 ? result : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
