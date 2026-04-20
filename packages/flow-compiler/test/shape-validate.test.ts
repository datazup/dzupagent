import type {
  ActionNode,
  ApprovalNode,
  BranchNode,
  ClarificationNode,
  FlowNode,
  ForEachNode,
  ParallelNode,
  PersonaNode,
  RouteNode,
  SequenceNode,
} from '@dzupagent/flow-ast'
import { describe, expect, it } from 'vitest'

import { validateShape } from '../src/stages/shape-validate.js'

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const action = (toolRef = 'tool.noop'): ActionNode => ({
  type: 'action',
  toolRef,
  input: {},
})

const sequence = (...nodes: FlowNode[]): SequenceNode => ({ type: 'sequence', nodes })

const branch = (thenNodes: FlowNode[], elseNodes?: FlowNode[]): BranchNode => ({
  type: 'branch',
  condition: 'x == 1',
  then: thenNodes,
  ...(elseNodes ? { else: elseNodes } : {}),
})

const parallel = (...branches: FlowNode[][]): ParallelNode => ({ type: 'parallel', branches })

const forEach = (...body: FlowNode[]): ForEachNode => ({
  type: 'for_each',
  source: 'items',
  as: 'item',
  body,
})

const approval = (...onApprove: FlowNode[]): ApprovalNode => ({
  type: 'approval',
  question: 'Proceed?',
  onApprove,
})

const clarification = (
  expected?: 'text' | 'choice',
  choices?: string[],
): ClarificationNode => ({
  type: 'clarification',
  question: 'Which option?',
  ...(expected !== undefined ? { expected } : {}),
  ...(choices !== undefined ? { choices } : {}),
})

const persona = (...body: FlowNode[]): PersonaNode => ({
  type: 'persona',
  personaId: 'reviewer',
  body,
})

const route = (...body: FlowNode[]): RouteNode => ({
  type: 'route',
  strategy: 'capability',
  tags: ['summarize'],
  body,
})

// ---------------------------------------------------------------------------
// R1 — EMPTY_BODY
// ---------------------------------------------------------------------------

