/**
 * Claude adapter event-mapping helpers.
 *
 * Pure utilities that transform Claude SDK messages into pieces used by the
 * adapter's `mapRawEvent` implementation: token usage extraction, sandbox
 * mode mapping, interaction-tool detection, and per-message-type mappers.
 */
import { randomUUID } from 'node:crypto'
import type {
  AdapterConfig,
  AgentEvent,
  AgentInput,
  InteractionPolicy,
  TokenUsage,
} from '../types.js'
import { extractTokenUsage as extractTokenUsageShared } from '../base/extract-token-usage.js'
import { classifyInteractionText } from '../interaction/interaction-detector.js'
import type { InteractionResolver } from '../interaction/interaction-resolver.js'
import type { StreamContext } from '../base/stream-runner.js'
import {
  makeCacheStatsEvent,
  makeCompletedEvent,
  makeFailedEvent,
  makeInteractionRequiredEvent,
  makeMessageEvent,
  makeStreamDeltaEvent,
  makeToolCallEvent,
  makeToolResultEvent,
} from '../events/event-factories.js'
import {
  type ClaudeSDKMessage,
  type ResultMessage,
  type StreamEventMessage,
  type ToolProgressMessage,
  extractTextFromContentBlocks,
} from './claude-sdk-types.js'

// ---------------------------------------------------------------------------
// Permission mode mapping
// ---------------------------------------------------------------------------

export function mapSandboxMode(mode: AdapterConfig['sandboxMode']): string {
  switch (mode) {
    case 'read-only':
      return 'default'
    case 'workspace-write':
      // Claude SDK has no granular cwd-write mode. Route to 'default' (restricted)
      // rather than 'bypassPermissions' (full access). Callers that need unrestricted
      // file writes must explicitly use 'full-access'.
      return 'default'
    case 'full-access':
      return 'bypassPermissions'
    default:
      return 'default'
  }
}

// ---------------------------------------------------------------------------
// Token usage extraction
// ---------------------------------------------------------------------------

export function extractTokenUsage(
  usage: Record<string, unknown> | undefined,
): TokenUsage | undefined {
  return extractTokenUsageShared(usage) as TokenUsage | undefined
}

// ---------------------------------------------------------------------------
// Interaction tool helpers
// ---------------------------------------------------------------------------

/** Tool names the Claude SDK uses when it needs to ask the user something. */
const INTERACTION_TOOL_NAMES = new Set([
  'user_confirmation',
  'request_permission',
  'ask_user',
  'clarification',
  'confirm',
])

export function isInteractionToolName(name: string): boolean {
  return INTERACTION_TOOL_NAMES.has(name)
}

/** Extract question text from the tool input object. */
export function extractQuestionFromToolInput(input: unknown): string {
  if (input === null || typeof input !== 'object') return String(input ?? '')
  const obj = input as Record<string, unknown>
  for (const key of ['question', 'message', 'prompt', 'text', 'description', 'reason']) {
    if (typeof obj[key] === 'string' && (obj[key] as string).length > 0) {
      return obj[key] as string
    }
  }
  return JSON.stringify(input)
}

// ---------------------------------------------------------------------------
// Per-message-type mappers
// ---------------------------------------------------------------------------

/** Map an `assistant` SDK message → unified `adapter:message` event. */
export function mapAssistantMessage(
  raw: ClaudeSDKMessage & { content: unknown[] },
  input: AgentInput,
): AgentEvent | null {
  const text = extractTextFromContentBlocks(raw.content)
  if (text.length === 0) return null
  return makeMessageEvent({
    providerId: 'claude',
    content: text,
    role: 'assistant',
    correlationId: input.correlationId,
  })
}

/** State carried across tool_progress messages — owned by the adapter. */
export interface ToolProgressState {
  lastToolStartTime: number
  lastToolName: string
}

/**
 * Map a `tool_progress` SDK message → unified tool-call/tool-result event,
 * or an interaction_required event when the tool is an interaction prompt.
 *
 * Mutates `state` to track timing for duration synthesis.
 */
