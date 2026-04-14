import { describe, it, expect, beforeEach } from 'vitest'
import { DzupTracer } from '../tracer.js'
import { NoopSpan } from '../noop.js'
import { ForgeSpanAttr } from '../span-attributes.js'
import { SpanKind, SpanStatusCode } from '../otel-types.js'
import type { OTelSpan, OTelTracer, OTelSpanOptions, OTelContext } from '../otel-types.js'
import { withForgeContext } from '../trace-context-store.js'

// --- Recording tracer that captures full span details ---

interface RecordedSpan {
  name: string
  options?: OTelSpanOptions
  parentContext?: OTelContext
  attributes: Record<string, string | number | boolean>
  events: Array<{ name: string; attributes?: Record<string, string | number | boolean> }>
  status?: { code: number; message?: string }
  ended: boolean
}

class RecordingSpan implements OTelSpan {
  readonly recorded: RecordedSpan

  constructor(name: string, options?: OTelSpanOptions) {
    this.recorded = {
      name,
      options,
      attributes: { ...(options?.attributes ?? {}) },
      events: [],
      ended: false,
    }
  }

  setAttribute(key: string, value: string | number | boolean): this {
    this.recorded.attributes[key] = value
    return this
  }

  setStatus(status: { code: number; message?: string }): this {
    this.recorded.status = status
    return this
  }

  addEvent(name: string, attributes?: Record<string, string | number | boolean>): this {
    this.recorded.events.push({ name, attributes })
    return this
  }

  end(): void {
    this.recorded.ended = true
  }

  spanContext(): { traceId: string; spanId: string } {
    return { traceId: 'abc123def456abc123def456abc123de', spanId: '1234567890abcdef' }
  }

  isRecording(): boolean {
    return !this.recorded.ended
  }
}

class RecordingTracer implements OTelTracer {
  spans: RecordingSpan[] = []

  startSpan(name: string, options?: OTelSpanOptions, context?: OTelContext): OTelSpan {
    const span = new RecordingSpan(name, options)
    if (context !== undefined) {
      span.recorded.parentContext = context
    }
    this.spans.push(span)
    return span
  }
}

// --- Tests ---

