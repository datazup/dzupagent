import { describe, it, expect } from 'vitest'
import { NoopSpan, NoopTracer } from '../noop.js'
import { ForgeSpanAttr } from '../span-attributes.js'
import type { ForgeSpanAttrKey } from '../span-attributes.js'

describe('NoopSpan', () => {
  it('returns a valid spanContext with traceId and spanId', () => {
    const span = new NoopSpan()
    const ctx = span.spanContext()
    expect(ctx.traceId).toBe('00000000000000000000000000000000')
    expect(ctx.spanId).toBeDefined()
    expect(ctx.spanId.length).toBe(16)
  })

  it('uses provided traceId', () => {
    const traceId = 'abcdef1234567890abcdef1234567890'
    const span = new NoopSpan(traceId)
    expect(span.spanContext().traceId).toBe(traceId)
  })

  it('generates unique spanIds for different spans', () => {
    const span1 = new NoopSpan()
    const span2 = new NoopSpan()
    expect(span1.spanContext().spanId).not.toBe(span2.spanContext().spanId)
  })

  it('setAttribute returns this for chaining', () => {
    const span = new NoopSpan()
    const result = span.setAttribute('key', 'value')
    expect(result).toBe(span)
  })

  it('setStatus returns this for chaining', () => {
    const span = new NoopSpan()
    const result = span.setStatus({ code: 1, message: 'error' })
    expect(result).toBe(span)
  })

  it('addEvent returns this for chaining', () => {
    const span = new NoopSpan()
    const result = span.addEvent('test-event', { key: 'value' })
    expect(result).toBe(span)
  })

  it('end() does not throw', () => {
    const span = new NoopSpan()
    expect(() => span.end()).not.toThrow()
  })

  it('isRecording returns false', () => {
    const span = new NoopSpan()
    expect(span.isRecording()).toBe(false)
  })

  it('supports full method chaining', () => {
    const span = new NoopSpan()
    const result = span
      .setAttribute('a', 1)
      .setAttribute('b', true)
      .setStatus({ code: 0 })
      .addEvent('ev1')
      .addEvent('ev2', { x: 'y' })
    expect(result).toBe(span)
  })

  it('addEvent with no attributes does not throw', () => {
    const span = new NoopSpan()
    expect(() => span.addEvent('no-attrs')).not.toThrow()
  })
})

describe('NoopTracer', () => {
  it('startSpan returns a NoopSpan', () => {
    const tracer = new NoopTracer()
    const span = tracer.startSpan('test-span')
    expect(span).toBeDefined()
    expect(span.isRecording()).toBe(false)
  })

  it('startSpan with options returns a NoopSpan', () => {
    const tracer = new NoopTracer()
    const span = tracer.startSpan('test-span', { attributes: { key: 'val' } })
    expect(span.spanContext().traceId).toBeDefined()
  })

  it('startSpan with context returns a NoopSpan', () => {
    const tracer = new NoopTracer()
    const span = tracer.startSpan('test-span', {}, {} as never)
    expect(span).toBeDefined()
  })

  it('produces unique spans on each call', () => {
    const tracer = new NoopTracer()
    const s1 = tracer.startSpan('a')
    const s2 = tracer.startSpan('b')
    expect(s1.spanContext().spanId).not.toBe(s2.spanContext().spanId)
  })

  it('returned spans support full API without errors', () => {
    const tracer = new NoopTracer()
    const span = tracer.startSpan('test')
    span.setAttribute('foo', 'bar')
    span.setStatus({ code: 0 })
    span.addEvent('done')
    span.end()
    // No error thrown
  })
})

