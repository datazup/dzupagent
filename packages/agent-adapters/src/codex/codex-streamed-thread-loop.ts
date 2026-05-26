/**
 * runStreamedThread — the main Codex SDK streaming loop.
 *
 * This module owns the async generator body that consumes events from
 * `thread.runStreamed()` and yields unified {@link AgentStreamEvent}s.
 * Helpers for event wrapping, approval handling, and started-event
 * construction live in sibling files; this module orchestrates them.
 */
import { defaultLogger } from '@dzupagent/core/utils'
import type {
  AgentInput,
  AgentStreamEvent,
  TokenUsage,
} from '../types.js'
import { withCorrelationId } from '../types.js'
import {
  makeCacheStatsEvent,
  makeCompletedEvent,
  makeFailedEvent,
} from '../events/event-factories.js'
import type {
  CodexInstance,
  CodexStreamEvent,
  CodexThread,
} from './codex-types.js'
import { mapCodexEvent, now, toTokenUsage } from './codex-helpers.js'
import {
  buildAdapterStartedEvent,
  wrapRawProviderEvent,
} from './codex-streamed-thread-events.js'
import {
  detectApprovalPause,
  handleStreamApprovalRequest,
  handleStreamTurnFailedApproval,
} from './codex-streamed-thread-approval.js'
import {
  DEFAULT_CODEX_TIMEOUT_MS,
  type RunStreamedThreadContext,
} from './codex-streamed-thread-types.js'

function buildTimeoutAbortReason(timeoutMs: number): Error & { code?: string } {
  const reason: Error & { code?: string } = new Error(`Codex adapter timed out after ${timeoutMs}ms`)
  reason.code = 'ADAPTER_TIMEOUT'
  return reason
}

function signalHasTimeoutReason(signal: AbortSignal): boolean {
  const reason = signal.reason as { code?: unknown; message?: unknown } | string | undefined
  if (!reason) return false
  if (typeof reason === 'object' && reason.code === 'ADAPTER_TIMEOUT') return true
  const text = typeof reason === 'string' ? reason : String(reason.message ?? '')
  return /ADAPTER_TIMEOUT|timed out|timeout/i.test(text)
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
    ctx.abort(buildTimeoutAbortReason(timeoutMs))
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
    const abortedByTimeout = didTimeout || (signal.aborted && signalHasTimeoutReason(signal))
    if (abortedByTimeout || signal.aborted) {
      const reason = abortedByTimeout
        ? 'timeout_before_stream_start'
        : 'caller_abort_before_stream_start'
      const durationMs = now() - startTime
      defaultLogger.warn(
        '[codex-streamed-thread:run] runStreamed() aborted before stream events',
        { sessionId, reason, durationMs, error: errMsg },
      )
      yield withCorrelationId(
        makeFailedEvent({
          providerId: ctx.providerId,
          sessionId,
          error: abortedByTimeout
            ? `Codex adapter timed out after ${durationMs}ms`
            : errMsg,
          code: abortedByTimeout ? 'ADAPTER_TIMEOUT' : 'ADAPTER_EXECUTION_FAILED',
          timestamp: now(),
        }),
        input.correlationId,
      )
      return
    }

    defaultLogger.error('[codex-streamed-thread:run] runStreamed() threw', {
      sessionId,
      error: errMsg,
    })
    yield withCorrelationId(
      makeFailedEvent({
        providerId: ctx.providerId,
        sessionId,
        error: errMsg,
        code: 'ADAPTER_EXECUTION_FAILED',
        timestamp: now(),
      }),
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
        yield* handleStreamApprovalRequest(
          event,
          input,
          providerEventId,
          parentProviderEventId,
          ctx,
        )
        continue
      }

      // Detect turn.failed caused by Codex approval-pause
      if (event.type === 'turn.failed') {
        const approvalErrMsg = detectApprovalPause(event, input, ctx)
        if (approvalErrMsg !== null) {
          yield* handleStreamTurnFailedApproval(
            approvalErrMsg,
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
      const abortedByTimeout = didTimeout || signalHasTimeoutReason(signal)
      const reason = abortedByTimeout ? 'timeout' : 'caller_abort'
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
        abortedByTimeout
          ? makeFailedEvent({
              providerId: ctx.providerId,
              sessionId,
              error: `Codex adapter timed out after ${now() - startTime}ms`,
              code: 'ADAPTER_TIMEOUT',
              timestamp: now(),
            })
          : makeCompletedEvent({
              providerId: ctx.providerId,
              sessionId,
              result: finalResponse || '(interrupted)',
              usage: lastUsage,
              durationMs: now() - startTime,
              timestamp: now(),
            }),
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
      makeFailedEvent({
        providerId: ctx.providerId,
        sessionId,
        error: errMsg,
        code: 'ADAPTER_EXECUTION_FAILED',
        timestamp: now(),
      }),
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
    makeCompletedEvent({
      providerId: ctx.providerId,
      sessionId,
      result: finalResponse || '',
      usage: lastUsage,
      durationMs: now() - startTime,
      timestamp: now(),
    }),
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
      makeCacheStatsEvent({
        providerId: ctx.providerId,
        sessionId,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        totalInputTokens: total,
        cacheHitRatio: total > 0 ? cacheRead / total : 0,
        timestamp: now(),
      }),
      input.correlationId,
    )
  }
}
