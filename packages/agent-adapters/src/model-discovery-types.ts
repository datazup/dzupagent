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
