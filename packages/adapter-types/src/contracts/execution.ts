import type { InteractionPolicy } from "./interaction.js";
import type { AgentEvent, AgentStreamEvent } from "./events.js";
import type { AdapterProviderId } from "./provider.js";
import type { TokenUsage } from "./token-usage.js";

export type { TokenUsage };

/** Per-run policy conformance handling mode. */
export type AgentPolicyConformanceMode = "strict" | "warn-only";

/** Provider-agnostic policy declaration carried on AgentInput. */
export interface AgentInputPolicy {
  sandboxMode?: "read-only" | "workspace-write" | "full-access" | undefined;
  networkAccess?: boolean | undefined;
  approvalRequired?: boolean | undefined;
  toolPolicy?: "strict" | "balanced" | "open" | undefined;
  allowedTools?: string[] | undefined;
  blockedTools?: string[] | undefined;
  maxBudgetUsd?: number | undefined;
  maxTurns?: number | undefined;
}

/** Guardrail overlay derived from policy compilation/projection. */
export interface AgentPolicyGuardrailHints {
  maxIterations?: number | undefined;
  maxCostCents?: number | undefined;
  blockedTools?: string[] | undefined;
}

/**
 * Structural adapter transport for the canonical
 * `@dzupagent/execution-contracts` SignedExecutionPolicy. Adapter types remain
 * a layer-0 leaf and deliberately do not construct or validate this envelope.
 */
export interface AgentSignedExecutionPolicy {
  policy: {
    version: string;
    policyId: string;
    issuedAt?: string | undefined;
    expiresAt?: string | undefined;
    cpuShares?: number | undefined;
    memoryMb?: number | undefined;
    pidLimit?: number | undefined;
    wallTimeSec: number;
    scratchMb?: number | undefined;
    maxCostUsd?: number | undefined;
    egressGrants: readonly { provider: string; label: string }[];
  };
  catalog: {
    version: string;
    digest: string;
    entries: readonly {
      binary: string;
      allowedArgs?: readonly string[] | undefined;
      workdirPolicy: "checkout-only" | "any";
      envAllowlist?: readonly string[] | undefined;
    }[];
  };
  signature: string;
}

/** Typed per-run policy metadata transport for execution routing. */
export interface AgentPolicyExecutionContext {
  activePolicy?: AgentInputPolicy | undefined;
  conformanceMode?: AgentPolicyConformanceMode | undefined;
  projectedGuardrails?: AgentPolicyGuardrailHints | undefined;
  conformanceWarnings?: string[] | undefined;
  /** Digest-sealed host resource policy carried unchanged through the adapter boundary. */
  executionPolicy?: AgentSignedExecutionPolicy | undefined;
}

/** Exact provider-neutral control required before a zero-tool dispatch. */
export interface AdapterExecutionControlRequirement {
  readonly schema: "dzupagent/adapter-execution-control-requirement/v1";
  readonly tools: { readonly mode: "none" };
}

/** Effect-free adapter admission for one exact execution-control requirement. */
export interface AdapterExecutionControlAdmission {
  readonly schema: "dzupagent/adapter-execution-control-admission/v1";
  readonly status: "admitted" | "rejected";
  readonly providerId: AdapterProviderId;
  readonly requirementSha256: string;
  readonly tools: {
    readonly mode: "none";
    readonly enforcement: "provider-pre-dispatch" | "unsupported";
  };
  readonly blockers: readonly string[];
  readonly effects: {
    readonly credentialReads: 0;
    readonly networkAttempts: 0;
    readonly providerDispatches: 0;
    readonly providerSpendUsd: 0;
  };
}

/** Opaque provider identity keys accepted by restart lookup implementations. */
export type ProviderRequestLookupKey =
  | "idempotencyKey"
  | "requestId"
  | "sessionId"
  | "responseId";

/** Where an accepted provider-request idempotency key is actually enforced. */
export type ProviderRequestIdempotencyEnforcement =
  | "provider"
  | "gateway"
  | "adapter"
  | "controller-local"
  | "none";

/**
 * Optional provider request-correlation capability.
 *
 * Resume support alone does not imply either idempotency or restart lookup.
 * Adapters must declare only behavior that the selected backend can perform
 * without starting another inference request.
 */
export interface ProviderRequestCorrelationCapability {
  idempotencyKey: {
    accepted: boolean;
    enforcement: ProviderRequestIdempotencyEnforcement;
  };
  restartLookup: {
    supported: boolean;
    lookupBy: readonly ProviderRequestLookupKey[];
  };
}

/** Bounded input used to inspect one retained provider attempt after restart. */
export interface ProviderRequestLookupInput {
  idempotencyKey?: string | undefined;
  requestId?: string | undefined;
  sessionId?: string | undefined;
  responseId?: string | undefined;
}

/**
 * Content-free restart lookup result. Provider prompts and responses are never
 * part of this contract.
 */
