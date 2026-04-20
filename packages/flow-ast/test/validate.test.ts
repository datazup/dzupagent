import { describe, expect, it } from 'vitest'

import {
  flowEdgeSchema,
  flowNodeSchema,
  SchemaValidationError,
  validateFlowNodeShape,
} from '../src/validate.js'

// ---------------------------------------------------------------------------
// flowNodeSchema — happy path
// ---------------------------------------------------------------------------

describe('flowNodeSchema.safeParse — valid inputs', () => {
  it('accepts a minimal action node', () => {
    const result = flowNodeSchema.safeParse({
      type: 'action',
      toolRef: 'my.tool',
      input: {},
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.type).toBe('action')
  })

  it('accepts a sequence of actions', () => {
    const result = flowNodeSchema.safeParse({
      type: 'sequence',
      nodes: [
        { type: 'action', toolRef: 't1', input: {} },
        { type: 'action', toolRef: 't2', input: {} },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('accepts a branch with then and else', () => {
    const result = flowNodeSchema.safeParse({
      type: 'branch',
      condition: 'x > 0',
      then: [{ type: 'complete' }],
      else: [{ type: 'complete' }],
    })
    expect(result.success).toBe(true)
  })

  it('accepts a parallel with two branches', () => {
    const result = flowNodeSchema.safeParse({
      type: 'parallel',
      branches: [
        [{ type: 'action', toolRef: 'a', input: {} }],
        [{ type: 'action', toolRef: 'b', input: {} }],
      ],
    })
    expect(result.success).toBe(true)
  })

  it('accepts a fixed-provider route', () => {
    const result = flowNodeSchema.safeParse({
      type: 'route',
      strategy: 'fixed-provider',
      provider: 'openai',
      body: [{ type: 'complete' }],
    })
    expect(result.success).toBe(true)
  })

  it('accepts a capability route', () => {
    const result = flowNodeSchema.safeParse({
      type: 'route',
      strategy: 'capability',
      tags: ['chat'],
      body: [{ type: 'complete' }],
    })
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// flowNodeSchema — error paths
// ---------------------------------------------------------------------------

describe('flowNodeSchema.safeParse — invalid inputs', () => {
  it('rejects non-object inputs with a typed issue', () => {
    const result = flowNodeSchema.safeParse('not an object')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1)
      expect(result.error.issues[0]!.code).toBe('MISSING_REQUIRED_FIELD')
    }
  })

  it('rejects nodes missing `type`', () => {
    const result = flowNodeSchema.safeParse({ foo: 'bar' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]!.path).toBe('root.type')
    }
  })

  it('rejects unknown node types', () => {
    const result = flowNodeSchema.safeParse({ type: 'mystery' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]!.message).toContain('Unknown node type')
    }
  })

  it('rejects action without toolRef', () => {
    const result = flowNodeSchema.safeParse({ type: 'action', input: {} })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path)
      expect(paths).toContain('root.toolRef')
    }
  })

  it('rejects fixed-provider route without provider', () => {
    const result = flowNodeSchema.safeParse({
      type: 'route',
      strategy: 'fixed-provider',
      body: [{ type: 'complete' }],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.message.includes('route.provider is required')),
      ).toBe(true)
    }
  })

  it('rejects capability route with empty tags', () => {
    const result = flowNodeSchema.safeParse({
      type: 'route',
      strategy: 'capability',
      tags: [],
      body: [{ type: 'complete' }],
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty sequence', () => {
    const result = flowNodeSchema.safeParse({ type: 'sequence', nodes: [] })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === 'EMPTY_BODY')).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// flowNodeSchema.parse — throw semantics
// ---------------------------------------------------------------------------

describe('flowNodeSchema.parse', () => {
  it('returns typed node on valid input', () => {
    const node = flowNodeSchema.parse({ type: 'complete' })
    expect(node.type).toBe('complete')
  })

  it('throws SchemaValidationError on invalid input', () => {
    expect(() => flowNodeSchema.parse({ type: 'action' })).toThrow(SchemaValidationError)
  })

  it('SchemaValidationError exposes all issues', () => {
    try {
      flowNodeSchema.parse({ type: 'action' })
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaValidationError)
      if (err instanceof SchemaValidationError) {
        expect(err.issues.length).toBeGreaterThan(0)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// flowEdgeSchema
// ---------------------------------------------------------------------------

describe('flowEdgeSchema', () => {
  it('accepts a minimal edge', () => {
    const result = flowEdgeSchema.safeParse({ from: 'a', to: 'b' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toEqual({ from: 'a', to: 'b' })
  })

  it('accepts edge with kind and condition', () => {
    const result = flowEdgeSchema.safeParse({
      from: 'a',
      to: 'b',
      kind: 'sequential',
      condition: 'x > 0',
    })
    expect(result.success).toBe(true)
  })

  it('rejects edge missing from', () => {
    const result = flowEdgeSchema.safeParse({ to: 'b' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]!.message).toContain('edge.from')
    }
  })

  it('rejects edge with numeric kind', () => {
    const result = flowEdgeSchema.safeParse({ from: 'a', to: 'b', kind: 42 })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// validateFlowNodeShape convenience helper
// ---------------------------------------------------------------------------

describe('validateFlowNodeShape', () => {
  it('returns empty array on valid AST', () => {
    const errors = validateFlowNodeShape({ type: 'complete' })
    expect(errors).toEqual([])
  })

  it('returns ValidationError[] on invalid AST', () => {
    const errors = validateFlowNodeShape({ type: 'action' })
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]!.code).toBe('MISSING_REQUIRED_FIELD')
    expect(typeof errors[0]!.nodePath).toBe('string')
  })

  it('uses custom base path', () => {
    const errors = validateFlowNodeShape({ type: 'action' }, 'custom.root')
    expect(errors[0]!.nodePath.startsWith('custom.root')).toBe(true)
  })
})
