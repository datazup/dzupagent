/**
 * Tracing middleware for the adapter middleware pipeline.
 *
 * Wraps every adapter execution in OTel-style spans using {@link AdapterTracer}.
 * The middleware yields every event unchanged. When trace propagation is
 * enabled on the tracer, it also attaches W3C trace env metadata to the
 * shared input object before the adapter generator starts executing.
 */

import type { AdapterMiddleware, MiddlewareContext } from '../middleware/middleware-pipeline.js'
import type { AgentEvent, AgentCompletedEvent, AgentFailedEvent } from '../types.js'
import { ADAPTER_TRACE_ENV_OPTION, AdapterTracer } from './adapter-tracer.js'
import { getToolCallId, ToolSpanTracker } from './tool-span-tracker.js'

/**
 * Creates a middleware that traces adapter executions using AdapterTracer.
 * Each execution creates a root span with child spans for tool calls.
 *
 * All events pass through unchanged.
 */
export function createTracingMiddleware(tracer: AdapterTracer): AdapterMiddleware {
  return async function* tracingMiddleware(
    source: AsyncGenerator<AgentEvent, void, undefined>,
    context: MiddlewareContext,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    const rootSpan = tracer.startSpan(`adapter.${context.providerId}.execute`, undefined, {
      'adapter.provider_id': context.providerId,
      'adapter.prompt_length': context.input.prompt.length,
      'adapter.has_system_prompt': !!context.input.systemPrompt,
      'adapter.max_turns': context.input.maxTurns ?? 0,
    })
    const traceEnv = tracer.buildPropagationEnv(rootSpan)
    if (Object.keys(traceEnv).length > 0) {
      context.input.options = {
        ...context.input.options,
        [ADAPTER_TRACE_ENV_OPTION]: traceEnv,
      }
    }

    const openToolSpans = new ToolSpanTracker()

    try {
      for await (const event of source) {
        switch (event.type) {
          case 'adapter:started': {
            tracer.addSpanEvent(rootSpan, 'session_started', {
              'adapter.session_id': event.sessionId,
            })
            break
          }

          case 'adapter:tool_call': {
            const toolCallId = getToolCallId(event as typeof event & Record<string, unknown>)
            const toolSpan = tracer.startSpan(
              `tool.${event.toolName}`,
              tracer.getTraceContext(rootSpan),
              {
                'tool.name': event.toolName,
                ...(toolCallId ? { 'tool.call_id': toolCallId } : {}),
              },
            )
            openToolSpans.add(event as typeof event & Record<string, unknown>, toolSpan)
            break
          }

          case 'adapter:tool_result': {
            const toolSpan = openToolSpans.take(event as typeof event & Record<string, unknown>)
            if (toolSpan) {
              toolSpan.attributes['tool.duration_ms'] = event.durationMs
              toolSpan.attributes['tool.output_length'] = event.output.length
              tracer.endSpan(toolSpan, 'ok')
            }
            break
          }

          case 'adapter:completed': {
            const completed = event as AgentCompletedEvent
            if (completed.usage) {
              tracer.addSpanEvent(rootSpan, 'usage', {
                input_tokens: completed.usage.inputTokens,
                output_tokens: completed.usage.outputTokens,
              })
            }
            rootSpan.attributes['adapter.duration_ms'] = completed.durationMs
            rootSpan.attributes['adapter.result_length'] = completed.result.length
            rootSpan.attributes['adapter.status'] = 'ok'
            tracer.endSpan(rootSpan, 'ok')
            break
          }

          case 'adapter:failed': {
            const failed = event as AgentFailedEvent
            rootSpan.attributes['adapter.status'] = 'error'
            rootSpan.attributes['adapter.error_code'] = failed.code ?? 'unknown'
            tracer.endSpan(rootSpan, 'error', failed.error)
            break
          }

          default:
            break
        }

        yield event
      }

      // If stream ends without completed/failed, close the root span
      if (rootSpan.endTime === undefined) {
        rootSpan.attributes['adapter.status'] = 'stream_ended'
        tracer.endSpan(rootSpan, 'ok')
      }
    } catch (error: unknown) {
      // Close any open tool spans
      for (const toolSpan of openToolSpans.openSpans()) {
        if (toolSpan.endTime === undefined) {
          tracer.endSpan(toolSpan, 'error', 'parent trace aborted')
        }
      }
      openToolSpans.clear()

      const message = error instanceof Error ? error.message : String(error)
      if (rootSpan.endTime === undefined) {
        rootSpan.attributes['adapter.status'] = 'error'
        tracer.endSpan(rootSpan, 'error', message)
      }
      throw error
    }
  }
}
