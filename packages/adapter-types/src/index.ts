/**
 * @dzupagent/adapter-types
 *
 * Standalone type definitions for DzupAgent agent adapters.
 * Enables third-party adapter implementations without pulling in
 * the full @dzupagent/agent-adapters package.
 */

/** Supported adapter provider IDs */
export type AdapterProviderId = 'claude' | 'codex' | 'gemini' | 'gemini-sdk' | 'qwen' | 'crush' | 'goose' | 'openrouter'

// ---------------------------------------------------------------------------
// Interaction Policy — mid-execution question/permission handling
// ---------------------------------------------------------------------------

/**
 * How the adapter should handle mid-execution questions, clarification
 * requests, and permission prompts from a sub-agent.
 */
export type InteractionPolicyMode =
  | 'auto-approve'    // always answer yes/grant (backward-compatible default)
  | 'auto-deny'       // always answer no/deny (safe for untrusted runs)
  | 'default-answers' // match question text against a regex → answer map
  | 'ai-autonomous'   // use a secondary LLM call to decide
  | 'ask-caller'      // emit adapter:interaction_required and wait for caller

export interface InteractionPolicy {
  mode: InteractionPolicyMode
  /** Used when mode === 'default-answers' */
  defaultAnswers?: {
    /** Each pattern string is compiled to RegExp and tested against the question text. */
    patterns: Array<{ pattern: string; answer: string }>
  } | undefined
  /** Used when mode === 'ai-autonomous' */
  aiAutonomous?: {
    /** Context injected into the LLM reasoning prompt (e.g. task constraints). */
    context?: string | undefined
    /** Model hint for the secondary LLM call. Adapters may ignore this. */
    model?: string | undefined
  } | undefined
  /** Used when mode === 'ask-caller' */
  askCaller?: {
    /** Timeout in ms to wait for caller response. Default: 60_000. */
    timeoutMs?: number | undefined
    /** Policy applied on timeout. Default: 'auto-deny'. */
    timeoutFallback?: 'auto-approve' | 'auto-deny' | undefined
  } | undefined
}

/** Runtime capability declaration for adapter behavior. */
export interface AdapterCapabilityProfile {
  supportsResume: boolean
  supportsFork: boolean
  supportsToolCalls: boolean
  supportsStreaming: boolean
  supportsCostUsage: boolean
  maxContextTokens?: number | undefined
}

/** Input to an agent adapter */
export interface AgentInput {
  /** The prompt or instruction to send */
  prompt: string
  /** Working directory for file operations */
  workingDirectory?: string | undefined
  /** System prompt override */
  systemPrompt?: string | undefined
  /** Maximum turns/iterations */
  maxTurns?: number | undefined
  /** Maximum budget in USD */
  maxBudgetUsd?: number | undefined
  /** Abort signal for cancellation */
  signal?: AbortSignal | undefined
  /** Session ID to resume (adapter-specific format) */
  resumeSessionId?: string | undefined
  /** Additional adapter-specific options */
  options?: Record<string, unknown> | undefined
  /** Correlation ID for log/event correlation. Propagated to all events. */
  correlationId?: string | undefined
  /**
   * JSON Schema describing the expected output structure.
   * When provided, adapters that support structured output will constrain
   * the response to match this schema (e.g. via response_format or tool-call shaping).
   * Adapters that do not support structured output ignore this field.
   */
  outputSchema?: Record<string, unknown> | undefined
}

/** Unified agent event emitted by all adapters */
export type AgentEvent =
  | AgentStartedEvent
  | AgentMessageEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | AgentCompletedEvent
  | AgentFailedEvent
  | AgentRecoveryCancelledEvent
  | AgentStreamDeltaEvent
  | AgentProgressEvent
  | AgentMemoryRecalledEvent
  | AgentSkillsCompiledEvent
  | AgentInteractionRequiredEvent
  | AgentInteractionResolvedEvent

