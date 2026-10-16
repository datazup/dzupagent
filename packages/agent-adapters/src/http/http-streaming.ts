/**
 * Streaming helpers for AdapterHttpHandler.
 *
 * Each helper returns an HttpStreamResponse (SSE) that emits unified
 * AgentEvents converted from the orchestrator output. Pulled out of the
 * main handler so the routing class stays focused on dispatch.
 */

import { randomUUID } from 'node:crypto'

import { ForgeError } from '@dzupagent/core/events'
import type { DzupEventBus } from '@dzupagent/core/events'
import { defaultLogger } from '@dzupagent/core/utils'

import type { OrchestratorFacade } from '../facade/orchestrator-facade.js'
import { StreamingHandler } from '../streaming/streaming-handler.js'
import type { AgentCompletedEvent, AgentEvent, AgentInput } from '../types.js'
import {
  collectProviderIds,
  resolveRuntimeFallbackProviderId,
  resolveStreamCompletionProviderId,
} from './http-helpers.js'
import type {
  HttpStreamResponse,
  ParallelRequestBody,
  RunRequestBody,
  SupervisorRequestBody,
} from './http-types.js'

interface StreamContext {
  orchestrator: OrchestratorFacade
  eventBus: DzupEventBus | undefined
  /** Correlation ID of the originating request, used to tie the log to the client frame. */
  correlationId?: string | undefined
}

/**
 * Turns a streaming failure into a client-safe `adapter:failed` event.
 *
 * The raw exception text (provider output, paths, hosts) is logged once,
 * server-side, under a correlation id. The client frame and the bus delta only
 * carry a stable code and a fixed message, never the thrown message.
 */
function streamFailure(
  ctx: StreamContext,
  err: unknown,
  operation: string,
  providerId: AgentEvent['providerId'],
  correlationId: string | undefined,
): AgentEvent {
  const correlation = correlationId ?? ctx.correlationId ?? randomUUID()
  const code = err instanceof ForgeError ? err.code : 'INTERNAL_ERROR'
  defaultLogger.error('[AdapterHttpHandler] stream operation failed', {
    operation,
    correlationId: correlation,
    code,
    error: err instanceof Error ? err.message : String(err),
    name: err instanceof Error ? err.constructor.name : typeof err,
    stack: err instanceof Error ? err.stack : undefined,
  })

  if (ctx.eventBus) {
    try {
      ctx.eventBus.emit({
        type: 'agent:stream_delta',
        agentId: 'http-handler',
        runId: `stream-${operation}`,
        content: `[error] ${code}`,
      })
    } catch {
      // Event bus failure is non-fatal
    }
  }

  return {
    type: 'adapter:failed',
    providerId,
    error: `Operation "${operation}" failed`,
    code,
    timestamp: Date.now(),
    correlationId: correlation,
  }
}

function toStreamResponse(
  events: AsyncGenerator<AgentEvent, void, undefined>,
  eventBus: DzupEventBus | undefined,
): HttpStreamResponse {
  const handler = new StreamingHandler({
    format: 'sse',
    includeToolCalls: true,
    trackProgress: true,
    eventBus,
  })

  return {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    },
    stream: handler.serialize(events),
  }
}

export function streamRun(
  ctx: StreamContext,
  input: AgentInput,
  body: RunRequestBody,
): HttpStreamResponse {
  const { orchestrator, eventBus } = ctx

  async function* generateEvents(): AsyncGenerator<AgentEvent, void, undefined> {
    try {
      // Use chat() which returns an AsyncGenerator of events
      const stream = orchestrator.chat(input.prompt, {
        provider: body.preferredProvider,
        workingDirectory: body.workingDirectory,
        systemPrompt: body.systemPrompt,
        policyConformanceMode: body.policyConformanceMode,
      })

      yield* stream
    } catch (err) {
      const failEvent = streamFailure(
        ctx,
        err,
        'run',
        resolveRuntimeFallbackProviderId(orchestrator.registry, body.preferredProvider),
        input.correlationId,
      )
      yield failEvent
    }
  }

  return toStreamResponse(generateEvents(), eventBus)
}

export function streamSupervisor(
  ctx: StreamContext,
  body: SupervisorRequestBody,
): HttpStreamResponse {
  const { orchestrator, eventBus } = ctx

  async function* generateEvents(): AsyncGenerator<AgentEvent, void, undefined> {
    try {
      const result = await orchestrator.supervisor(body.goal, {
        maxConcurrentDelegations: body.maxConcurrentDelegations,
      })

      const completedEvent: AgentCompletedEvent = {
        type: 'adapter:completed',
        providerId: resolveStreamCompletionProviderId(
          orchestrator.registry,
          result,
          collectProviderIds(result.subtaskResults),
        ),
        sessionId: 'supervisor',
        result: JSON.stringify(result),
        durationMs: result.totalDurationMs,
        timestamp: Date.now(),
      }
      yield completedEvent
    } catch (err) {
      const failEvent = streamFailure(
        ctx,
        err,
        'supervisor',
        resolveRuntimeFallbackProviderId(orchestrator.registry),
        undefined,
      )
      yield failEvent
    }
  }

  return toStreamResponse(generateEvents(), eventBus)
}

export function streamParallel(
  ctx: StreamContext,
  body: ParallelRequestBody,
): HttpStreamResponse {
  const { orchestrator, eventBus } = ctx

  async function* generateEvents(): AsyncGenerator<AgentEvent, void, undefined> {
    try {
      const mergeStrategy = body.strategy ?? 'all'

      const result = await orchestrator.parallel(body.prompt, {
        providers: body.providers,
        mergeStrategy,
      })

      const completedEvent: AgentCompletedEvent = {
        type: 'adapter:completed',
        providerId: resolveStreamCompletionProviderId(
          orchestrator.registry,
          result,
          collectProviderIds(result.allResults),
        ),
        sessionId: 'parallel',
        result: JSON.stringify(result),
        durationMs: result.totalDurationMs,
        timestamp: Date.now(),
      }
      yield completedEvent
    } catch (err) {
      const failEvent = streamFailure(
        ctx,
        err,
        'parallel',
        resolveRuntimeFallbackProviderId(orchestrator.registry, undefined, body.providers),
        undefined,
      )
      yield failEvent
    }
  }

  return toStreamResponse(generateEvents(), eventBus)
}
