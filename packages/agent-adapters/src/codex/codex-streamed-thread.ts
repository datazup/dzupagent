/**
 * Helpers for {@link CodexAdapter.runStreamedThread}.
 *
 * Extracted from `codex-adapter.ts` to keep the streaming pipeline focused:
 *
 *   - {@link createThreadAbortController} — combine caller signal +
 *     internal abort + per-call timeout into a single signal with cleanup.
 *   - {@link classifyCodexItem}            — dispatch table mapping a
 *     completed Codex SDK ThreadItem to zero or more unified `AgentEvent`s.
 *     The full SDK event-to-event mapping lives in `CodexAdapter.mapEvent`;
 *     this helper covers the `item.completed` branch since item-type
 *     dispatch dominates the original method body.
 *   - {@link buildCompletedPayload}        — assemble the final
 *     `adapter:completed` event from accumulated stream state.
 *
 * All helpers are pure functions — they receive an explicit context object
 * (provider id, current input, identity annotations) instead of relying on
 * adapter-instance state. This keeps `runStreamedThread` thin while letting
 * the existing `CodexAdapter.mapEvent` / `mapItemCompleted` keep their
 * provider-specific identity threading.
 */

import type {
  AdapterProviderId,
  AgentEvent,
  AgentInput,
  TokenUsage,
} from '../types.js'
import { withCorrelationId } from '../types.js'

// ---------------------------------------------------------------------------
// Types — re-declared minimally here to avoid a circular import with
// `codex-adapter.ts`. They mirror the SDK shape we already document there.
// ---------------------------------------------------------------------------

interface CodexAgentMessageItem {
  type: 'agent_message'
  id: string
  text: string
}

interface CodexCommandExecutionItem {
  type: 'command_execution'
  id: string
  command: string
  aggregated_output: string
  exit_code?: number
  status: string
}

interface CodexFileChangeItem {
  type: 'file_change'
  id: string
  changes: ReadonlyArray<{ path: string; kind: string }>
  status: string
}

interface CodexMcpToolCallItem {
  type: 'mcp_tool_call'
  id: string
  server: string
  tool: string
  arguments: unknown
  result?: { content: unknown[]; structured_content: unknown }
  error?: { message: string }
  status: string
}

interface CodexWebSearchItem {
  type: 'web_search'
  id: string
  query: string
}

interface CodexReasoningItem {
  type: 'reasoning'
  id: string
  text: string
}

interface CodexTodoListItem {
  type: 'todo_list'
  id: string
  items: ReadonlyArray<{ text: string; completed: boolean }>
}

interface CodexErrorItem {
  type: 'error'
  id: string
  message: string
}

interface CodexApprovalRequestItem {
  type: 'approval_request'
  id: string
  message: string
  kind: 'permission' | 'clarification' | 'confirmation'
}

export type CodexThreadItem =
  | CodexAgentMessageItem
  | CodexCommandExecutionItem
  | CodexFileChangeItem
  | CodexMcpToolCallItem
  | CodexWebSearchItem
  | CodexReasoningItem
  | CodexTodoListItem
  | CodexErrorItem
  | CodexApprovalRequestItem

// ---------------------------------------------------------------------------
// Types — public API
// ---------------------------------------------------------------------------

/**
 * Mutable state accumulated while iterating the Codex stream.
 *
 * `runStreamedThread` owns the canonical instance and updates it in-place;
 * helpers like {@link buildCompletedPayload} read from it.
 */
export interface StreamState {
  sessionId: string
  startTime: number
  finalResponse: string
  lastUsage: TokenUsage | undefined
}

export interface ClassifyContext {
  providerId: AdapterProviderId
  providerEventId: string | null
  parentProviderEventId: string | null
}

