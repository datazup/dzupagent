/**
 * runStreamedThread — Codex SDK streaming loop.
 *
 * This is the heart of the Codex adapter: it consumes events emitted by the
 * Codex SDK's `thread.runStreamed()` iterable and yields unified
 * {@link AgentStreamEvent}s. It owns:
 *
 *   - Per-call timeout enforcement (config.timeoutMs / DEFAULT_TIMEOUT_MS).
 *   - `runStreamed()` pre-stream phase (may throw/abort before events start).
 *   - Per-event mapping via {@link mapCodexEvent} + {@link wrapRawProviderEvent}.
 *   - Approval-pause handling via {@link handleApprovalRequest} and
 *     {@link handleTurnFailedApproval} (see `codex-approval.ts`).
 *   - Final `adapter:completed` + optional `adapter:cache_stats` emission.
 *
 * Extracted from {@link CodexAdapter} to keep the class file focused on the
 * adapter contract. The function receives a {@link RunStreamedThreadContext}
 * snapshot of the adapter state it needs (config, current input, providerId,
 * resolver hooks, mutable session id) so it stays callable without owning the
 * class instance.
 */

import { defaultLogger } from '@dzupagent/core'
import type {
  AdapterConfig,
  AdapterProviderId,
  AgentEvent,
  AgentInput,
  AgentStreamEvent,
  ProviderRawStreamEvent,
  RawAgentEvent,
  TokenUsage,
} from '../types.js'
import { withCorrelationId } from '../types.js'
import type { InteractionResolver } from '../interaction/interaction-resolver.js'
import type {
  CodexApprovalRequestItem,
  CodexInstance,
  CodexStreamEvent,
  CodexThread,
  CodexThreadOptions,
} from './codex-types.js'
import {
  buildProviderEventId,
  mapCodexEvent,
  now,
  toTokenUsage,
} from './codex-helpers.js'
import {
  handleApprovalRequest,
  handleTurnFailedApproval,
  type CodexApprovalContext,
} from './codex-approval.js'

/** Default timeout for a single adapter call (2 minutes) */
export const DEFAULT_CODEX_TIMEOUT_MS = 120_000

/**
 * State and hooks the streaming loop needs from the adapter instance.
 *
 * The fields with `get*`/`set*` patterns let the loop read or update
 * adapter-owned mutable state (`currentSessionId`, `abortController`)
 * without holding a hard reference to the class.
 */
export interface RunStreamedThreadContext {
  providerId: AdapterProviderId
  config: AdapterConfig
  currentInput: AgentInput | undefined
  isResume: boolean
  /** Returns the current session id (may be `null` before thread.started). */
  getSessionId: () => string | null
  /** Updates the active session id when the SDK emits `thread.started`. */
  setSessionId: (sessionId: string) => void
  /** Triggers `interrupt()` semantics on timeout. */
  abort: () => void
  /** Lazily build the approval-flow context (resolver + thread-options). */
  buildApprovalContext: (input: AgentInput) => CodexApprovalContext
  /**
   * Lazily resolve the interaction policy mode for a given input.
   * Used to detect approval-pause `turn.failed` events without forcing
   * the streaming loop to know about `BaseSdkAdapter`.
   */
  isApprovalCapable: (input: AgentInput) => boolean
  /** Build thread options for approval-resume recursion. */
  buildThreadOptions: (input: AgentInput) => CodexThreadOptions
  /** Optional helper kept for parity but not currently invoked here. */
  resolver?: InteractionResolver
}

/**
 * Run a streamed Codex thread and yield unified AgentStreamEvent items.
 *
 * Tracks timing for durationMs and maps every SDK event to the
 * corresponding AgentEvent discriminated union variant.
 *
 * Enforces a per-call timeout (config.timeoutMs or
 * {@link DEFAULT_CODEX_TIMEOUT_MS}) so the stream never hangs indefinitely.
 */
