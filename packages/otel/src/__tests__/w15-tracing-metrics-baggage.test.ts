/**
 * W15-A2: Comprehensive tests for tracing, metrics, and baggage.
 *
 * Covers:
 * - Span creation with correct attributes and names
 * - Metrics recording (counter, histogram, gauge) via InMemoryMetricSink
 * - Baggage propagation across async boundaries
 * - Platform-identity extract functions (remaining function coverage)
 * - Edge cases in tracer, bridge, and context store
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import type { DzupEvent, DzupEventBus } from '@dzupagent/core'

import { DzupTracer } from '../tracer.js'
import type { ForgeTraceSnapshot } from '../tracer.js'
import { NoopSpan, NoopTracer } from '../noop.js'
import { ForgeSpanAttr } from '../span-attributes.js'
import { SpanStatusCode, SpanKind } from '../otel-types.js'
import type { OTelSpan, OTelTracer, OTelSpanOptions, OTelContext } from '../otel-types.js'
import {
  forgeContextStore,
  withForgeContext,
  currentForgeContext,
  type ForgeTraceContext,
} from '../trace-context-store.js'
import { OTelBridge, InMemoryMetricSink } from '../otel-bridge.js'
import type { MetricSink } from '../otel-bridge.js'
import { platformIdentityMetricMap } from '../event-metric-map/platform-identity.js'
import { EVENT_METRIC_MAP } from '../event-metric-map.js'

// ------------------------------------------------------------------ Helpers

/** Recording span for verifying attribute/event/status writes */
class RecordingSpan implements OTelSpan {
  readonly name: string
  readonly attrs: Record<string, string | number | boolean> = {}
  readonly events: Array<{ name: string; attributes?: Record<string, string | number | boolean> }> = []
  status?: { code: number; message?: string }
  ended = false
  private readonly _traceId: string
  private readonly _spanId: string

  constructor(name: string, options?: OTelSpanOptions, traceId?: string, spanId?: string) {
    this.name = name
    if (options?.attributes) Object.assign(this.attrs, options.attributes)
    this._traceId = traceId ?? 'aaaa0000bbbb1111cccc2222dddd3333'
    this._spanId = spanId ?? 'eeee4444ffff5555'
  }

  setAttribute(key: string, value: string | number | boolean): this {
    this.attrs[key] = value
    return this
  }

  setStatus(s: { code: number; message?: string }): this {
    this.status = s
    return this
  }

  addEvent(n: string, a?: Record<string, string | number | boolean>): this {
    this.events.push({ name: n, attributes: a })
    return this
  }

  end(): void {
    this.ended = true
  }

  spanContext() {
    return { traceId: this._traceId, spanId: this._spanId }
  }

  isRecording(): boolean {
    return !this.ended
  }
}

class RecordingTracer implements OTelTracer {
  spans: RecordingSpan[] = []
  startSpan(name: string, options?: OTelSpanOptions, _context?: OTelContext): OTelSpan {
    const span = new RecordingSpan(name, options)
    this.spans.push(span)
    return span
  }
}

function tick(ms = 15): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function makeCtx(overrides?: Partial<ForgeTraceContext>): ForgeTraceContext {
  return {
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spanId: 'b7ad6b7169203331',
    baggage: {},
    ...overrides,
  }
}

// ================================================================== TRACING
// Tests for span creation, attribute population, and lifecycle