export function mapToolProgressMessage(
  raw: ToolProgressMessage,
  input: AgentInput,
  state: ToolProgressState,
  resolver: InteractionResolver | null,
  policy: InteractionPolicy,
): AgentEvent | null {
  if (raw.status === 'started') {
    state.lastToolStartTime = Date.now()
    state.lastToolName = raw.tool_name

    if (resolver && isInteractionToolName(raw.tool_name)) {
      const questionText = extractQuestionFromToolInput(raw.input)
      const interactionId = randomUUID()
      const kind = classifyInteractionText(questionText)
      const nowMs = Date.now()

      if (policy.mode === 'ask-caller') {
        // Return interaction_required as the mapped event; the resolver runs async.
        void resolver.resolve({ interactionId, question: questionText, kind })
        return makeInteractionRequiredEvent({
          providerId: 'claude',
          interactionId,
          question: questionText,
          kind,
          timestamp: nowMs,
          expiresAt: nowMs + (policy.askCaller?.timeoutMs ?? 60_000),
          correlationId: input.correlationId,
        })
      }
      return null
    }

    return makeToolCallEvent({
      providerId: 'claude',
      toolName: raw.tool_name,
      input: raw.input ?? {},
      correlationId: input.correlationId,
    })
  }

  // completed/failed
  if (isInteractionToolName(raw.tool_name) && resolver) return null
  const durationMs = typeof raw.duration_ms === 'number'
    ? raw.duration_ms
    : (state.lastToolName === raw.tool_name ? Date.now() - state.lastToolStartTime : 0)
  return makeToolResultEvent({
    providerId: 'claude',
    toolName: raw.tool_name,
    output: typeof raw.output === 'string' ? raw.output : '',
    durationMs,
    correlationId: input.correlationId,
  })
}

/** Map a `stream_event` SDK message → unified `adapter:stream_delta` event. */
export function mapStreamEventMessage(
  raw: StreamEventMessage,
  input: AgentInput,
): AgentEvent | null {
  const delta = raw.delta
  if (typeof delta !== 'string' || delta.length === 0) return null
  return makeStreamDeltaEvent({
    providerId: 'claude',
    content: delta,
    correlationId: input.correlationId,
  })
}

/**
 * Map a `result` SDK message → `adapter:completed` (+ optional cache_stats)
 * or `adapter:failed` based on the message subtype.
 */
export function mapResultMessage(
  raw: ResultMessage,
  input: AgentInput,
  context: StreamContext,
  startTime: number,
): AgentEvent | AgentEvent[] {
  const durationMs = typeof raw.duration_ms === 'number'
    ? raw.duration_ms
    : Date.now() - startTime

  if (raw.subtype === 'success') {
    const tokenUsage = extractTokenUsage(raw.usage)
    const sessionId = raw.session_id ?? context.sessionId
    const completedEvent = makeCompletedEvent({
      providerId: 'claude',
      sessionId,
      result: typeof raw.result === 'string' ? raw.result : '',
      usage: tokenUsage,
      durationMs,
      correlationId: input.correlationId,
    })
    if (tokenUsage && (tokenUsage.cachedInputTokens !== undefined || tokenUsage.cacheWriteTokens !== undefined)) {
      const cacheRead = tokenUsage.cachedInputTokens ?? 0
      const cacheWrite = tokenUsage.cacheWriteTokens ?? 0
      // Anthropic reports uncached input, cache reads, and cache writes as
      // separate usage fields. The shared cache-statistics contract requires
      // totalInputTokens to include every input category.
      const total = tokenUsage.inputTokens + cacheRead + cacheWrite
      const cacheStatsEvent = makeCacheStatsEvent({
        providerId: 'claude',
        sessionId,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        totalInputTokens: total,
        cacheHitRatio: total > 0 ? cacheRead / total : 0,
        correlationId: input.correlationId,
      })
      return [completedEvent, cacheStatsEvent]
    }
    return completedEvent
  }

  const failedSessionId = raw.session_id ?? (context.sessionId || undefined)
  return makeFailedEvent({
    providerId: 'claude',
    sessionId: failedSessionId,
    error: typeof raw.error === 'string'
      ? raw.error
      : `Claude agent failed with subtype: ${raw.subtype}`,
    code: raw.subtype,
    correlationId: input.correlationId,
  })
}