export interface ProviderRequestLookupResult {
  state: "terminal" | "in_flight" | "unknown";
  outcome?: "completed" | "failed" | "cancelled" | undefined;
  requestId?: string | undefined;
  sessionId?: string | undefined;
  responseId?: string | undefined;
  usage?:
    | {
        inputTokens?: number | undefined;
        outputTokens?: number | undefined;
        costUsd?: number | undefined;
      }
    | undefined;
}

/** Runtime capability declaration for adapter behavior. */
export interface AdapterCapabilityProfile {
  supportsResume: boolean;
  supportsFork: boolean;
  /**
   * @deprecated Ambiguous -- split into {@link emitsToolCalls} and
   * {@link executesToolLoop}. Retained for backwards compatibility. Reading
   * this flag to decide whether an adapter can *autonomously complete* a
   * tool-using task is incorrect for fetch-based adapters (openai, openrouter,
   * ollama), which surface tool_call deltas but do not execute tools or
   * re-invoke the model. Use {@link executesToolLoop} for that decision.
   */
  supportsToolCalls: boolean;
  /**
   * The adapter surfaces provider tool_call deltas/events to the host. True for
   * fetch adapters (openai, openrouter, ollama) and for CLI/SDK adapters that
   * expose tool activity. Does NOT imply the adapter executes those tools.
   */
  emitsToolCalls?: boolean | undefined;
  /**
   * The adapter itself executes tools and re-invokes the model until the task
   * completes (an autonomous tool-use loop). True only for CLI or SDK-managed
   * process adapters whose harness performs that loop (for example Claude,
   * Codex, Gemini CLI, Crush, Goose, and Qwen). FALSE for network SDK/HTTP
   * adapters such as Gemini SDK, openai, openrouter, and ollama when they stop
   * at the first tool_call with no result. Routers selecting an adapter for
   * autonomous agentic work MUST key on this flag, not {@link supportsToolCalls}.
   */
  executesToolLoop?: boolean | undefined;
  supportsStreaming: boolean;
  supportsCostUsage: boolean;
  nativeToolControls?:
    | {
        mode?: boolean | undefined;
        allowlist?: boolean | undefined;
        blocklist?: boolean | undefined;
      }
    | undefined;
  /** Optional request idempotency and read-only restart lookup support. */
  providerRequestCorrelation?: ProviderRequestCorrelationCapability | undefined;
  /** Provider-visible tools can be proven empty before dispatch. */
  supportsZeroToolDispatch?: boolean | undefined;
  maxContextTokens?: number | undefined;
}

/** Input to an agent adapter */
export interface AgentInput {
  /** The prompt or instruction to send */
  prompt: string;
  /** Working directory for file operations */
  workingDirectory?: string | undefined;
  /** System prompt override */
  systemPrompt?: string | undefined;
  /** Maximum turns/iterations */
  maxTurns?: number | undefined;
  /** Maximum budget in USD */
  maxBudgetUsd?: number | undefined;
  /** Abort signal for cancellation */
  signal?: AbortSignal | undefined;
  /** Session ID to resume (adapter-specific format) */
  resumeSessionId?: string | undefined;
  /** Additional adapter-specific options */
  options?: Record<string, unknown> | undefined;
  /** Correlation ID for log/event correlation. Propagated to all events. */
  correlationId?: string | undefined;
  /**
   * JSON Schema describing the expected output structure.
   * When provided, adapters that support structured output will constrain
   * the response to match this schema (e.g. via response_format or tool-call shaping).
   * Adapters that do not support structured output ignore this field.
   */
  outputSchema?: Record<string, unknown> | undefined;
  /**
   * Typed policy metadata used by routing/pipeline layers to perform
   * per-attempt projection and conformance handling.
   */
  policyContext?: AgentPolicyExecutionContext | undefined;
  /** Exact adapter control that must be admitted before provider dispatch. */
  executionControlRequirement?: AdapterExecutionControlRequirement | undefined;
}

/** Runtime status of optional adapter monitor integration. */
export type AdapterMonitorStatusState =
  | "unsupported"
  | "not_configured"
  | "ready"
  | "active"
  | "failed_to_start";

export interface AdapterMonitorStatus {
  state: AdapterMonitorStatusState;
  supported: boolean;
  monitorIntrospection?: string | undefined;
  watchedPathCount?: number | undefined;
  lastError?: string | undefined;
}

/** Health status of an adapter */
export interface HealthStatus {
  healthy: boolean;
  providerId: AdapterProviderId;
  sdkInstalled: boolean;
  cliAvailable: boolean;
  lastError?: string | undefined;
  lastSuccessTimestamp?: number | undefined;
  monitorStatus?: AdapterMonitorStatus | undefined;
}