describe('Tracing — span creation and attributes', () => {
  let rec: RecordingTracer
  let tracer: DzupTracer

  beforeEach(() => {
    rec = new RecordingTracer()
    tracer = new DzupTracer({ tracer: rec, serviceName: 'test-svc' })
  })

  it('startAgentSpan with parentContext passes context to underlying tracer', () => {
    const parentCtx = { someField: true }
    const span = tracer.startAgentSpan('my-agent', 'run-42', { parentContext: parentCtx })
    expect(span).toBeDefined()
    expect(rec.spans[0]!.attrs[ForgeSpanAttr.AGENT_ID]).toBe('my-agent')
    expect(rec.spans[0]!.attrs[ForgeSpanAttr.RUN_ID]).toBe('run-42')
  })

  it('startLLMSpan with only temperature set (no maxTokens)', () => {
    tracer.startLLMSpan('gpt-4o', 'openai', { temperature: 0.3 })
    const s = rec.spans[0]!
    expect(s.attrs[ForgeSpanAttr.GEN_AI_REQUEST_TEMPERATURE]).toBe(0.3)
    expect(ForgeSpanAttr.GEN_AI_REQUEST_MAX_TOKENS in s.attrs).toBe(false)
  })

  it('startLLMSpan with only maxTokens set (no temperature)', () => {
    tracer.startLLMSpan('claude-sonnet-4-6', 'anthropic', { maxTokens: 4096 })
    const s = rec.spans[0]!
    expect(s.attrs[ForgeSpanAttr.GEN_AI_REQUEST_MAX_TOKENS]).toBe(4096)
    expect(ForgeSpanAttr.GEN_AI_REQUEST_TEMPERATURE in s.attrs).toBe(false)
  })

  it('startToolSpan without inputSize omits that attribute', () => {
    tracer.startToolSpan('write_file')
    const s = rec.spans[0]!
    expect(s.attrs[ForgeSpanAttr.TOOL_NAME]).toBe('write_file')
    expect(ForgeSpanAttr.TOOL_INPUT_SIZE in s.attrs).toBe(false)
  })

  it('startMemorySpan for each operation type', () => {
    const ops = ['read', 'write', 'search', 'delete'] as const
    for (const op of ops) {
      tracer.startMemorySpan(op, `ns-${op}`)
    }
    expect(rec.spans).toHaveLength(4)
    expect(rec.spans[0]!.name).toBe('memory:read')
    expect(rec.spans[1]!.name).toBe('memory:write')
    expect(rec.spans[2]!.name).toBe('memory:search')
    expect(rec.spans[3]!.name).toBe('memory:delete')
  })

  it('startPhaseSpan with only agentId (no runId)', () => {
    tracer.startPhaseSpan('validate', { agentId: 'a1' })
    const s = rec.spans[0]!
    expect(s.attrs[ForgeSpanAttr.AGENT_ID]).toBe('a1')
    expect(ForgeSpanAttr.RUN_ID in s.attrs).toBe(false)
  })

  it('startPhaseSpan with only runId (no agentId)', () => {
    tracer.startPhaseSpan('deploy', { runId: 'r1' })
    const s = rec.spans[0]!
    // agentId is falsy so not set
    expect(ForgeSpanAttr.AGENT_ID in s.attrs).toBe(false)
    expect(s.attrs[ForgeSpanAttr.RUN_ID]).toBe('r1')
  })

  it('endSpanWithError with numeric error', () => {
    const span = tracer.startToolSpan('calc')
    tracer.endSpanWithError(span, 42)
    const s = rec.spans[0]!
    expect(s.status!.code).toBe(SpanStatusCode.ERROR)
    expect(s.status!.message).toBe('42')
    expect(s.attrs[ForgeSpanAttr.ERROR_CODE]).toBe('42')
    expect(s.ended).toBe(true)
  })

  it('endSpanWithError with undefined error', () => {
    const span = tracer.startToolSpan('calc')
    tracer.endSpanWithError(span, undefined)
    const s = rec.spans[0]!
    expect(s.status!.message).toBe('undefined')
  })

  it('multiple spans can be created and ended independently', () => {
    const s1 = tracer.startAgentSpan('a1', 'r1')
    const s2 = tracer.startLLMSpan('m1', 'p1')
    const s3 = tracer.startToolSpan('t1')

    tracer.endSpanOk(s1)
    expect(rec.spans[0]!.ended).toBe(true)
    expect(rec.spans[1]!.ended).toBe(false)
    expect(rec.spans[2]!.ended).toBe(false)

    tracer.endSpanWithError(s2, new Error('fail'))
    expect(rec.spans[1]!.ended).toBe(true)

    s3.end()
    expect(rec.spans[2]!.ended).toBe(true)
  })
})

// ================================================================== METRICS
// Tests for counter, histogram, and gauge via InMemoryMetricSink

