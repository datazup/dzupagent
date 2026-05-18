import { describe, it, expect } from 'vitest'
import { parseFlow } from '../src/index.js'

describe('memory.search', () => {
  it('parses with query and limit', () => {
    const { ast, errors } = parseFlow({
      type: 'sequence',
      nodes: [
        { type: 'memory', operation: 'search', tier: 'workspace', query: '{{ state.q }}', limit: 5 },
      ],
    })
    expect(errors).toEqual([])
    expect(ast).not.toBeNull()
    const node = (ast as { nodes: Array<Record<string, unknown>> }).nodes[0]!
    expect(node.operation).toBe('search')
    expect(node.query).toBe('{{ state.q }}')
    expect(node.limit).toBe(5)
  })

  it('rejects search without query', () => {
    const { errors } = parseFlow({
      type: 'sequence',
      nodes: [{ type: 'memory', operation: 'search', tier: 'workspace' }],
    })
    expect(errors.some((e: { message: string }) => /query/i.test(e.message))).toBe(true)
  })

  it('rejects unknown operation', () => {
    const { errors } = parseFlow({
      type: 'sequence',
      nodes: [{ type: 'memory', operation: 'bogus', tier: 'workspace' }],
    })
    expect(errors.some((e: { message: string }) => /operation/i.test(e.message))).toBe(true)
  })

  it('rejects non-positive limit', () => {
    const { errors } = parseFlow({
      type: 'sequence',
      nodes: [
        { type: 'memory', operation: 'search', tier: 'workspace', query: '{{ state.q }}', limit: 0 },
      ],
    })
    expect(errors.some((e: { message: string }) => /limit/i.test(e.message))).toBe(true)
  })
})
