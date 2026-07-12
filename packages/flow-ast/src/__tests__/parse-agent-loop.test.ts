/**
 * Parser-level coverage for the agent-node loop-control sub-parsers in
 * `parse/agent-loop.ts` (parseOutput, parseStop, parseOnInvalidOutput,
 * parseRetry, parseAttemptsBranch). `parse-agent.test.ts` covers the
 * happy-path shape of these fields as part of the wider `agent` node; this
 * file focuses on the fields and malformed-input branches not exercised
 * there: `stop.requireFinalSchema`, `retry.onValidationFailure`,
 * `retry.onModelUnavailable`, and type/shape validation errors.
 */
import { describe, it, expect } from 'vitest'
import { parseFlow } from '../index.js'
import type { AgentNode } from '../index.js'

function baseAgent(overrides: Record<string, unknown> = {}) {
  return {
    type: 'agent',
    id: 'a1',
    agentId: 'planner',
    instructions: 'Plan it.',
    output: { key: 'plan', schemaRef: 'plan.v1' },
    ...overrides,
  }
}

describe('parseFlow — agent.output (parseOutput)', () => {
  it('parses output with inline schema and no schemaRef', () => {
    const result = parseFlow(
      baseAgent({ output: { key: 'plan', schema: { type: 'object' } } }),
    )
    expect(result.errors).toHaveLength(0)
    const node = result.ast as AgentNode
    expect(node?.output.key).toBe('plan')
    expect(node?.output.schema).toEqual({ type: 'object' })
  })

  it('rejects a non-object output', () => {
    const result = parseFlow(baseAgent({ output: 'plan' }))
    expect(result.ast).toBeNull()
    expect(result.errors.some((e) => e.code === 'EXPECTED_OBJECT')).toBe(true)
  })

  it('rejects output with a non-string schemaRef', () => {
    const result = parseFlow(
      baseAgent({ output: { key: 'plan', schemaRef: 123 } }),
    )
    expect(result.ast).toBeNull()
    expect(
      result.errors.some((e) => e.message.includes('schemaRef')),
    ).toBe(true)
  })

  it('rejects output with a non-object inline schema', () => {
    const result = parseFlow(
      baseAgent({ output: { key: 'plan', schema: 'not-an-object' } }),
    )
    expect(result.ast).toBeNull()
    expect(result.errors.some((e) => e.message.includes('schema'))).toBe(
      true,
    )
  })
})

describe('parseFlow — agent.stop (parseStop)', () => {
  it('parses requireFinalSchema alongside maxIterations/maxToolCalls', () => {
    const result = parseFlow(
      baseAgent({
        stop: { maxIterations: 5, maxToolCalls: 20, requireFinalSchema: true },
      }),
    )
    expect(result.errors).toHaveLength(0)
    const node = result.ast as AgentNode
    expect(node?.stop?.maxIterations).toBe(5)
    expect(node?.stop?.maxToolCalls).toBe(20)
    expect(node?.stop?.requireFinalSchema).toBe(true)
  })

  it('is optional and omitted entirely when absent', () => {
    const result = parseFlow(baseAgent())
    expect(result.errors).toHaveLength(0)
    const node = result.ast as AgentNode
    expect(node?.stop).toBeUndefined()
  })

  it('rejects a non-object stop', () => {
    const result = parseFlow(baseAgent({ stop: 'soon' }))
    expect(result.errors.some((e) => e.code === 'EXPECTED_OBJECT')).toBe(
      true,
    )
  })

  it('rejects a non-numeric maxIterations but keeps parsing other fields', () => {
    const result = parseFlow(
      baseAgent({ stop: { maxIterations: 'five', maxToolCalls: 20 } }),
    )
    expect(
      result.errors.some((e) => e.message.includes('maxIterations')),
    ).toBe(true)
  })

  it('rejects a non-positive maxToolCalls', () => {
    const result = parseFlow(baseAgent({ stop: { maxToolCalls: 0 } }))
    expect(
      result.errors.some((e) => e.message.includes('maxToolCalls')),
    ).toBe(true)
  })

  it('rejects a non-boolean requireFinalSchema', () => {
    const result = parseFlow(
      baseAgent({ stop: { requireFinalSchema: 'yes' } }),
    )
    expect(
      result.errors.some((e) => e.message.includes('requireFinalSchema')),
    ).toBe(true)
  })
})

