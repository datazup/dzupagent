/**
 * Pure helpers for Codex event normalization.
 *
 * No state — every function is pure. The {@link CodexAdapter} class wires
 * these into the {@link AdapterStreamSource} contract.
 */

import type {
  AdapterConfig,
  AdapterProviderId,
  AgentEvent,
  AgentInput,
  TokenUsage,
} from '../types.js'
import { withCorrelationId } from '../types.js'
import {
  makeFailedEvent,
  makeMessageEvent,
  makeProgressEvent,
  makeToolCallEvent,
  makeToolResultEvent,
} from '../events/event-factories.js'
import type {
  CodexApprovalRequestItem,
  CodexStreamEvent,
  CodexThreadItem,
} from './codex-types.js'

export function now(): number {
  return Date.now()
}

export function isCodexItemOfType<T extends CodexThreadItem['type']>(
  item: CodexThreadItem,
  type: T,
): item is Extract<CodexThreadItem, { type: T }> {
  return item.type === type
}

export function annotateProviderIdentity<T extends AgentEvent>(
  event: T,
  providerEventId: string | null,
  parentProviderEventId: string | null,
): T {
  if (!providerEventId && !parentProviderEventId) return event
  return {
    ...event,
    ...(providerEventId ? { providerEventId } : {}),
    ...(parentProviderEventId ? { parentProviderEventId } : {}),
  } as T
}

/** Map AdapterConfig sandbox mode to the Codex SDK SandboxMode enum values */
export function toCodexSandboxMode(
  mode: AdapterConfig['sandboxMode'],
): string {
  switch (mode) {
    case 'read-only':
      return 'read-only'
    case 'full-access':
      return 'danger-full-access'  // SDK uses 'danger-full-access', not 'full-access'
    case 'workspace-write':
    default:
      return 'workspace-write'
  }
}

export function toTokenUsage(
  usage: CodexStreamEvent['usage'],
): TokenUsage | undefined {
  if (!usage) return undefined
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(usage.cached_input_tokens !== undefined ? { cachedInputTokens: usage.cached_input_tokens } : {}),
  }
}

export function summarizeTodoList(
  items: ReadonlyArray<{ text: string; completed: boolean }>,
): {
  current: number
  total: number
  percentage: number
  message: string
} {
  const total = items.length
  const current = items.filter((item) => item.completed).length
  const percentage = total > 0 ? Math.round((current / total) * 100) : 100
  const nextPending = items
    .find((item) => !item.completed && item.text.trim().length > 0)
    ?.text
    .trim()

  if (total === 0) {
    return {
      current,
      total,
      percentage,
      message: 'Todo list updated',
    }
  }

  return {
    current,
    total,
    percentage,
    message: nextPending
      ? `Todo list updated (${current}/${total} completed). Next: ${nextPending}`
      : `Todo list updated (${current}/${total} completed)`,
  }
}

export function buildProviderEventId(
  providerId: AdapterProviderId,
  event: CodexStreamEvent,
  sessionId: string,
  ordinal: number,
): string {
  const itemId =
    event.item && typeof event.item === 'object' && 'id' in event.item && typeof event.item.id === 'string'
      ? event.item.id
      : null
  const threadId = typeof event.thread_id === 'string' ? event.thread_id : sessionId
  return [
    providerId,
    threadId,
    event.type,
    itemId ?? ordinal,
  ].join(':')
}

// ---------------------------------------------------------------------------
// Event mapping: SDK CodexStreamEvent → AgentEvent[]
// ---------------------------------------------------------------------------

/**
 * Map a single Codex SDK event to zero or more AgentEvents.
 */
export function mapCodexEvent(
  providerId: AdapterProviderId,
  event: CodexStreamEvent,
  sessionId: string,
  providerEventId: string,
  parentProviderEventId: string | null,
  input: AgentInput,
): AgentEvent[] {
  const ts = now()

  switch (event.type) {
    case 'thread.started':
      // Handled by detectThreadStart → runner emits adapter:started.
      return []

    case 'item.completed': {
      if (!event.item) return []
      return mapItemCompleted(providerId, event.item, ts, providerEventId, parentProviderEventId, input)
    }

    case 'turn.completed':
      // Usage already captured in open(). No AgentEvent emitted here.
      return []

    case 'turn.failed': {
      const errObj = event.error
      const errMsg =
        typeof errObj === 'object' && errObj !== null && 'message' in errObj
          ? (errObj as { message: string }).message
          : typeof errObj === 'string'
            ? errObj
            : 'Turn failed (unknown reason)'
      return [
        annotateProviderIdentity(
          withCorrelationId(
            makeFailedEvent({
              providerId,
              sessionId,
              error: errMsg,
              code: 'ADAPTER_EXECUTION_FAILED',
              timestamp: ts,
            }),
            input.correlationId,
          ),
          providerEventId,
          parentProviderEventId,
        ),
      ]
    }

    case 'error':
      return [
        annotateProviderIdentity(
          withCorrelationId(
            makeFailedEvent({
              providerId,
              sessionId,
              error: event.message ?? 'Unknown error',
              code: 'ADAPTER_EXECUTION_FAILED',
              timestamp: ts,
            }),
            input.correlationId,
          ),
          providerEventId,
          parentProviderEventId,
        ),
      ]

    default:
      return []
  }
}

