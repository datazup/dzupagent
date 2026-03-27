import { describe, it, expect } from 'vitest'
import {
  injectTraceContext,
  extractTraceContext,
  formatTraceparent,
  parseTraceparent,
} from '../telemetry/trace-propagation.js'
import type { TraceContext } from '../telemetry/trace-propagation.js'

describe('trace-propagation', () => {
  // -----------------------------------------------------------------------
  // formatTraceparent / parseTraceparent
  // -----------------------------------------------------------------------
  describe('formatTraceparent', () => {
    it('formats a TraceContext as W3C traceparent', () => {
      const ctx: TraceContext = {
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: 'b7ad6b7169203331',
        traceFlags: 1,
      }
      expect(formatTraceparent(ctx)).toBe(
        '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      )
    })

    it('zero-pads trace flags', () => {
      const ctx: TraceContext = {
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: 'b7ad6b7169203331',
        traceFlags: 0,
      }
      expect(formatTraceparent(ctx)).toMatch(/-00$/)
    })
  })

  describe('parseTraceparent', () => {
    it('parses a valid W3C traceparent', () => {
      const result = parseTraceparent(
        '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      )
      expect(result).toEqual({
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: 'b7ad6b7169203331',
        traceFlags: 1,
      })
    })

    it('returns null for malformed strings', () => {
      expect(parseTraceparent('')).toBeNull()
      expect(parseTraceparent('00')).toBeNull()
      expect(parseTraceparent('00-short-id-01')).toBeNull()
      expect(parseTraceparent('not-a-traceparent')).toBeNull()
    })

    it('returns null when traceId has wrong length', () => {
      expect(
        parseTraceparent('00-0af765-b7ad6b7169203331-01'),
      ).toBeNull()
    })

    it('returns null when spanId has wrong length', () => {
      expect(
        parseTraceparent('00-0af7651916cd43dd8448eb211c80319c-short-01'),
      ).toBeNull()
    })

    it('returns null when traceId has non-hex chars', () => {
      expect(
        parseTraceparent('00-ZZZZ651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'),
      ).toBeNull()
    })
  })

  // -----------------------------------------------------------------------
  // injectTraceContext
  // -----------------------------------------------------------------------
  describe('injectTraceContext', () => {
    it('adds _trace to empty metadata', () => {
      const result = injectTraceContext({})
      expect(result).toHaveProperty('_trace')
      const trace = result['_trace'] as Record<string, unknown>
      expect(typeof trace['traceparent']).toBe('string')
    })

    it('adds _trace when called with no argument', () => {
      const result = injectTraceContext()
      expect(result).toHaveProperty('_trace')
    })

    it('preserves existing metadata fields', () => {
      const result = injectTraceContext({ foo: 'bar', count: 42 })
      expect(result['foo']).toBe('bar')
      expect(result['count']).toBe(42)
      expect(result).toHaveProperty('_trace')
    })

    it('does not mutate the original metadata object', () => {
      const original: Record<string, unknown> = { key: 'value' }
      const result = injectTraceContext(original)
      expect(original).not.toHaveProperty('_trace')
      expect(result).toHaveProperty('_trace')
    })

    it('generates valid W3C traceparent format', () => {
      const result = injectTraceContext({})
      const trace = result['_trace'] as Record<string, unknown>
      const traceparent = trace['traceparent'] as string
      // W3C format: version-traceId(32hex)-spanId(16hex)-flags(2hex)
      expect(traceparent).toMatch(
        /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/,
      )
    })

    it('is idempotent — does not overwrite existing valid trace', () => {
      const first = injectTraceContext({})
      const second = injectTraceContext(first)
      const trace1 = (first['_trace'] as Record<string, unknown>)['traceparent']
      const trace2 = (second['_trace'] as Record<string, unknown>)['traceparent']
      expect(trace1).toBe(trace2)
    })

    it('generates unique traceIds across calls', () => {
      const a = injectTraceContext({})
      const b = injectTraceContext({})
      const traceA = (a['_trace'] as Record<string, unknown>)['traceparent'] as string
      const traceB = (b['_trace'] as Record<string, unknown>)['traceparent'] as string
      expect(traceA).not.toBe(traceB)
    })
  })

  // -----------------------------------------------------------------------
  // extractTraceContext
  // -----------------------------------------------------------------------
  describe('extractTraceContext', () => {
    it('returns null for undefined metadata', () => {
      expect(extractTraceContext(undefined)).toBeNull()
    })

    it('returns null for empty metadata', () => {
      expect(extractTraceContext({})).toBeNull()
    })

    it('returns null when _trace is not an object', () => {
      expect(extractTraceContext({ _trace: 'bad' })).toBeNull()
      expect(extractTraceContext({ _trace: 123 })).toBeNull()
      expect(extractTraceContext({ _trace: null })).toBeNull()
    })

    it('returns null when traceparent is missing', () => {
      expect(extractTraceContext({ _trace: {} })).toBeNull()
    })

    it('returns null when traceparent is not a string', () => {
      expect(extractTraceContext({ _trace: { traceparent: 42 } })).toBeNull()
    })

    it('returns null when traceparent is malformed', () => {
      expect(
        extractTraceContext({ _trace: { traceparent: 'garbage' } }),
      ).toBeNull()
    })

    it('extracts a valid TraceContext', () => {
      const metadata = {
        _trace: {
          traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
        },
      }
      const ctx = extractTraceContext(metadata)
      expect(ctx).toEqual({
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: 'b7ad6b7169203331',
        traceFlags: 1,
      })
    })
  })

  // -----------------------------------------------------------------------
  // Round-trip
  // -----------------------------------------------------------------------
  describe('round-trip: inject -> extract', () => {
    it('preserves traceId and spanId through inject and extract', () => {
      const metadata = injectTraceContext({ user: 'alice' })
      const ctx = extractTraceContext(metadata)

      expect(ctx).not.toBeNull()
      expect(ctx!.traceId).toHaveLength(32)
      expect(ctx!.spanId).toHaveLength(16)
      expect(ctx!.traceFlags).toBe(1)

      // traceId and spanId are valid hex
      expect(ctx!.traceId).toMatch(/^[0-9a-f]{32}$/)
      expect(ctx!.spanId).toMatch(/^[0-9a-f]{16}$/)
    })

    it('round-trips through formatTraceparent and parseTraceparent', () => {
      const original: TraceContext = {
        traceId: 'abcdef0123456789abcdef0123456789',
        spanId: '0123456789abcdef',
        traceFlags: 1,
      }
      const traceparent = formatTraceparent(original)
      const parsed = parseTraceparent(traceparent)
      expect(parsed).toEqual(original)
    })

    it('survives JSON serialization (queue persistence scenario)', () => {
      const metadata = injectTraceContext({ jobType: 'agent-run' })

      // Simulate queue serialization round-trip
      const serialized = JSON.stringify(metadata)
      const deserialized = JSON.parse(serialized) as Record<string, unknown>

      const ctx = extractTraceContext(deserialized)
      expect(ctx).not.toBeNull()
      expect(ctx!.traceId).toHaveLength(32)
      expect(ctx!.spanId).toHaveLength(16)
    })
  })
})
