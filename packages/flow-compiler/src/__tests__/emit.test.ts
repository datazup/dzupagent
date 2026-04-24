import { describe, it, expect } from 'vitest'

import type { FlowNode, ResolvedTool } from '@dzupagent/flow-ast'
import { routeTarget, computeFeatureBitmask, hasOnError, FEATURE_BITS } from '../route-target.js'
import { validateShape } from '../stages/shape-validate.js'
import { semanticResolve } from '../stages/semantic.js'
import type { ToolResolver } from '@dzupagent/flow-ast'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAction(toolRef: string): FlowNode {
  return { type: 'action', id: toolRef, toolRef, input: {} }
}

function makeSkillRt(ref: string): ResolvedTool {
  return { ref, kind: 'skill', inputSchema: {}, handle: {} }
}

// ---------------------------------------------------------------------------
// routeTarget
// ---------------------------------------------------------------------------

describe('routeTarget', () => {
  it('routes to skill-chain for a sequential-only AST', () => {
    const ast: FlowNode = {
      type: 'sequence',
      nodes: [makeAction('skill:a'), makeAction('skill:b')],
    }
    const { target, bitmask } = routeTarget(ast)
    expect(target).toBe('skill-chain')
    expect(bitmask).toBe(FEATURE_BITS.SEQUENTIAL_ONLY)
  })

  it('routes to workflow-builder when branch is present', () => {
    const ast: FlowNode = {
      type: 'branch',
      condition: 'x > 0',
      then: [makeAction('skill:a')],
    }
    const { target } = routeTarget(ast)
    expect(target).toBe('workflow-builder')
  })

  it('routes to workflow-builder when parallel is present', () => {
    const ast: FlowNode = {
      type: 'parallel',
      branches: [
        [makeAction('skill:a')],
        [makeAction('skill:b')],
      ],
    }
    const { target } = routeTarget(ast)
    expect(target).toBe('workflow-builder')
  })

  it('routes to workflow-builder when approval is present', () => {
    const ast: FlowNode = {
      type: 'approval',
      question: 'Proceed?',
      onApprove: [makeAction('skill:a')],
    }
    const { target } = routeTarget(ast)
    expect(target).toBe('workflow-builder')
  })

  it('routes to workflow-builder when clarification is present', () => {
    const ast: FlowNode = { type: 'clarification', question: 'What?' }
    const { target } = routeTarget(ast)
    expect(target).toBe('workflow-builder')
  })

  it('routes to workflow-builder when persona is present', () => {
    const ast: FlowNode = {
      type: 'persona',
      personaId: 'coach',
      body: [makeAction('skill:a')],
    }
    const { target } = routeTarget(ast)
    expect(target).toBe('workflow-builder')
  })

  it('routes to workflow-builder when route node is present', () => {
    const ast: FlowNode = {
      type: 'route',
      strategy: 'capability',
      tags: ['fast'],
      body: [makeAction('skill:a')],
    }
    const { target } = routeTarget(ast)
    expect(target).toBe('workflow-builder')
  })

  it('routes to pipeline when for_each is present', () => {
    const ast: FlowNode = {
      type: 'for_each',
      source: 'items',
      as: 'item',
      body: [makeAction('skill:process')],
    }
    const { target } = routeTarget(ast)
    expect(target).toBe('pipeline')
  })

  it('for_each takes priority over branch', () => {
    const ast: FlowNode = {
      type: 'for_each',
      source: 'items',
      as: 'item',
      body: [{
        type: 'branch',
        condition: 'x',
        then: [makeAction('skill:a')],
      }],
    }
    const { target } = routeTarget(ast)
    expect(target).toBe('pipeline')
  })

  it('returns correct bitmask for branch', () => {
    const ast: FlowNode = {
      type: 'branch',
      condition: 'c',
      then: [makeAction('skill:a')],
    }
    const { bitmask } = routeTarget(ast)
    expect((bitmask & FEATURE_BITS.BRANCH) !== 0).toBe(true)
  })

  it('returns correct bitmask for parallel', () => {
    const ast: FlowNode = {
      type: 'parallel',
      branches: [[makeAction('skill:a')], [makeAction('skill:b')]],
    }
    const { bitmask } = routeTarget(ast)
    expect((bitmask & FEATURE_BITS.PARALLEL) !== 0).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// computeFeatureBitmask
// ---------------------------------------------------------------------------

describe('computeFeatureBitmask', () => {
  it('returns 0 for a pure action node', () => {
    expect(computeFeatureBitmask(makeAction('skill:a'))).toBe(0)
  })

  it('returns BRANCH bit for branch node', () => {
    const ast: FlowNode = {
      type: 'branch',
      condition: 'c',
      then: [makeAction('skill:a')],
    }
    expect(computeFeatureBitmask(ast) & FEATURE_BITS.BRANCH).toBe(FEATURE_BITS.BRANCH)
  })

  it('returns FOR_EACH bit for for_each node', () => {
    const ast: FlowNode = {
      type: 'for_each',
      source: 'items',
      as: 'item',
      body: [makeAction('skill:a')],
    }
    expect(computeFeatureBitmask(ast) & FEATURE_BITS.FOR_EACH).toBe(FEATURE_BITS.FOR_EACH)
  })

  it('ORs bits from nested structures', () => {
    const ast: FlowNode = {
      type: 'sequence',
      nodes: [
        {
          type: 'branch',
          condition: 'c',
          then: [makeAction('skill:a')],
        },
        makeAction('skill:b'),
      ],
    }
    const bits = computeFeatureBitmask(ast)
    expect((bits & FEATURE_BITS.BRANCH) !== 0).toBe(true)
  })

  it('PARALLEL bit set for parallel in sub-tree', () => {
    const ast: FlowNode = {
      type: 'sequence',
      nodes: [{
        type: 'parallel',
        branches: [[makeAction('skill:a')], [makeAction('skill:b')]],
      }],
    }
    const bits = computeFeatureBitmask(ast)
    expect((bits & FEATURE_BITS.PARALLEL) !== 0).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// hasOnError
// ---------------------------------------------------------------------------

describe('hasOnError', () => {
  it('returns false for a clean AST', () => {
    const ast: FlowNode = makeAction('skill:a')
    expect(hasOnError(ast)).toBe(false)
  })

  it('returns true when on_error is present on a node', () => {
    const ast: FlowNode & { on_error?: unknown } = {
      type: 'action',
      toolRef: 'skill:a',
      input: {},
      on_error: 'handle',
    }
    expect(hasOnError(ast)).toBe(true)
  })

  it('detects on_error in a nested sequence child', () => {
    const child: FlowNode & { on_error?: string } = {
      ...makeAction('skill:a'),
      on_error: 'handle',
    }
    const ast: FlowNode = {
      type: 'sequence',
      nodes: [child],
    }
    expect(hasOnError(ast)).toBe(true)
  })

  it('detects on_error inside branch.then', () => {
    const then: FlowNode & { on_error?: string } = {
      ...makeAction('skill:a'),
      on_error: 'retry',
    }
    const ast: FlowNode = {
      type: 'branch',
      condition: 'c',
      then: [then],
    }
    expect(hasOnError(ast)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// validateShape
// ---------------------------------------------------------------------------

describe('validateShape', () => {
  it('returns empty errors for a valid action', () => {
    const ast: FlowNode = makeAction('skill:do-work')
    const errors = validateShape(ast)
    expect(errors).toHaveLength(0)
  })

  it('emits MISSING_REQUIRED_FIELD for empty toolRef', () => {
    const ast: FlowNode = { type: 'action', toolRef: '', input: {} }
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'MISSING_REQUIRED_FIELD')).toBe(true)
  })

  it('emits MISSING_REQUIRED_FIELD when action.input is missing', () => {
    const ast: FlowNode = { type: 'action', toolRef: 'skill:a', input: undefined as unknown as Record<string, unknown> }
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'MISSING_REQUIRED_FIELD' && e.message.includes('input'))).toBe(true)
  })

  it('emits EMPTY_BODY for empty sequence', () => {
    const ast: FlowNode = { type: 'sequence', nodes: [] }
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'EMPTY_BODY')).toBe(true)
  })

  it('emits MISSING_REQUIRED_FIELD for branch with empty condition', () => {
    const ast: FlowNode = {
      type: 'branch',
      condition: '',
      then: [makeAction('skill:a')],
    }
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'MISSING_REQUIRED_FIELD')).toBe(true)
  })

  it('emits EMPTY_BODY for branch with empty then', () => {
    const ast: FlowNode = {
      type: 'branch',
      condition: 'x',
      then: [],
    }
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'EMPTY_BODY')).toBe(true)
  })

  it('emits EMPTY_BODY for empty else branch', () => {
    const ast: FlowNode = {
      type: 'branch',
      condition: 'x',
      then: [makeAction('skill:a')],
      else: [],
    }
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'EMPTY_BODY')).toBe(true)
  })

  it('emits EMPTY_BODY for for_each with empty body', () => {
    const ast: FlowNode = {
      type: 'for_each',
      source: 'items',
      as: 'item',
      body: [],
    }
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'EMPTY_BODY')).toBe(true)
  })

  it('emits MISSING_REQUIRED_FIELD for for_each with empty source', () => {
    const ast: FlowNode = {
      type: 'for_each',
      source: '',
      as: 'item',
      body: [makeAction('skill:a')],
    }
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'MISSING_REQUIRED_FIELD')).toBe(true)
  })

  it('emits MISSING_REQUIRED_FIELD for approval with empty question', () => {
    const ast: FlowNode = {
      type: 'approval',
      question: '',
      onApprove: [makeAction('skill:a')],
    }
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'MISSING_REQUIRED_FIELD')).toBe(true)
  })

  it('emits EMPTY_BODY for approval with empty onApprove', () => {
    const ast: FlowNode = {
      type: 'approval',
      question: 'ok?',
      onApprove: [],
    }
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'EMPTY_BODY')).toBe(true)
  })

  it('emits error when clarification expected=choice but no choices', () => {
    const ast: FlowNode = {
      type: 'clarification',
      question: 'Pick one',
      expected: 'choice',
      choices: [],
    }
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'MISSING_REQUIRED_FIELD')).toBe(true)
  })

  it('emits error for route fixed-provider without provider', () => {
    const ast: FlowNode = {
      type: 'route',
      strategy: 'fixed-provider',
      body: [makeAction('skill:a')],
    }
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'MISSING_REQUIRED_FIELD')).toBe(true)
  })

  it('emits error for route capability without tags', () => {
    const ast: FlowNode = {
      type: 'route',
      strategy: 'capability',
      body: [makeAction('skill:a')],
    }
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'MISSING_REQUIRED_FIELD')).toBe(true)
  })

  it('OI-4: emits error for on_error in skill-chain-routed flow', () => {
    const ast: FlowNode & { on_error?: string } = {
      type: 'action',
      toolRef: 'skill:a',
      input: {},
      on_error: 'retry',
    }
    const errors = validateShape(ast)
    expect(errors.some((e) => e.code === 'MISSING_REQUIRED_FIELD' && e.message.includes('on_error'))).toBe(true)
  })

  it('does NOT emit OI-4 error for on_error in pipeline-routed flow', () => {
    const ast: FlowNode = {
      type: 'for_each',
      source: 'items',
      as: 'item',
      body: [makeAction('skill:a')],
    }
    const errors = validateShape(ast)
    // No OI-4 error expected for pipeline target
    expect(errors.every((e) => !e.message.includes('on_error'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// semanticResolve
// ---------------------------------------------------------------------------

function makeResolver(available: string[]): ToolResolver {
  const map = new Map<string, ResolvedTool>()
  for (const ref of available) {
    map.set(ref, makeSkillRt(ref))
  }
  return {
    resolve(ref: string) { return map.get(ref) ?? null },
    listAvailable() { return available },
  }
}

describe('semanticResolve', () => {
  it('resolves a valid action node', async () => {
    const resolver = makeResolver(['skill:work'])
    const ast: FlowNode = makeAction('skill:work')
    const result = await semanticResolve(ast, { toolResolver: resolver })
    expect(result.errors).toHaveLength(0)
    expect(result.resolved.size).toBe(1)
  })

  it('emits UNRESOLVED_TOOL_REF for missing ref', async () => {
    const resolver = makeResolver([])
    const ast: FlowNode = makeAction('skill:missing')
    const result = await semanticResolve(ast, { toolResolver: resolver })
    expect(result.errors.some((e) => e.code === 'UNRESOLVED_TOOL_REF')).toBe(true)
  })

  it('provides did-you-mean suggestion for close miss', async () => {
    const resolver = makeResolver(['skill:dostuff'])
    const ast: FlowNode = makeAction('skill:dostuf') // typo
    const result = await semanticResolve(ast, { toolResolver: resolver })
    const err = result.errors[0]
    expect(err?.message).toContain('Did you mean')
    expect(err?.message).toContain('"skill:dostuff"')
  })

  it('emits UNRESOLVED_PERSONA_REF when no personaResolver is provided', async () => {
    const resolver = makeResolver(['skill:a'])
    const ast: FlowNode = makeAction('skill:a')
    ;(ast as FlowNode & { personaRef?: string }).personaRef = 'coach'
    const action = ast as typeof ast & { personaRef?: string }
    action.personaRef = 'coach'

    const ast2: FlowNode = {
      type: 'persona',
      personaId: 'coach',
      body: [makeAction('skill:a')],
    }
    const result = await semanticResolve(ast2, { toolResolver: resolver })
    // No persona resolver → UNRESOLVED_PERSONA_REF
    expect(result.errors.some((e) => e.code === 'UNRESOLVED_PERSONA_REF')).toBe(true)
  })

  it('emits RESOLVER_INFRA_ERROR when resolver throws', async () => {
    const resolver: ToolResolver = {
      resolve() { throw new Error('DB offline') },
      listAvailable() { return [] },
    }
    const ast: FlowNode = makeAction('skill:a')
    const result = await semanticResolve(ast, { toolResolver: resolver })
    expect(result.errors.some((e) => e.code === 'RESOLVER_INFRA_ERROR')).toBe(true)
    expect(result.errors[0]?.message).toContain('DB offline')
  })

  it('resolves all action nodes in a sequence', async () => {
    const resolver = makeResolver(['skill:a', 'skill:b'])
    const ast: FlowNode = {
      type: 'sequence',
      nodes: [makeAction('skill:a'), makeAction('skill:b')],
    }
    const result = await semanticResolve(ast, { toolResolver: resolver })
    expect(result.errors).toHaveLength(0)
    expect(result.resolved.size).toBe(2)
  })

  it('aggregates multiple unresolved refs instead of stopping at first', async () => {
    const resolver = makeResolver([])
    const ast: FlowNode = {
      type: 'sequence',
      nodes: [makeAction('skill:a'), makeAction('skill:b')],
    }
    const result = await semanticResolve(ast, { toolResolver: resolver })
    expect(result.errors.length).toBe(2)
  })
})