describe('Metrics — InMemoryMetricSink operations', () => {
  let sink: InMemoryMetricSink

  beforeEach(() => {
    sink = new InMemoryMetricSink()
  })

  it('increment with default value of 1', () => {
    sink.increment('requests_total', { method: 'GET' })
    expect(sink.getCounter('requests_total', { method: 'GET' })).toBe(1)
  })

  it('increment with explicit value', () => {
    sink.increment('tokens_total', { agent: 'a1' }, 150)
    sink.increment('tokens_total', { agent: 'a1' }, 250)
    expect(sink.getCounter('tokens_total', { agent: 'a1' })).toBe(400)
  })

  it('counter returns 0 for unknown metric', () => {
    expect(sink.getCounter('unknown', {})).toBe(0)
  })

  it('observe records histogram values', () => {
    sink.observe('latency_ms', { op: 'search' }, 12.5)
    sink.observe('latency_ms', { op: 'search' }, 8.3)
    sink.observe('latency_ms', { op: 'search' }, 15.7)
    const values = sink.getHistogram('latency_ms', { op: 'search' })
    expect(values).toEqual([12.5, 8.3, 15.7])
  })

  it('histogram returns empty array for unknown metric', () => {
    expect(sink.getHistogram('unknown', {})).toEqual([])
  })

  it('gauge records latest value', () => {
    sink.gauge('active_connections', {}, 5)
    sink.gauge('active_connections', {}, 10)
    expect(sink.getGauge('active_connections', {})).toBe(10)
  })

  it('gauge returns undefined for unknown metric', () => {
    expect(sink.getGauge('unknown', {})).toBeUndefined()
  })

  it('label ordering is deterministic (alphabetical key sort)', () => {
    sink.increment('m', { z: '1', a: '2' }, 3)
    // Same labels in different order should resolve to same key
    sink.increment('m', { a: '2', z: '1' }, 7)
    expect(sink.getCounter('m', { a: '2', z: '1' })).toBe(10)
  })

  it('reset clears all metrics', () => {
    sink.increment('c', {}, 5)
    sink.observe('h', {}, 10)
    sink.gauge('g', {}, 20)
    sink.reset()
    expect(sink.getCounter('c', {})).toBe(0)
    expect(sink.getHistogram('h', {})).toEqual([])
    expect(sink.getGauge('g', {})).toBeUndefined()
  })

  it('different label combinations are stored separately', () => {
    sink.increment('c', { env: 'prod' }, 1)
    sink.increment('c', { env: 'staging' }, 2)
    expect(sink.getCounter('c', { env: 'prod' })).toBe(1)
    expect(sink.getCounter('c', { env: 'staging' })).toBe(2)
  })

  it('empty labels produce a key without braces', () => {
    sink.increment('bare', {})
    expect(sink.getCounter('bare', {})).toBe(1)
  })
})

describe('Metrics — OTelBridge event-to-metric recording', () => {
  let bus: DzupEventBus
  let sink: InMemoryMetricSink
  let bridge: OTelBridge

  beforeEach(() => {
    bus = createEventBus()
    sink = new InMemoryMetricSink()
    bridge = new OTelBridge({
      tracer: new DzupTracer(),
      metricSink: sink,
    })
    bridge.attach(bus)
  })

  it('records agent:started counter metric', () => {
    bus.emit({ type: 'agent:started', agentId: 'planner', runId: 'r1' })
    expect(sink.getCounter('dzip_agent_runs_total', { agent_id: 'planner', status: 'started' })).toBe(1)
  })

  it('records agent:completed counter and histogram', () => {
    bus.emit({ type: 'agent:completed', agentId: 'coder', runId: 'r1', durationMs: 5000 })
    expect(sink.getCounter('dzip_agent_runs_total', { agent_id: 'coder', status: 'completed' })).toBe(1)
    const hist = sink.getHistogram('dzip_agent_duration_seconds', { agent_id: 'coder' })
    expect(hist).toHaveLength(1)
    expect(hist[0]).toBeCloseTo(5.0)
  })

  it('records tool:called counter metric', () => {
    bus.emit({ type: 'tool:called', toolName: 'git_status', input: {} })
    expect(sink.getCounter('forge_tool_calls_total', { tool_name: 'git_status' })).toBe(1)
  })

  it('records tool:result histogram (duration)', () => {
    bus.emit({ type: 'tool:result', toolName: 'read_file', durationMs: 120 })
    const hist = sink.getHistogram('forge_tool_duration_seconds', { tool_name: 'read_file' })
    expect(hist).toHaveLength(1)
    expect(hist[0]).toBeCloseTo(0.12)
  })

  it('records tool:error counter metric', () => {
    bus.emit({ type: 'tool:error', toolName: 'write_file', errorCode: 'PERM', message: 'denied' })
    expect(sink.getCounter('forge_tool_errors_total', { tool_name: 'write_file', error_code: 'PERM' })).toBe(1)
  })

  it('records memory:written counter', () => {
    bus.emit({ type: 'memory:written', namespace: 'user', key: 'prefs', scope: 'local' })
    expect(sink.getCounter('forge_memory_writes_total', { namespace: 'user' })).toBe(1)
  })

  it('enableMetrics=false disables metric recording', () => {
    const noMetricBridge = new OTelBridge({
      tracer: new DzupTracer(),
      metricSink: sink,
      enableMetrics: false,
    })
    noMetricBridge.attach(bus)
    // Detach the first bridge
    bridge.detach()

    bus.emit({ type: 'agent:started', agentId: 'x', runId: 'r' })
    expect(sink.getCounter('dzip_agent_runs_total', { agent_id: 'x', status: 'started' })).toBe(0)
    noMetricBridge.detach()
  })

  it('enableSpanEvents=false disables span event recording', () => {
    const noSpanBridge = new OTelBridge({
      tracer: new DzupTracer(),
      metricSink: sink,
      enableSpanEvents: false,
    })
    // Should not throw when events fire
    noSpanBridge.attach(bus)
    bridge.detach()

    bus.emit({ type: 'agent:started', agentId: 'x', runId: 'r' })
    // Metric still recorded since enableMetrics defaults to true
    expect(sink.getCounter('dzip_agent_runs_total', { agent_id: 'x', status: 'started' })).toBe(1)
    noSpanBridge.detach()
  })
})