export interface ThreadAbortHandle {
  /** Combined signal — fires on caller abort, internal abort, or timeout. */
  signal: AbortSignal
  /** Internal AbortController whose abort triggers the combined signal. */
  internal: AbortController
  /** Returns true if the timeout fired before completion. */
  didTimeout: () => boolean
  /** Clear the timer + signal listeners. Idempotent. */
  cleanup: () => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now(): number {
  return Date.now()
}

function isItemOfType<T extends CodexThreadItem['type']>(
  item: CodexThreadItem,
  type: T,
): item is Extract<CodexThreadItem, { type: T }> {
  return item.type === type
}

function annotateProviderIdentity<T extends AgentEvent>(
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

function summarizeTodoList(
  items: ReadonlyArray<{ text: string; completed: boolean }>,
): { current: number; total: number; percentage: number; message: string } {
  const total = items.length
  const current = items.filter((item) => item.completed).length
  const percentage = total > 0 ? Math.round((current / total) * 100) : 100
  const nextPending = items
    .find((item) => !item.completed && item.text.trim().length > 0)
    ?.text.trim()

  if (total === 0) {
    return { current, total, percentage, message: 'Todo list updated' }
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Combine the caller-supplied AbortSignal (optional) with an internal
 * AbortController and a per-call timeout into a single signal.
 *
 * The returned handle exposes:
 *   - `signal`     — pass to `thread.runStreamed({ signal })`.
 *   - `internal`   — adapter-owned controller; calling `internal.abort()`
 *                    cancels the in-flight stream (used by `interrupt()`).
 *   - `didTimeout` — true once the timeout has fired (regardless of who
 *                    observed the abort first).
 *   - `cleanup`    — clears the timer and any attached listeners. Idempotent.
 *
 * If `timeoutMs` is `undefined` the timer is not started.
 */
export function createThreadAbortController(
  timeoutMs: number | undefined,
  callerSignal: AbortSignal | undefined,
  onTimeout?: () => void,
): ThreadAbortHandle {
  const internal = new AbortController()
  let timedOut = false
  let cleaned = false

  const timeoutHandle =
    typeof timeoutMs === 'number' && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          if (onTimeout) onTimeout()
          internal.abort()
        }, timeoutMs)
      : null

  // Combine caller signal + internal signal into a single observable signal
  let signal: AbortSignal
  let externalListener: (() => void) | null = null
  let internalListener: (() => void) | null = null

  if (!callerSignal) {
    signal = internal.signal
  } else if (callerSignal.aborted || internal.signal.aborted) {
    const combined = new AbortController()
    combined.abort()
    signal = combined.signal
  } else {
    const combined = new AbortController()
    externalListener = () => combined.abort()
    internalListener = () => combined.abort()
    callerSignal.addEventListener('abort', externalListener, { once: true })
    internal.signal.addEventListener('abort', internalListener, { once: true })
    signal = combined.signal
  }

  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    if (timeoutHandle) clearTimeout(timeoutHandle)
    if (callerSignal && externalListener) {
      callerSignal.removeEventListener('abort', externalListener)
    }
    if (internalListener) {
      internal.signal.removeEventListener('abort', internalListener)
    }
  }

  return {
    signal,
    internal,
    didTimeout: () => timedOut,
    cleanup,
  }
}

/**
 * Map a completed Codex `ThreadItem` to zero or more unified
 * {@link AgentEvent}s.
 *
 * Mirrors the dispatch logic of `CodexAdapter.mapItemCompleted` but lives
 * outside the class so the streaming loop can be a thin wrapper.
 *
 * Returns `null` for `approval_request` items — those are intercepted by the
 * approval-handling block in `runStreamedThread` and produce no synchronous
 * AgentEvent here.
 */
export function classifyCodexItem(
  item: CodexThreadItem,
  ctx: ClassifyContext,
): AgentEvent[] | null {
  const ts = now()
  const { providerId, providerEventId, parentProviderEventId } = ctx

  if (isItemOfType(item, 'agent_message')) {
    return [
      annotateProviderIdentity(
        {
          type: 'adapter:message',
          providerId,
          content: item.text ?? '',
          role: 'assistant',
          timestamp: ts,
        } as AgentEvent,
        providerEventId,
        parentProviderEventId,
      ),
    ]
  }

  if (isItemOfType(item, 'command_execution')) {
    return [
      annotateProviderIdentity(
        {
          type: 'adapter:tool_call',
          providerId,
          toolName: 'shell',
          input: { command: item.command },
          timestamp: ts,
        } as AgentEvent,
        providerEventId,
        parentProviderEventId,
      ),
      annotateProviderIdentity(
        {
          type: 'adapter:tool_result',
          providerId,
          toolName: 'shell',
          output: item.aggregated_output ?? '',
          durationMs: 0,
          timestamp: ts,
        } as AgentEvent,
        providerEventId,
        parentProviderEventId,
      ),
    ]
  }

  if (isItemOfType(item, 'file_change')) {
    const summary = item.changes.map((c) => `${c.kind}: ${c.path}`).join('\n')
    return [
      annotateProviderIdentity(
        {
          type: 'adapter:tool_result',
          providerId,
          toolName: 'file_edit',
          output: summary,
          durationMs: 0,
          timestamp: ts,
        } as AgentEvent,
        providerEventId,
        parentProviderEventId,
      ),
    ]
  }

  if (isItemOfType(item, 'mcp_tool_call')) {
    const toolName = `${item.server}/${item.tool}`
    const outputContent = item.result?.content
      ? JSON.stringify(item.result.content)
      : (item.error?.message ?? '')
    return [
      annotateProviderIdentity(
        {
          type: 'adapter:tool_call',
          providerId,
          toolName,
          input: item.arguments,
          timestamp: ts,
        } as AgentEvent,
        providerEventId,
        parentProviderEventId,
      ),
      annotateProviderIdentity(
        {
          type: 'adapter:tool_result',
          providerId,
          toolName,
          output: outputContent,
          durationMs: 0,
          timestamp: ts,
        } as AgentEvent,
        providerEventId,
        parentProviderEventId,
      ),
    ]
  }

  if (isItemOfType(item, 'web_search')) {
    return [
      annotateProviderIdentity(
        {
          type: 'adapter:tool_call',
          providerId,
          toolName: 'web_search',
          input: { query: item.query },
          timestamp: ts,
        } as AgentEvent,
        providerEventId,
        parentProviderEventId,
      ),
    ]
  }

  if (isItemOfType(item, 'reasoning')) {
    return [
      annotateProviderIdentity(
        {
          type: 'adapter:message',
          providerId,
          content: item.text ?? '',
          role: 'assistant',
          timestamp: ts,
        } as AgentEvent,
        providerEventId,
        parentProviderEventId,
      ),
    ]
  }

  if (isItemOfType(item, 'todo_list')) {
    const summary = summarizeTodoList(item.items)
    return [
      annotateProviderIdentity(
        {
          type: 'adapter:progress',
          providerId,
          phase: 'todo_list',
          current: summary.current,
          total: summary.total,
          percentage: summary.percentage,
          message: summary.message,
          timestamp: ts,
        } as AgentEvent,
        providerEventId,
        parentProviderEventId,
      ),
    ]
  }

  if (isItemOfType(item, 'error')) {
    return [
      annotateProviderIdentity(
        {
          type: 'adapter:failed',
          providerId,
          error: item.message,
          code: 'ADAPTER_EXECUTION_FAILED',
          timestamp: ts,
        } as AgentEvent,
        providerEventId,
        parentProviderEventId,
      ),
    ]
  }

  // approval_request — handled by runStreamedThread's resolver flow.
  if (isItemOfType(item, 'approval_request')) {
    return null
  }

  return []
}

/**
 * Build the final `adapter:completed` event for a streamed turn.
 *
 * The caller is responsible for ensuring the state reflects the most recent
 * `lastUsage` (extracted from `turn.completed.usage`) and the accumulated
 * `finalResponse` (from `adapter:message` events with `role === 'assistant'`).
 */
export function buildCompletedPayload(
  state: StreamState,
  providerId: AdapterProviderId,
  input: AgentInput,
): AgentEvent {
  const durationMs = now() - state.startTime
  const ts = now()
  return withCorrelationId(
    {
      type: 'adapter:completed',
      providerId,
      sessionId: state.sessionId,
      result: state.finalResponse || '',
      ...(state.lastUsage !== undefined ? { usage: state.lastUsage } : {}),
      durationMs,
      timestamp: ts,
    } as AgentEvent,
    input.correlationId,
  )
}
