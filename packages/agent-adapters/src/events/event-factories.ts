/**
 * Typed factory functions for {@link AgentEvent} variants.
 *
 * Each factory constructs a single concrete variant of the AgentEvent
 * discriminated union. Because the return type IS the variant interface,
 * the compiler verifies the shape at the call-site without an `as AgentEvent`
 * cast. Callers obtain a precisely-typed event that is assignable to
 * AgentEvent (or AgentStreamEvent) by union-widening, not by assertion.
 *
 * Conventions
 * - Required fields are passed positionally / by named arg.
 * - `timestamp` is set to `Date.now()` when omitted.
 * - Optional fields are merged via conditional spreads to preserve the
 *   exact existing object-literal output (so no runtime behavior change).
 * - `correlationId` is handled by the caller (or by `withCorrelationId`);
 *   factories do not embed correlation logic.
 */
import type {
  AdapterProviderId,
  AgentCacheStatsEvent,
  AgentCompletedEvent,
  AgentFailedEvent,
  AgentInteractionRequiredEvent,
  AgentInteractionResolvedEvent,
  AgentMessageEvent,
  AgentProgressEvent,
  AgentStartedEvent,
  AgentStreamDeltaEvent,
  AgentToolCallEvent,
  AgentToolResultEvent,
  TokenUsage,
} from '../types.js'

// ---------------------------------------------------------------------------
// Started
// ---------------------------------------------------------------------------

export interface MakeStartedEventArgs {
  providerId: AdapterProviderId
  sessionId: string
  prompt?: string | undefined
  systemPrompt?: string | undefined
  model?: string | undefined
  workingDirectory?: string | undefined
  isResume?: boolean | undefined
  correlationId?: string | undefined
  timestamp?: number
}

export function makeStartedEvent(args: MakeStartedEventArgs): AgentStartedEvent {
  return {
    type: 'adapter:started',
    providerId: args.providerId,
    sessionId: args.sessionId,
    timestamp: args.timestamp ?? Date.now(),
    ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
    ...(args.systemPrompt !== undefined ? { systemPrompt: args.systemPrompt } : {}),
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.workingDirectory !== undefined
      ? { workingDirectory: args.workingDirectory }
      : {}),
    ...(args.isResume !== undefined ? { isResume: args.isResume } : {}),
    ...(args.correlationId !== undefined ? { correlationId: args.correlationId } : {}),
  }
}

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export interface MakeMessageEventArgs {
  providerId: AdapterProviderId
  content: string
  role: 'assistant' | 'user' | 'system'
  correlationId?: string | undefined
  timestamp?: number
}

export function makeMessageEvent(args: MakeMessageEventArgs): AgentMessageEvent {
  return {
    type: 'adapter:message',
    providerId: args.providerId,
    content: args.content,
    role: args.role,
    timestamp: args.timestamp ?? Date.now(),
    ...(args.correlationId !== undefined ? { correlationId: args.correlationId } : {}),
  }
}

// ---------------------------------------------------------------------------
// Tool call / result
// ---------------------------------------------------------------------------

export interface MakeToolCallEventArgs {
  providerId: AdapterProviderId
  toolName: string
  toolCallId?: string | undefined
  input: unknown
  correlationId?: string | undefined
  timestamp?: number
}

export function makeToolCallEvent(args: MakeToolCallEventArgs): AgentToolCallEvent {
  return {
    type: 'adapter:tool_call',
    providerId: args.providerId,
    toolName: args.toolName,
    ...(args.toolCallId !== undefined ? { toolCallId: args.toolCallId } : {}),
    input: args.input,
    timestamp: args.timestamp ?? Date.now(),
    ...(args.correlationId !== undefined ? { correlationId: args.correlationId } : {}),
  }
}

export interface MakeToolResultEventArgs {
  providerId: AdapterProviderId
  toolName: string
  toolCallId?: string | undefined
  output: string
  durationMs: number
  correlationId?: string | undefined
  timestamp?: number
}

export function makeToolResultEvent(args: MakeToolResultEventArgs): AgentToolResultEvent {
  return {
    type: 'adapter:tool_result',
    providerId: args.providerId,
    toolName: args.toolName,
    ...(args.toolCallId !== undefined ? { toolCallId: args.toolCallId } : {}),
    output: args.output,
    durationMs: args.durationMs,
    timestamp: args.timestamp ?? Date.now(),
    ...(args.correlationId !== undefined ? { correlationId: args.correlationId } : {}),
  }
}

// ---------------------------------------------------------------------------
// Completed / failed
// ---------------------------------------------------------------------------

export interface MakeCompletedEventArgs {
  providerId: AdapterProviderId
  sessionId: string
  result: string
  usage?: TokenUsage | undefined
  durationMs: number
  correlationId?: string | undefined
  timestamp?: number
}

