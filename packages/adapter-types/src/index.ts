/**
 * @dzupagent/adapter-types
 *
 * Standalone type definitions for DzupAgent agent adapters.
 * Enables third-party adapter implementations without pulling in
 * the full @dzupagent/agent-adapters package.
 */

/** Supported adapter provider IDs */
export type AdapterProviderId = 'claude' | 'codex' | 'gemini' | 'gemini-sdk' | 'qwen' | 'crush' | 'goose' | 'openrouter'

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