describe('DzupTracer extended', () => {
  let recording: RecordingTracer
  let sut: DzupTracer

  beforeEach(() => {
    recording = new RecordingTracer()
    sut = new DzupTracer({ tracer: recording, serviceName: 'test-svc' })
  })

  describe('startAgentSpan with parent context', () => {
    it('passes parentContext to underlying tracer', () => {
      const parentCtx = { parentMarker: true }
      sut.startAgentSpan('agent-1', 'run-1', { parentContext: parentCtx })

      expect(recording.spans).toHaveLength(1)
      expect(recording.spans[0]!.recorded.parentContext).toBe(parentCtx)
    })

    it('sets span kind to INTERNAL', () => {
      sut.startAgentSpan('agent-x', 'run-x')
      const opts = recording.spans[0]!.recorded.options
      expect(opts?.kind).toBe(SpanKind.INTERNAL)
    })
  })

  describe('startLLMSpan span kind', () => {
    it('sets span kind to CLIENT', () => {
      sut.startLLMSpan('claude-haiku-4-5', 'anthropic')
      const opts = recording.spans[0]!.recorded.options
      expect(opts?.kind).toBe(SpanKind.CLIENT)
    })

    it('handles temperature of zero correctly', () => {
      sut.startLLMSpan('gpt-4', 'openai', { temperature: 0, maxTokens: 100 })
      const recorded = recording.spans[0]!.recorded
      expect(recorded.attributes[ForgeSpanAttr.GEN_AI_REQUEST_TEMPERATURE]).toBe(0)
      expect(recorded.attributes[ForgeSpanAttr.GEN_AI_REQUEST_MAX_TOKENS]).toBe(100)
    })
  })

  describe('startToolSpan span kind', () => {
    it('sets span kind to INTERNAL', () => {
      sut.startToolSpan('write_file')
      const opts = recording.spans[0]!.recorded.options
      expect(opts?.kind).toBe(SpanKind.INTERNAL)
    })

    it('omits inputSize attribute when not provided', () => {
      sut.startToolSpan('git_diff')
      const recorded = recording.spans[0]!.recorded
      expect(ForgeSpanAttr.TOOL_INPUT_SIZE in recorded.attributes).toBe(false)
    })

    it('includes inputSize of zero', () => {
      sut.startToolSpan('empty_tool', { inputSize: 0 })
      const recorded = recording.spans[0]!.recorded
      expect(recorded.attributes[ForgeSpanAttr.TOOL_INPUT_SIZE]).toBe(0)
    })
  })

  describe('startMemorySpan operations', () => {
    const operations = ['read', 'write', 'search', 'delete'] as const

    for (const op of operations) {
      it(`creates correct span name for "${op}" operation`, () => {
        sut.startMemorySpan(op, 'ns-test')
        const recorded = recording.spans[0]!.recorded
        expect(recorded.name).toBe(`memory:${op}`)
        expect(recorded.attributes[ForgeSpanAttr.MEMORY_OPERATION]).toBe(op)
        expect(recorded.attributes[ForgeSpanAttr.MEMORY_NAMESPACE]).toBe('ns-test')
      })
    }

    it('sets span kind to INTERNAL', () => {
      sut.startMemorySpan('read', 'ns')
      const opts = recording.spans[0]!.recorded.options
      expect(opts?.kind).toBe(SpanKind.INTERNAL)
    })
  })

  describe('startPhaseSpan', () => {
    it('sets span kind to INTERNAL', () => {
      sut.startPhaseSpan('gen_frontend')
      const opts = recording.spans[0]!.recorded.options
      expect(opts?.kind).toBe(SpanKind.INTERNAL)
    })

    it('includes only agentId when runId is not provided', () => {
      sut.startPhaseSpan('review', { agentId: 'reviewer' })
      const recorded = recording.spans[0]!.recorded
      expect(recorded.attributes[ForgeSpanAttr.AGENT_ID]).toBe('reviewer')
      expect(ForgeSpanAttr.RUN_ID in recorded.attributes).toBe(false)
    })

    it('includes only runId when agentId is not provided', () => {
      sut.startPhaseSpan('plan', { runId: 'r42' })
      const recorded = recording.spans[0]!.recorded
      expect(recorded.attributes[ForgeSpanAttr.RUN_ID]).toBe('r42')
      expect(ForgeSpanAttr.AGENT_ID in recorded.attributes).toBe(false)
    })
  })

  describe('nested span creation', () => {
    it('creates independent spans that can be ended separately', () => {
      const agentSpan = sut.startAgentSpan('a1', 'r1')
      const llmSpan = sut.startLLMSpan('claude', 'anthropic')
      const toolSpan = sut.startToolSpan('read_file')

      expect(recording.spans).toHaveLength(3)

      // End in reverse order
      toolSpan.end()
      expect(recording.spans[2]!.recorded.ended).toBe(true)
      expect(recording.spans[1]!.recorded.ended).toBe(false)
      expect(recording.spans[0]!.recorded.ended).toBe(false)

      llmSpan.end()
      expect(recording.spans[1]!.recorded.ended).toBe(true)
      expect(recording.spans[0]!.recorded.ended).toBe(false)

      agentSpan.end()
      expect(recording.spans[0]!.recorded.ended).toBe(true)
    })
  })

  describe('span error recording', () => {
    it('endSpanWithError sets ERROR_CODE attribute', () => {
      const span = sut.startToolSpan('broken')
      sut.endSpanWithError(span, new Error('timeout'))

      const recorded = recording.spans[0]!.recorded
      expect(recorded.attributes[ForgeSpanAttr.ERROR_CODE]).toBe('timeout')
      expect(recorded.status?.code).toBe(SpanStatusCode.ERROR)
      expect(recorded.ended).toBe(true)
    })

    it('endSpanWithError handles undefined error', () => {
      const span = sut.startToolSpan('broken')
      sut.endSpanWithError(span, undefined)

      const recorded = recording.spans[0]!.recorded
      expect(recorded.status?.message).toBe('undefined')
      expect(recorded.ended).toBe(true)
    })

    it('endSpanWithError handles number error', () => {
      const span = sut.startToolSpan('broken')
      sut.endSpanWithError(span, 42)

      const recorded = recording.spans[0]!.recorded
      expect(recorded.status?.message).toBe('42')
    })

    it('endSpanWithError handles object error', () => {
      const span = sut.startToolSpan('broken')
      sut.endSpanWithError(span, { code: 'ENOENT' })

      const recorded = recording.spans[0]!.recorded
      // String(obj) produces '[object Object]'
      expect(recorded.status?.message).toBe('[object Object]')
    })
  })

  describe('currentContext within nested withForgeContext', () => {
    it('returns undefined after context exits', () => {
      withForgeContext(
        { traceId: 't1', spanId: 's1', baggage: {} },
        () => {
          expect(sut.currentContext()).toBeDefined()
        },
      )
      expect(sut.currentContext()).toBeUndefined()
    })

    it('snapshot reflects innermost context', () => {
      withForgeContext(
        { traceId: 't1', spanId: 's1', agentId: 'outer', baggage: {} },
        () => {
          const inner = withForgeContext(
            { traceId: 't2', spanId: 's2', agentId: 'inner', baggage: {} },
            () => sut.currentContext(),
          )
          expect(inner?.agentId).toBe('inner')

          // After inner exits, outer is visible
          const outer = sut.currentContext()
          expect(outer?.agentId).toBe('outer')
        },
      )
    })
  })

  describe('inject with URI-encoded baggage', () => {
    it('encodes special characters in baggage', () => {
      const carrier: Record<string, string> = {}

      withForgeContext(
        {
          traceId: 'aaa',
          spanId: 'bbb',
          baggage: { 'user name': 'John Doe', 'path': '/a/b?c=d' },
        },
        () => sut.inject(carrier),
      )

      expect(carrier['baggage']).toBeDefined()
      expect(carrier['baggage']).toContain('user%20name=John%20Doe')
      expect(carrier['baggage']).toContain('path=%2Fa%2Fb%3Fc%3Dd')
    })

    it('does not inject baggage header when baggage is empty', () => {
      const carrier: Record<string, string> = {}

      withForgeContext(
        { traceId: 'aaa', spanId: 'bbb', baggage: {} },
        () => sut.inject(carrier),
      )

      expect(carrier['traceparent']).toBeDefined()
      expect(carrier['baggage']).toBeUndefined()
    })
  })

  describe('extract edge cases', () => {
    it('handles traceparent with too few parts', () => {
      expect(sut.extract({ traceparent: '00-abc' })).toBeUndefined()
    })

    it('handles empty traceId in traceparent', () => {
      expect(sut.extract({ traceparent: '00--spanid-01' })).toBeUndefined()
    })

    it('handles empty spanId in traceparent', () => {
      expect(sut.extract({ traceparent: '00-traceid--01' })).toBeUndefined()
    })

    it('extracts baggage with URI-encoded values', () => {
      const result = sut.extract({
        traceparent: '00-tid-sid-01',
        baggage: 'user%20name=John%20Doe,path=%2Fa%2Fb',
      })
      expect(result!.baggage).toEqual({
        'user name': 'John Doe',
        'path': '/a/b',
      })
    })

    it('ignores baggage entries without =', () => {
      const result = sut.extract({
        traceparent: '00-tid-sid-01',
        baggage: 'invalid,key=value',
      })
      expect(result!.baggage).toEqual({ key: 'value' })
    })
  })

  describe('NoopSpan extended', () => {
    it('generates unique span IDs', () => {
      const ft = new DzupTracer() // noop
      const span1 = ft.startAgentSpan('a', 'r')
      const span2 = ft.startAgentSpan('a', 'r')

      const id1 = span1.spanContext().spanId
      const id2 = span2.spanContext().spanId
      expect(id1).not.toBe(id2)
    })

    it('NoopSpan setStatus returns this for chaining', () => {
      const span = new NoopSpan()
      const result = span.setStatus({ code: SpanStatusCode.OK })
      expect(result).toBe(span)
    })

    it('NoopSpan addEvent returns this for chaining', () => {
      const span = new NoopSpan()
      const result = span.addEvent('test', { key: 'val' })
      expect(result).toBe(span)
    })

    it('NoopSpan spanContext returns zeroed traceId by default', () => {
      const span = new NoopSpan()
      expect(span.spanContext().traceId).toBe('00000000000000000000000000000000')
    })

    it('NoopSpan accepts custom traceId', () => {
      const span = new NoopSpan('custom-trace-id')
      expect(span.spanContext().traceId).toBe('custom-trace-id')
    })
  })
})
