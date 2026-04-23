import type { TokenUsage } from './execution.js'
import type { AdapterProviderId } from './provider.js'
import type { RawAgentEvent } from './run-store.js'

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
  /** Duration of the memory recall phase in milliseconds */
  durationMs: number
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
  /** Duration of the skills compilation phase in milliseconds */
  durationMs: number
  correlationId?: string | undefined
}

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
  resolvedBy:
    | 'auto-approve'
    | 'auto-deny'
    | 'default-answers'
    | 'ai-autonomous'
    | 'caller'
    | 'timeout-fallback'
  timestamp: number
  correlationId?: string | undefined
}

/**
 * Side-channel wrapper for a provider-native raw event emitted live alongside
 * normalized adapter events.
 */
export interface ProviderRawStreamEvent {
  type: 'adapter:provider_raw'
  rawEvent: RawAgentEvent
}

/** Stream item yielded by raw-capable adapters and orchestrators. */
export type AgentStreamEvent = AgentEvent | ProviderRawStreamEvent
