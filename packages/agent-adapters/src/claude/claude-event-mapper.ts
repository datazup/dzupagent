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
  isContentBlock,
  messageContentBlocks,
} from './claude-sdk-types.js'
import { serializeProviderPayload } from '../utils/provider-event-normalization.js'

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

/**
 * Map an `assistant` SDK message → `adapter:message` for its text plus one
 * `adapter:tool_call` per `tool_use` block. Tool names are recorded by call id
 * so the matching `tool_result` can be attributed.
 */
export function mapAssistantMessage(
  raw: ClaudeSDKMessage,
  input: AgentInput,
  toolNamesByCallId: Map<string, string>,
): AgentEvent[] | null {
  const blocks = messageContentBlocks(raw) ?? []
  const events: AgentEvent[] = []
  const text = extractTextFromContentBlocks(blocks)
  if (text.length > 0) {
    events.push(makeMessageEvent({
      providerId: 'claude',
      content: text,
      role: 'assistant',
      correlationId: input.correlationId,
    }))
  }
  for (const block of blocks) {
    if (!isContentBlock(block) || block.type !== 'tool_use') continue
    const part = block as unknown as Record<string, unknown>
    const toolName = typeof part['name'] === 'string' ? part['name'] : 'unknown'
    const toolCallId = typeof part['id'] === 'string' ? part['id'] : undefined
    if (toolCallId) toolNamesByCallId.set(toolCallId, toolName)
    events.push(makeToolCallEvent({
      providerId: 'claude',
      toolName,
      toolCallId,
      input: part['input'] ?? {},
      correlationId: input.correlationId,
    }))
  }
  return events.length > 0 ? events : null
}

/** Map the `tool_result` blocks of a `user` SDK message → `adapter:tool_result` events. */
export function mapUserToolResults(
  raw: ClaudeSDKMessage,
  input: AgentInput,
  toolNamesByCallId: Map<string, string>,
): AgentEvent[] | null {
  const events: AgentEvent[] = []
  for (const block of messageContentBlocks(raw) ?? []) {
    if (!isContentBlock(block) || block.type !== 'tool_result') continue
    const part = block as unknown as Record<string, unknown>
    const toolCallId = typeof part['tool_use_id'] === 'string' ? part['tool_use_id'] : undefined
    const toolName = toolCallId ? toolNamesByCallId.get(toolCallId) ?? 'unknown' : 'unknown'
    if (toolCallId) toolNamesByCallId.delete(toolCallId)
    events.push(makeToolResultEvent({
      providerId: 'claude',
      toolName,
      toolCallId,
      output: serializeProviderPayload(part['content']) ?? '',
      durationMs: 0,
      isError: typeof part['is_error'] === 'boolean' ? part['is_error'] : undefined,
      correlationId: input.correlationId,
    }))
  }
  return events.length > 0 ? events : null
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
  // SDK progress heartbeats carry no status; the call and its result arrive
  // as assistant `tool_use` and user `tool_result` blocks instead.
  if (raw.status === undefined) return null
  if (raw.status === 'started') {
    state.lastToolStartTime = Date.now()
    state.lastToolName = raw.tool_name

    if (resolver && isInteractionToolName(raw.tool_name)) {
      const questionText = extractQuestionFromToolInput(raw.input)
      const interactionId = randomUUID()
      const kind = classifyInteractionText(questionText)
      const nowMs = Date.now()

      // Internal request marker: the adapter registers and enforces resolution
      // before exposing this event in ask-caller mode. Mapping starts no work.
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
 * or `adapter:failed` based on the message subtype and `is_error` flag.
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

  // The SDK reports a provider API rejection (e.g. an HTTP 400) as subtype
  // `success` with `is_error: true` and the error text in `result`.
  const apiError = raw.is_error === true
  if (raw.subtype === 'success' && !apiError) {
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
  const failedUsage = extractTokenUsage(raw.usage)
  // A cost-only result cannot establish the required token fields of TokenUsage.
  if (failedUsage) {
    // Preserve only reported, valid cost. The SDK reports total cost on the
    // result message, separately from its token usage object.
    if (failedUsage.costCents !== undefined &&
        (!Number.isFinite(failedUsage.costCents) || failedUsage.costCents < 0)) {
      delete failedUsage.costCents
    }
    const costCents = typeof raw.total_cost_usd === 'number'
      ? raw.total_cost_usd * 100
      : undefined
    if (costCents !== undefined && Number.isFinite(costCents) && costCents >= 0) {
      failedUsage.costCents = costCents
    }
  }
  return makeFailedEvent({
    providerId: 'claude',
    sessionId: failedSessionId,
    error: typeof raw.error === 'string'
      ? raw.error
      : apiError && typeof raw.result === 'string' && raw.result.length > 0
        ? raw.result
        : `Claude agent failed with subtype: ${raw.subtype}`,
    code: apiError && raw.subtype === 'success' ? 'is_error' : raw.subtype,
    usage: failedUsage,
    correlationId: input.correlationId,
  })
}