describe('validateShape — R1 EMPTY_BODY', () => {
  it('rejects an empty sequence', () => {
    const errors = validateShape(sequence())
    expect(errors).toHaveLength(1)
    expect(errors[0]?.code).toBe('EMPTY_BODY')
    expect(errors[0]?.nodeType).toBe('sequence')
    expect(errors[0]?.nodePath).toBe('root')
  })

  it('rejects a branch with empty then', () => {
    const ast = branch([])
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'EMPTY_BODY' && e.nodeType === 'branch')).toBe(true)
  })

  it('rejects a branch with empty else (when else is present)', () => {
    const ast = branch([action('a')], [])
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'EMPTY_BODY' && /else/.test(e.message))).toBe(true)
  })

  it('rejects a parallel with no branches', () => {
    const ast = parallel()
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'EMPTY_BODY' && e.nodeType === 'parallel')).toBe(true)
  })

  it('rejects a parallel with one empty inner branch', () => {
    const ast = parallel([action('a')], [])
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'EMPTY_BODY' && /branches\[1\]/.test(e.nodePath))).toBe(true)
  })

  it('rejects a for_each with empty body', () => {
    const ast = forEach()
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'EMPTY_BODY' && e.nodeType === 'for_each')).toBe(true)
  })

  it('rejects a persona with empty body', () => {
    const ast = persona()
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'EMPTY_BODY' && e.nodeType === 'persona')).toBe(true)
  })

  it('rejects a route with empty body', () => {
    const ast = route()
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'EMPTY_BODY' && e.nodeType === 'route')).toBe(true)
  })

  it('rejects an approval with empty onApprove', () => {
    const ast = approval()
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'EMPTY_BODY' && e.nodeType === 'approval')).toBe(true)
  })

  it('rejects an approval with explicit empty onReject', () => {
    const ast: ApprovalNode = { type: 'approval', question: 'go?', onApprove: [action('a')], onReject: [] }
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'EMPTY_BODY' && /onReject/.test(e.message))).toBe(true)
  })

  it('accepts a non-empty sequence', () => {
    expect(validateShape(sequence(action('a')))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// R2 — MISSING_REQUIRED_FIELD
// ---------------------------------------------------------------------------

describe('validateShape — R2 MISSING_REQUIRED_FIELD', () => {
  it('rejects an action missing toolRef', () => {
    const ast = { type: 'action', input: {} } as unknown as FlowNode
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'MISSING_REQUIRED_FIELD' && /toolRef/.test(e.message))).toBe(true)
  })

  it('rejects an action with empty toolRef', () => {
    const ast = action('')
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'MISSING_REQUIRED_FIELD' && /toolRef/.test(e.message))).toBe(true)
  })

  it('rejects an action missing input (not an object)', () => {
    const ast = { type: 'action', toolRef: 't', input: null } as unknown as FlowNode
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'MISSING_REQUIRED_FIELD' && /input/.test(e.message))).toBe(true)
  })

  it('accepts an action with empty input object', () => {
    expect(validateShape(action('t'))).toEqual([])
  })

  it('rejects a for_each missing as', () => {
    const ast = { type: 'for_each', source: 'items', as: '', body: [action('a')] } as unknown as FlowNode
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'MISSING_REQUIRED_FIELD' && /\.as/.test(e.message))).toBe(true)
  })

  it('rejects a for_each missing source', () => {
    const ast = { type: 'for_each', source: '', as: 'x', body: [action('a')] } as unknown as FlowNode
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'MISSING_REQUIRED_FIELD' && /source/.test(e.message))).toBe(true)
  })

  it('rejects a branch with empty condition', () => {
    const ast = { type: 'branch', condition: '', then: [action('a')] } as unknown as FlowNode
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'MISSING_REQUIRED_FIELD' && /condition/.test(e.message))).toBe(true)
  })

  it('rejects an approval with empty question', () => {
    const ast = { type: 'approval', question: '', onApprove: [action('a')] } as unknown as FlowNode
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'MISSING_REQUIRED_FIELD' && /question/.test(e.message))).toBe(true)
  })

  it("rejects a clarification with expected='choice' and no choices", () => {
    const ast = clarification('choice')
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'MISSING_REQUIRED_FIELD' && /choices/.test(e.message))).toBe(true)
  })

  it("accepts a clarification with expected='choice' and choices populated", () => {
    expect(validateShape(clarification('choice', ['a', 'b']))).toEqual([])
  })

  it("accepts a clarification with expected='text'", () => {
    expect(validateShape(clarification('text'))).toEqual([])
  })

  it('rejects a persona missing personaId', () => {
    const ast = { type: 'persona', personaId: '', body: [action('a')] } as unknown as FlowNode
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'MISSING_REQUIRED_FIELD' && /personaId/.test(e.message))).toBe(true)
  })

  it("rejects a route with strategy='fixed-provider' and no provider", () => {
    const ast = {
      type: 'route',
      strategy: 'fixed-provider',
      body: [action('a')],
    } as unknown as FlowNode
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'MISSING_REQUIRED_FIELD' && /provider/.test(e.message))).toBe(true)
  })

  it("accepts a route with strategy='fixed-provider' and provider populated", () => {
    const ast: RouteNode = {
      type: 'route',
      strategy: 'fixed-provider',
      provider: 'openai',
      body: [action('a')],
    }
    expect(validateShape(ast)).toEqual([])
  })

  it("rejects a route with strategy='capability' and empty tags", () => {
    const ast: RouteNode = { type: 'route', strategy: 'capability', tags: [], body: [action('a')] }
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'MISSING_REQUIRED_FIELD' && /tags/.test(e.message))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// R3 — INVALID_CONDITION (deferred)
// ---------------------------------------------------------------------------

describe('validateShape — R3 INVALID_CONDITION (deferred)', () => {
  it('never emits INVALID_CONDITION from STAGE 2', () => {
    const ast = sequence(branch([action('a')], [action('b')]))
    const errors = validateShape(ast)
    expect(errors.find((e) => e.code === 'INVALID_CONDITION')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// R4 — OI-4 on_error legality
// ---------------------------------------------------------------------------

describe('validateShape — R4 OI-4 on_error', () => {
  it('rejects on_error in a skill-chain-targeted (sequence-only) AST', () => {
    const tainted = { ...action('a'), on_error: 'continue' } as unknown as FlowNode
    const ast = sequence(tainted, action('b'))
    const errors = validateShape(ast)
    const oi4 = errors.filter((e) => e.message.includes('on_error'))
    expect(oi4).toHaveLength(1)
    expect(oi4[0]?.code).toBe('MISSING_REQUIRED_FIELD')
    expect(oi4[0]?.nodePath).toBe('root.nodes[0]')
  })

  it('accepts on_error in a workflow-builder-targeted AST (branch present)', () => {
    const tainted = { ...action('a'), on_error: 'continue' } as unknown as FlowNode
    const ast = sequence(branch([action('t')]), tainted)
    const errors = validateShape(ast)
    expect(errors.find((e) => e.message.includes('on_error'))).toBeUndefined()
  })

  it('accepts on_error in a pipeline-targeted AST (for_each present)', () => {
    const tainted = { ...action('p'), on_error: 'retry' } as unknown as FlowNode
    const ast = sequence(forEach(action('inner')), tainted)
    const errors = validateShape(ast)
    expect(errors.find((e) => e.message.includes('on_error'))).toBeUndefined()
  })

  it('detects on_error on deeply nested nodes within a skill-chain AST', () => {
    const tainted = { ...action('inner'), on_error: 'continue' } as unknown as FlowNode
    const ast = sequence(action('a'), sequence(tainted))
    const errors = validateShape(ast)
    const oi4 = errors.filter((e) => e.message.includes('on_error'))
    expect(oi4).toHaveLength(1)
    expect(oi4[0]?.nodePath).toBe('root.nodes[1].nodes[0]')
  })
})

// ---------------------------------------------------------------------------
// Aggregation — all defects reported, in document order.
// ---------------------------------------------------------------------------

describe('validateShape — aggregation', () => {
  it('returns three errors in document order for an AST with three independent defects', () => {
    // Defects (skill-chain-targeted so OI-4 is moot):
    //   1. action missing toolRef         -> root.nodes[0]
    //   2. for_each missing as            -> root.nodes[1]   [also empty body suppressed by adding body]
    //   3. action with empty toolRef      -> root.nodes[2]
    const bad1 = { type: 'action', input: {} } as unknown as FlowNode
    const bad2 = { type: 'for_each', source: 'items', as: '', body: [action('inner')] } as unknown as FlowNode
    const bad3 = action('')
    const ast = sequence(bad1, bad2, bad3)
    const errors = validateShape(ast)
    expect(errors).toHaveLength(3)
    expect(errors[0]?.nodePath).toBe('root.nodes[0]')
    expect(errors[1]?.nodePath).toBe('root.nodes[1]')
    expect(errors[2]?.nodePath).toBe('root.nodes[2]')
    for (const e of errors) {
      expect(e.code).toBe('MISSING_REQUIRED_FIELD')
    }
  })
})

// ---------------------------------------------------------------------------
// Clean fixtures — STAGE 1's golden flows produce zero shape errors.
// We hand-build representative ASTs locally rather than coupling to STAGE 1's
// test directory (parser fixtures live under flow-ast and may move).
// ---------------------------------------------------------------------------

describe('validateShape — clean fixtures', () => {
  it('simple-sequence: clean', () => {
    const ast = sequence(action('a'), action('b'), action('c'))
    expect(validateShape(ast)).toEqual([])
  })

  it('branch-with-parallel: clean', () => {
    const ast = sequence(
      branch(
        [parallel([action('p1')], [action('p2')])],
        [action('fallback')],
      ),
    )
    expect(validateShape(ast)).toEqual([])
  })

  it('for-each-with-action: clean', () => {
    const ast = forEach(action('per-item'))
    // Allowed to carry on_error since for_each routes to pipeline.
    const tainted = { ...action('p'), on_error: 'retry' } as unknown as FlowNode
    expect(validateShape(ast)).toEqual([])
    expect(validateShape(forEach(tainted))).toEqual([])
  })

  it('approval-flow: clean', () => {
    const ast = approval(action('next'))
    expect(validateShape(ast)).toEqual([])
  })

  it('persona-route-clarification mix: clean', () => {
    const ast = sequence(
      persona(action('inside')),
      route(action('inside')),
      clarification('choice', ['a', 'b']),
    )
    expect(validateShape(ast)).toEqual([])
  })
})
