import { describe, it, expect, beforeEach } from 'vitest'
import { DzipTracer } from '../tracer.js'
import { NoopTracer, NoopSpan } from '../noop.js'
import { ForgeSpanAttr } from '../span-attributes.js'
import { SpanStatusCode } from '../otel-types.js'
import type { OTelSpan, OTelTracer, OTelSpanOptions, OTelContext } from '../otel-types.js'
import { forgeContextStore, withForgeContext } from '../trace-context-store.js'

// --- Recording tracer for assertions ---

interface RecordedSpan {
  name: string
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

  startSpan(name: string, options?: OTelSpanOptions, _context?: OTelContext): OTelSpan {
    const span = new RecordingSpan(name, options)
    this.spans.push(span)
    return span
  }
}

// --- Tests ---

describe('DzipTracer', () => {
  describe('constructor', () => {
    it('uses NoopTracer when no tracer provided', () => {
      const ft = new DzipTracer()
      expect(ft.tracer).toBeInstanceOf(NoopTracer)
    })

    it('uses provided tracer', () => {
      const recording = new RecordingTracer()
      const ft = new DzipTracer({ tracer: recording })
      expect(ft.tracer).toBe(recording)
    })

    it('defaults serviceName to dzipagent', () => {
      const ft = new DzipTracer()
      expect(ft.serviceName).toBe('dzipagent')
    })

    it('uses custom serviceName', () => {
      const ft = new DzipTracer({ serviceName: 'my-service' })
      expect(ft.serviceName).toBe('my-service')
    })
  })

  describe('startAgentSpan', () => {
    let recording: RecordingTracer
    let ft: DzipTracer

    beforeEach(() => {
      recording = new RecordingTracer()
      ft = new DzipTracer({ tracer: recording })
    })

    it('creates a span with agent attributes', () => {
      const span = ft.startAgentSpan('code-gen', 'run-123')
      expect(span).toBeDefined()
      expect(recording.spans).toHaveLength(1)

      const recorded = recording.spans[0]!.recorded
      expect(recorded.name).toBe('agent:code-gen')
      expect(recorded.attributes[ForgeSpanAttr.AGENT_ID]).toBe('code-gen')
      expect(recorded.attributes[ForgeSpanAttr.RUN_ID]).toBe('run-123')
    })

    it('span is not auto-ended', () => {
      ft.startAgentSpan('a1', 'r1')
      expect(recording.spans[0]!.recorded.ended).toBe(false)
    })
  })

  describe('startLLMSpan', () => {
    let recording: RecordingTracer
    let ft: DzipTracer

    beforeEach(() => {
      recording = new RecordingTracer()
      ft = new DzipTracer({ tracer: recording })
    })

    it('creates a span with GenAI attributes', () => {
      ft.startLLMSpan('claude-sonnet-4-6', 'anthropic')
      const recorded = recording.spans[0]!.recorded
      expect(recorded.name).toBe('llm:invoke')
      expect(recorded.attributes[ForgeSpanAttr.GEN_AI_REQUEST_MODEL]).toBe('claude-sonnet-4-6')
      expect(recorded.attributes[ForgeSpanAttr.GEN_AI_SYSTEM]).toBe('anthropic')
    })

    it('includes optional temperature and maxTokens', () => {
      ft.startLLMSpan('gpt-4', 'openai', { temperature: 0.7, maxTokens: 2048 })
      const recorded = recording.spans[0]!.recorded
      expect(recorded.attributes[ForgeSpanAttr.GEN_AI_REQUEST_TEMPERATURE]).toBe(0.7)
      expect(recorded.attributes[ForgeSpanAttr.GEN_AI_REQUEST_MAX_TOKENS]).toBe(2048)
    })

    it('omits optional fields when not provided', () => {
      ft.startLLMSpan('model-x', 'provider-y')
      const recorded = recording.spans[0]!.recorded
      expect(ForgeSpanAttr.GEN_AI_REQUEST_TEMPERATURE in recorded.attributes).toBe(false)
      expect(ForgeSpanAttr.GEN_AI_REQUEST_MAX_TOKENS in recorded.attributes).toBe(false)
    })
  })

  describe('startToolSpan', () => {
    it('creates a span with tool name', () => {
      const recording = new RecordingTracer()
      const ft = new DzipTracer({ tracer: recording })

      ft.startToolSpan('git_status')
      const recorded = recording.spans[0]!.recorded
      expect(recorded.name).toBe('tool:git_status')
      expect(recorded.attributes[ForgeSpanAttr.TOOL_NAME]).toBe('git_status')
    })

    it('includes inputSize when provided', () => {
      const recording = new RecordingTracer()
      const ft = new DzipTracer({ tracer: recording })

      ft.startToolSpan('read_file', { inputSize: 256 })
      const recorded = recording.spans[0]!.recorded
      expect(recorded.attributes[ForgeSpanAttr.TOOL_INPUT_SIZE]).toBe(256)
    })
  })

  describe('startMemorySpan', () => {
    it('creates a span with memory attributes', () => {
      const recording = new RecordingTracer()
      const ft = new DzipTracer({ tracer: recording })

      ft.startMemorySpan('search', 'user_preferences')
      const recorded = recording.spans[0]!.recorded
      expect(recorded.name).toBe('memory:search')
      expect(recorded.attributes[ForgeSpanAttr.MEMORY_NAMESPACE]).toBe('user_preferences')
      expect(recorded.attributes[ForgeSpanAttr.MEMORY_OPERATION]).toBe('search')
    })
  })

  describe('startPhaseSpan', () => {
    it('creates a span with phase attribute', () => {
      const recording = new RecordingTracer()
      const ft = new DzipTracer({ tracer: recording })

      ft.startPhaseSpan('gen_backend', { agentId: 'a1', runId: 'r1' })
      const recorded = recording.spans[0]!.recorded
      expect(recorded.name).toBe('phase:gen_backend')
      expect(recorded.attributes[ForgeSpanAttr.PHASE]).toBe('gen_backend')
      expect(recorded.attributes[ForgeSpanAttr.AGENT_ID]).toBe('a1')
      expect(recorded.attributes[ForgeSpanAttr.RUN_ID]).toBe('r1')
    })

    it('omits agent/run when not provided', () => {
      const recording = new RecordingTracer()
      const ft = new DzipTracer({ tracer: recording })

      ft.startPhaseSpan('validate')
      const recorded = recording.spans[0]!.recorded
      expect(recorded.attributes[ForgeSpanAttr.PHASE]).toBe('validate')
      expect(ForgeSpanAttr.AGENT_ID in recorded.attributes).toBe(false)
    })
  })

  describe('currentContext', () => {
    it('returns undefined when no ForgeTraceContext active', () => {
      const ft = new DzipTracer()
      expect(ft.currentContext()).toBeUndefined()
    })

    it('returns snapshot from ForgeTraceContext store', () => {
      const ft = new DzipTracer()
      const result = withForgeContext(
        {
          traceId: 'aaaa',
          spanId: 'bbbb',
          agentId: 'agent-1',
          runId: 'run-1',
          baggage: {},
        },
        () => ft.currentContext(),
      )
      expect(result).toEqual({
        traceId: 'aaaa',
        spanId: 'bbbb',
        agentId: 'agent-1',
        runId: 'run-1',
      })
    })
  })

  describe('inject', () => {
    it('does nothing when no context', () => {
      const ft = new DzipTracer()
      const carrier: Record<string, string> = {}
      ft.inject(carrier)
      expect(Object.keys(carrier)).toHaveLength(0)
    })

    it('injects W3C traceparent', () => {
      const ft = new DzipTracer()
      const carrier: Record<string, string> = {}

      withForgeContext(
        {
          traceId: '0af7651916cd43dd8448eb211c80319c',
          spanId: 'b7ad6b7169203331',
          baggage: {},
        },
        () => ft.inject(carrier),
      )

      expect(carrier['traceparent']).toBe(
        '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      )
    })

    it('injects baggage header', () => {
      const ft = new DzipTracer()
      const carrier: Record<string, string> = {}

      withForgeContext(
        {
          traceId: 'aaa',
          spanId: 'bbb',
          baggage: { userId: '42', env: 'prod' },
        },
        () => ft.inject(carrier),
      )

      expect(carrier['baggage']).toBeDefined()
      // Order may vary, check both entries present
      expect(carrier['baggage']).toContain('userId=42')
      expect(carrier['baggage']).toContain('env=prod')
    })
  })

  describe('extract', () => {
    it('returns undefined for missing traceparent', () => {
      const ft = new DzipTracer()
      expect(ft.extract({})).toBeUndefined()
    })

    it('parses W3C traceparent', () => {
      const ft = new DzipTracer()
      const result = ft.extract({
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      })
      expect(result).toBeDefined()
      expect(result!.traceId).toBe('0af7651916cd43dd8448eb211c80319c')
      expect(result!.spanId).toBe('b7ad6b7169203331')
    })

    it('parses baggage', () => {
      const ft = new DzipTracer()
      const result = ft.extract({
        traceparent: '00-aaa-bbb-01',
        baggage: 'userId=42,env=prod',
      })
      expect(result!.baggage).toEqual({ userId: '42', env: 'prod' })
    })

    it('returns undefined for malformed traceparent', () => {
      const ft = new DzipTracer()
      expect(ft.extract({ traceparent: 'invalid' })).toBeUndefined()
    })
  })

  describe('endSpanWithError', () => {
    it('sets error status and ends span', () => {
      const recording = new RecordingTracer()
      const ft = new DzipTracer({ tracer: recording })

      const span = ft.startToolSpan('failing_tool')
      ft.endSpanWithError(span, new Error('something broke'))

      const recorded = recording.spans[0]!.recorded
      expect(recorded.status).toEqual({
        code: SpanStatusCode.ERROR,
        message: 'something broke',
      })
      expect(recorded.ended).toBe(true)
    })

    it('handles non-Error objects', () => {
      const recording = new RecordingTracer()
      const ft = new DzipTracer({ tracer: recording })

      const span = ft.startToolSpan('t')
      ft.endSpanWithError(span, 'string error')

      const recorded = recording.spans[0]!.recorded
      expect(recorded.status!.message).toBe('string error')
    })
  })

  describe('endSpanOk', () => {
    it('sets OK status and ends span', () => {
      const recording = new RecordingTracer()
      const ft = new DzipTracer({ tracer: recording })

      const span = ft.startAgentSpan('a', 'r')
      ft.endSpanOk(span)

      const recorded = recording.spans[0]!.recorded
      expect(recorded.status).toEqual({ code: SpanStatusCode.OK })
      expect(recorded.ended).toBe(true)
    })
  })

  describe('noop fallback', () => {
    it('all operations succeed with noop tracer', () => {
      const ft = new DzipTracer() // no tracer = noop

      const agentSpan = ft.startAgentSpan('a', 'r')
      expect(agentSpan).toBeInstanceOf(NoopSpan)

      const llmSpan = ft.startLLMSpan('model', 'provider')
      expect(llmSpan).toBeInstanceOf(NoopSpan)

      const toolSpan = ft.startToolSpan('tool')
      expect(toolSpan).toBeInstanceOf(NoopSpan)

      const memSpan = ft.startMemorySpan('read', 'ns')
      expect(memSpan).toBeInstanceOf(NoopSpan)

      const phaseSpan = ft.startPhaseSpan('plan')
      expect(phaseSpan).toBeInstanceOf(NoopSpan)

      // All can be ended safely
      agentSpan.end()
      llmSpan.end()
      toolSpan.end()
      memSpan.end()
      phaseSpan.end()

      // setAttribute returns this for chaining
      const chained = agentSpan.setAttribute('key', 'val')
      expect(chained).toBe(agentSpan)
    })

    it('noop span reports isRecording as false', () => {
      const ft = new DzipTracer()
      const span = ft.startAgentSpan('a', 'r')
      expect(span.isRecording()).toBe(false)
    })
  })
})