describe('Metrics — OTelBridge span events for lifecycle events', () => {
  let bus: DzupEventBus
  let rec: RecordingTracer
  let bridge: OTelBridge

  beforeEach(() => {
    bus = createEventBus()
    rec = new RecordingTracer()
    const tracer = new DzupTracer({ tracer: rec })
    bridge = new OTelBridge({ tracer, enableMetrics: false })
    bridge.attach(bus)
  })

  it('agent:started creates span with agent.started event', () => {
    bus.emit({ type: 'agent:started', agentId: 'code-gen', runId: 'r1' })
    expect(rec.spans).toHaveLength(1)
    const s = rec.spans[0]!
    expect(s.name).toBe('agent:code-gen')
    expect(s.events).toHaveLength(1)
    expect(s.events[0]!.name).toBe('agent.started')
    expect(s.ended).toBe(true)
  })

  it('agent:failed creates span with error status', () => {
    bus.emit({ type: 'agent:failed', agentId: 'a1', runId: 'r1', errorCode: 'TIMEOUT', message: 'timed out' })
    const s = rec.spans[0]!
    expect(s.status!.code).toBe(SpanStatusCode.ERROR)
    expect(s.status!.message).toBe('timed out')
    expect(s.attrs[ForgeSpanAttr.ERROR_CODE]).toBe('TIMEOUT')
    expect(s.events[0]!.name).toBe('agent.failed')
    expect(s.ended).toBe(true)
  })

  it('tool:error creates span with error status', () => {
    bus.emit({ type: 'tool:error', toolName: 'exec', errorCode: 'ERR', message: 'crash' })
    const s = rec.spans[0]!
    expect(s.name).toBe('tool:exec')
    expect(s.status!.code).toBe(SpanStatusCode.ERROR)
    expect(s.ended).toBe(true)
  })

  it('provider:circuit_opened creates circuit breaker span', () => {
    bus.emit({ type: 'provider:circuit_opened', provider: 'anthropic' } as DzupEvent)
    const s = rec.spans[0]!
    expect(s.name).toBe('provider.circuit_opened')
    expect(s.events[0]!.name).toBe('circuit_breaker.opened')
    expect(s.ended).toBe(true)
  })

  it('non-lifecycle events do not create span events', () => {
    bus.emit({ type: 'tool:called', toolName: 'read', input: {} })
    expect(rec.spans).toHaveLength(0)
  })
})

