/**
 * OTelBridge — translates ForgeEventBus events into OTel operations.
 *
 * Subscribes to the event bus and for each event:
 * 1. Records metrics according to EVENT_METRIC_MAP
 * 2. Adds span events to active spans (if enableSpanEvents is true)
 *
 * This is the single wiring point between ForgeAgent's event-driven
 * architecture and the OpenTelemetry SDK.
 *
 * @example
 * ```ts
 * import { createEventBus } from '@forgeagent/core'
 * import { ForgeTracer, OTelBridge } from '@forgeagent/otel'
 *
 * const bus = createEventBus()
 * const tracer = new ForgeTracer()
 * const bridge = new OTelBridge({ tracer })
 * bridge.attach(bus)
 *
 * // Now all events emitted on `bus` produce OTel metrics
 * bus.emit({ type: 'tool:called', toolName: 'git_status', input: {} })
 * ```
 */

import type { ForgeEventBus, ForgeEvent } from '@forgeagent/core'
import type { ForgeTracer } from './tracer.js'
import { EVENT_METRIC_MAP } from './event-metric-map.js'
import { SpanStatusCode } from './otel-types.js'
import { ForgeSpanAttr } from './span-attributes.js'

/**
 * In-memory metric store used by OTelBridge.
 *
 * When OTel SDK metrics are available, this can be replaced by
 * a proper OTel MeterProvider. For now, we use a simple internal
 * accumulator that can be read by exporters.
 */
export interface MetricSink {
  increment(name: string, labels: Record<string, string>, value?: number): void
  observe(name: string, labels: Record<string, string>, value: number): void
  gauge(name: string, labels: Record<string, string>, value: number): void
}

/**
 * Simple in-memory metric sink for use when OTel SDK metrics are not available.
 */
export class InMemoryMetricSink implements MetricSink {
  private readonly _counters = new Map<string, number>()
  private readonly _histograms = new Map<string, number[]>()
  private readonly _gauges = new Map<string, number>()

  increment(name: string, labels: Record<string, string>, value = 1): void {
    const key = this._key(name, labels)
    this._counters.set(key, (this._counters.get(key) ?? 0) + value)
  }

  observe(name: string, labels: Record<string, string>, value: number): void {
    const key = this._key(name, labels)
    const existing = this._histograms.get(key)
    if (existing) {
      existing.push(value)
    } else {
      this._histograms.set(key, [value])
    }
  }

  gauge(name: string, labels: Record<string, string>, value: number): void {
    const key = this._key(name, labels)
    this._gauges.set(key, value)
  }

  /** Get a counter value for testing/inspection */
  getCounter(name: string, labels: Record<string, string>): number {
    return this._counters.get(this._key(name, labels)) ?? 0
  }

  /** Get histogram observations for testing/inspection */
  getHistogram(name: string, labels: Record<string, string>): readonly number[] {
    return this._histograms.get(this._key(name, labels)) ?? []
  }

  /** Get a gauge value for testing/inspection */
  getGauge(name: string, labels: Record<string, string>): number | undefined {
    return this._gauges.get(this._key(name, labels))
  }

  /** Reset all metrics */
  reset(): void {
    this._counters.clear()
    this._histograms.clear()
    this._gauges.clear()
  }

  private _key(name: string, labels: Record<string, string>): string {
    const sorted = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))
    if (sorted.length === 0) return name
    return `${name}{${sorted.map(([k, v]) => `${k}="${v}"`).join(',')}}`
  }
}

/**
 * Configuration for OTelBridge.
 */
export interface OTelBridgeConfig {
  /** ForgeTracer instance for span operations */
  tracer: ForgeTracer

  /** Whether to record metrics from events (default: true) */
  enableMetrics?: boolean

  /** Whether to add span events on active spans (default: true) */
  enableSpanEvents?: boolean

  /**
   * Metric sink for recording counters/histograms/gauges.
   * Defaults to InMemoryMetricSink if not provided.
   */
  metricSink?: MetricSink

  /**
   * Event types to ignore (e.g., high-frequency events in production).
   */
  ignoreEvents?: ForgeEvent['type'][]
}