export async function* runStreamedThread(
  thread: CodexThread,
  input: AgentInput,
  codex: CodexInstance,
  signal: AbortSignal,
  ctx: RunStreamedThreadContext,
): AsyncGenerator<AgentStreamEvent, void, undefined> {
  const startTime = now()
  let sessionId = ctx.getSessionId() ?? `codex-${Date.now()}`
  let lastUsage: TokenUsage | undefined
  let finalResponse = ''
  const inputTimeoutMs =
    typeof input.options?.['timeoutMs'] === 'number'
      ? input.options['timeoutMs']
      : undefined
  const configuredTimeoutMs = ctx.config.timeoutMs
  const timeoutMs = inputTimeoutMs ?? configuredTimeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS
  let eventCount = 0
  let lastEventAt = startTime
  let lastEventType = 'none'
  let rawEventOrdinal = 0
  let threadProviderEventId: string | null = null

  // Auto-abort after timeout so we never hang
  let didTimeout = false
  const timeoutHandle = setTimeout(() => {
    didTimeout = true
    defaultLogger.error(
      `[codex-streamed-thread:run] timeout after ${timeoutMs}ms — aborting`,
      { sessionId },
    )
    ctx.abort()
  }, timeoutMs)

  defaultLogger.debug('[codex-streamed-thread:run] starting', {
    sessionId,
    promptLength: input.prompt.length,
    timeoutMs,
    timeoutSource:
      inputTimeoutMs != null
        ? 'input.options.timeoutMs'
        : configuredTimeoutMs != null
          ? 'adapter.config.timeoutMs'
          : 'default',
  })

  let streamedTurn: { events: AsyncIterable<CodexStreamEvent> }

  try {
    streamedTurn = await thread.runStreamed(input.prompt, { signal })
    defaultLogger.debug(
      '[codex-streamed-thread:run] runStreamed returned — consuming events',
      { sessionId },
    )
  } catch (err: unknown) {
    clearTimeout(timeoutHandle)
    const errMsg = err instanceof Error ? err.message : String(err)
    if (didTimeout || signal.aborted) {
      const reason = didTimeout
        ? 'timeout_before_stream_start'
        : 'caller_abort_before_stream_start'
      const durationMs = now() - startTime
      defaultLogger.warn(
        '[codex-streamed-thread:run] runStreamed() aborted before stream events',
        { sessionId, reason, durationMs, error: errMsg },
      )
      yield withCorrelationId(
        {
          type: 'adapter:failed',
          providerId: ctx.providerId,
          sessionId,
          error: didTimeout
            ? `Codex adapter timed out after ${durationMs}ms`
            : errMsg,
          code: didTimeout ? 'ADAPTER_TIMEOUT' : 'ADAPTER_EXECUTION_FAILED',
          timestamp: now(),
        } as AgentEvent,
        input.correlationId,
      )
      return
    }

    defaultLogger.error('[codex-streamed-thread:run] runStreamed() threw', {
      sessionId,
      error: errMsg,
    })
    yield withCorrelationId(
      {
        type: 'adapter:failed',
        providerId: ctx.providerId,
        sessionId,
        error: errMsg,
        code: 'ADAPTER_EXECUTION_FAILED',
        timestamp: now(),
      } as AgentEvent,
      input.correlationId,
    )
    return
  }

  try {
    for await (const event of streamedTurn.events) {
      if (event.type === 'thread.started' && event.thread_id) {
        sessionId = event.thread_id
        ctx.setSessionId(sessionId)
        defaultLogger.debug('[codex-streamed-thread:run] session assigned', {
          sessionId,
        })
      }

      rawEventOrdinal += 1
      const rawProviderEvent = wrapRawProviderEvent(
        ctx.providerId,
        event,
        sessionId,
        input,
        rawEventOrdinal,
        threadProviderEventId,
      )
      if (event.type === 'thread.started') {
        threadProviderEventId =
          rawProviderEvent.rawEvent.providerEventId ?? threadProviderEventId
      }
      yield rawProviderEvent

      const eventNow = now()
      const gapMs = eventNow - lastEventAt
      eventCount += 1
      lastEventAt = eventNow
      lastEventType = event.type
      if (gapMs > 15_000) {
        defaultLogger.debug(
          '[codex-streamed-thread:run] slow stream gap observed',
          { sessionId, eventType: event.type, eventCount, gapMs },
        )
      }

      const providerEventId = rawProviderEvent.rawEvent.providerEventId ?? null
      const parentProviderEventId =
        rawProviderEvent.rawEvent.parentProviderEventId ?? null

      // Special-case `thread.started` — needs adapter-instance state
      // (currentInput, isResume, model, workingDirectory) that's awkward to
      // pass into a standalone helper; emit it inline.
      const mapped =
        event.type === 'thread.started'
          ? buildAdapterStartedEvent(event, sessionId, ctx, providerEventId, parentProviderEventId)
          : mapCodexEvent(
              ctx.providerId,
              event,
              sessionId,
              providerEventId ?? '',
              parentProviderEventId,
              input,
            )

      if (event.type === 'turn.completed' && event.usage) {
        lastUsage = toTokenUsage(event.usage)
        defaultLogger.debug(
          '[codex-streamed-thread:run] turn.completed — usage captured',
          { sessionId, usage: lastUsage },
        )
      }

      // Handle approval_request items (SDK forward-compat)
      if (event.type === 'item.completed' && event.item?.type === 'approval_request') {
        const item = event.item as CodexApprovalRequestItem
        yield* handleApprovalRequest(
          item,
          input,
          providerEventId,
          parentProviderEventId,
          ctx.buildApprovalContext(input),
        )
        continue
      }

      // Detect turn.failed caused by Codex approval-pause
      if (event.type === 'turn.failed') {
        const errObj = event.error
        const errMsg =
          typeof errObj === 'object' && errObj !== null && 'message' in errObj
            ? (errObj as { message: string }).message
            : typeof errObj === 'string'
              ? errObj
              : ''

        const isApprovalPause =
          ctx.isApprovalCapable(input) &&
          /requires approval|user confirmation|permission denied|approval required/i.test(errMsg)

        if (isApprovalPause) {
          yield* handleTurnFailedApproval(
            errMsg,
            input,
            sessionId,
            codex,
            signal,
            providerEventId,
            parentProviderEventId,
            ctx.buildApprovalContext(input),
            (resumedThread) =>
              runStreamedThread(resumedThread, input, codex, signal, ctx),
          )
          return
        }
      }

      for (const rawAgentEvent of mapped) {
        const agentEvent = withCorrelationId(rawAgentEvent, input.correlationId)
        yield agentEvent

        if (agentEvent.type === 'adapter:message' && agentEvent.role === 'assistant') {
          finalResponse = agentEvent.content ?? ''
        }
      }
    }
  } catch (err: unknown) {
    clearTimeout(timeoutHandle)

    if (signal.aborted) {
      const reason = didTimeout ? 'timeout' : 'caller_abort'
      defaultLogger.warn('[codex-streamed-thread:run] aborted', {
        sessionId,
        reason,
        durationMs: now() - startTime,
        finalResponseLength: finalResponse.length,
        eventCount,
        lastEventType,
        lastEventAgeMs: now() - lastEventAt,
      })
      yield withCorrelationId(
        {
          type: didTimeout ? 'adapter:failed' : 'adapter:completed',
          providerId: ctx.providerId,
          sessionId,
          ...(didTimeout
            ? {
                error: `Codex adapter timed out after ${now() - startTime}ms`,
                code: 'ADAPTER_TIMEOUT' as const,
              }
            : { result: finalResponse || '(interrupted)' }),
          ...(lastUsage !== undefined ? { usage: lastUsage } : {}),
          durationMs: now() - startTime,
          timestamp: now(),
        } as AgentEvent,
        input.correlationId,
      )
      return
    }

    const errMsg = err instanceof Error ? err.message : String(err)
    defaultLogger.error('[codex-streamed-thread:run] event loop threw', {
      sessionId,
      error: errMsg,
    })
    yield withCorrelationId(
      {
        type: 'adapter:failed',
        providerId: ctx.providerId,
        sessionId,
        error: errMsg,
        code: 'ADAPTER_EXECUTION_FAILED',
        timestamp: now(),
      } as AgentEvent,
      input.correlationId,
    )
    return
  } finally {
    clearTimeout(timeoutHandle)
  }

  defaultLogger.debug('[codex-streamed-thread:run] completed normally', {
    sessionId,
    durationMs: now() - startTime,
    responseLength: finalResponse.length,
    usage: lastUsage,
    eventCount,
    lastEventType,
  })

  yield withCorrelationId(
    {
      type: 'adapter:completed',
      providerId: ctx.providerId,
      sessionId,
      result: finalResponse || '',
      ...(lastUsage !== undefined ? { usage: lastUsage } : {}),
      durationMs: now() - startTime,
      timestamp: now(),
    } as AgentEvent,
    input.correlationId,
  )

  if (
    lastUsage &&
    (lastUsage.cachedInputTokens !== undefined ||
      lastUsage.cacheWriteTokens !== undefined)
  ) {
    const cacheRead = lastUsage.cachedInputTokens ?? 0
    const cacheWrite = lastUsage.cacheWriteTokens ?? 0
    const total = lastUsage.inputTokens
    yield withCorrelationId(
      {
        type: 'adapter:cache_stats',
        providerId: ctx.providerId,
        sessionId,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        totalInputTokens: total,
        cacheHitRatio: total > 0 ? cacheRead / total : 0,
        timestamp: now(),
      } as AgentEvent,
      input.correlationId,
    )
  }
}