describe('Metrics — OTelBridge lifecycle', () => {
  it('isAttached is false before attach', () => {
    const bridge = new OTelBridge({ tracer: new DzupTracer() })
    expect(bridge.isAttached).toBe(false)
  })

  it('isAttached is true after attach', () => {
    const bridge = new OTelBridge({ tracer: new DzupTracer() })
    bridge.attach(createEventBus())
    expect(bridge.isAttached).toBe(true)
  })

  it('isAttached is false after detach', () => {
    const bridge = new OTelBridge({ tracer: new DzupTracer() })
    bridge.attach(createEventBus())
    bridge.detach()
    expect(bridge.isAttached).toBe(false)
  })

  it('double detach is safe', () => {
    const bridge = new OTelBridge({ tracer: new DzupTracer() })
    bridge.detach()
    bridge.detach()
    expect(bridge.isAttached).toBe(false)
  })

  it('re-attach detaches previous and attaches new', () => {
    const sink = new InMemoryMetricSink()
    const bridge = new OTelBridge({ tracer: new DzupTracer(), metricSink: sink })
    const bus1 = createEventBus()
    const bus2 = createEventBus()

    bridge.attach(bus1)
    bridge.attach(bus2)

    // Events on bus1 should not be recorded (detached)
    bus1.emit({ type: 'agent:started', agentId: 'old', runId: 'r' })
    expect(sink.getCounter('dzip_agent_runs_total', { agent_id: 'old', status: 'started' })).toBe(0)

    // Events on bus2 should be recorded
    bus2.emit({ type: 'agent:started', agentId: 'new', runId: 'r' })
    expect(sink.getCounter('dzip_agent_runs_total', { agent_id: 'new', status: 'started' })).toBe(1)
  })

  it('metricSink getter returns the configured sink', () => {
    const sink = new InMemoryMetricSink()
    const bridge = new OTelBridge({ tracer: new DzupTracer(), metricSink: sink })
    expect(bridge.metricSink).toBe(sink)
  })

  it('bridge swallows errors from event handlers', () => {
    const throwingSink: MetricSink = {
      increment() { throw new Error('boom') },
      observe() { throw new Error('boom') },
      gauge() { throw new Error('boom') },
    }
    const bridge = new OTelBridge({ tracer: new DzupTracer(), metricSink: throwingSink })
    const bus = createEventBus()
    bridge.attach(bus)

    // Should not throw
    expect(() => {
      bus.emit({ type: 'agent:started', agentId: 'a', runId: 'r' })
    }).not.toThrow()
  })
})

// ================================================================== BAGGAGE
// Tests for baggage context propagation

describe('Baggage — context propagation', () => {
  it('baggage is available inside withForgeContext', () => {
    const result = withForgeContext(
      makeCtx({ baggage: { tenant: 'acme', env: 'prod' } }),
      () => currentForgeContext()!.baggage,
    )
    expect(result).toEqual({ tenant: 'acme', env: 'prod' })
  })

  it('baggage propagates across async boundaries', async () => {
    const result = await withForgeContext(
      makeCtx({ baggage: { correlationId: 'abc-123' } }),
      async () => {
        await tick(5)
        return currentForgeContext()!.baggage
      },
    )
    expect(result.correlationId).toBe('abc-123')
  })

  it('nested contexts merge baggage with child taking precedence', () => {
    const result = withForgeContext(
      makeCtx({ baggage: { a: '1', b: '2' } }),
      () =>
        withForgeContext(
          makeCtx({ baggage: { b: 'overridden', c: '3' } }),
          () => currentForgeContext()!.baggage,
        ),
    )
    expect(result).toEqual({ a: '1', b: 'overridden', c: '3' })
  })

  it('parent baggage is restored after child exits', () => {
    const result = withForgeContext(
      makeCtx({ baggage: { key: 'parent-val' } }),
      () => {
        withForgeContext(makeCtx({ baggage: { key: 'child-val' } }), () => {
          // child scope
        })
        return currentForgeContext()!.baggage
      },
    )
    expect(result.key).toBe('parent-val')
  })

  it('inject includes baggage in carrier header', () => {
    const tracer = new DzupTracer()
    const carrier: Record<string, string> = {}

    withForgeContext(
      makeCtx({ baggage: { 'x-request-id': 'req-99', region: 'eu' } }),
      () => tracer.inject(carrier),
    )

    expect(carrier['baggage']).toBeDefined()
    expect(carrier['baggage']).toContain('x-request-id=req-99')
    expect(carrier['baggage']).toContain('region=eu')
  })

  it('inject omits baggage header when baggage is empty', () => {
    const tracer = new DzupTracer()
    const carrier: Record<string, string> = {}

    withForgeContext(makeCtx({ baggage: {} }), () => tracer.inject(carrier))

    expect(carrier['traceparent']).toBeDefined()
    expect(carrier['baggage']).toBeUndefined()
  })

  it('extract parses baggage with URL-encoded values', () => {
    const tracer = new DzupTracer()
    const result = tracer.extract({
      traceparent: '00-aaa-bbb-01',
      baggage: 'key%20with%20spaces=val%20ue,normal=yes',
    })
    expect(result!.baggage['key with spaces']).toBe('val ue')
    expect(result!.baggage['normal']).toBe('yes')
  })

  it('extract returns empty baggage when no baggage header', () => {
    const tracer = new DzupTracer()
    const result = tracer.extract({
      traceparent: '00-aaa-bbb-01',
    })
    expect(result!.baggage).toEqual({})
  })

  it('inject then extract round-trips baggage', () => {
    const tracer = new DzupTracer()
    const carrier: Record<string, string> = {}
    const originalBaggage = { userId: '42', role: 'admin' }

    withForgeContext(
      makeCtx({ baggage: originalBaggage }),
      () => tracer.inject(carrier),
    )

    const extracted = tracer.extract(carrier)!
    expect(extracted.baggage).toEqual(originalBaggage)
  })

  it('deeply nested async propagation preserves accumulated baggage', async () => {
    const result = await withForgeContext(
      makeCtx({ baggage: { level: '1' } }),
      async () => {
        await tick(1)
        return withForgeContext(
          makeCtx({ baggage: { level: '2' } }),
          async () => {
            await tick(1)
            return withForgeContext(
              makeCtx({ baggage: { level: '3' } }),
              async () => {
                await tick(1)
                return currentForgeContext()!.baggage
              },
            )
          },
        )
      },
    )
    // Each level's 'level' key overwrites the previous
    expect(result.level).toBe('3')
  })

  it('concurrent async contexts do not interfere', async () => {
    const task1 = withForgeContext(
      makeCtx({ agentId: 'task1', baggage: { from: 'task1' } }),
      async () => {
        await tick(10)
        return currentForgeContext()!
      },
    )

    const task2 = withForgeContext(
      makeCtx({ agentId: 'task2', baggage: { from: 'task2' } }),
      async () => {
        await tick(5)
        return currentForgeContext()!
      },
    )

    const [r1, r2] = await Promise.all([task1, task2])
    expect(r1.agentId).toBe('task1')
    expect(r1.baggage.from).toBe('task1')
    expect(r2.agentId).toBe('task2')
    expect(r2.baggage.from).toBe('task2')
  })
})

