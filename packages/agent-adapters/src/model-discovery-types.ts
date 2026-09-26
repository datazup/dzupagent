/**
 * Provider model-discovery and catalog contracts.
 *
 * Declaration-only: the catalog entry/snapshot shapes, the per-provider
 * discovery option types, and the dependency surface discovery runs against.
 * A leaf module, so the discovery implementation, the catalog builders and the
 * value helpers can all depend on it without forming a cycle.
 *
 * `model-discovery.ts` re-exports this module wholesale, so the public
 * surface is unchanged.
 *
 * @module model-discovery-types
 */

import type { ProviderCapabilitySupport } from "@dzupagent/adapter-types/provider-session-explorer";

export type DiscoverableProviderId = "codex" | "claude" | "gemini" | "qwen" | "crush";
export type CrushUnderlyingProviderId = Exclude<DiscoverableProviderId, "crush">;
export type AcpCatalogProviderId = "gemini" | "qwen";
export type ProviderModelCatalogSource =
  | "codex-app-server"
  | "openai-models-api"
  | "anthropic-models-api"
  | "claude-cli"
  | "gemini-cli-acp"
  | "qwen-cli-acp"
  | "crush-profile"
  | "crush-underlying-provider";
export type ProviderModelCatalogCompleteness =
  | "account-catalog"
  | "runtime-catalog"
  | "aliases-only"
  | "provider-default";

export interface ProviderDefaultExecutionEvidence {
  qualifiedVersion: string;
  underlyingProviderId?: CrushUnderlyingProviderId | undefined;
}

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
  providerDefaultExecution?: ProviderDefaultExecutionEvidence | undefined;
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
  /** Additional connector-qualified control evidence; unknown remains the default. */
  controlCapabilities?: Readonly<
    Partial<
      Record<
        "interactions" | "streaming" | "cancellation",
      {
        support: ProviderCapabilitySupport;
        qualifiedVersion?: string | undefined;
        constraints?: Readonly<Record<string, unknown>> | undefined;
      }
      >
    >
  > | undefined;
}


export interface ModelAvailabilityAssessment {
  status: "available" | "unavailable" | "unverified" | "provider-default";
  requestedModel?: string | undefined;
  matchedModel?: ProviderModelCatalogEntry | undefined;
  reason: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface ProviderCliCatalogObservation extends CommandResult {
  authenticated?: boolean | null | undefined;
  sourceRevision?: string | undefined;
}

/** Normalized, secret-free Crush profile evidence supplied by a qualified host connector. */
export interface CrushProfileCatalogObservation {
  underlyingProviderId: CrushUnderlyingProviderId;
  authenticated?: boolean | null | undefined;
  sourceRevision?: string | undefined;
  providerDefaultQualifiedVersion?: string | undefined;
}

export interface CodexPageResult {
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
    env?: Readonly<Record<string, string | undefined>>;
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
  loadCrushProfile?: (input: {
    cliPath: string;
    timeoutMs: number;
    sourceEvidence?: ProviderModelCatalogSourceEvidence | undefined;
    signal?: AbortSignal | undefined;
  }) => Promise<CrushProfileCatalogObservation>;
  discoverCrushUnderlyingProvider?: (input: {
    providerId: CrushUnderlyingProviderId;
    timeoutMs: number;
    sourceEvidence?: ProviderModelCatalogSourceEvidence | undefined;
    signal?: AbortSignal | undefined;
  }) => Promise<ProviderModelCatalog>;
  now?: (() => Date) | undefined;
}

interface SourceScopedModelDiscoveryOptions {
  sourceEvidence?: ProviderModelCatalogSourceEvidence | undefined;
  signal?: AbortSignal | undefined;
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

export interface CrushModelDiscoveryOptions extends SourceScopedModelDiscoveryOptions {
  source?: "profile" | undefined;
  cliPath?: string | undefined;
  timeoutMs?: number | undefined;
  dependencies?: ModelDiscoveryDependencies | undefined;
}

export type ProviderModelDiscoveryOptions =
  | CodexModelDiscoveryOptions
  | ClaudeModelDiscoveryOptions
  | GeminiModelDiscoveryOptions
  | QwenModelDiscoveryOptions
  | CrushModelDiscoveryOptions;

/** An opaque installation/profile or credential scope, never a raw path or key. */
export interface ProviderRouteBinding {
  route: "codex-cli" | "openai-api";
  sourceId: string;
  /** Must change when the executable, profile, credential or configuration changes. */
  sourceRevision: string;
}

export type ProviderRouteOperation = "agent.run" | "chat.generate";

export interface ProviderRouteModelObservation {
  modelId: string;
  operation: ProviderRouteOperation;
  support: ProviderCapabilitySupport;
  supportedReasoningEfforts?: string[] | undefined;
  providerDefaultSupported?: boolean | undefined;
}

/** Trusted connector facts, independently qualified for this exact source/version. */
export interface ProviderRouteObservation {
  binding: ProviderRouteBinding;
  observedAt: string;
  expiresAt: string;
  installed: boolean | null;
  authenticated: boolean | null;
  healthy: boolean | null;
  version?: string | undefined;
  models?: ProviderRouteModelObservation[] | undefined;
}

export interface ProviderRouteDiscoveryOptions {
  binding: ProviderRouteBinding;
  configured: boolean;
  observation?: ProviderRouteObservation | undefined;
  cliPath?: string | undefined;
  env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Explicit API credential; this surface never reads ambient API credentials. */
  apiKey?: string | undefined;
  apiBaseUrl?: string | undefined;
  timeoutMs?: number | undefined;
  ttlMs?: number | undefined;
  signal?: AbortSignal | undefined;
  dependencies?: ModelDiscoveryDependencies | undefined;
}

export type ProviderRouteEvidenceReason =
  | "observation_mismatch" | "observation_stale" | "catalog_unavailable"
  | "discovery_cancelled" | "evidence_stale" | "binding_mismatch"
  | "route_unqualified" | "model_unlisted" | "operation_unqualified" | "effort_unqualified";

export interface ProviderRouteModelEvidence {
  modelId: string;
  /** null means unknown; [] means explicitly no supported effort levels. */
  supportedReasoningEfforts: string[] | null;
  operations: Array<{
    operation: ProviderRouteOperation;
    support: ProviderCapabilitySupport;
    supportedReasoningEfforts: string[] | null;
    providerDefaultSupported: boolean | null;
  }>;
}

/** Discovery evidence, not app authorization or a live-generation receipt. */
export interface ProviderRouteEvidence {
  schemaVersion: "dzupagent/provider-route-evidence/v1";
  providerId: "codex" | "openai";
  binding: ProviderRouteBinding;
  observedAt: string;
  expiresAt: string;
  version: string | null;
  source: "codex-app-server" | "openai-models-api" | null;
  facts: {
    configured: boolean;
    installed: boolean | null;
    authenticated: boolean | null;
    healthy: boolean | null;
    modelCatalog: boolean | null;
  };
  models: ProviderRouteModelEvidence[];
  reasons: ProviderRouteEvidenceReason[];
  fingerprint: string;
}

export interface ProviderRouteSelection {
  binding: ProviderRouteBinding;
  modelId: string;
  operation: ProviderRouteOperation;
  /** null explicitly requests the provider default; it still requires evidence. */
  effort: string | null;
}

export interface ProviderRouteSelectionAssessment {
  qualified: boolean;
  reasons: ProviderRouteEvidenceReason[];
}
