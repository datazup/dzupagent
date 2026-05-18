import { describe, it, expect } from 'vitest'
import { parseFlow } from '../src/index.js'
import type { FlowNode } from '../src/index.js'
import { checkOutputKeyUniqueness } from '../src/output-key-uniqueness.js'

const agentNode = (id: string, key: string): Record<string, unknown> => ({
  type: 'agent',
  id,
  agentId: id,
  instructions: 'do the thing',
  output: { key, schema: { type: 'object' } },
})

function parseRoot(input: object): FlowNode {
  const result = parseFlow(input)
  if (!result.ast) {
    throw new Error(
      `parseFlow returned no ast; errors: ${JSON.stringify(result.errors, null, 2)}`,
    )
  }
  return result.ast
}

describe('checkOutputKeyUniqueness', () => {
  it('flags duplicate output.key in same sequence', () => {
    const root = parseRoot({
      type: 'sequence',
      nodes: [agentNode('a', 'result'), agentNode('b', 'result')],
    })
    const diags = checkOutputKeyUniqueness(root)
    expect(diags).toHaveLength(1)
    expect(diags[0]!.severity).toBe('warning')
    expect(diags[0]!.message).toMatch(/result/)
    expect(diags[0]!.relatedIds).toEqual(['a', 'b'])
    expect(diags[0]!.key).toBe('result')
    expect(diags[0]!.scopePath).toBe('root')
  })

  it('allows duplicates across try and catch branches', () => {
    const root = parseRoot({
      type: 'sequence',
      nodes: [
        {
          type: 'try_catch',
          id: 'tc',
          body: [agentNode('t', 'result')],
          catch: [agentNode('c', 'result')],
        },
      ],
    })
    expect(checkOutputKeyUniqueness(root)).toEqual([])
  })

  it('allows duplicates across parallel branches', () => {
    const root = parseRoot({
      type: 'sequence',
      nodes: [
        {
          type: 'parallel',
          id: 'p',
          branches: [[agentNode('p1', 'result')], [agentNode('p2', 'result')]],
        },
      ],
    })
    expect(checkOutputKeyUniqueness(root)).toEqual([])
  })

  it('returns no diagnostics for unique keys', () => {
    const root = parseRoot({
      type: 'sequence',
      nodes: [agentNode('a', 'r1'), agentNode('b', 'r2')],
    })
    expect(checkOutputKeyUniqueness(root)).toEqual([])
  })

  it('flags duplicate inside a persona body', () => {
    const root = parseRoot({
      type: 'sequence',
      nodes: [
        {
          type: 'persona',
          id: 'pp',
          personaId: 'p1',
          body: [agentNode('a', 'k'), agentNode('b', 'k')],
        },
      ],
    })
    const diags = checkOutputKeyUniqueness(root)
    expect(diags).toHaveLength(1)
    expect(diags[0]!.key).toBe('k')
    expect(diags[0]!.scopePath).toContain('persona')
  })

  it('flags duplicate across for_each body (single iteration scope)', () => {
    const root = parseRoot({
      type: 'sequence',
      nodes: [
        {
          type: 'for_each',
          id: 'fe',
          source: '{{ state.items }}',
          as: 'item',
          body: [agentNode('a', 'k'), agentNode('b', 'k')],
        },
      ],
    })
    const diags = checkOutputKeyUniqueness(root)
    expect(diags).toHaveLength(1)
    expect(diags[0]!.scopePath).toContain('for_each')
  })
})
