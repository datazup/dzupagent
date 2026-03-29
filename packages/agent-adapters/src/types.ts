/**
 * Core types for AI agent CLI/SDK adapters.
 *
 * All adapters implement AgentCLIAdapter to provide a unified interface
 * for orchestrating multiple AI agents (Claude, Codex, Gemini, Qwen, Crush).
 */

/** Supported adapter provider IDs */
export type AdapterProviderId = 'claude' | 'codex' | 'gemini' | 'qwen' | 'crush'

/** Input to an agent adapter */
export interface AgentInput {
  /** The prompt or instruction to send */
  prompt: string
  /** Working directory for file operations */
  workingDirectory?: string
  /** System prompt override */
  systemPrompt?: string
  /** Maximum turns/iterations */
  maxTurns?: number
  /** Maximum budget in USD */
  maxBudgetUsd?: number
  /** Abort signal for cancellation */
  signal?: AbortSignal
  /** Session ID to resume (adapter-specific format) */
  resumeSessionId?: string
  /** Additional adapter-specific options */
  options?: Record<string, unknown>
}

/** Unified agent event emitted by all adapters */
export type AgentEvent =
  | AgentStartedEvent
  | AgentMessageEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | AgentCompletedEvent
  | AgentFailedEvent
  | AgentStreamDeltaEvent

export interface AgentStartedEvent {
  type: 'adapter:started'
  providerId: AdapterProviderId
  sessionId: string
  timestamp: number
}

export interface AgentMessageEvent {
  type: 'adapter:message'
  providerId: AdapterProviderId
  content: string
  role: 'assistant' | 'user' | 'system'
  timestamp: number
}

export interface AgentToolCallEvent {
  type: 'adapter:tool_call'
  providerId: AdapterProviderId
  toolName: string
  input: unknown
  timestamp: number
}

export interface AgentToolResultEvent {
  type: 'adapter:tool_result'
  providerId: AdapterProviderId
  toolName: string
  output: string
  durationMs: number
  timestamp: number
}

export interface AgentCompletedEvent {
  type: 'adapter:completed'
  providerId: AdapterProviderId
  sessionId: string
  result: string
  usage?: TokenUsage
  durationMs: number
  timestamp: number
}

export interface AgentFailedEvent {
  type: 'adapter:failed'
  providerId: AdapterProviderId
  sessionId?: string
  error: string
  code?: string
  timestamp: number
}

export interface AgentStreamDeltaEvent {
  type: 'adapter:stream_delta'
  providerId: AdapterProviderId
  content: string
  timestamp: number
}

/** Token usage statistics */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
  costCents?: number
}

/** Health status of an adapter */
export interface HealthStatus {
  healthy: boolean
  providerId: AdapterProviderId
  sdkInstalled: boolean
  cliAvailable: boolean
  lastError?: string
  lastSuccessTimestamp?: number
}

/** Session info for session management */
export interface SessionInfo {
  sessionId: string
  providerId: AdapterProviderId
  createdAt: Date
  lastActiveAt: Date
  workingDirectory?: string
  metadata?: Record<string, unknown>
}

/** Configuration for an adapter */
export interface AdapterConfig {
  /** API key for the provider */
  apiKey?: string
  /** Custom model name override */
  model?: string
  /** Timeout in ms for operations */
  timeoutMs?: number
  /** Working directory override */
  workingDirectory?: string
  /** Sandbox/permission mode */
  sandboxMode?: 'read-only' | 'workspace-write' | 'full-access'
  /** Custom environment variables */
  env?: Record<string, string>
  /** Additional provider-specific options */
  providerOptions?: Record<string, unknown>
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

  /** List available sessions (if supported by the adapter) */
  listSessions?(): Promise<SessionInfo[]>

  /** Fork a session (if supported — currently Claude only) */
  forkSession?(sessionId: string): Promise<string>
}

/** Task descriptor used by the router to decide which adapter to use */
export interface TaskDescriptor {
  prompt: string
  tags: string[]
  budgetConstraint?: 'low' | 'medium' | 'high' | 'unlimited'
  preferredProvider?: AdapterProviderId
  requiresExecution?: boolean
  requiresReasoning?: boolean
  workingDirectory?: string
}

/** Decision made by the task router */
export interface RoutingDecision {
  provider: AdapterProviderId | 'auto'
  reason: string
  fallbackProviders?: AdapterProviderId[]
  confidence: number
}

/** Pluggable strategy for routing tasks to adapters */
export interface TaskRoutingStrategy {
  readonly name: string
  route(task: TaskDescriptor, availableProviders: AdapterProviderId[]): RoutingDecision
}
