import { describe, expect, it } from 'vitest'

import {
  flowDocumentSchema,
  flowEdgeSchema,
  flowNodeSchema,
  SchemaValidationError,
  validateFlowDocumentShape,
  validateFlowNodeShape,
} from '../validate.js'
import { FLOW_NODE_VALIDATOR_DESCRIPTORS, KNOWN_NODE_TYPES } from '../validation-descriptors.js'
import { isFlowValue, isPlainObject, joinPath } from '../validation-helpers.js'
import { validateCanonicalNodeIds, type ValidationTraversalIssue } from '../validation-traversal.js'
import { FLOW_NODE_KINDS } from '../types.js'

// ---------------------------------------------------------------------------
// flowNodeSchema — happy path
// ---------------------------------------------------------------------------

describe('flowNodeSchema.safeParse — valid inputs', () => {
  it('accepts a minimal action node', () => {
    const result = flowNodeSchema.safeParse({
      type: 'action',
      id: 'plan',
      toolRef: 'my.tool',
      input: {},
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.type).toBe('action')
  })

  it('accepts a sequence of actions', () => {
    const result = flowNodeSchema.safeParse({
      type: 'sequence',
      id: 'root',
      nodes: [
        { type: 'action', id: 'a1', toolRef: 't1', input: {} },
        { type: 'action', id: 'a2', toolRef: 't2', input: {} },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('accepts a branch with then and else', () => {
    const result = flowNodeSchema.safeParse({
      type: 'branch',
      id: 'branch',
      condition: 'x > 0',
      then: [{ type: 'complete', id: 'then_done' }],
      else: [{ type: 'complete', id: 'else_done' }],
    })
    expect(result.success).toBe(true)
  })

  it('accepts a parallel with two branches', () => {
    const result = flowNodeSchema.safeParse({
      type: 'parallel',
      id: 'parallel',
      branches: [
        [{ type: 'action', id: 'left', toolRef: 'a', input: {} }],
        [{ type: 'action', id: 'right', toolRef: 'b', input: {} }],
      ],
    })
    expect(result.success).toBe(true)
  })

  it('accepts a fixed-provider route', () => {
    const result = flowNodeSchema.safeParse({
      type: 'route',
      id: 'route_fixed',
      strategy: 'fixed-provider',
      provider: 'openai',
      body: [{ type: 'complete', id: 'fixed_done' }],
    })
    expect(result.success).toBe(true)
  })

  it('accepts a capability route', () => {
    const result = flowNodeSchema.safeParse({
      type: 'route',
      id: 'route_capability',
      strategy: 'capability',
      tags: ['chat'],
      body: [{ type: 'complete', id: 'cap_done' }],
    })
    expect(result.success).toBe(true)
  })

  it('accepts a classify node with an explicit default choice', () => {
    const result = flowNodeSchema.safeParse({
      type: 'classify',
      id: 'classify_intent',
      prompt: 'Choose the next branch',
      choices: ['frontend', 'backend', 'infra'],
      outputKey: 'intent',
      defaultChoice: 'infra',
    })
    expect(result.success).toBe(true)
    if (result.success && result.data.type === 'classify') {
      expect(result.data.defaultChoice).toBe('infra')
    }
  })

  it('accepts optional node metadata fields', () => {
    const result = flowNodeSchema.safeParse({
      type: 'action',
      id: 'plan',
      name: 'Plan Work',
      description: 'Create the initial plan',
      meta: { source: 'dsl' },
      toolRef: 'my.tool',
      input: {},
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
    const result = flowNodeSchema.safeParse({ type: 'action', id: 'x', input: {} })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path)
      expect(paths).toContain('root.toolRef')
    }
  })

  it('rejects fixed-provider route without provider', () => {
    const result = flowNodeSchema.safeParse({
      type: 'route',
      id: 'route',
      strategy: 'fixed-provider',
      body: [{ type: 'complete', id: 'done' }],
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
      id: 'route',
      strategy: 'capability',
      tags: [],
      body: [{ type: 'complete', id: 'done' }],
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty sequence', () => {
    const result = flowNodeSchema.safeParse({ type: 'sequence', id: 'root', nodes: [] })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === 'EMPTY_BODY')).toBe(true)
    }
  })

  it('rejects classify.defaultChoice values outside classify.choices', () => {
    const result = flowNodeSchema.safeParse({
      type: 'classify',
      id: 'classify_intent',
      prompt: 'Choose the next branch',
      choices: ['frontend', 'backend'],
      outputKey: 'intent',
      defaultChoice: 'infra',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(
        result.error.issues.some((i) => (
          i.path === 'root.defaultChoice'
          && i.message.includes('must match one of classify.choices')
        )),
      ).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// flowNodeSchema.parse — throw semantics
// ---------------------------------------------------------------------------

describe('flowNodeSchema.parse', () => {
  it('returns typed node on valid input', () => {
    const node = flowNodeSchema.parse({ type: 'complete', id: 'done' })
    expect(node.type).toBe('complete')
  })

  it('throws SchemaValidationError on invalid input', () => {
    expect(() => flowNodeSchema.parse({ type: 'action', id: 'x' })).toThrow(SchemaValidationError)
  })

  it('SchemaValidationError exposes all issues', () => {
    try {
      flowNodeSchema.parse({ type: 'action', id: 'x' })
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
    const errors = validateFlowNodeShape({ type: 'complete', id: 'done' })
    expect(errors).toEqual([])
  })

  it('returns ValidationError[] on invalid AST', () => {
    const errors = validateFlowNodeShape({ type: 'action', id: 'x' })
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]!.code).toBe('MISSING_REQUIRED_FIELD')
    expect(typeof errors[0]!.nodePath).toBe('string')
  })

  it('uses custom base path', () => {
    const errors = validateFlowNodeShape({ type: 'action', id: 'x' }, 'custom.root')
    expect(errors[0]!.nodePath.startsWith('custom.root')).toBe(true)
  })
})

describe('flowDocumentSchema', () => {
  it('accepts a canonical workflow document with unique ids', () => {
    const result = flowDocumentSchema.safeParse({
      dsl: 'dzupflow/v1',
      id: 'workflow',
      version: 1,
      root: {
        type: 'sequence',
        id: 'root',
        nodes: [
          { type: 'action', id: 'plan', toolRef: 'pm.create', input: {} },
          { type: 'complete', id: 'done', result: 'ok' },
        ],
      },
    })
    expect(result.success).toBe(true)
  })

  it('accepts JSON-like input defaults', () => {
    const result = flowDocumentSchema.safeParse({
      dsl: 'dzupflow/v1',
      id: 'workflow',
      version: 1,
      inputs: {
        payload: {
          type: 'object',
          default: {
            nested: ['a', 1, true, null],
          },
        },
      },
      root: {
        type: 'sequence',
        id: 'root',
        nodes: [{ type: 'complete', id: 'done' }],
      },
    })

    expect(result.success).toBe(true)
  })

  it('rejects non-FlowValue input defaults', () => {
    const result = flowDocumentSchema.safeParse({
      dsl: 'dzupflow/v1',
      id: 'workflow',
      version: 1,
      inputs: {
        startedAt: {
          type: 'string',
          default: new Date('2026-04-23T00:00:00.000Z'),
        },
      },
      root: {
        type: 'sequence',
        id: 'root',
        nodes: [{ type: 'complete', id: 'done' }],
      },
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: 'root.inputs.startedAt.default',
            message: 'input spec.default must be a JSON-like value when present',
          }),
        ]),
      )
    }
  })

  it('rejects a document whose canonical nodes are missing ids', () => {
    const result = flowDocumentSchema.safeParse({
      dsl: 'dzupflow/v1',
      id: 'workflow',
      version: 1,
      root: {
        type: 'sequence',
        nodes: [{ type: 'complete' }],
      },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.endsWith('.id'))).toBe(true)
    }
  })

  it('rejects duplicate canonical node ids', () => {
    const errors = validateFlowDocumentShape({
      dsl: 'dzupflow/v1',
      id: 'workflow',
      version: 1,
      root: {
        type: 'sequence',
        id: 'root',
        nodes: [
          { type: 'action', id: 'duplicate', toolRef: 'pm.create', input: {} },
          { type: 'complete', id: 'duplicate' },
        ],
      },
    })
    expect(errors.some((error) => error.code === 'DUPLICATE_NODE_ID')).toBe(true)
  })
})

describe('validation extraction seams', () => {
  it('keeps node validator descriptors exhaustive with public node kinds', () => {
    expect(FLOW_NODE_VALIDATOR_DESCRIPTORS.map((descriptor) => descriptor.type).sort()).toEqual(
      [...FLOW_NODE_KINDS].sort(),
    )
    expect([...KNOWN_NODE_TYPES].sort()).toEqual([...FLOW_NODE_KINDS].sort())
  })

  it('keeps validation primitives aligned with document default semantics', () => {
    expect(isPlainObject({ ok: true })).toBe(true)
    expect(isPlainObject([])).toBe(false)
    expect(isFlowValue({ nested: ['a', 1, true, null] })).toBe(true)
    expect(isFlowValue(new Date('2026-04-30T00:00:00.000Z'))).toBe(false)
    expect(joinPath('root.nodes[0]', 'id')).toBe('root.nodes[0].id')
  })

  it('reports duplicate canonical ids through the traversal helper', () => {
    const issues: ValidationTraversalIssue[] = []
    validateCanonicalNodeIds(
      {
        type: 'sequence',
        id: 'root',
        nodes: [
          { type: 'complete', id: 'dup' },
          { type: 'complete', id: 'dup' },
        ],
      },
      'root',
      issues,
      new Map(),
    )

    expect(issues).toEqual([
      expect.objectContaining({
        path: 'root.nodes[1].id',
        code: 'DUPLICATE_NODE_ID',
        message: 'duplicate node id "dup" first seen at root.nodes[0]',
      }),
    ])
  })
})

describe('flowNodeSchema.safeParse — SetNode', () => {
  it('accepts a set node with an `assign` object', () => {
    const result = flowNodeSchema.safeParse({
      type: 'set',
      id: 's1',
      assign: { count: '{{ state.n }}', done: true },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.type).toBe('set')
    }
  })

  it('rejects a set node without `assign`', () => {
    const result = flowNodeSchema.safeParse({ type: 'set', id: 's1' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path)
      expect(paths).toContain('root.assign')
    }
  })

  it('rejects a set node when `assign` is not an object', () => {
    const result = flowNodeSchema.safeParse({ type: 'set', id: 's1', assign: 'oops' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path)
      expect(paths).toContain('root.assign')
    }
  })
})