/** Session info for session management */
export interface SessionInfo {
  sessionId: string;
  providerId: AdapterProviderId;
  createdAt: Date;
  lastActiveAt: Date;
  workingDirectory?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/** Configuration for filtering sensitive environment variables from child processes */
export interface EnvFilterConfig {
  /** Additional regex patterns to block (merged with defaults) */
  blockedPatterns?: RegExp[] | undefined;
  /** Env var names explicitly allowed even if they match a blocked pattern */
  allowedVars?: string[] | undefined;
  /** Disable filtering entirely (passes all env vars through) */
  disableFilter?: boolean | undefined;
}

/** Configuration for an adapter */
export interface AdapterConfig {
  /** API key for the provider */
  apiKey?: string | undefined;
  /** Custom model name override */
  model?: string | undefined;
  /** Timeout in ms for operations */
  timeoutMs?: number | undefined;
  /** Working directory override */
  workingDirectory?: string | undefined;
  /** Sandbox/permission mode */
  sandboxMode?: "read-only" | "workspace-write" | "full-access" | undefined;
  /** Custom environment variables */
  env?: Record<string, string> | undefined;
  /** Environment variable filtering to prevent leaking secrets to child processes */
  envFilter?: EnvFilterConfig | undefined;
  /** Additional provider-specific options */
  providerOptions?: Record<string, unknown> | undefined;
  /** Mid-execution interaction handling policy. Default behavior: auto-approve. */
  interactionPolicy?: InteractionPolicy | undefined;
  /**
   * Codex-only: skip the git-repo safety check when starting a thread.
   * Adapters that do not use Codex ignore this flag.
   */
  skipGitRepoCheck?: boolean | undefined;
  /**
   * Normalized reasoning effort level.
   * Claude passes it through as the SDK's native `effort` option ('minimal'
   * downgrades to 'low'); Codex maps to model_reasoning_effort.
   */
  reasoning?:
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max"
    | undefined;
  /**
   * Claude extended thinking budget in tokens. When set (> 0) it takes
   * precedence over `reasoning` and pins a fixed extended-thinking budget
   * instead of the SDK's native effort option. Ignored by non-Claude adapters.
   */
  thinkingBudgetTokens?: number | undefined;
  /**
   * Prompt caching mode for Claude adapter.
   * - 'auto': inject cache_control on system prompt and tool definitions (default for Claude)
   * - 'off': disable caching entirely
   * Ignored by non-Claude adapters.
   */
  promptCache?: "auto" | "off" | undefined;
}

/**
 * Core interface all agent adapters must implement.
 *
 * Adapters wrap external AI agent SDKs (Claude, Codex, Gemini, etc.)
 * and normalize their events into the unified AgentEvent type.
 */
export interface AgentCLIAdapter {
  /** Unique provider identifier */
  readonly providerId: AdapterProviderId;

  /**
   * Execute a prompt and yield unified events.
   * This is the primary execution method.
   */
  execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined>;

  /**
   * Execute a prompt and yield unified events plus provider-native raw events.
   * Adapters that do not implement this may still be wrapped by callers that
   * synthesize a normalized-only stream.
   */
  executeWithRaw?(
    input: AgentInput,
  ): AsyncGenerator<AgentStreamEvent, void, undefined>;

  /**
   * Respond to a pending ask-caller interaction.
   *
   * Returns true when the interaction was found and resolved, false when the
   * adapter has no matching pending interaction.
   */
  respondInteraction?(
    interactionId: string,
    answer: string,
  ): boolean | Promise<boolean>;

  /**
   * Resume a previous session by ID.
   * Not all adapters support this — throws if unsupported.
   */
  resumeSession(
    sessionId: string,
    input: AgentInput,
  ): AsyncGenerator<AgentEvent, void, undefined>;

  /** Interrupt the currently running execution */
  interrupt(): void;

  /** Check if the adapter's SDK is installed and the CLI is available */
  healthCheck(): Promise<HealthStatus>;

  /** Update adapter configuration */
  configure(opts: Partial<AdapterConfig>): void;

  /** Runtime capability declaration. */
  getCapabilities(): AdapterCapabilityProfile;

  /** Admit an exact execution-control requirement without provider effects. */
  admitExecutionControls?(
    input: AgentInput,
    requirement: AdapterExecutionControlRequirement,
  ): AdapterExecutionControlAdmission;

  /**
   * Inspect one retained upstream request without dispatching new inference.
   * Present only when providerRequestCorrelation.restartLookup is supported.
   */
  lookupProviderRequest?(
    lookup: ProviderRequestLookupInput,
  ): Promise<ProviderRequestLookupResult>;

  /** List available sessions (if supported by the adapter) */
  listSessions?(): Promise<SessionInfo[]>;

  /** Fork a session (if supported — currently Claude only) */
  forkSession?(sessionId: string): Promise<string>;

  /** Pre-load SDK to eliminate cold-start on first execute(). Optional. */
  warmup?(): Promise<void>;
}