/**
 * Wrap a raw {@link CodexStreamEvent} in a {@link ProviderRawStreamEvent}
 * with provider-event identity threading.
 */
export function wrapRawProviderEvent(
  providerId: AdapterProviderId,
  event: CodexStreamEvent,
  sessionId: string,
  input: AgentInput,
  ordinal: number,
  threadProviderEventId: string | null,
): ProviderRawStreamEvent {
  const providerEventId = buildProviderEventId(providerId, event, sessionId, ordinal)
  const rawEvent: RawAgentEvent = {
    providerId,
    runId: sessionId,
    sessionId,
    providerEventId,
    ...(event.type === 'thread.started'
      ? {}
      : { parentProviderEventId: threadProviderEventId ?? undefined }),
    timestamp: now(),
    source: 'sdk',
    payload: event,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
  }

  return {
    type: 'adapter:provider_raw',
    rawEvent,
  }
}

/**
 * Combine two optional AbortSignals into one.
 * If either fires, the combined signal aborts.
 */
export function combineSignals(
  external: AbortSignal | undefined,
  internal: AbortSignal,
): AbortSignal {
  if (!external) return internal

  const combined = new AbortController()

  if (external.aborted || internal.aborted) {
    combined.abort()
    return combined.signal
  }

  const onAbort = () => {
    combined.abort()
    external.removeEventListener('abort', onAbort)
    internal.removeEventListener('abort', onAbort)
  }

  external.addEventListener('abort', onAbort, { once: true })
  internal.addEventListener('abort', onAbort, { once: true })

  return combined.signal
}