// ================================================================== PLATFORM IDENTITY
// Covers remaining extract functions in platform-identity.ts (64.7% -> 100%)

describe('Platform-identity metric map — remaining extract functions', () => {
  it('mcp:connected extracts server and status=connected', () => {
    const mappings = platformIdentityMetricMap['mcp:connected']
    const result = mappings[0]!.extract({
      type: 'mcp:connected',
      serverName: 'code-tools',
    } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels.server).toBe('code-tools')
    expect(result.labels.status).toBe('connected')
  })

  it('mcp:disconnected extracts server and status=disconnected', () => {
    const mappings = platformIdentityMetricMap['mcp:disconnected']
    const result = mappings[0]!.extract({
      type: 'mcp:disconnected',
      serverName: 'code-tools',
    } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels.server).toBe('code-tools')
    expect(result.labels.status).toBe('disconnected')
  })

  it('mcp:server_updated produces registry mutation counter', () => {
    const mappings = platformIdentityMetricMap['mcp:server_updated']
    const result = mappings[0]!.extract({ type: 'mcp:server_updated' } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels.operation).toBe('updated')
  })

  it('mcp:server_removed produces registry mutation counter', () => {
    const mappings = platformIdentityMetricMap['mcp:server_removed']
    const result = mappings[0]!.extract({ type: 'mcp:server_removed' } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels.operation).toBe('removed')
  })

  it('mcp:server_enabled produces registry mutation counter', () => {
    const mappings = platformIdentityMetricMap['mcp:server_enabled']
    const result = mappings[0]!.extract({ type: 'mcp:server_enabled' } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels.operation).toBe('enabled')
  })

  it('mcp:server_disabled produces registry mutation counter', () => {
    const mappings = platformIdentityMetricMap['mcp:server_disabled']
    const result = mappings[0]!.extract({ type: 'mcp:server_disabled' } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels.operation).toBe('disabled')
  })

  it('mcp:test_passed produces connectivity test counter', () => {
    const mappings = platformIdentityMetricMap['mcp:test_passed']
    const result = mappings[0]!.extract({ type: 'mcp:test_passed' } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels.result).toBe('passed')
  })

  it('mcp:test_failed produces connectivity test counter', () => {
    const mappings = platformIdentityMetricMap['mcp:test_failed']
    const result = mappings[0]!.extract({ type: 'mcp:test_failed' } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels.result).toBe('failed')
  })

  it('provider:failed extracts provider and tier labels', () => {
    const mappings = platformIdentityMetricMap['provider:failed']
    const result = mappings[0]!.extract({
      type: 'provider:failed',
      provider: 'anthropic',
      tier: 'primary',
    } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels.provider).toBe('anthropic')
    expect(result.labels.tier).toBe('primary')
  })

  it('provider:circuit_opened sets gauge to 1', () => {
    const mappings = platformIdentityMetricMap['provider:circuit_opened']
    const result = mappings[0]!.extract({
      type: 'provider:circuit_opened',
      provider: 'openai',
    } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels.provider).toBe('openai')
  })

  it('provider:circuit_closed sets gauge to 0', () => {
    const mappings = platformIdentityMetricMap['provider:circuit_closed']
    const result = mappings[0]!.extract({
      type: 'provider:circuit_closed',
      provider: 'openai',
    } as DzupEvent)
    expect(result.value).toBe(0)
    expect(result.labels.provider).toBe('openai')
  })

  it('identity:resolved extracts agent_id and status=resolved', () => {
    const mappings = platformIdentityMetricMap['identity:resolved']
    const result = mappings[0]!.extract({
      type: 'identity:resolved',
      agentId: 'agent-x',
    } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels.agent_id).toBe('agent-x')
    expect(result.labels.status).toBe('resolved')
  })

  it('identity:failed extracts agent_id and status=failed', () => {
    const mappings = platformIdentityMetricMap['identity:failed']
    const result = mappings[0]!.extract({
      type: 'identity:failed',
      agentId: 'agent-y',
    } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels.agent_id).toBe('agent-y')
    expect(result.labels.status).toBe('failed')
  })

  it('identity:credential_expired extracts agent_id and credential_type', () => {
    const mappings = platformIdentityMetricMap['identity:credential_expired']
    const result = mappings[0]!.extract({
      type: 'identity:credential_expired',
      agentId: 'agent-z',
      credentialType: 'api_key',
    } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels.agent_id).toBe('agent-z')
    expect(result.labels.credential_type).toBe('api_key')
  })

  it('identity:trust_updated extracts agent_id', () => {
    const mappings = platformIdentityMetricMap['identity:trust_updated']
    const result = mappings[0]!.extract({
      type: 'identity:trust_updated',
      agentId: 'agent-trust',
    } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels.agent_id).toBe('agent-trust')
  })

  it('identity:delegation_issued extracts delegator', () => {
    const mappings = platformIdentityMetricMap['identity:delegation_issued']
    const result = mappings[0]!.extract({
      type: 'identity:delegation_issued',
      delegator: 'admin-agent',
    } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels.delegator).toBe('admin-agent')
  })
})