/**
 * Map a completed ThreadItem to AgentEvent(s).
 */
export function mapItemCompleted(
  providerId: AdapterProviderId,
  item: CodexThreadItem,
  ts: number,
  providerEventId: string,
  parentProviderEventId: string | null,
  input: AgentInput,
): AgentEvent[] {
  if (isCodexItemOfType(item, 'agent_message')) {
    return [
      annotateProviderIdentity(
        withCorrelationId(
          makeMessageEvent({
            providerId,
            content: item.text ?? '',
            role: 'assistant',
            timestamp: ts,
          }),
          input.correlationId,
        ),
        providerEventId,
        parentProviderEventId,
      ),
    ]
  }

  if (isCodexItemOfType(item, 'command_execution')) {
    return [
      annotateProviderIdentity(
        withCorrelationId(
          makeToolCallEvent({
            providerId,
            toolName: 'shell',
            input: { command: item.command },
            timestamp: ts,
          }),
          input.correlationId,
        ),
        providerEventId,
        parentProviderEventId,
      ),
      annotateProviderIdentity(
        withCorrelationId(
          makeToolResultEvent({
            providerId,
            toolName: 'shell',
            output: item.aggregated_output ?? '',
            durationMs: 0,
            timestamp: ts,
          }),
          input.correlationId,
        ),
        providerEventId,
        parentProviderEventId,
      ),
    ]
  }

  if (isCodexItemOfType(item, 'file_change')) {
    const summary = item.changes
      .map((c) => `${c.kind}: ${c.path}`)
      .join('\n')
    return [
      annotateProviderIdentity(
        withCorrelationId(
          makeToolResultEvent({
            providerId,
            toolName: 'file_edit',
            output: summary,
            durationMs: 0,
            timestamp: ts,
          }),
          input.correlationId,
        ),
        providerEventId,
        parentProviderEventId,
      ),
    ]
  }

  if (isCodexItemOfType(item, 'mcp_tool_call')) {
    const toolName = `${item.server}/${item.tool}`
    const outputContent = item.result?.content
      ? JSON.stringify(item.result.content)
      : (item.error?.message ?? '')
    return [
      annotateProviderIdentity(
        withCorrelationId(
          makeToolCallEvent({
            providerId,
            toolName,
            input: item.arguments,
            timestamp: ts,
          }),
          input.correlationId,
        ),
        providerEventId,
        parentProviderEventId,
      ),
      annotateProviderIdentity(
        withCorrelationId(
          makeToolResultEvent({
            providerId,
            toolName,
            output: outputContent,
            durationMs: 0,
            timestamp: ts,
          }),
          input.correlationId,
        ),
        providerEventId,
        parentProviderEventId,
      ),
    ]
  }

  if (isCodexItemOfType(item, 'web_search')) {
    return [
      annotateProviderIdentity(
        withCorrelationId(
          makeToolCallEvent({
            providerId,
            toolName: 'web_search',
            input: { query: item.query },
            timestamp: ts,
          }),
          input.correlationId,
        ),
        providerEventId,
        parentProviderEventId,
      ),
    ]
  }

  if (isCodexItemOfType(item, 'reasoning')) {
    return [
      annotateProviderIdentity(
        withCorrelationId(
          makeMessageEvent({
            providerId,
            content: item.text ?? '',
            role: 'assistant',
            timestamp: ts,
          }),
          input.correlationId,
        ),
        providerEventId,
        parentProviderEventId,
      ),
    ]
  }

  if (isCodexItemOfType(item, 'todo_list')) {
    const summary = summarizeTodoList(item.items)
    return [
      annotateProviderIdentity(
        withCorrelationId(
          makeProgressEvent({
            providerId,
            phase: 'todo_list',
            current: summary.current,
            total: summary.total,
            percentage: summary.percentage,
            message: summary.message,
            timestamp: ts,
          }),
          input.correlationId,
        ),
        providerEventId,
        parentProviderEventId,
      ),
    ]
  }

  if (isCodexItemOfType(item, 'error')) {
    return [
      annotateProviderIdentity(
        withCorrelationId(
          makeFailedEvent({
            providerId,
            error: item.message,
            code: 'ADAPTER_EXECUTION_FAILED',
            timestamp: ts,
          }),
          input.correlationId,
        ),
        providerEventId,
        parentProviderEventId,
      ),
    ]
  }

  // approval_request — handled by open() via handleApprovalRequest(); emit no events here.
  if (isCodexItemOfType(item, 'approval_request')) {
    return []
  }

  return []
}

// Re-export for back-compat / convenience
export type { CodexApprovalRequestItem }