export interface AgentStartedEvent {
  type: 'adapter:started'
  providerId: AdapterProviderId
  sessionId: string
  timestamp: number
  /** The input prompt (redacted if configured) */
  prompt?: string | undefined
  /** The system prompt used */
  systemPrompt?: string | undefined
  /** The model selected */
  model?: string | undefined
  /** Working directory */
  workingDirectory?: string | undefined
  /** Whether this is a resumed session */
  isResume?: boolean | undefined
  /** Correlation ID from the originating request */
  correlationId?: string | undefined
}

export interface AgentMessageEvent {
  type: 'adapter:message'
  providerId: AdapterProviderId
  content: string
  role: 'assistant' | 'user' | 'system'
  timestamp: number
  /** Correlation ID from the originating request */
  correlationId?: string | undefined
}

export interface AgentToolCallEvent {
  type: 'adapter:tool_call'
  providerId: AdapterProviderId
  toolName: string
  input: unknown
  timestamp: number
  /** Correlation ID from the originating request */
  correlationId?: string | undefined
}

export interface AgentToolResultEvent {
  type: 'adapter:tool_result'
  providerId: AdapterProviderId
  toolName: string
  output: string
  durationMs: number
  timestamp: number
  /** Correlation ID from the originating request */
  correlationId?: string | undefined
}

export interface AgentCompletedEvent {
  type: 'adapter:completed'
  providerId: AdapterProviderId
  sessionId: string
  result: string
  usage?: TokenUsage | undefined
  durationMs: number
  timestamp: number
  /** Correlation ID from the originating request */
  correlationId?: string | undefined
}

export interface AgentFailedEvent {
  type: 'adapter:failed'
  providerId: AdapterProviderId
  sessionId?: string | undefined
  error: string
  code?: string | undefined
  timestamp: number
  /** Correlation ID from the originating request */
  correlationId?: string | undefined
}

export interface AgentRecoveryCancelledEvent {
  type: 'recovery:cancelled'
  providerId: AdapterProviderId
  strategy: 'abort'
  error: string
  totalAttempts: number
  totalDurationMs: number
  timestamp: number
  /** Correlation ID from the originating request */
  correlationId?: string | undefined
}

export interface AgentStreamDeltaEvent {
  type: 'adapter:stream_delta'
  providerId: AdapterProviderId
  content: string
  timestamp: number
  /** Correlation ID from the originating request */
  correlationId?: string | undefined
}

export interface AgentProgressEvent {
  type: 'adapter:progress'
  providerId: AdapterProviderId
  timestamp: number
  /** Progress phase name */
  phase: string
  /** Progress percentage (0-100). Undefined if indeterminate. */
  percentage?: number | undefined
  /** Human-readable status message */
  message?: string | undefined
  /** Current step/iteration number */
  current?: number | undefined
  /** Total steps/iterations (if known) */
  total?: number | undefined
  /** Correlation ID from the originating request */
  correlationId?: string | undefined
}

/** Token usage statistics */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number | undefined
  costCents?: number | undefined
}

/** Health status of an adapter */
export interface HealthStatus {
  healthy: boolean
  providerId: AdapterProviderId
  sdkInstalled: boolean
  cliAvailable: boolean
  lastError?: string | undefined
  lastSuccessTimestamp?: number | undefined
}

/** Session info for session management */
export interface SessionInfo {
  sessionId: string
  providerId: AdapterProviderId
  createdAt: Date
  lastActiveAt: Date
  workingDirectory?: string | undefined
  metadata?: Record<string, unknown> | undefined
}

/** Configuration for filtering sensitive environment variables from child processes */
export interface EnvFilterConfig {
  /** Additional regex patterns to block (merged with defaults) */
  blockedPatterns?: RegExp[] | undefined
  /** Env var names explicitly allowed even if they match a blocked pattern */
  allowedVars?: string[] | undefined
  /** Disable filtering entirely (passes all env vars through) */
  disableFilter?: boolean | undefined
}

