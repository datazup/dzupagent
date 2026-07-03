import { describe, it, expect } from 'vitest'
import { parseFlow } from '../index.js'
import type { FlowNode } from '../index.js'
import {
  OUTPUT_KEY_UNIQUENESS_CODE,
  OUTPUT_KEY_UNIQUENESS_SEVERITY,
  checkOutputKeyUniqueness,
} from '../output-key-uniqueness.js'

const agentNode = (id: string, key: string): Record<string, unknown> => ({
  type: 'agent',
  id,
  agentId: id,
  instructions: 'do the thing',
  output: { key, schema: { type: 'object' } },
})

const promptNode = (id: string, outputKey: string): Record<string, unknown> => ({
  type: 'prompt',
  id,
  userPrompt: 'summarize the input',
  outputKey,
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
    expect(diags[0]!.code).toBe(OUTPUT_KEY_UNIQUENESS_CODE)
    expect(diags[0]!.severity).toBe(OUTPUT_KEY_UNIQUENESS_SEVERITY)
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

  it('does not globally reject duplicate output.key in nested sequence scopes', () => {
    const root = parseRoot({
      type: 'sequence',
      nodes: [
        agentNode('root-agent', 'result'),
        {
          type: 'sequence',
          id: 'nested',
          nodes: [agentNode('nested-agent', 'result')],
        },
      ],
    })

    expect(checkOutputKeyUniqueness(root)).toEqual([])
  })

  it('does not flag duplicate output keys from non-agent output-producing nodes', () => {
    const root = parseRoot({
      type: 'sequence',
      nodes: [
        promptNode('prompt-a', 'result'),
        promptNode('prompt-b', 'result'),
      ],
    })

    expect(checkOutputKeyUniqueness(root)).toEqual([])
  })

  it('does not promote allowed warning-scoped collisions to errors', () => {
    const root = parseRoot({
      type: 'sequence',
      nodes: [agentNode('a', 'result'), agentNode('b', 'result')],
    })

    expect(checkOutputKeyUniqueness(root)).toEqual([
      expect.objectContaining({
        code: OUTPUT_KEY_UNIQUENESS_CODE,
        severity: OUTPUT_KEY_UNIQUENESS_SEVERITY,
        key: 'result',
        relatedIds: ['a', 'b'],
      }),
    ])
  })

  it('does not retain duplicate state after a warning-producing validation', () => {
    const duplicateRoot = parseRoot({
      type: 'sequence',
      nodes: [agentNode('a', 'result'), agentNode('b', 'result')],
    })
    expect(checkOutputKeyUniqueness(duplicateRoot)).toEqual([
      expect.objectContaining({
        code: OUTPUT_KEY_UNIQUENESS_CODE,
        severity: OUTPUT_KEY_UNIQUENESS_SEVERITY,
      }),
    ])

    const uniqueRoot = parseRoot({
      type: 'sequence',
      nodes: [agentNode('c', 'result'), agentNode('d', 'review')],
    })
    expect(checkOutputKeyUniqueness(uniqueRoot)).toEqual([])
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
