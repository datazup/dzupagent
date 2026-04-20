/**
 * Dedicated tests for otel-types.ts.
 *
 * otel-types.ts exports pure value objects (SpanStatusCode, SpanKind)
 * and interface definitions. This file asserts the exported constants
 * match OpenTelemetry specifications and that the minimal interfaces
 * are structurally correct.
 */

import { describe, it, expect } from 'vitest'
import { SpanStatusCode, SpanKind } from '../otel-types.js'
import type { OTelSpan, OTelTracer, OTelSpanOptions } from '../otel-types.js'

// ------------------------------------------------------------------ SpanStatusCode

describe('SpanStatusCode', () => {
  it('exports a non-null const object', () => {
    expect(SpanStatusCode).toBeDefined()
    expect(typeof SpanStatusCode).toBe('object')
  })

  it('UNSET is 0 matching the OTel specification', () => {
    expect(SpanStatusCode.UNSET).toBe(0)
  })

  it('OK is 1 matching the OTel specification', () => {
    expect(SpanStatusCode.OK).toBe(1)
  })

  it('ERROR is 2 matching the OTel specification', () => {
    expect(SpanStatusCode.ERROR).toBe(2)
  })

  it('has exactly 3 status codes', () => {
    expect(Object.keys(SpanStatusCode)).toHaveLength(3)
  })

  it('all status codes are non-negative integers', () => {
    for (const v of Object.values(SpanStatusCode)) {
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
    }
  })

  it('status codes are unique', () => {
    const values = Object.values(SpanStatusCode)
    expect(new Set(values).size).toBe(values.length)
  })

  it('status codes are ordered UNSET < OK < ERROR', () => {
    expect(SpanStatusCode.UNSET).toBeLessThan(SpanStatusCode.OK)
    expect(SpanStatusCode.OK).toBeLessThan(SpanStatusCode.ERROR)
  })

  it('ERROR code can be used in a setStatus call on a compliant span', () => {
    // Construct a minimal compliant implementation inline to verify interface shape
    const events: Array<{ code: number; message?: string }> = []
    const span: OTelSpan = {
      setAttribute: () => span,
      setStatus: (s) => { events.push(s); return span },
      addEvent: () => span,
      end: () => undefined,
      spanContext: () => ({ traceId: 'aaa', spanId: 'bbb' }),
      isRecording: () => true,
    }
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'something failed' })
    expect(events[0]!.code).toBe(2)
    expect(events[0]!.message).toBe('something failed')
  })
})

// ------------------------------------------------------------------ SpanKind

describe('SpanKind', () => {
  it('exports a non-null const object', () => {
    expect(SpanKind).toBeDefined()
    expect(typeof SpanKind).toBe('object')
  })

  it('INTERNAL is 0 matching the OTel specification', () => {
    expect(SpanKind.INTERNAL).toBe(0)
  })

  it('SERVER is 1 matching the OTel specification', () => {
    expect(SpanKind.SERVER).toBe(1)
  })

  it('CLIENT is 2 matching the OTel specification', () => {
    expect(SpanKind.CLIENT).toBe(2)
  })

  it('PRODUCER is 3 matching the OTel specification', () => {
    expect(SpanKind.PRODUCER).toBe(3)
  })

  it('CONSUMER is 4 matching the OTel specification', () => {
    expect(SpanKind.CONSUMER).toBe(4)
  })

  it('has exactly 5 span kinds', () => {
    expect(Object.keys(SpanKind)).toHaveLength(5)
  })

  it('all span kinds are non-negative integers', () => {
    for (const v of Object.values(SpanKind)) {
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
    }
  })

  it('span kinds are unique', () => {
    const values = Object.values(SpanKind)
    expect(new Set(values).size).toBe(values.length)
  })

  it('INTERNAL kind can be passed as OTelSpanOptions.kind', () => {
    const options: OTelSpanOptions = {
      kind: SpanKind.INTERNAL,
      attributes: { 'forge.agent.id': 'test' },
    }
    expect(options.kind).toBe(0)
  })

  it('CLIENT kind can be passed as OTelSpanOptions.kind', () => {
    const options: OTelSpanOptions = { kind: SpanKind.CLIENT }
    expect(options.kind).toBe(2)
  })
})

// ------------------------------------------------------------------ OTelSpan interface compliance

describe('OTelSpan interface', () => {
  function makeCompliantSpan(): OTelSpan {
    const span: OTelSpan = {
      setAttribute: (_k, _v) => span,
      setStatus: (_s) => span,
      addEvent: (_n, _a) => span,
      end: () => undefined,
      spanContext: () => ({ traceId: '0'.repeat(32), spanId: '0'.repeat(16) }),
      isRecording: () => false,
    }
    return span
  }

  it('setAttribute returns this for chaining', () => {
    const span = makeCompliantSpan()
    expect(span.setAttribute('k', 'v')).toBe(span)
  })

  it('setStatus returns this for chaining', () => {
    const span = makeCompliantSpan()
    expect(span.setStatus({ code: SpanStatusCode.OK })).toBe(span)
  })

  it('addEvent returns this for chaining', () => {
    const span = makeCompliantSpan()
    expect(span.addEvent('event-name')).toBe(span)
  })

  it('spanContext returns traceId and spanId', () => {
    const span = makeCompliantSpan()
    const ctx = span.spanContext()
    expect(ctx.traceId).toHaveLength(32)
    expect(ctx.spanId).toHaveLength(16)
  })

  it('isRecording returns a boolean', () => {
    const span = makeCompliantSpan()
    expect(typeof span.isRecording()).toBe('boolean')
  })

  it('setAttribute accepts string, number and boolean values', () => {
    const span = makeCompliantSpan()
    expect(() => span.setAttribute('s', 'hello')).not.toThrow()
    expect(() => span.setAttribute('n', 42)).not.toThrow()
    expect(() => span.setAttribute('b', true)).not.toThrow()
  })

  it('addEvent with attributes does not throw', () => {
    const span = makeCompliantSpan()
    expect(() => span.addEvent('test', { count: 1, label: 'x', flag: false })).not.toThrow()
  })
})

// ------------------------------------------------------------------ OTelTracer interface compliance

describe('OTelTracer interface', () => {
  it('startSpan returns an OTelSpan with the correct interface shape', () => {
    const tracer: OTelTracer = {
      startSpan: (_name, _opts, _ctx) => {
        const span: OTelSpan = {
          setAttribute: () => span,
          setStatus: () => span,
          addEvent: () => span,
          end: () => undefined,
          spanContext: () => ({ traceId: 'abc', spanId: 'def' }),
          isRecording: () => true,
        }
        return span
      },
    }
    const span = tracer.startSpan('op-name')
    expect(span.isRecording()).toBe(true)
    expect(span.spanContext().traceId).toBe('abc')
  })

  it('startSpan accepts optional options without throwing', () => {
    const spans: string[] = []
    const tracer: OTelTracer = {
      startSpan: (name, opts) => {
        spans.push(`${name}-${opts?.kind ?? 'none'}`)
        const span: OTelSpan = {
          setAttribute: () => span,
          setStatus: () => span,
          addEvent: () => span,
          end: () => undefined,
          spanContext: () => ({ traceId: 't', spanId: 's' }),
          isRecording: () => false,
        }
        return span
      },
    }
    tracer.startSpan('span-with-kind', { kind: SpanKind.SERVER })
    expect(spans[0]).toBe('span-with-kind-1')
  })
})
