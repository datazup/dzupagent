/**
 * Streaming helpers for AdapterHttpHandler.
 *
 * Each helper returns an HttpStreamResponse (SSE) that emits unified
 * AgentEvents converted from the orchestrator output. Pulled out of the
 * main handler so the routing class stays focused on dispatch.
 */

import type { DzupEventBus } from '@dzupagent/core/events'

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
      })

      yield* stream
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      if (eventBus) {
        try {
          eventBus.emit({
            type: 'agent:stream_delta',
            agentId: 'http-handler',
            runId: 'stream-run',
            content: `[error] ${errorMessage}`,
          })
        } catch {
          // Event bus failure is non-fatal
        }
      }
      const failEvent: AgentEvent = {
        type: 'adapter:failed',
        providerId: resolveRuntimeFallbackProviderId(orchestrator.registry, body.preferredProvider),
        error: errorMessage,
        timestamp: Date.now(),
      }
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
      const failEvent: AgentEvent = {
        type: 'adapter:failed',
        providerId: resolveRuntimeFallbackProviderId(orchestrator.registry),
        error: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      }
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
      const failEvent: AgentEvent = {
        type: 'adapter:failed',
        providerId: resolveRuntimeFallbackProviderId(orchestrator.registry, undefined, body.providers),
        error: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      }
      yield failEvent
    }
  }

  return toStreamResponse(generateEvents(), eventBus)
}
