import type { AgentEvent, TokenUsage } from '../types.js'
import type { CodexAppServerInboundEvent } from './codex-app-server-client.js'
import {
  HUMAN_REQUEST_METHODS,
  MAX_DELTA_LENGTH,
  MAX_RESULT_LENGTH,
  adapterError,
  staleTurnError,
  type ActiveRun,
} from './codex-app-server-adapter-contracts.js'
import {
  failedEvent,
  interactionEvent,
  tokenUsage,
  withCorrelation,
} from './codex-app-server-adapter-events.js'
import {
  assertRunEventIdentity,
  stringValue,
} from './codex-app-server-adapter-validation.js'
import {
  assertThreadStartedNotification,
  assertTurnNotification,
} from './codex-app-server-protocol.js'

export interface CodexAppServerTurnContext {
  readonly run: ActiveRun
  /** The exact backend version admitted for this binding. */
  readonly admittedVersion: string
  readonly correlationId: string | undefined
  /** Wall-clock start of the run, used only for the completed event's duration. */
  readonly startedAt: number
  readonly now: () => number
  /**
   * Re-checks cancellation and the execution deadline, throwing the run's
   * terminal decision if either has fired. Owned by the caller because the
   * decision it records is what the caller's cleanup path acts on.
   */
  readonly requireRemaining: () => number
}

/**
 * Consumes one turn's inbound event stream and yields the normalized events it
 * maps to, returning the terminal event once the provider reports a final turn
 * status.
 *
 * The turn's accumulated state -- the streamed result, the last usage report and
 * whether a start has been seen -- lives here for the length of the stream and
 * nowhere else. That is the whole reason this is a separate unit: the accumulator
 * has invariants of its own (a bounded total, exactly one start, usage required
 * before a completion counts) that are independent of process lifecycle, and
 * holding them next to spawn and cleanup state is what made them hard to read.
 *
 * Every branch is either a mapping or a refusal. There is deliberately no
 * default case: an unrecognised notification is ignored, while an unrecognised
 * *request* is a failure, because ignoring a request would leave the provider
 * waiting on an answer that is never coming.
 */
export async function* consumeCodexAppServerTurn(
  events: AsyncIterable<CodexAppServerInboundEvent>,
  context: CodexAppServerTurnContext,
): AsyncGenerator<AgentEvent, AgentEvent | undefined, undefined> {
  const { run, correlationId, now } = context
  let result = ''
  let usage: TokenUsage | undefined
  let sawTurnStarted = false

  for await (const event of events) {
    context.requireRemaining()
    if (event.kind === 'request') {
      assertRunEventIdentity(event.params, run, false)
      if (!HUMAN_REQUEST_METHODS.has(event.method)) {
        throw adapterError(
          'CODEX_APP_SERVER_REQUEST_UNSUPPORTED',
          'Codex app-server requested an unsupported host operation',
        )
      }
      yield interactionEvent(event, run, correlationId, now())
      continue
    }
    if (event.method === 'thread/started') {
      const observedThreadId = assertThreadStartedNotification(
        event.params,
        context.admittedVersion,
      )
      if (observedThreadId !== run.threadId) throw staleTurnError()
      continue
    }
    if (event.method === 'turn/started') {
      assertTurnNotification(event.params, 'started')
      assertRunEventIdentity(event.params, run, true)
      if (sawTurnStarted) throw adapterError(
        'CODEX_APP_SERVER_DUPLICATE_EVENT',
        'Codex app-server emitted a duplicate turn start',
      )
      sawTurnStarted = true
      continue
    }
    if (event.method === 'item/agentMessage/delta') {
      assertRunEventIdentity(event.params, run, false)
      const delta = stringValue(event.params['delta'])
      if (delta.length === 0 || delta.length > MAX_DELTA_LENGTH) {
        throw adapterError(
          'CODEX_APP_SERVER_DELTA_INVALID',
          'Codex app-server emitted an invalid message delta',
        )
      }
      result += delta
      if (result.length > MAX_RESULT_LENGTH) throw adapterError(
        'CODEX_APP_SERVER_RESULT_LIMIT',
        'Codex app-server result exceeded its limit',
      )
      yield withCorrelation({
        type: 'adapter:stream_delta',
        providerId: 'codex',
        content: delta,
        timestamp: now(),
      }, correlationId)
      continue
    }
    if (event.method === 'thread/tokenUsage/updated') {
      assertRunEventIdentity(event.params, run, false)
      usage = tokenUsage(event.params['tokenUsage'])
      continue
    }
    if (event.method === 'turn/completed') {
      const completedTurn = assertTurnNotification(event.params, 'completed')
      assertRunEventIdentity(event.params, run, true)
      return terminalEvent(completedTurn.status, { result, usage }, context)
    }
    if (event.method === 'error') {
      throw adapterError(
        'CODEX_APP_SERVER_PROTOCOL_ERROR',
        'Codex app-server emitted a protocol error',
      )
    }
  }
  return undefined
}

/**
 * Maps a reported terminal status onto the event the caller emits.
 *
 * A `completed` turn without usage is deliberately a failure rather than a
 * completion with the field omitted: usage is the only evidence the run actually
 * consumed what it claims, and a consumer that reads a completion is entitled to
 * assume that evidence exists.
 */
function terminalEvent(
  status: string,
  accumulated: { readonly result: string, readonly usage: TokenUsage | undefined },
  context: CodexAppServerTurnContext,
): AgentEvent {
  const { run, correlationId, now } = context
  if (status === 'completed') {
    return accumulated.usage
      ? withCorrelation({
          type: 'adapter:completed',
          providerId: 'codex',
          sessionId: run.threadId,
          result: accumulated.result,
          usage: accumulated.usage,
          durationMs: Math.max(0, now() - context.startedAt),
          timestamp: now(),
        }, correlationId)
      : failedEvent(
          now(),
          correlationId,
          'CODEX_APP_SERVER_USAGE_MISSING',
          'Codex app-server completed without terminal usage evidence',
          run.threadId,
        )
  }
  if (status === 'interrupted') {
    return failedEvent(
      now(),
      correlationId,
      'CODEX_APP_SERVER_CANCELLED',
      'Codex app-server execution was interrupted',
      run.threadId,
    )
  }
  if (status === 'failed') {
    return failedEvent(
      now(),
      correlationId,
      'CODEX_APP_SERVER_TURN_FAILED',
      'Codex app-server turn failed',
      run.threadId,
    )
  }
  throw adapterError(
    'CODEX_APP_SERVER_TURN_INVALID',
    'Codex app-server emitted an invalid terminal turn',
  )
}
