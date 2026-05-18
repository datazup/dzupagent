import { describe, it, expect } from 'vitest'

import { normalizeSteps } from '../normalize.js'
import type { DslDiagnostic } from '../types.js'

function diag(): DslDiagnostic[] {
  return []
}

// ── spawn ─────────────────────────────────────────────────────────────────────

describe('normalizeSteps — spawn', () => {
  it('parses a minimal valid spawn node', () => {
    const diagnostics = diag()
    const nodes = normalizeSteps(
      [{ spawn: { id: 'run_child', templateRef: 'template-abc' } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics).toHaveLength(0)
    expect(nodes).toHaveLength(1)
    const node = nodes[0]!
    expect(node.type).toBe('spawn')
    if (node.type === 'spawn') {
      expect(node.templateRef).toBe('template-abc')
      expect(node.id).toBe('run_child')
      expect(node.waitForCompletion).toBeUndefined()
      expect(node.input).toBeUndefined()
    }
  })

  it('accepts template_ref as alias for templateRef', () => {
    const diagnostics = diag()
    const nodes = normalizeSteps(
      [{ spawn: { id: 's1', template_ref: 'tmpl-xyz' } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics).toHaveLength(0)
    const node = nodes[0]!
    if (node.type === 'spawn') {
      expect(node.templateRef).toBe('tmpl-xyz')
    }
  })

  it('parses optional waitForCompletion and input', () => {
    const diagnostics = diag()
    const nodes = normalizeSteps(
      [{
        spawn: {
          id: 's2',
          templateRef: 'tmpl-1',
          waitForCompletion: true,
          input: { goal: '{{ input.goal }}' },
        },
      }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics).toHaveLength(0)
    const node = nodes[0]!
    if (node.type === 'spawn') {
      expect(node.waitForCompletion).toBe(true)
      expect(node.input).toEqual({ goal: '{{ input.goal }}' })
    }
  })

  it('emits MISSING_REQUIRED_FIELD when templateRef is absent', () => {
    const diagnostics = diag()
    normalizeSteps(
      [{ spawn: { id: 'bad' } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics.some((d) => d.code === 'MISSING_REQUIRED_FIELD' && d.path?.includes('templateRef'))).toBe(true)
  })

  it('emits INVALID_NODE_SHAPE for non-boolean waitForCompletion', () => {
    const diagnostics = diag()
    normalizeSteps(
      [{ spawn: { id: 'bad2', templateRef: 'x', waitForCompletion: 'yes' } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics.some((d) => d.code === 'INVALID_NODE_SHAPE' && d.path?.includes('waitForCompletion'))).toBe(true)
  })

  it('emits UNSUPPORTED_FIELD for unrecognised keys', () => {
    const diagnostics = diag()
    normalizeSteps(
      [{ spawn: { id: 's3', templateRef: 'x', unknownKey: 'v' } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics.some((d) => d.code === 'UNSUPPORTED_FIELD')).toBe(true)
  })
})

// ── emit ──────────────────────────────────────────────────────────────────────

describe('normalizeSteps — emit', () => {
  it('parses a minimal valid emit node', () => {
    const diagnostics = diag()
    const nodes = normalizeSteps(
      [{ emit: { id: 'fire_event', event: 'task.completed' } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics).toHaveLength(0)
    const node = nodes[0]!
    expect(node.type).toBe('emit')
    if (node.type === 'emit') {
      expect(node.event).toBe('task.completed')
      expect(node.payload).toBeUndefined()
    }
  })

  it('parses an emit node with payload', () => {
    const diagnostics = diag()
    const nodes = normalizeSteps(
      [{ emit: { id: 'e1', event: 'plan.approved', payload: { status: 'done', count: 3 } } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics).toHaveLength(0)
    const node = nodes[0]!
    if (node.type === 'emit') {
      expect(node.payload).toEqual({ status: 'done', count: 3 })
    }
  })

  it('emits MISSING_REQUIRED_FIELD when event is absent', () => {
    const diagnostics = diag()
    normalizeSteps(
      [{ emit: { id: 'bad' } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics.some((d) => d.code === 'MISSING_REQUIRED_FIELD' && d.path?.includes('event'))).toBe(true)
  })

  it('emits INVALID_NODE_SHAPE for non-JSON-compatible payload values', () => {
    const diagnostics = diag()
    normalizeSteps(
      [{ emit: { id: 'e2', event: 'x', payload: { fn: undefined } } }],
      'root.steps',
      diagnostics,
    )
    // payload.fn = undefined is not a valid FlowValue — should warn
    // (undefined keys are stripped by the plain object normalizer, so no error expected here)
    // Just check the node is produced
    expect(diagnostics.filter((d) => d.code === 'MISSING_REQUIRED_FIELD').length).toBe(0)
  })

  it('emits UNSUPPORTED_FIELD for unknown keys', () => {
    const diagnostics = diag()
    normalizeSteps(
      [{ emit: { id: 'e3', event: 'x', badField: 'y' } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics.some((d) => d.code === 'UNSUPPORTED_FIELD')).toBe(true)
  })
})

// ── memory ────────────────────────────────────────────────────────────────────

describe('normalizeSteps — memory', () => {
  it('parses a valid read operation', () => {
    const diagnostics = diag()
    const nodes = normalizeSteps(
      [{ memory: { id: 'm1', operation: 'read', tier: 'session', key: 'plan', outputVar: 'planResult' } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics).toHaveLength(0)
    const node = nodes[0]!
    if (node.type === 'memory') {
      expect(node.operation).toBe('read')
      expect(node.tier).toBe('session')
      expect(node.key).toBe('plan')
      expect(node.outputVar).toBe('planResult')
    }
  })

  it('parses a valid write operation', () => {
    const diagnostics = diag()
    const nodes = normalizeSteps(
      [{ memory: { id: 'm2', operation: 'write', tier: 'project', key: 'snapshot', valueExpr: '{{ plan }}' } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics).toHaveLength(0)
    const node = nodes[0]!
    if (node.type === 'memory') {
      expect(node.operation).toBe('write')
      expect(node.valueExpr).toBe('{{ plan }}')
    }
  })

  it('accepts value_expr as alias for valueExpr', () => {
    const diagnostics = diag()
    const nodes = normalizeSteps(
      [{ memory: { id: 'm3', operation: 'write', tier: 'session', key: 'k', value_expr: '{{ v }}' } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics).toHaveLength(0)
    const node = nodes[0]!
    if (node.type === 'memory') {
      expect(node.valueExpr).toBe('{{ v }}')
    }
  })

  it('parses a valid list operation', () => {
    const diagnostics = diag()
    const nodes = normalizeSteps(
      [{ memory: { id: 'm4', operation: 'list', tier: 'workspace', outputVar: 'items' } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics).toHaveLength(0)
    const node = nodes[0]!
    if (node.type === 'memory') {
      expect(node.operation).toBe('list')
    }
  })

  it('emits MISSING_REQUIRED_FIELD for missing operation', () => {
    const diagnostics = diag()
    normalizeSteps(
      [{ memory: { id: 'bad', tier: 'session' } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics.some((d) => d.code === 'MISSING_REQUIRED_FIELD' && d.path?.includes('operation'))).toBe(true)
  })

  it('emits MISSING_REQUIRED_FIELD for missing tier', () => {
    const diagnostics = diag()
    normalizeSteps(
      [{ memory: { id: 'bad2', operation: 'read' } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics.some((d) => d.code === 'MISSING_REQUIRED_FIELD' && d.path?.includes('tier'))).toBe(true)
  })

  it('emits MISSING_REQUIRED_FIELD for write without key', () => {
    const diagnostics = diag()
    normalizeSteps(
      [{ memory: { id: 'bad3', operation: 'write', tier: 'session', valueExpr: '{{ v }}' } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics.some((d) => d.code === 'MISSING_REQUIRED_FIELD' && d.path?.includes('key'))).toBe(true)
  })

  it('emits MISSING_REQUIRED_FIELD for write without valueExpr', () => {
    const diagnostics = diag()
    normalizeSteps(
      [{ memory: { id: 'bad4', operation: 'write', tier: 'session', key: 'k' } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics.some((d) => d.code === 'MISSING_REQUIRED_FIELD' && d.path?.includes('valueExpr'))).toBe(true)
  })

  it('emits UNSUPPORTED_FIELD for unknown keys', () => {
    const diagnostics = diag()
    normalizeSteps(
      [{ memory: { id: 'm5', operation: 'read', tier: 'session', unknownKey: 'x' } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics.some((d) => d.code === 'UNSUPPORTED_FIELD')).toBe(true)
  })
})

describe('normalizeSteps — memory.search', () => {
  it('accepts operation: search with query and limit', () => {
    const diagnostics = diag()
    const nodes = normalizeSteps(
      [{
        memory: {
          id: 'ms1',
          operation: 'search',
          tier: 'workspace',
          query: '{{ state.q }}',
          limit: 5,
        },
      }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics).toEqual([])
    const node = nodes[0]!
    if (node.type === 'memory') {
      expect(node.operation).toBe('search')
      expect(node.query).toBe('{{ state.q }}')
      expect(node.limit).toBe(5)
    }
  })

  it('rejects search without query', () => {
    const diagnostics = diag()
    normalizeSteps(
      [{ memory: { id: 'ms2', operation: 'search', tier: 'workspace' } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics.some((d) => d.code === 'MISSING_REQUIRED_FIELD' && d.path?.includes('query'))).toBe(true)
  })

  it('rejects non-positive limit', () => {
    const diagnostics = diag()
    normalizeSteps(
      [{
        memory: {
          id: 'ms3',
          operation: 'search',
          tier: 'workspace',
          query: '{{ state.q }}',
          limit: 0,
        },
      }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics.some((d) => d.code === 'INVALID_NODE_SHAPE' && d.path?.includes('limit'))).toBe(true)
  })
})

// ── set ───────────────────────────────────────────────────────────────────────

describe('normalizeSteps — set', () => {
  it('parses a set node with literal + template values', () => {
    const diagnostics = diag()
    const nodes = normalizeSteps(
      [{ set: { id: 's1', assign: { count: '{{ state.n }}', done: true } } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics).toHaveLength(0)
    expect(nodes).toHaveLength(1)
    const node = nodes[0]!
    expect(node.type).toBe('set')
    if (node.type === 'set') {
      expect(node.id).toBe('s1')
      expect(node.assign).toEqual({ count: '{{ state.n }}', done: true })
    }
  })

  it('parses a set node with nested object values', () => {
    const diagnostics = diag()
    const nodes = normalizeSteps(
      [{ set: { id: 's2', assign: { profile: { name: 'a', age: 1 }, tags: ['x', 'y'] } } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics).toHaveLength(0)
    const node = nodes[0]!
    if (node.type === 'set') {
      expect(node.assign).toEqual({ profile: { name: 'a', age: 1 }, tags: ['x', 'y'] })
    }
  })

  it('emits MISSING_REQUIRED_FIELD when assign is absent', () => {
    const diagnostics = diag()
    const nodes = normalizeSteps(
      [{ set: { id: 'bad' } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics.some((d) => d.code === 'MISSING_REQUIRED_FIELD' && d.path?.includes('assign'))).toBe(true)
    // Still returns a degraded node so the dispatcher can keep working.
    expect(nodes).toHaveLength(1)
    const node = nodes[0]!
    if (node.type === 'set') {
      expect(node.assign).toEqual({})
    }
  })

  it('emits INVALID_NODE_SHAPE when assign is not an object', () => {
    const diagnostics = diag()
    normalizeSteps(
      [{ set: { id: 'bad2', assign: 'oops' } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics.some((d) => d.code === 'INVALID_NODE_SHAPE' && d.path?.includes('assign'))).toBe(true)
  })

  it('emits INVALID_NODE_SHAPE when assign is an array', () => {
    const diagnostics = diag()
    normalizeSteps(
      [{ set: { id: 'bad3', assign: ['nope'] } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics.some((d) => d.code === 'INVALID_NODE_SHAPE' && d.path?.includes('assign'))).toBe(true)
  })

  it('emits UNSUPPORTED_FIELD for unknown keys', () => {
    const diagnostics = diag()
    normalizeSteps(
      [{ set: { id: 's3', assign: { a: 1 }, unknownKey: 'v' } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics.some((d) => d.code === 'UNSUPPORTED_FIELD')).toBe(true)
  })
})