describe('parseFlow — agent.onInvalidOutput (parseOnInvalidOutput)', () => {
  it('parses retry, repairPrompt and failAfterRetries', () => {
    const result = parseFlow(
      baseAgent({
        onInvalidOutput: { retry: 3, repairPrompt: true, failAfterRetries: true },
      }),
    )
    expect(result.errors).toHaveLength(0)
    const node = result.ast as AgentNode
    expect(node?.onInvalidOutput?.retry).toBe(3)
    expect(node?.onInvalidOutput?.repairPrompt).toBe(true)
    expect(node?.onInvalidOutput?.failAfterRetries).toBe(true)
  })

  it('rejects a non-object onInvalidOutput', () => {
    const result = parseFlow(baseAgent({ onInvalidOutput: 'retry-please' }))
    expect(result.errors.some((e) => e.code === 'EXPECTED_OBJECT')).toBe(
      true,
    )
  })

  it('rejects onInvalidOutput missing the required retry count', () => {
    const result = parseFlow(
      baseAgent({ onInvalidOutput: { repairPrompt: true } }),
    )
    expect(result.errors.some((e) => e.message.includes('retry'))).toBe(
      true,
    )
  })

  it('rejects a negative retry count', () => {
    const result = parseFlow(baseAgent({ onInvalidOutput: { retry: -1 } }))
    expect(result.errors.some((e) => e.message.includes('retry'))).toBe(
      true,
    )
  })
})

describe('parseFlow — agent.retry (parseRetry / parseAttemptsBranch)', () => {
  it('parses onValidationFailure with fullLoop', () => {
    const result = parseFlow(
      baseAgent({
        retry: { onValidationFailure: { attempts: 3, fullLoop: true } },
      }),
    )
    expect(result.errors).toHaveLength(0)
    const node = result.ast as AgentNode
    expect(node?.retry?.onValidationFailure?.attempts).toBe(3)
    expect(node?.retry?.onValidationFailure?.fullLoop).toBe(true)
  })

  it('parses onModelUnavailable with fallbackProfile', () => {
    const result = parseFlow(
      baseAgent({
        retry: {
          onModelUnavailable: { attempts: 1, fallbackProfile: 'fallback-v1' },
        },
      }),
    )
    expect(result.errors).toHaveLength(0)
    const node = result.ast as AgentNode
    expect(node?.retry?.onModelUnavailable?.attempts).toBe(1)
    expect(node?.retry?.onModelUnavailable?.fallbackProfile).toBe(
      'fallback-v1',
    )
  })

  it('parses all four retry branches together', () => {
    const result = parseFlow(
      baseAgent({
        retry: {
          onInvalidOutput: { attempts: 2, repairPrompt: true },
          onToolError: { attempts: 1 },
          onValidationFailure: { attempts: 3, fullLoop: true },
          onModelUnavailable: { attempts: 1, fallbackProfile: 'fallback-v1' },
        },
      }),
    )
    expect(result.errors).toHaveLength(0)
    const node = result.ast as AgentNode
    expect(node?.retry?.onInvalidOutput?.attempts).toBe(2)
    expect(node?.retry?.onToolError?.attempts).toBe(1)
    expect(node?.retry?.onValidationFailure?.attempts).toBe(3)
    expect(node?.retry?.onModelUnavailable?.attempts).toBe(1)
  })

  it('rejects a non-object retry block', () => {
    const result = parseFlow(baseAgent({ retry: 'again' }))
    expect(result.errors.some((e) => e.code === 'EXPECTED_OBJECT')).toBe(
      true,
    )
  })

  it('rejects an attempts branch missing the required attempts count', () => {
    const result = parseFlow(
      baseAgent({ retry: { onToolError: { fullLoop: true } } }),
    )
    expect(result.errors.some((e) => e.message.includes('attempts'))).toBe(
      true,
    )
  })

  it('rejects a non-object attempts branch', () => {
    const result = parseFlow(baseAgent({ retry: { onToolError: 'once' } }))
    expect(
      result.errors.some((e) => e.message.includes('onToolError')),
    ).toBe(true)
  })
})
