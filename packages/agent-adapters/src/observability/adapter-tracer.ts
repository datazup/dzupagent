/**
 * AdapterTracer — lightweight distributed tracing for adapter orchestration.
 *
 * Provides span-based tracing without a hard dependency on OpenTelemetry.
 * Users who have OTel installed can bridge via the `onSpanEnd` callback.
 *
 * Trace context is propagated to adapter child processes via W3C `traceparent`
 * environment variables when `propagateContext` is enabled (default).
 */

import { randomUUID } from 'node:crypto'

import type { DzupEventBus } from '@dzupagent/core'

import type { AgentEvent } from '../types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpanEvent {
  name: string
  timestamp: number
  attributes?: Record<string, string | number | boolean>
}

export interface TraceSpan {
  traceId: string
  spanId: string
  parentSpanId?: string | undefined
  name: string
  startTime: number
  endTime?: number | undefined
  status: 'ok' | 'error' | 'unset'
  attributes: Record<string, string | number | boolean>
  events: SpanEvent[]
}

export interface AdapterTracerConfig {
  /** Service name. Default: 'dzupagent-adapters' */
  serviceName?: string | undefined
  /** Event bus for emitting trace events */
  eventBus?: DzupEventBus | undefined
  /** Whether to propagate trace context to adapter processes via env vars. Default true */
  propagateContext?: boolean | undefined
  /** Custom span exporter callback */
  onSpanEnd?: ((span: TraceSpan) => void) | undefined
}

export interface TraceContext {
  traceId: string
  spanId: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a 32-char hex trace ID from a UUID. */
function generateTraceId(): string {
  return randomUUID().replace(/-/g, '')
}

/** Generate a 16-char hex span ID from a UUID (first 16 hex chars). */
function generateSpanId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16)
}

// ---------------------------------------------------------------------------
// AdapterTracer
// ---------------------------------------------------------------------------

export class AdapterTracer {
  private readonly serviceName: string
  private readonly eventBus: DzupEventBus | undefined
  private readonly propagateContext: boolean
  private readonly onSpanEnd: ((span: TraceSpan) => void)
  private readonly spans: TraceSpan[] = []

  constructor(config?: AdapterTracerConfig) {
    this.serviceName = config?.serviceName ?? 'dzupagent-adapters'
    this.eventBus = config?.eventBus
    this.propagateContext = config?.propagateContext ?? true
    this.onSpanEnd = config?.onSpanEnd ?? (() => {})
  }

  /**
   * Start a new trace and wrap adapter execution with spans.
   * Returns an async generator that yields the original events plus injects
   * trace context into the environment.
   */
  async *trace(
    name: string,
    source: AsyncGenerator<AgentEvent>,
    parentContext?: TraceContext,
  ): AsyncGenerator<AgentEvent> {
    const rootSpan = this.startSpan(name, parentContext, {
      'service.name': this.serviceName,
    })

    // Track open tool spans by toolName so we can close them on tool_result
    const openToolSpans = new Map<string, TraceSpan>()

    try {
      for await (const event of source) {
        switch (event.type) {
          case 'adapter:started': {
            this.addSpanEvent(rootSpan, 'adapter.started', {
              'adapter.provider_id': event.providerId,
              'adapter.session_id': event.sessionId,
            })
            break
          }

          case 'adapter:tool_call': {
            const toolSpan = this.startSpan(
              `tool.${event.toolName}`,
              this.getTraceContext(rootSpan),
              {
                'tool.name': event.toolName,
                'adapter.provider_id': event.providerId,
              },
            )
            openToolSpans.set(event.toolName, toolSpan)
            break
          }

          case 'adapter:tool_result': {
            const toolSpan = openToolSpans.get(event.toolName)
            if (toolSpan) {
              toolSpan.attributes['tool.duration_ms'] = event.durationMs
              this.endSpan(toolSpan, 'ok')
              openToolSpans.delete(event.toolName)
            }
            break
          }

          case 'adapter:completed': {
            if (event.usage) {
              rootSpan.attributes['usage.input_tokens'] = event.usage.inputTokens
              rootSpan.attributes['usage.output_tokens'] = event.usage.outputTokens
              if (event.usage.cachedInputTokens !== undefined) {
                rootSpan.attributes['usage.cached_input_tokens'] = event.usage.cachedInputTokens
              }
              if (event.usage.costCents !== undefined) {
                rootSpan.attributes['usage.cost_cents'] = event.usage.costCents
              }
            }
            rootSpan.attributes['adapter.duration_ms'] = event.durationMs
            rootSpan.attributes['adapter.provider_id'] = event.providerId
            this.endSpan(rootSpan, 'ok')
            break
          }

          case 'adapter:failed': {
            rootSpan.attributes['adapter.provider_id'] = event.providerId
            this.endSpan(rootSpan, 'error', event.error)
            break
          }

          default:
            break
        }

        yield event
      }

      // If the generator completes without an explicit completed/failed event,
      // close the root span as ok (unless already ended).
      if (rootSpan.endTime === undefined) {
        this.endSpan(rootSpan, 'ok')
      }
    } catch (err: unknown) {
      // Close any open tool spans
      for (const toolSpan of openToolSpans.values()) {
        if (toolSpan.endTime === undefined) {
          this.endSpan(toolSpan, 'error', 'parent trace aborted')
        }
      }
      openToolSpans.clear()

      const message = err instanceof Error ? err.message : String(err)
      if (rootSpan.endTime === undefined) {
        this.endSpan(rootSpan, 'error', message)
      }
      throw err
    }
  }

