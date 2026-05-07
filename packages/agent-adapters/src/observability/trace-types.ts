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
  eventBus?: import('@dzupagent/core').DzupEventBus | undefined
  /** Whether to propagate trace context to adapter processes via env vars. Default true */
  propagateContext?: boolean | undefined
  /** Custom span exporter callback */
  onSpanEnd?: ((span: TraceSpan) => void) | undefined
}

export interface TraceContext {
  traceId: string
  spanId: string
}
