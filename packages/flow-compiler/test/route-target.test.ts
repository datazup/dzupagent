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

import {
  computeFeatureBitmask,
  FEATURE_BITS,
  hasOnError,
  routeTarget,
} from '../src/route-target.js'

// ---------------------------------------------------------------------------
// Fixtures — minimal hand-built ASTs (no parser; STAGE 1 hasn't run yet).
// ---------------------------------------------------------------------------

const action = (toolRef = 'tool.noop'): ActionNode => ({
  type: 'action',
  toolRef,
  input: {},
})

const sequence = (...nodes: FlowNode[]): SequenceNode => ({
  type: 'sequence',
  nodes,
})

const branch = (
  thenNodes: FlowNode[],
  elseNodes?: FlowNode[],
): BranchNode => ({
  type: 'branch',
  condition: 'x == 1',
  then: thenNodes,
  ...(elseNodes ? { else: elseNodes } : {}),
})

const parallel = (...branches: FlowNode[][]): ParallelNode => ({
  type: 'parallel',
  branches,
})

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

const clarification = (): ClarificationNode => ({
  type: 'clarification',
  question: 'Which option?',
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
// D2 routing matrix — one assertion per row.
// ---------------------------------------------------------------------------

describe('routeTarget — D2 routing matrix', () => {
  it('routes a flat sequence of actions to skill-chain', () => {
    const ast = sequence(action('a'), action('b'))
    const result = routeTarget(ast)
    expect(result.target).toBe('skill-chain')
    expect(result.bitmask).toBe(FEATURE_BITS.SEQUENTIAL_ONLY)
  })

  it('routes a top-level action (no sequence wrapper) to skill-chain', () => {
    const ast = action('only')
    const result = routeTarget(ast)
    expect(result.target).toBe('skill-chain')
    expect(result.bitmask).toBe(FEATURE_BITS.SEQUENTIAL_ONLY)
  })

  it('routes an AST containing a branch to workflow-builder', () => {
    const ast = sequence(action('pre'), branch([action('t')], [action('e')]))
    const result = routeTarget(ast)
    expect(result.target).toBe('workflow-builder')
    expect(result.bitmask & FEATURE_BITS.BRANCH).toBe(FEATURE_BITS.BRANCH)
  })

  it('routes an AST containing a parallel to workflow-builder', () => {
    const ast = sequence(parallel([action('a')], [action('b')]))
    const result = routeTarget(ast)
    expect(result.target).toBe('workflow-builder')
    expect(result.bitmask & FEATURE_BITS.PARALLEL).toBe(FEATURE_BITS.PARALLEL)
  })

  it('routes an AST containing an approval to workflow-builder', () => {
    const ast = sequence(approval(action('next')))
    const result = routeTarget(ast)
    expect(result.target).toBe('workflow-builder')
    expect(result.bitmask & FEATURE_BITS.SUSPEND).toBe(FEATURE_BITS.SUSPEND)
  })

  it('routes an AST containing a clarification to workflow-builder', () => {
    const ast = sequence(clarification(), action('next'))
    const result = routeTarget(ast)
    expect(result.target).toBe('workflow-builder')
    expect(result.bitmask & FEATURE_BITS.SUSPEND).toBe(FEATURE_BITS.SUSPEND)
  })

  it('routes an AST containing a persona to workflow-builder', () => {
    const ast = persona(action('inside'))
    const result = routeTarget(ast)
    expect(result.target).toBe('workflow-builder')
    expect(result.bitmask & FEATURE_BITS.SUSPEND).toBe(FEATURE_BITS.SUSPEND)
  })

  it('routes an AST containing a route to workflow-builder', () => {
    const ast = route(action('inside'))
    const result = routeTarget(ast)
    expect(result.target).toBe('workflow-builder')
    expect(result.bitmask & FEATURE_BITS.SUSPEND).toBe(FEATURE_BITS.SUSPEND)
  })

  it('routes an AST containing a for_each to pipeline', () => {
    const ast = forEach(action('per-item'))
    const result = routeTarget(ast)
    expect(result.target).toBe('pipeline')
    expect(result.bitmask & FEATURE_BITS.FOR_EACH).toBe(FEATURE_BITS.FOR_EACH)
  })

  it('escalates to pipeline when both branch and for_each are present', () => {
    const ast = sequence(branch([action('t')]), forEach(action('p')))
    const result = routeTarget(ast)
    expect(result.target).toBe('pipeline')
    // Both bits must be set — pipeline trumps workflow-builder.
    expect(result.bitmask & FEATURE_BITS.BRANCH).toBe(FEATURE_BITS.BRANCH)
    expect(result.bitmask & FEATURE_BITS.FOR_EACH).toBe(FEATURE_BITS.FOR_EACH)
  })

  it('escalates to pipeline when for_each is nested inside a branch.then', () => {
    const ast = branch([forEach(action('p'))])
    const result = routeTarget(ast)
    expect(result.target).toBe('pipeline')
    expect(result.bitmask & FEATURE_BITS.BRANCH).toBe(FEATURE_BITS.BRANCH)
    expect(result.bitmask & FEATURE_BITS.FOR_EACH).toBe(FEATURE_BITS.FOR_EACH)
  })
})

// ---------------------------------------------------------------------------
// Per-bit isolation — ensures each FEATURE_BITS constant is set independently.
// ---------------------------------------------------------------------------

describe('computeFeatureBitmask — per-bit isolation', () => {
  it('sets exactly BRANCH for a lone branch', () => {
    expect(computeFeatureBitmask(branch([action('t')]))).toBe(FEATURE_BITS.BRANCH)
  })

  it('sets exactly PARALLEL for a lone parallel', () => {
    expect(computeFeatureBitmask(parallel([action('a')]))).toBe(
      FEATURE_BITS.PARALLEL,
    )
  })

  it('sets exactly SUSPEND for a lone clarification', () => {
    expect(computeFeatureBitmask(clarification())).toBe(FEATURE_BITS.SUSPEND)
  })

  it('sets exactly SUSPEND for a lone approval', () => {
    expect(computeFeatureBitmask(approval(action('n')))).toBe(
      FEATURE_BITS.SUSPEND,
    )
  })

  it('sets exactly SUSPEND for a lone persona', () => {
    expect(computeFeatureBitmask(persona(action('n')))).toBe(
      FEATURE_BITS.SUSPEND,
    )
  })

  it('sets exactly SUSPEND for a lone route', () => {
    expect(computeFeatureBitmask(route(action('n')))).toBe(FEATURE_BITS.SUSPEND)
  })

  it('sets exactly FOR_EACH for a lone for_each', () => {
    expect(computeFeatureBitmask(forEach(action('p')))).toBe(
      FEATURE_BITS.FOR_EACH,
    )
  })

  it('returns SEQUENTIAL_ONLY (0) for a flat action', () => {
    expect(computeFeatureBitmask(action('a'))).toBe(FEATURE_BITS.SEQUENTIAL_ONLY)
  })

  it('OR-s multiple bits when several feature kinds coexist', () => {
    const ast = sequence(branch([action('t')]), parallel([action('a')]), forEach(action('p')))
    const expected = FEATURE_BITS.BRANCH | FEATURE_BITS.PARALLEL | FEATURE_BITS.FOR_EACH
    expect(computeFeatureBitmask(ast)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// hasOnError — STAGE 2 OI-4 + STAGE 4 backstop.
// ---------------------------------------------------------------------------

describe('hasOnError', () => {
  it('returns false when no node carries an on_error field', () => {
    const ast = sequence(action('a'), action('b'))
    expect(hasOnError(ast)).toBe(false)
  })

  it('returns true when a top-level action carries on_error (skill-chain rejection path)', () => {
    // Skill-chain-routed flow with on_error — STAGE 2 / STAGE 4 reject this.
    const tainted = { ...action('a'), on_error: 'continue' } as unknown as FlowNode
    const ast = sequence(tainted, action('b'))
    expect(routeTarget(ast).target).toBe('skill-chain')
    expect(hasOnError(ast)).toBe(true)
  })

  it('returns true when a deeply nested node carries on_error', () => {
    const tainted = { ...action('p'), on_error: 'retry' } as unknown as FlowNode
    const ast = branch([forEach(tainted)])
    expect(hasOnError(ast)).toBe(true)
  })

  it('returns true when on_error is on a non-leaf (branch) node', () => {
    const taintedBranch = {
      ...branch([action('t')]),
      on_error: 'continue',
    } as unknown as FlowNode
    expect(hasOnError(taintedBranch)).toBe(true)
  })

  it('returns false for a clean pipeline-target AST', () => {
    const ast = sequence(branch([action('t')]), forEach(action('p')))
    expect(hasOnError(ast)).toBe(false)
  })
})