describe('ForgeSpanAttr', () => {
  it('defines AGENT_ID attribute key', () => {
    expect(ForgeSpanAttr.AGENT_ID).toBe('forge.agent.id')
  })

  it('defines AGENT_NAME attribute key', () => {
    expect(ForgeSpanAttr.AGENT_NAME).toBe('forge.agent.name')
  })

  it('defines RUN_ID attribute key', () => {
    expect(ForgeSpanAttr.RUN_ID).toBe('forge.run.id')
  })

  it('defines PHASE attribute key', () => {
    expect(ForgeSpanAttr.PHASE).toBe('forge.pipeline.phase')
  })

  it('defines TOOL_NAME attribute key', () => {
    expect(ForgeSpanAttr.TOOL_NAME).toBe('forge.tool.name')
  })

  it('defines TOOL_DURATION_MS attribute key', () => {
    expect(ForgeSpanAttr.TOOL_DURATION_MS).toBe('forge.tool.duration_ms')
  })

  it('defines MEMORY_NAMESPACE attribute key', () => {
    expect(ForgeSpanAttr.MEMORY_NAMESPACE).toBe('forge.memory.namespace')
  })

  it('defines COST_CENTS attribute key', () => {
    expect(ForgeSpanAttr.COST_CENTS).toBe('forge.cost.cents')
  })

  it('defines TOKEN_COUNT attribute key', () => {
    expect(ForgeSpanAttr.TOKEN_COUNT).toBe('forge.tokens.total')
  })

  it('defines GenAI semantic convention keys', () => {
    expect(ForgeSpanAttr.GEN_AI_SYSTEM).toBe('gen_ai.system')
    expect(ForgeSpanAttr.GEN_AI_REQUEST_MODEL).toBe('gen_ai.request.model')
    expect(ForgeSpanAttr.GEN_AI_RESPONSE_MODEL).toBe('gen_ai.response.model')
    expect(ForgeSpanAttr.GEN_AI_USAGE_INPUT_TOKENS).toBe('gen_ai.usage.input_tokens')
    expect(ForgeSpanAttr.GEN_AI_USAGE_OUTPUT_TOKENS).toBe('gen_ai.usage.output_tokens')
    expect(ForgeSpanAttr.GEN_AI_USAGE_TOTAL_TOKENS).toBe('gen_ai.usage.total_tokens')
  })

  it('defines budget attribute keys', () => {
    expect(ForgeSpanAttr.BUDGET_TOKENS_USED).toBe('forge.budget.tokens_used')
    expect(ForgeSpanAttr.BUDGET_TOKENS_LIMIT).toBe('forge.budget.tokens_limit')
    expect(ForgeSpanAttr.BUDGET_COST_USED).toBe('forge.budget.cost_used_cents')
    expect(ForgeSpanAttr.BUDGET_COST_LIMIT).toBe('forge.budget.cost_limit_cents')
    expect(ForgeSpanAttr.BUDGET_ITERATIONS).toBe('forge.budget.iterations')
    expect(ForgeSpanAttr.BUDGET_ITERATIONS_LIMIT).toBe('forge.budget.iterations_limit')
  })

  it('defines error attribute keys', () => {
    expect(ForgeSpanAttr.ERROR_CODE).toBe('forge.error.code')
    expect(ForgeSpanAttr.ERROR_RECOVERABLE).toBe('forge.error.recoverable')
  })

  it('all attribute values are strings', () => {
    for (const value of Object.values(ForgeSpanAttr)) {
      expect(typeof value).toBe('string')
    }
  })

  it('all forge attributes use forge. prefix', () => {
    const forgeKeys = Object.entries(ForgeSpanAttr)
      .filter(([key]) => !key.startsWith('GEN_AI'))
    for (const [, value] of forgeKeys) {
      expect(value).toMatch(/^forge\./)
    }
  })

  it('all gen_ai attributes use gen_ai. prefix', () => {
    const genAiKeys = Object.entries(ForgeSpanAttr)
      .filter(([key]) => key.startsWith('GEN_AI'))
    for (const [, value] of genAiKeys) {
      expect(value).toMatch(/^gen_ai\./)
    }
  })

  it('ForgeSpanAttrKey type covers all values', () => {
    // Type-level test: ensure a value can be assigned to the key type
    const key: ForgeSpanAttrKey = ForgeSpanAttr.AGENT_ID
    expect(key).toBe('forge.agent.id')
  })

  it('has no duplicate attribute values', () => {
    const values = Object.values(ForgeSpanAttr)
    expect(new Set(values).size).toBe(values.length)
  })
})