/** Configuration for an adapter */
export interface AdapterConfig {
  /** API key for the provider */
  apiKey?: string | undefined
  /** Custom model name override */
  model?: string | undefined
  /** Timeout in ms for operations */
  timeoutMs?: number | undefined
  /** Working directory override */
  workingDirectory?: string | undefined
  /** Sandbox/permission mode */
  sandboxMode?: 'read-only' | 'workspace-write' | 'full-access' | undefined
  /** Custom environment variables */
  env?: Record<string, string> | undefined
  /** Environment variable filtering to prevent leaking secrets to child processes */
  envFilter?: EnvFilterConfig | undefined
  /** Additional provider-specific options */
  providerOptions?: Record<string, unknown> | undefined
  /** Mid-execution interaction handling policy. Default behavior: auto-approve. */
  interactionPolicy?: InteractionPolicy | undefined
  /**
   * Codex-only: skip the git-repo safety check when starting a thread.
   * Adapters that do not use Codex ignore this flag.
   */
  skipGitRepoCheck?: boolean | undefined
}

/**
 * Core interface all agent adapters must implement.
 *
 * Adapters wrap external AI agent SDKs (Claude, Codex, Gemini, etc.)
 * and normalize their events into the unified AgentEvent type.
 */
export interface AgentCLIAdapter {
  /** Unique provider identifier */
  readonly providerId: AdapterProviderId

  /**
   * Execute a prompt and yield unified events.
   * This is the primary execution method.
   */
  execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined>

  /**
   * Resume a previous session by ID.
   * Not all adapters support this — throws if unsupported.
   */
  resumeSession(sessionId: string, input: AgentInput): AsyncGenerator<AgentEvent, void, undefined>

  /** Interrupt the currently running execution */
  interrupt(): void

  /** Check if the adapter's SDK is installed and the CLI is available */
  healthCheck(): Promise<HealthStatus>

  /** Update adapter configuration */
  configure(opts: Partial<AdapterConfig>): void

  /** Runtime capability declaration. */
  getCapabilities(): AdapterCapabilityProfile

  /** List available sessions (if supported by the adapter) */
  listSessions?(): Promise<SessionInfo[]>

  /** Fork a session (if supported — currently Claude only) */
  forkSession?(sessionId: string): Promise<string>

  /** Pre-load SDK to eliminate cold-start on first execute(). Optional. */
  warmup?(): Promise<void>
}

/** Task descriptor used by the router to decide which adapter to use */
export interface TaskDescriptor {
  prompt: string
  tags: string[]
  budgetConstraint?: 'low' | 'medium' | 'high' | 'unlimited' | undefined
  preferredProvider?: AdapterProviderId | undefined
  requiresExecution?: boolean | undefined
  requiresReasoning?: boolean | undefined
  workingDirectory?: string | undefined
}

/** Decision made by the task router */
export interface RoutingDecision {
  provider: AdapterProviderId | 'auto'
  reason: string
  fallbackProviders?: AdapterProviderId[] | undefined
  confidence: number
}

/** Pluggable strategy for routing tasks to adapters */
export interface TaskRoutingStrategy {
  readonly name: string
  route(task: TaskDescriptor, availableProviders: AdapterProviderId[]): RoutingDecision
}

// ---------------------------------------------------------------------------
// Unified Capability Layer — new event types
// ---------------------------------------------------------------------------

/** Emitted after memory injection completes (withHierarchicalMemoryEnrichment) */
export interface AgentMemoryRecalledEvent {
  type: 'adapter:memory_recalled'
  providerId: AdapterProviderId
  timestamp: number
  entries: Array<{
    level: 'global' | 'workspace' | 'project' | 'agent'
    name: string
    /** Rough token estimate (chars / 4) */
    tokenEstimate: number
  }>
  /** Total tokens injected across all entries */
  totalTokens: number
  correlationId?: string | undefined
}