export function makeCompletedEvent(args: MakeCompletedEventArgs): AgentCompletedEvent {
  return {
    type: 'adapter:completed',
    providerId: args.providerId,
    sessionId: args.sessionId,
    result: args.result,
    ...(args.usage !== undefined ? { usage: args.usage } : {}),
    durationMs: args.durationMs,
    timestamp: args.timestamp ?? Date.now(),
    ...(args.correlationId !== undefined ? { correlationId: args.correlationId } : {}),
  }
}

export interface MakeFailedEventArgs {
  providerId: AdapterProviderId
  sessionId?: string | undefined
  error: string
  code?: string | undefined
  correlationId?: string | undefined
  timestamp?: number
}

export function makeFailedEvent(args: MakeFailedEventArgs): AgentFailedEvent {
  return {
    type: 'adapter:failed',
    providerId: args.providerId,
    ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
    error: args.error,
    ...(args.code !== undefined ? { code: args.code } : {}),
    timestamp: args.timestamp ?? Date.now(),
    ...(args.correlationId !== undefined ? { correlationId: args.correlationId } : {}),
  }
}

// ---------------------------------------------------------------------------
// Stream delta
// ---------------------------------------------------------------------------

export interface MakeStreamDeltaEventArgs {
  providerId: AdapterProviderId
  content: string
  correlationId?: string | undefined
  timestamp?: number
}

export function makeStreamDeltaEvent(
  args: MakeStreamDeltaEventArgs,
): AgentStreamDeltaEvent {
  return {
    type: 'adapter:stream_delta',
    providerId: args.providerId,
    content: args.content,
    timestamp: args.timestamp ?? Date.now(),
    ...(args.correlationId !== undefined ? { correlationId: args.correlationId } : {}),
  }
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export interface MakeProgressEventArgs {
  providerId: AdapterProviderId
  phase: string
  percentage?: number | undefined
  message?: string | undefined
  current?: number | undefined
  total?: number | undefined
  details?: Record<string, unknown> | undefined
  correlationId?: string | undefined
  timestamp?: number
}

export function makeProgressEvent(args: MakeProgressEventArgs): AgentProgressEvent {
  return {
    type: 'adapter:progress',
    providerId: args.providerId,
    phase: args.phase,
    timestamp: args.timestamp ?? Date.now(),
    ...(args.percentage !== undefined ? { percentage: args.percentage } : {}),
    ...(args.message !== undefined ? { message: args.message } : {}),
    ...(args.current !== undefined ? { current: args.current } : {}),
    ...(args.total !== undefined ? { total: args.total } : {}),
    ...(args.details !== undefined ? { details: args.details } : {}),
    ...(args.correlationId !== undefined ? { correlationId: args.correlationId } : {}),
  }
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

export interface MakeInteractionRequiredEventArgs {
  providerId: AdapterProviderId
  interactionId: string
  question: string
  kind: AgentInteractionRequiredEvent['kind']
  expiresAt: number
  correlationId?: string | undefined
  timestamp?: number
}

export function makeInteractionRequiredEvent(
  args: MakeInteractionRequiredEventArgs,
): AgentInteractionRequiredEvent {
  return {
    type: 'adapter:interaction_required',
    providerId: args.providerId,
    interactionId: args.interactionId,
    question: args.question,
    kind: args.kind,
    timestamp: args.timestamp ?? Date.now(),
    expiresAt: args.expiresAt,
    ...(args.correlationId !== undefined ? { correlationId: args.correlationId } : {}),
  }
}

export interface MakeInteractionResolvedEventArgs {
  providerId: AdapterProviderId
  interactionId: string
  question: string
  answer: string
  resolvedBy: AgentInteractionResolvedEvent['resolvedBy']
  correlationId?: string | undefined
  timestamp?: number
}

export function makeInteractionResolvedEvent(
  args: MakeInteractionResolvedEventArgs,
): AgentInteractionResolvedEvent {
  return {
    type: 'adapter:interaction_resolved',
    providerId: args.providerId,
    interactionId: args.interactionId,
    question: args.question,
    answer: args.answer,
    resolvedBy: args.resolvedBy,
    timestamp: args.timestamp ?? Date.now(),
    ...(args.correlationId !== undefined ? { correlationId: args.correlationId } : {}),
  }
}

// ---------------------------------------------------------------------------
// Cache stats
// ---------------------------------------------------------------------------

export interface MakeCacheStatsEventArgs {
  providerId: AdapterProviderId
  sessionId: string
  cacheReadTokens: number
  cacheWriteTokens: number
  totalInputTokens: number
  cacheHitRatio: number
  correlationId?: string | undefined
  timestamp?: number
}

export function makeCacheStatsEvent(
  args: MakeCacheStatsEventArgs,
): AgentCacheStatsEvent {
  return {
    type: 'adapter:cache_stats',
    providerId: args.providerId,
    sessionId: args.sessionId,
    cacheReadTokens: args.cacheReadTokens,
    cacheWriteTokens: args.cacheWriteTokens,
    totalInputTokens: args.totalInputTokens,
    cacheHitRatio: args.cacheHitRatio,
    timestamp: args.timestamp ?? Date.now(),
    ...(args.correlationId !== undefined ? { correlationId: args.correlationId } : {}),
  }
}