/**
 * OTelBridge subscribes to ForgeEventBus and translates events
 * into OTel metrics and span events.
 */
export class OTelBridge {
  private readonly _tracer: ForgeTracer
  private readonly _enableMetrics: boolean
  private readonly _enableSpanEvents: boolean
  private readonly _metricSink: MetricSink
  private readonly _ignoreEvents: Set<ForgeEvent['type']>
  private _unsubscribe: (() => void) | undefined

  constructor(config: OTelBridgeConfig) {
    this._tracer = config.tracer
    this._enableMetrics = config.enableMetrics ?? true
    this._enableSpanEvents = config.enableSpanEvents ?? true
    this._metricSink = config.metricSink ?? new InMemoryMetricSink()
    this._ignoreEvents = new Set(config.ignoreEvents ?? [])
  }

  /** The metric sink used by this bridge */
  get metricSink(): MetricSink {
    return this._metricSink
  }

  /**
   * Attach the bridge to an event bus.
   * Subscribes to all events and records metrics + span events.
   */
  attach(eventBus: ForgeEventBus): void {
    if (this._unsubscribe) {
      // Already attached; detach first
      this._unsubscribe()
    }

    this._unsubscribe = eventBus.onAny((event) => {
      try {
        this._handleEvent(event)
      } catch {
        // Bridge errors must never propagate to the event bus
        // This is intentionally silent — bridge failures are non-fatal
      }
    })
  }

  /**
   * Detach the bridge from the event bus.
   */
  detach(): void {
    if (this._unsubscribe) {
      this._unsubscribe()
      this._unsubscribe = undefined
    }
  }

  /** Whether the bridge is currently attached to an event bus */
  get isAttached(): boolean {
    return this._unsubscribe !== undefined
  }

  private _handleEvent(event: ForgeEvent): void {
    if (this._ignoreEvents.has(event.type)) return

    // Record metrics
    if (this._enableMetrics) {
      this._recordMetrics(event)
    }

    // Add span events for error-type events
    if (this._enableSpanEvents) {
      this._addSpanEvents(event)
    }
  }

  private _recordMetrics(event: ForgeEvent): void {
    const mappings = EVENT_METRIC_MAP[event.type]
    if (!mappings || mappings.length === 0) return

    for (const mapping of mappings) {
      const { value, labels } = mapping.extract(event)

      switch (mapping.type) {
        case 'counter':
          this._metricSink.increment(mapping.metricName, labels, value)
          break
        case 'histogram':
          this._metricSink.observe(mapping.metricName, labels, value)
          break
        case 'gauge':
          this._metricSink.gauge(mapping.metricName, labels, value)
          break
      }
    }
  }

  private _addSpanEvents(event: ForgeEvent): void {
    // Only add span events for significant lifecycle events
    switch (event.type) {
      case 'agent:started': {
        const span = this._tracer.startAgentSpan(event.agentId, event.runId)
        span.addEvent('agent.started', {
          [ForgeSpanAttr.AGENT_ID]: event.agentId,
          [ForgeSpanAttr.RUN_ID]: event.runId,
        })
        span.end()
        break
      }
      case 'agent:failed': {
        const span = this._tracer.startAgentSpan(event.agentId, event.runId)
        span.setStatus({ code: SpanStatusCode.ERROR, message: event.message })
        span.setAttribute(ForgeSpanAttr.ERROR_CODE, event.errorCode)
        span.addEvent('agent.failed', {
          [ForgeSpanAttr.ERROR_CODE]: event.errorCode,
        })
        span.end()
        break
      }
      case 'tool:error': {
        const span = this._tracer.startToolSpan(event.toolName)
        span.setStatus({ code: SpanStatusCode.ERROR, message: event.message })
        span.setAttribute(ForgeSpanAttr.ERROR_CODE, event.errorCode)
        span.end()
        break
      }
      case 'provider:circuit_opened': {
        const span = this._tracer.tracer.startSpan('provider.circuit_opened')
        span.addEvent('circuit_breaker.opened', {
          provider: event.provider,
        })
        span.end()
        break
      }
      default:
        // Other events don't create span events
        break
    }
  }
}
