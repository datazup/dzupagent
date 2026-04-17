/**
 * Deep coverage tests for DzupTracer, NoopSpan/NoopTracer, trace-context-store,
 * and span-attributes edge cases.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { DzupTracer } from '../tracer.js'
import { NoopSpan, NoopTracer } from '../noop.js'
import { ForgeSpanAttr } from '../span-attributes.js'
import { SpanStatusCode, SpanKind } from '../otel-types.js'
import type { OTelSpan, OTelTracer, OTelSpanOptions, OTelContext } from '../otel-types.js'
import {
  forgeContextStore,
  withForgeContext,
  currentForgeContext,
} from '../trace-context-store.js'

// --- Recording helpers ---

interface RecordedSpan {
  name: string
  attributes: Record<string, string | number | boolean>
  events: Array<{ name: string; attributes?: Record<string, string | number | boolean> }>
  status?: { code: number; message?: string }
  ended: boolean
  kind?: number
  parentContext?: OTelContext
}

class RecordingSpan implements OTelSpan {
  readonly recorded: RecordedSpan

  constructor(name: string, options?: OTelSpanOptions) {
    this.recorded = {
      name,
      attributes: { ...(options?.attributes ?? {}) },
      events: [],
      ended: false,
      kind: options?.kind,
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
    span.recorded.parentContext = context
    this.spans.push(span)
    return span
  }
}

// ============================================================
// NoopSpan deep tests
// ============================================================

describe('NoopSpan — edge cases', () => {
  it('generates unique span IDs across multiple instances', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const span = new NoopSpan()
      ids.add(span.spanContext().spanId)
    }
    expect(ids.size).toBe(100)
  })

  it('uses default traceId when none provided', () => {
    const span = new NoopSpan()
    expect(span.spanContext().traceId).toBe('00000000000000000000000000000000')
  })

  it('uses provided traceId', () => {
    const span = new NoopSpan('aabbccdd11223344aabbccdd11223344')
    expect(span.spanContext().traceId).toBe('aabbccdd11223344aabbccdd11223344')
  })

  it('setAttribute returns this for chaining', () => {
    const span = new NoopSpan()
    const result = span.setAttribute('key', 'value')
    expect(result).toBe(span)
  })

  it('setStatus returns this for chaining', () => {
    const span = new NoopSpan()
    const result = span.setStatus({ code: SpanStatusCode.OK })
    expect(result).toBe(span)
  })

  it('addEvent returns this for chaining', () => {
    const span = new NoopSpan()
    const result = span.addEvent('my.event', { key: 'val' })
    expect(result).toBe(span)
  })

  it('chaining all methods in sequence works', () => {
    const span = new NoopSpan()
    const result = span
      .setAttribute('a', 1)
      .setAttribute('b', true)
      .setStatus({ code: SpanStatusCode.ERROR, message: 'fail' })
      .addEvent('e1')
      .addEvent('e2', { x: 42 })
    expect(result).toBe(span)
  })

  it('isRecording returns false', () => {
    const span = new NoopSpan()
    expect(span.isRecording()).toBe(false)
  })

  it('end is callable multiple times without error', () => {
    const span = new NoopSpan()
    span.end()
    span.end()
    span.end()
    // Should not throw
    expect(span.isRecording()).toBe(false)
  })

  it('spanId is zero-padded to 16 hex chars', () => {
    const span = new NoopSpan()
    const { spanId } = span.spanContext()
    expect(spanId).toHaveLength(16)
    expect(/^[0-9a-f]+$/.test(spanId)).toBe(true)
  })
})

// ============================================================
// NoopTracer deep tests
// ============================================================

describe('NoopTracer — edge cases', () => {
  it('returns a NoopSpan regardless of options', () => {
    const tracer = new NoopTracer()
    const span = tracer.startSpan('test', { kind: SpanKind.CLIENT, attributes: { foo: 'bar' } })
    expect(span).toBeInstanceOf(NoopSpan)
  })

  it('returns different span instances each call', () => {
    const tracer = new NoopTracer()
    const s1 = tracer.startSpan('a')
    const s2 = tracer.startSpan('b')
    expect(s1).not.toBe(s2)
  })

  it('ignores context argument gracefully', () => {
    const tracer = new NoopTracer()
    const span = tracer.startSpan('test', undefined, { custom: 'context' })
    expect(span).toBeInstanceOf(NoopSpan)
  })
})

// ============================================================
// DzupTracer — startAgentSpan edge cases
// ============================================================

describe('DzupTracer.startAgentSpan — edge cases', () => {
  let recorder: RecordingTracer
  let tracer: DzupTracer

  beforeEach(() => {
    recorder = new RecordingTracer()
    tracer = new DzupTracer({ tracer: recorder })
  })

  it('sets agent and run attributes', () => {
    const span = tracer.startAgentSpan('my-agent', 'run-xyz') as RecordingSpan
    expect(span.recorded.attributes[ForgeSpanAttr.AGENT_ID]).toBe('my-agent')
    expect(span.recorded.attributes[ForgeSpanAttr.RUN_ID]).toBe('run-xyz')
  })

  it('uses SpanKind.INTERNAL', () => {
    tracer.startAgentSpan('a', 'r') as RecordingSpan
    expect(recorder.spans[0]!.recorded.kind).toBe(SpanKind.INTERNAL)
  })

  it('passes parentContext when provided', () => {
    const parentCtx = { someField: true }
    tracer.startAgentSpan('a', 'r', { parentContext: parentCtx }) as RecordingSpan
    expect(recorder.spans[0]!.recorded.parentContext).toBe(parentCtx)
  })

  it('parentContext is undefined when not provided', () => {
    tracer.startAgentSpan('a', 'r')
    expect(recorder.spans[0]!.recorded.parentContext).toBeUndefined()
  })

  it('handles empty string agentId and runId', () => {
    const span = tracer.startAgentSpan('', '') as RecordingSpan
    expect(span.recorded.attributes[ForgeSpanAttr.AGENT_ID]).toBe('')
    expect(span.recorded.attributes[ForgeSpanAttr.RUN_ID]).toBe('')
    expect(span.recorded.name).toBe('agent:')
  })

  it('handles special characters in agentId', () => {
    const span = tracer.startAgentSpan('agent/with spaces!@#', 'r') as RecordingSpan
    expect(span.recorded.attributes[ForgeSpanAttr.AGENT_ID]).toBe('agent/with spaces!@#')
    expect(span.recorded.name).toBe('agent:agent/with spaces!@#')
  })
})

// ============================================================
// DzupTracer.startLLMSpan — edge cases
// ============================================================

describe('DzupTracer.startLLMSpan — edge cases', () => {
  let recorder: RecordingTracer
  let tracer: DzupTracer

  beforeEach(() => {
    recorder = new RecordingTracer()
    tracer = new DzupTracer({ tracer: recorder })
  })

  it('sets model and provider', () => {
    const span = tracer.startLLMSpan('claude-sonnet-4-6', 'anthropic') as RecordingSpan
    expect(span.recorded.attributes[ForgeSpanAttr.GEN_AI_REQUEST_MODEL]).toBe('claude-sonnet-4-6')
    expect(span.recorded.attributes[ForgeSpanAttr.GEN_AI_SYSTEM]).toBe('anthropic')
  })

  it('uses SpanKind.CLIENT', () => {
    tracer.startLLMSpan('m', 'p')
    expect(recorder.spans[0]!.recorded.kind).toBe(SpanKind.CLIENT)
  })

  it('includes temperature when provided', () => {
    const span = tracer.startLLMSpan('m', 'p', { temperature: 0.7 }) as RecordingSpan
    expect(span.recorded.attributes[ForgeSpanAttr.GEN_AI_REQUEST_TEMPERATURE]).toBe(0.7)
  })

  it('omits temperature when not provided', () => {
    const span = tracer.startLLMSpan('m', 'p') as RecordingSpan
    expect(ForgeSpanAttr.GEN_AI_REQUEST_TEMPERATURE in span.recorded.attributes).toBe(false)
  })

  it('includes maxTokens when provided', () => {
    const span = tracer.startLLMSpan('m', 'p', { maxTokens: 4096 }) as RecordingSpan
    expect(span.recorded.attributes[ForgeSpanAttr.GEN_AI_REQUEST_MAX_TOKENS]).toBe(4096)
  })

  it('omits maxTokens when not provided', () => {
    const span = tracer.startLLMSpan('m', 'p', {}) as RecordingSpan
    expect(ForgeSpanAttr.GEN_AI_REQUEST_MAX_TOKENS in span.recorded.attributes).toBe(false)
  })

  it('handles temperature=0 (falsy but valid)', () => {
    const span = tracer.startLLMSpan('m', 'p', { temperature: 0 }) as RecordingSpan
    expect(span.recorded.attributes[ForgeSpanAttr.GEN_AI_REQUEST_TEMPERATURE]).toBe(0)
  })

  it('handles maxTokens=0 (falsy but valid)', () => {
    const span = tracer.startLLMSpan('m', 'p', { maxTokens: 0 }) as RecordingSpan
    expect(span.recorded.attributes[ForgeSpanAttr.GEN_AI_REQUEST_MAX_TOKENS]).toBe(0)
  })

  it('includes both temperature and maxTokens', () => {
    const span = tracer.startLLMSpan('m', 'p', { temperature: 1.0, maxTokens: 1024 }) as RecordingSpan
    expect(span.recorded.attributes[ForgeSpanAttr.GEN_AI_REQUEST_TEMPERATURE]).toBe(1.0)
    expect(span.recorded.attributes[ForgeSpanAttr.GEN_AI_REQUEST_MAX_TOKENS]).toBe(1024)
  })
})

// ============================================================
// DzupTracer.startToolSpan — edge cases
// ============================================================

describe('DzupTracer.startToolSpan — edge cases', () => {
  let recorder: RecordingTracer
  let tracer: DzupTracer

  beforeEach(() => {
    recorder = new RecordingTracer()
    tracer = new DzupTracer({ tracer: recorder })
  })

  it('sets tool name', () => {
    const span = tracer.startToolSpan('git_status') as RecordingSpan
    expect(span.recorded.attributes[ForgeSpanAttr.TOOL_NAME]).toBe('git_status')
    expect(span.recorded.name).toBe('tool:git_status')
  })

  it('uses SpanKind.INTERNAL', () => {
    tracer.startToolSpan('t')
    expect(recorder.spans[0]!.recorded.kind).toBe(SpanKind.INTERNAL)
  })

  it('includes inputSize when provided', () => {
    const span = tracer.startToolSpan('t', { inputSize: 2048 }) as RecordingSpan
    expect(span.recorded.attributes[ForgeSpanAttr.TOOL_INPUT_SIZE]).toBe(2048)
  })

  it('omits inputSize when not provided', () => {
    const span = tracer.startToolSpan('t') as RecordingSpan
    expect(ForgeSpanAttr.TOOL_INPUT_SIZE in span.recorded.attributes).toBe(false)
  })

  it('handles inputSize=0 (falsy but valid)', () => {
    const span = tracer.startToolSpan('t', { inputSize: 0 }) as RecordingSpan
    expect(span.recorded.attributes[ForgeSpanAttr.TOOL_INPUT_SIZE]).toBe(0)
  })
})

// ============================================================
// DzupTracer.startMemorySpan — all operations
// ============================================================

describe('DzupTracer.startMemorySpan — all operations', () => {
  let recorder: RecordingTracer
  let tracer: DzupTracer

  beforeEach(() => {
    recorder = new RecordingTracer()
    tracer = new DzupTracer({ tracer: recorder })
  })

  for (const op of ['read', 'write', 'search', 'delete'] as const) {
    it(`creates span for ${op} operation`, () => {
      const span = tracer.startMemorySpan(op, 'test-ns') as RecordingSpan
      expect(span.recorded.name).toBe(`memory:${op}`)
      expect(span.recorded.attributes[ForgeSpanAttr.MEMORY_NAMESPACE]).toBe('test-ns')
      expect(span.recorded.attributes[ForgeSpanAttr.MEMORY_OPERATION]).toBe(op)
      expect(span.recorded.kind).toBe(SpanKind.INTERNAL)
    })
  }
})

// ============================================================
// DzupTracer.startPhaseSpan — edge cases
// ============================================================

describe('DzupTracer.startPhaseSpan — edge cases', () => {
  let recorder: RecordingTracer
  let tracer: DzupTracer

  beforeEach(() => {
    recorder = new RecordingTracer()
    tracer = new DzupTracer({ tracer: recorder })
  })

  it('sets phase attribute', () => {
    const span = tracer.startPhaseSpan('codegen') as RecordingSpan
    expect(span.recorded.attributes[ForgeSpanAttr.PHASE]).toBe('codegen')
    expect(span.recorded.name).toBe('phase:codegen')
  })

  it('includes agentId when provided', () => {
    const span = tracer.startPhaseSpan('review', { agentId: 'a1' }) as RecordingSpan
    expect(span.recorded.attributes[ForgeSpanAttr.AGENT_ID]).toBe('a1')
  })

  it('includes runId when provided', () => {
    const span = tracer.startPhaseSpan('review', { runId: 'r1' }) as RecordingSpan
    expect(span.recorded.attributes[ForgeSpanAttr.RUN_ID]).toBe('r1')
  })

  it('omits agentId when not provided', () => {
    const span = tracer.startPhaseSpan('review') as RecordingSpan
    expect(ForgeSpanAttr.AGENT_ID in span.recorded.attributes).toBe(false)
  })

  it('omits runId when not provided', () => {
    const span = tracer.startPhaseSpan('review') as RecordingSpan
    expect(ForgeSpanAttr.RUN_ID in span.recorded.attributes).toBe(false)
  })

  it('empty string agentId is treated as falsy (omitted)', () => {
    const span = tracer.startPhaseSpan('review', { agentId: '' }) as RecordingSpan
    // Empty string is falsy in JS, so it should be omitted
    expect(ForgeSpanAttr.AGENT_ID in span.recorded.attributes).toBe(false)
  })
})

// ============================================================
// DzupTracer.endSpanWithError / endSpanOk
// ============================================================

describe('DzupTracer.endSpanWithError', () => {
  let recorder: RecordingTracer
  let tracer: DzupTracer

  beforeEach(() => {
    recorder = new RecordingTracer()
    tracer = new DzupTracer({ tracer: recorder })
  })

  it('sets ERROR status and error attribute from Error instance', () => {
    const span = tracer.startToolSpan('t') as RecordingSpan
    tracer.endSpanWithError(span, new Error('boom'))
    expect(span.recorded.status).toEqual({ code: SpanStatusCode.ERROR, message: 'boom' })
    expect(span.recorded.attributes[ForgeSpanAttr.ERROR_CODE]).toBe('boom')
    expect(span.recorded.ended).toBe(true)
  })

  it('handles string error', () => {
    const span = tracer.startToolSpan('t') as RecordingSpan
    tracer.endSpanWithError(span, 'string error')
    expect(span.recorded.status).toEqual({ code: SpanStatusCode.ERROR, message: 'string error' })
    expect(span.recorded.attributes[ForgeSpanAttr.ERROR_CODE]).toBe('string error')
  })

  it('handles number error', () => {
    const span = tracer.startToolSpan('t') as RecordingSpan
    tracer.endSpanWithError(span, 42)
    expect(span.recorded.status?.message).toBe('42')
  })

  it('handles null error', () => {
    const span = tracer.startToolSpan('t') as RecordingSpan
    tracer.endSpanWithError(span, null)
    expect(span.recorded.status?.message).toBe('null')
  })

  it('handles undefined error', () => {
    const span = tracer.startToolSpan('t') as RecordingSpan
    tracer.endSpanWithError(span, undefined)
    expect(span.recorded.status?.message).toBe('undefined')
  })

  it('handles object error', () => {
    const span = tracer.startToolSpan('t') as RecordingSpan
    tracer.endSpanWithError(span, { code: 'E_FAIL' })
    expect(span.recorded.status?.message).toBe('[object Object]')
  })
})

describe('DzupTracer.endSpanOk', () => {
  it('sets OK status and ends span', () => {
    const recorder = new RecordingTracer()
    const tracer = new DzupTracer({ tracer: recorder })
    const span = tracer.startToolSpan('t') as RecordingSpan
    tracer.endSpanOk(span)
    expect(span.recorded.status).toEqual({ code: SpanStatusCode.OK })
    expect(span.recorded.ended).toBe(true)
  })
})

// ============================================================
// DzupTracer.inject / extract — W3C trace context
// ============================================================

describe('DzupTracer.inject', () => {
  let tracer: DzupTracer

  beforeEach(() => {
    tracer = new DzupTracer()
  })

  it('does nothing outside of ForgeTraceContext', () => {
    const carrier: Record<string, string> = {}
    tracer.inject(carrier)
    expect(Object.keys(carrier)).toHaveLength(0)
  })

  it('injects traceparent inside context', () => {
    const carrier: Record<string, string> = {}
    withForgeContext(
      { traceId: 'aaaa', spanId: 'bbbb', baggage: {} },
      () => { tracer.inject(carrier) },
    )
    expect(carrier['traceparent']).toBe('00-aaaa-bbbb-01')
  })

  it('injects baggage when present', () => {
    const carrier: Record<string, string> = {}
    withForgeContext(
      { traceId: 'a', spanId: 'b', baggage: { key1: 'val1', key2: 'val2' } },
      () => { tracer.inject(carrier) },
    )
    expect(carrier['baggage']).toBeDefined()
    expect(carrier['baggage']).toContain('key1')
    expect(carrier['baggage']).toContain('val1')
  })

  it('does not inject baggage when empty', () => {
    const carrier: Record<string, string> = {}
    withForgeContext(
      { traceId: 'a', spanId: 'b', baggage: {} },
      () => { tracer.inject(carrier) },
    )
    expect(carrier['baggage']).toBeUndefined()
  })

  it('URL-encodes baggage keys and values', () => {
    const carrier: Record<string, string> = {}
    withForgeContext(
      { traceId: 'a', spanId: 'b', baggage: { 'key with space': 'val=ue' } },
      () => { tracer.inject(carrier) },
    )
    expect(carrier['baggage']).toContain('key%20with%20space')
    expect(carrier['baggage']).toContain('val%3Due')
  })
})

describe('DzupTracer.extract', () => {
  let tracer: DzupTracer

  beforeEach(() => {
    tracer = new DzupTracer()
  })

  it('returns undefined when no traceparent', () => {
    expect(tracer.extract({})).toBeUndefined()
  })

  it('returns undefined for malformed traceparent (too few parts)', () => {
    expect(tracer.extract({ traceparent: '00-abc' })).toBeUndefined()
  })

  it('extracts traceId and spanId from valid traceparent', () => {
    const ctx = tracer.extract({ traceparent: '00-traceIdHere-spanIdHere-01' })
    expect(ctx).toBeDefined()
    expect(ctx!.traceId).toBe('traceIdHere')
    expect(ctx!.spanId).toBe('spanIdHere')
  })

  it('parses baggage header', () => {
    const ctx = tracer.extract({
      traceparent: '00-t-s-01',
      baggage: 'key1=val1,key2=val2',
    })
    expect(ctx!.baggage).toEqual({ key1: 'val1', key2: 'val2' })
  })

  it('decodes URL-encoded baggage', () => {
    const ctx = tracer.extract({
      traceparent: '00-t-s-01',
      baggage: 'key%20with%20space=val%3Due',
    })
    expect(ctx!.baggage['key with space']).toBe('val=ue')
  })

  it('returns empty baggage when no baggage header', () => {
    const ctx = tracer.extract({ traceparent: '00-t-s-01' })
    expect(ctx!.baggage).toEqual({})
  })

  it('ignores baggage entries without = sign', () => {
    const ctx = tracer.extract({
      traceparent: '00-t-s-01',
      baggage: 'goodkey=goodval,badentry',
    })
    expect(ctx!.baggage).toEqual({ goodkey: 'goodval' })
  })

  it('handles baggage with = in value', () => {
    const ctx = tracer.extract({
      traceparent: '00-t-s-01',
      baggage: 'key=val=ue=more',
    })
    // eqIdx finds first =, so value includes everything after
    expect(ctx!.baggage['key']).toBe('val=ue=more')
  })
})

// ============================================================
// DzupTracer.currentContext
// ============================================================

describe('DzupTracer.currentContext', () => {
  let tracer: DzupTracer

  beforeEach(() => {
    tracer = new DzupTracer()
  })

  it('returns undefined outside of context', () => {
    expect(tracer.currentContext()).toBeUndefined()
  })

  it('returns snapshot inside context', () => {
    const result = withForgeContext(
      { traceId: 't1', spanId: 's1', agentId: 'a', runId: 'r', baggage: {} },
      () => tracer.currentContext(),
    )
    expect(result).toEqual({
      traceId: 't1',
      spanId: 's1',
      agentId: 'a',
      runId: 'r',
    })
  })

  it('returns undefined agentId and runId when not set', () => {
    const result = withForgeContext(
      { traceId: 't', spanId: 's', baggage: {} },
      () => tracer.currentContext(),
    )
    expect(result!.agentId).toBeUndefined()
    expect(result!.runId).toBeUndefined()
  })
})

// ============================================================
// withForgeContext — nesting behavior
// ============================================================

describe('withForgeContext — nesting', () => {
  it('merges nested context with parent', () => {
    const result = withForgeContext(
      { traceId: 't1', spanId: 's1', agentId: 'parent', baggage: { env: 'prod' } },
      () => {
        return withForgeContext(
          { traceId: 't2', spanId: 's2', baggage: { extra: 'val' } },
          () => currentForgeContext(),
        )
      },
    )
    expect(result!.traceId).toBe('t2')
    expect(result!.spanId).toBe('s2')
    expect(result!.agentId).toBe('parent') // inherited
    expect(result!.baggage).toEqual({ env: 'prod', extra: 'val' }) // merged
  })

  it('child baggage overrides parent baggage for same key', () => {
    const result = withForgeContext(
      { traceId: 't', spanId: 's', baggage: { k: 'parent' } },
      () => withForgeContext(
        { traceId: 't2', spanId: 's2', baggage: { k: 'child' } },
        () => currentForgeContext(),
      ),
    )
    expect(result!.baggage['k']).toBe('child')
  })

  it('returns value from synchronous callback', () => {
    const result = withForgeContext(
      { traceId: 't', spanId: 's', baggage: {} },
      () => 42,
    )
    expect(result).toBe(42)
  })

  it('returns promise from async callback', async () => {
    const result = await withForgeContext(
      { traceId: 't', spanId: 's', baggage: {} },
      async () => {
        return 'async-result'
      },
    )
    expect(result).toBe('async-result')
  })
})

// ============================================================
// ForgeSpanAttr completeness
// ============================================================

describe('ForgeSpanAttr', () => {
  it('has all expected agent identity attributes', () => {
    expect(ForgeSpanAttr.AGENT_ID).toBe('forge.agent.id')
    expect(ForgeSpanAttr.AGENT_NAME).toBe('forge.agent.name')
    expect(ForgeSpanAttr.RUN_ID).toBe('forge.run.id')
    expect(ForgeSpanAttr.PHASE).toBe('forge.pipeline.phase')
    expect(ForgeSpanAttr.TENANT_ID).toBe('forge.tenant.id')
  })

  it('has all expected GenAI attributes', () => {
    expect(ForgeSpanAttr.GEN_AI_SYSTEM).toBe('gen_ai.system')
    expect(ForgeSpanAttr.GEN_AI_REQUEST_MODEL).toBe('gen_ai.request.model')
    expect(ForgeSpanAttr.GEN_AI_RESPONSE_MODEL).toBe('gen_ai.response.model')
    expect(ForgeSpanAttr.GEN_AI_USAGE_INPUT_TOKENS).toBe('gen_ai.usage.input_tokens')
    expect(ForgeSpanAttr.GEN_AI_USAGE_OUTPUT_TOKENS).toBe('gen_ai.usage.output_tokens')
    expect(ForgeSpanAttr.GEN_AI_USAGE_TOTAL_TOKENS).toBe('gen_ai.usage.total_tokens')
  })

  it('has all expected budget attributes', () => {
    expect(ForgeSpanAttr.BUDGET_TOKENS_USED).toBe('forge.budget.tokens_used')
    expect(ForgeSpanAttr.BUDGET_TOKENS_LIMIT).toBe('forge.budget.tokens_limit')
    expect(ForgeSpanAttr.BUDGET_COST_USED).toBe('forge.budget.cost_used_cents')
    expect(ForgeSpanAttr.BUDGET_COST_LIMIT).toBe('forge.budget.cost_limit_cents')
    expect(ForgeSpanAttr.BUDGET_ITERATIONS).toBe('forge.budget.iterations')
    expect(ForgeSpanAttr.BUDGET_ITERATIONS_LIMIT).toBe('forge.budget.iterations_limit')
  })

  it('attribute values are all strings (no accidental number/boolean)', () => {
    for (const value of Object.values(ForgeSpanAttr)) {
      expect(typeof value).toBe('string')
    }
  })

  it('attribute keys are unique (no duplicates)', () => {
    const values = Object.values(ForgeSpanAttr)
    const unique = new Set(values)
    expect(unique.size).toBe(values.length)
  })
})

// ============================================================
// SpanStatusCode / SpanKind constants
// ============================================================

describe('SpanStatusCode constants', () => {
  it('has correct values', () => {
    expect(SpanStatusCode.UNSET).toBe(0)
    expect(SpanStatusCode.OK).toBe(1)
    expect(SpanStatusCode.ERROR).toBe(2)
  })
})

describe('SpanKind constants', () => {
  it('has correct values', () => {
    expect(SpanKind.INTERNAL).toBe(0)
    expect(SpanKind.SERVER).toBe(1)
    expect(SpanKind.CLIENT).toBe(2)
    expect(SpanKind.PRODUCER).toBe(3)
    expect(SpanKind.CONSUMER).toBe(4)
  })
})

// ============================================================
// DzupTracer constructor edge cases
// ============================================================

describe('DzupTracer constructor', () => {
  it('defaults serviceName to dzupagent', () => {
    const t = new DzupTracer()
    expect(t.serviceName).toBe('dzupagent')
  })

  it('uses custom serviceName', () => {
    const t = new DzupTracer({ serviceName: 'custom-service' })
    expect(t.serviceName).toBe('custom-service')
  })

  it('uses NoopTracer when config is undefined', () => {
    const t = new DzupTracer(undefined)
    expect(t.tracer).toBeInstanceOf(NoopTracer)
  })

  it('uses NoopTracer when config is empty object', () => {
    const t = new DzupTracer({})
    expect(t.tracer).toBeInstanceOf(NoopTracer)
  })
})