  /**
   * Create a child span within the current trace.
   */
  startSpan(
    name: string,
    parentContext?: TraceContext,
    attributes?: Record<string, string | number | boolean>,
  ): TraceSpan {
    const span: TraceSpan = {
      traceId: parentContext?.traceId ?? generateTraceId(),
      spanId: generateSpanId(),
      parentSpanId: parentContext?.spanId,
      name,
      startTime: Date.now(),
      status: 'unset',
      attributes: { ...attributes },
      events: [],
    }
    return span
  }

  /**
   * End a span, setting its status and recording it.
   */
  endSpan(span: TraceSpan, status?: 'ok' | 'error', errorMessage?: string): void {
    span.endTime = Date.now()
    span.status = status ?? 'ok'

    if (errorMessage !== undefined) {
      this.addSpanEvent(span, 'exception', { 'exception.message': errorMessage })
    }

    this.spans.push(span)

    if (this.onSpanEnd) {
      try {
        this.onSpanEnd(span)
      } catch {
        // onSpanEnd failures are non-fatal
      }
    }

    if (this.eventBus) {
      try {
        this.eventBus.emit({
          type: 'tool:latency',
          toolName: `trace:${span.name}`,
          durationMs: span.endTime - span.startTime,
          ...(errorMessage !== undefined ? { error: errorMessage } : {}),
        })
      } catch {
        // Event bus failures are non-fatal
      }
    }
  }

  /**
   * Add an event to a span.
   */
  addSpanEvent(
    span: TraceSpan,
    name: string,
    attributes?: Record<string, string | number | boolean>,
  ): void {
    const event: SpanEvent = {
      name,
      timestamp: Date.now(),
    }
    if (attributes !== undefined) {
      event.attributes = attributes
    }
    span.events.push(event)
  }

  /**
   * Get trace context for propagation (e.g., to inject into adapter env vars).
   */
  getTraceContext(span: TraceSpan): TraceContext {
    return {
      traceId: span.traceId,
      spanId: span.spanId,
    }
  }

  /**
   * Get all completed spans (useful for testing and post-mortem).
   */
  getSpans(): TraceSpan[] {
    return [...this.spans]
  }

  /**
   * Clear all recorded spans.
   */
  reset(): void {
    this.spans.length = 0
  }

  /**
   * Build env vars for trace context propagation (W3C traceparent format).
   *
   * Format: `00-{traceId32hex}-{spanId16hex}-01`
   */
  buildPropagationEnv(span: TraceSpan): Record<string, string> {
    if (!this.propagateContext) {
      return {}
    }

    const traceparent = `00-${span.traceId}-${span.spanId}-01`
    return {
      TRACEPARENT: traceparent,
    }
  }
}
