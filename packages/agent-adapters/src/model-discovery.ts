
import {
  validateProviderCatalogSnapshotV2,
  type ProviderCapabilitySupport,
  type ProviderCatalogSnapshotV2,
} from "@dzupagent/adapter-types/provider-session-explorer";


// Declaration-only contracts live in their own leaf module; re-exported here so
// the public surface of this module is unchanged.
export * from "./model-discovery-types.js";

import type {
  AcpCatalogProviderId,
  ClaudeModelDiscoveryOptions,
  CodexModelDiscoveryOptions,
  CrushModelDiscoveryOptions,
  CrushProfileCatalogObservation,
  DiscoverableProviderId,
  GeminiModelDiscoveryOptions,
  ModelAvailabilityAssessment,
  ProviderCatalogV2ProjectionOptions,
  ProviderModelCatalog,
  ProviderModelCatalogEntry,
  ProviderModelDiscoveryOptions,
  QwenModelDiscoveryOptions,
} from "./model-discovery-types.js";
import {
  acpModelEntry,
  createCatalog,
  defaultRunCommand,
} from "./model-catalog-builders.js";
import {
  listAnthropicApiModels,
  listCodexAppServerModels,
  listOpenAiApiModels,
  resolveAnthropicApiModelAliases,
} from "./model-provider-apis.js";
import {
  crushUnderlyingProviderId,
  errorMessage,
  mergeObservedSourceRevision,
  modelIdentifier,
  normalizeCatalogModels,
  normalizeSourceEvidence,
  positiveInteger,
  providerDisplayName,
  sourceRevisionValue,
  strictObjectValue,
  throwIfAborted,
} from "./model-discovery-values.js";

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
          : catalog.completeness === "aliases-only"
            ? "aliases"
            : "partial",
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
      ...(catalog.providerDefaultExecution
        ? {
            provider_default_execution: {
              support: "supported" as const,
              source: catalog.source,
              observedAt: catalog.discoveredAt,
              expiresAt: options.expiresAt,
              qualifiedVersion: catalog.providerDefaultExecution.qualifiedVersion,
              ...(catalog.providerDefaultExecution.underlyingProviderId
                ? {
                    constraints: {
                      underlyingProviderId:
                        catalog.providerDefaultExecution.underlyingProviderId,
                    },
                  }
                : {}),
            },
          }
        : {}),
      ...Object.fromEntries(
        Object.entries(options.controlCapabilities ?? {}).map(([name, evidence]) => [
          name,
          {
            support: evidence.support,
            source: catalog.source,
            observedAt: catalog.discoveredAt,
            expiresAt: options.expiresAt,
            ...(evidence.qualifiedVersion
              ? { qualifiedVersion: evidence.qualifiedVersion }
              : {}),
            ...(evidence.constraints ? { constraints: evidence.constraints } : {}),
          },
        ]),
      ),
    },
    warnings: catalog.warnings,
  };
  return validateProviderCatalogSnapshotV2(projected).valid ? projected : null;
}


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
  providerId: "crush",
  options?: CrushModelDiscoveryOptions,
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
    case "crush":
      return discoverCrushModels(options as CrushModelDiscoveryOptions);
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

export async function discoverCrushModels(
  options: CrushModelDiscoveryOptions = {},
): Promise<ProviderModelCatalog> {
  if (options.source !== undefined && options.source !== "profile") {
    throw new Error("Crush model discovery supports normalized profile observations only");
  }
  const dependencies = options.dependencies ?? {};
  if (!dependencies.loadCrushProfile) {
    throw new Error(
      "Crush model discovery requires an injected normalized profile loader",
    );
  }
  const timeoutMs = positiveInteger(options.timeoutMs ?? 10_000, "Crush catalog timeoutMs") ?? 10_000;
  const sourceEvidence = normalizeSourceEvidence(options.sourceEvidence);
  throwIfAborted(options.signal);
  let observation: CrushProfileCatalogObservation;
  try {
    observation = await dependencies.loadCrushProfile({
      cliPath: options.cliPath ?? "crush",
      timeoutMs,
      ...(sourceEvidence ? { sourceEvidence } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    throwIfAborted(options.signal);
    throw new Error("Crush normalized profile discovery failed", { cause: error });
  }
  throwIfAborted(options.signal);
  const underlyingProviderId = crushUnderlyingProviderId(
    observation.underlyingProviderId,
  );
  const observedEvidence = mergeObservedSourceRevision(
    sourceEvidence,
    observation.sourceRevision,
  );
  const providerDefaultQualifiedVersion = observation.providerDefaultQualifiedVersion
    ? sourceRevisionValue(
        observation.providerDefaultQualifiedVersion,
        "Crush provider-default qualifiedVersion",
      )
    : undefined;

  if (!dependencies.discoverCrushUnderlyingProvider) {
    if (!providerDefaultQualifiedVersion) {
      throw new Error(
        "Crush profile did not provide a qualified underlying catalog or provider-default capability",
      );
    }
    return createCatalog({
      providerId: "crush",
      source: "crush-profile",
      completeness: "provider-default",
      authenticated: observation.authenticated ?? null,
      sourceEvidence: observedEvidence,
      models: [],
      providerDefaultExecution: {
        qualifiedVersion: providerDefaultQualifiedVersion,
        underlyingProviderId,
      },
      warnings: [
        "Crush exposes provider-default execution only; no selectable model IDs were observed.",
      ],
      now: dependencies.now,
    });
  }

  let underlying: ProviderModelCatalog;
  try {
    underlying = await dependencies.discoverCrushUnderlyingProvider({
      providerId: underlyingProviderId,
      timeoutMs,
      ...(sourceEvidence ? { sourceEvidence } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    throwIfAborted(options.signal);
    throw new Error("Crush underlying provider discovery failed", { cause: error });
  }
  throwIfAborted(options.signal);
  if (underlying.providerId !== underlyingProviderId) {
    throw new Error("Crush underlying discovery returned a mismatched provider");
  }
  const compoundModels = underlying.models.map((model) => ({
    ...model,
    providerId: "crush" as const,
    id: `${underlyingProviderId}/${model.id}`,
    displayName: `${providerDisplayName(underlyingProviderId)} / ${model.displayName}`,
    ...(model.canonicalId
      ? { canonicalId: `${underlyingProviderId}/${model.canonicalId}` }
      : {}),
  }));
  return createCatalog({
    providerId: "crush",
    source: "crush-underlying-provider",
    completeness: "runtime-catalog",
    authenticated: observation.authenticated ?? underlying.authenticated,
    sourceEvidence: observedEvidence,
    models: compoundModels,
    ...(providerDefaultQualifiedVersion
      ? {
          providerDefaultExecution: {
            qualifiedVersion: providerDefaultQualifiedVersion,
            underlyingProviderId,
          },
        }
      : {}),
    warnings:
      underlying.warnings.length > 0
        ? ["Crush underlying catalog reported diagnostics; raw diagnostics were not retained."]
        : [],
    now: dependencies.now,
  });
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
    if (!catalog.providerDefaultExecution) {
      return {
        status: "unverified",
        ...(defaultModel ? { matchedModel: defaultModel } : {}),
        reason:
          "No model was pinned and provider-default execution has no qualified capability evidence",
      };
    }
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
