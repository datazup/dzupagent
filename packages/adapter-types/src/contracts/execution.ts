import type { InteractionPolicy } from './interaction.js'
import type { AgentEvent, AgentStreamEvent } from './events.js'
import type { AdapterProviderId } from './provider.js'

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
   * Execute a prompt and yield unified events plus provider-native raw events.
   * Adapters that do not implement this may still be wrapped by callers that
   * synthesize a normalized-only stream.
   */
  executeWithRaw?(input: AgentInput): AsyncGenerator<AgentStreamEvent, void, undefined>

  /**
   * Respond to a pending ask-caller interaction.
   *
   * Returns true when the interaction was found and resolved, false when the
   * adapter has no matching pending interaction.
   */
  respondInteraction?(interactionId: string, answer: string): boolean | Promise<boolean>

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