/** Emitted after skills are compiled for a run (DzupAgentFileLoader) */
export interface AgentSkillsCompiledEvent {
  type: 'adapter:skills_compiled'
  providerId: AdapterProviderId
  timestamp: number
  skills: Array<{
    skillId: string
    /** Features that compiled at reduced capacity */
    degraded: string[]
    /** Features that were silently dropped (unsupported by provider) */
    dropped: string[]
  }>
  correlationId?: string | undefined
}

// ---------------------------------------------------------------------------
// Interaction events — mid-execution question/permission handling
// ---------------------------------------------------------------------------

/**
 * Emitted when the adapter detects a mid-execution question, clarification
 * request, or permission prompt from the sub-agent.
 * Only emitted when interactionPolicy.mode === 'ask-caller'.
 */
export interface AgentInteractionRequiredEvent {
  type: 'adapter:interaction_required'
  providerId: AdapterProviderId
  /** Unique ID — pass back to InteractionResolver.respond(interactionId, answer) */
  interactionId: string
  /** The raw question/prompt text from the sub-agent */
  question: string
  /** Classified kind of interaction */
  kind: 'permission' | 'clarification' | 'confirmation' | 'unknown'
  timestamp: number
  /** Epoch ms deadline — caller must respond before this or the timeout fires */
  expiresAt: number
  correlationId?: string | undefined
}

/**
 * Emitted when a mid-execution interaction is resolved (auto or manual).
 * Always emitted regardless of policy mode, for observability.
 */
export interface AgentInteractionResolvedEvent {
  type: 'adapter:interaction_resolved'
  providerId: AdapterProviderId
  interactionId: string
  question: string
  answer: string
  /** How the answer was determined */
  resolvedBy: 'auto-approve' | 'auto-deny' | 'default-answers' | 'ai-autonomous' | 'caller' | 'timeout-fallback'
  timestamp: number
  correlationId?: string | undefined
}

// ---------------------------------------------------------------------------
// Unified Capability Layer — skill capability matrix types
// ---------------------------------------------------------------------------

export type CapabilityStatus = 'active' | 'degraded' | 'dropped' | 'unsupported'

export interface ProviderCapabilityRow {
  systemPrompt: CapabilityStatus
  toolBindings: CapabilityStatus
  approvalMode: CapabilityStatus
  networkPolicy: CapabilityStatus
  budgetLimit: CapabilityStatus
  warnings: string[]
  /**
   * Index signature so callers can read rows generically
   * (for example when formatting a matrix into a table).
   */
  [key: string]: CapabilityStatus | string[] | undefined
}

export interface SkillCapabilityMatrix {
  skillId: string
  skillName: string
  providers: Partial<Record<AdapterProviderId, ProviderCapabilityRow>>
}

// ---------------------------------------------------------------------------
// Unified Capability Layer — config + path types
// ---------------------------------------------------------------------------

/** Strategy for injecting project memory into Codex runs */
export type CodexMemoryStrategy =
  | 'inject-always'
  | 'inject-on-new-thread'
  | 'trust-thread-history'

/** Global/project DzupAgent configuration (config.json) */
export interface DzupAgentConfig {
  codex?: {
    /** How to handle memory injection for Codex. Default: 'inject-on-new-thread' */
    memoryStrategy?: CodexMemoryStrategy | undefined
  }
  memory?: {
    /** Max tokens to inject per run. Default: 2000 */
    maxTokens?: number | undefined
    /** Include global (~/.dzupagent/memory/) entries. Default: true */
    includeGlobal?: boolean | undefined
    /** Include workspace-level entries. Default: true */
    includeWorkspace?: boolean | undefined
  }
  sync?: {
    /** Auto-sync to native files on project open. Default: false */
    onProjectOpen?: boolean | undefined
  }
}

/** Resolved filesystem paths for a project's .dzupagent/ context */
export interface DzupAgentPaths {
  /** ~/.dzupagent/ */
  globalDir: string
  /** <git-root>/.dzupagent/ — workspace level, undefined if same as project */
  workspaceDir: string | undefined
  /** <project>/.dzupagent/ */
  projectDir: string
  /** <project>/.dzupagent/state.json */
  stateFile: string
  /** <project>/.dzupagent/config.json */
  projectConfig: string
}