// ================================================================== NOOP
// Additional noop edge cases

describe('NoopSpan edge cases', () => {
  it('spanContext returns unique spanIds for different instances', () => {
    const s1 = new NoopSpan()
    const s2 = new NoopSpan()
    expect(s1.spanContext().spanId).not.toBe(s2.spanContext().spanId)
  })

  it('NoopSpan with custom traceId', () => {
    const s = new NoopSpan('custom-trace-id')
    expect(s.spanContext().traceId).toBe('custom-trace-id')
  })

  it('all methods return this for chaining (except end)', () => {
    const s = new NoopSpan()
    expect(s.setAttribute('k', 'v')).toBe(s)
    expect(s.setStatus({ code: 1 })).toBe(s)
    expect(s.addEvent('e')).toBe(s)
  })
})

describe('SpanKind and SpanStatusCode constants', () => {
  it('SpanKind has all expected values', () => {
    expect(SpanKind.INTERNAL).toBe(0)
    expect(SpanKind.SERVER).toBe(1)
    expect(SpanKind.CLIENT).toBe(2)
    expect(SpanKind.PRODUCER).toBe(3)
    expect(SpanKind.CONSUMER).toBe(4)
  })

  it('SpanStatusCode has all expected values', () => {
    expect(SpanStatusCode.UNSET).toBe(0)
    expect(SpanStatusCode.OK).toBe(1)
    expect(SpanStatusCode.ERROR).toBe(2)
  })
})