/**
 * Build the `adapter:started` event for a `thread.started` SDK event.
 *
 * Lives here (rather than in `codex-helpers.mapCodexEvent`) because it needs
 * adapter-instance state (`currentInput`, `isResume`, `config.model`,
 * `config.workingDirectory`) that is cleaner to read from the streaming
 * context object than to pass through the generic mapping helper.
 */
function buildAdapterStartedEvent(
  event: CodexStreamEvent,
  sessionId: string,
  ctx: RunStreamedThreadContext,
  providerEventId: string | null,
  parentProviderEventId: string | null,
): AgentEvent[] {
  const ts = now()
  const annotated: AgentEvent = {
    type: 'adapter:started',
    providerId: ctx.providerId,
    sessionId: event.thread_id ?? sessionId,
    timestamp: ts,
    ...(ctx.currentInput?.prompt !== undefined
      ? { prompt: ctx.currentInput.prompt }
      : {}),
    ...(ctx.currentInput?.systemPrompt !== undefined
      ? { systemPrompt: ctx.currentInput.systemPrompt }
      : {}),
    model: ctx.config.model ?? 'gpt-5.4',
    ...((() => {
      const wd = ctx.currentInput?.workingDirectory ?? ctx.config.workingDirectory
      return wd !== undefined ? { workingDirectory: wd } : {}
    })()),
    isResume: ctx.isResume,
  } as AgentEvent

  if (!providerEventId && !parentProviderEventId) return [annotated]
  return [
    {
      ...annotated,
      ...(providerEventId ? { providerEventId } : {}),
      ...(parentProviderEventId ? { parentProviderEventId } : {}),
    } as AgentEvent,
  ]
}