// ---------------------------------------------------------------------------
// Run Event Store — raw, normalized, and artifact event persistence
// ---------------------------------------------------------------------------

/**
 * A raw provider event persisted verbatim to `.dzupagent/runs/<runId>/raw-events.jsonl`.
 * The `payload` is the unmodified SDK/CLI output — shape varies per provider.
 */
export interface RawAgentEvent {
  providerId: AdapterProviderId
  runId: string
  /** Session ID, if available at the time of the event */
  sessionId?: string | undefined
  /** Monotonic epoch-ms timestamp */
  timestamp: number
  /** Where the raw event originated */
  source: 'stdout' | 'stderr' | 'sdk' | 'ipc'
  /** Unmodified provider payload */
  payload: unknown
  /** Correlation ID propagated from the originating request */
  correlationId?: string | undefined
}

/**
 * An artifact mutation event — created when an adapter writes, updates, or
 * removes a file under the run directory (transcripts, checkpoints, outputs…).
 */
export interface AgentArtifactEvent {
  runId: string
  providerId: AdapterProviderId
  timestamp: number
  /** Classifier for downstream tooling */
  artifactType: 'transcript' | 'checkpoint' | 'output' | 'log' | 'other'
  /** Absolute filesystem path of the artifact */
  path: string
  /** Mutation kind */
  action: 'created' | 'updated' | 'deleted'
  /** Optional provider-specific metadata */
  metadata?: Record<string, unknown> | undefined
  correlationId?: string | undefined
}

// ---------------------------------------------------------------------------
// Governance event plane — approvals, hooks, rule violations, dangerous cmds
// ---------------------------------------------------------------------------

/** Kinds of governance-plane events emitted alongside the unified AgentEvent stream. */
export type GovernanceEventKind =
  | 'governance:approval_requested'
  | 'governance:approval_resolved'
  | 'governance:hook_executed'
  | 'governance:rule_violation'
  | 'governance:dangerous_command'

/**
 * Governance events are emitted on a side-channel parallel to `AgentEvent`.
 * They surface approval/authorization decisions, hook executions, rule
 * violations, and dangerous-command detections so the host can audit, alert,
 * or replay governance decisions independently of normal adapter output.
 */
export type GovernanceEvent =
  | {
      type: 'governance:approval_requested'
      runId: string
      sessionId?: string
      interactionId: string
      providerId: string
      timestamp: number
      prompt: string
      commandPreview?: string
    }
  | {
      type: 'governance:approval_resolved'
      runId: string
      sessionId?: string
      interactionId: string
      providerId: string
      timestamp: number
      resolution: 'approved' | 'denied' | 'auto'
    }
  | {
      type: 'governance:hook_executed'
      runId: string
      sessionId?: string
      providerId: string
      timestamp: number
      hookName: string
      exitCode?: number
    }
  | {
      type: 'governance:rule_violation'
      runId: string
      sessionId?: string
      providerId: string
      timestamp: number
      ruleId: string
      severity: 'warn' | 'block'
      detail: string
    }
  | {
      type: 'governance:dangerous_command'
      runId: string
      sessionId?: string
      providerId: string
      timestamp: number
      command: string
      blocked: boolean
    }

/** Terminal status for a completed run */
export type RunStatus = 'completed' | 'failed' | 'cancelled'

/**
 * Summary record written to `.dzupagent/runs/<runId>/summary.json` when the
 * store is closed. Aggregates high-level run statistics.
 */
export interface RunSummary {
  runId: string
  providerId: AdapterProviderId
  /** Session ID, if one was assigned by the provider */
  sessionId?: string | undefined
  startedAt: number
  completedAt: number
  durationMs: number
  toolCallCount: number
  artifactCount: number
  tokenUsage?: TokenUsage | undefined
  /** Populated when status === 'failed' */
  errorMessage?: string | undefined
  status: RunStatus
  correlationId?: string | undefined
}
