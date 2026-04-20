/**
 * Deep coverage for `composeTemplates`.
 *
 * The existing `agent-templates.test.ts` contains composition smoke tests
 * using built-in templates. This file exercises the merge logic with
 * synthetic inputs so each rule is verified in isolation:
 *   - ID / name / description / category concatenation and delimiters
 *   - Instructions join separator
 *   - modelTier: highest-wins across all permutations
 *   - suggestedTools union + dedup + all-undefined case
 *   - guardrails max-merge with various missing-field combinations
 *   - tags union + dedup with empty arrays
 *   - Immutability: composing does not mutate inputs
 */
import { describe, it, expect } from 'vitest'
import { composeTemplates } from '../templates/template-composer.js'
import type {
  AgentTemplate,
  AgentTemplateCategory,
} from '../templates/agent-templates.js'

// ---------------------------------------------------------------------------
// Synthetic template builder
// ---------------------------------------------------------------------------

function makeTemplate(overrides: Partial<AgentTemplate> & { id: string }): AgentTemplate {
  return {
    name: overrides.id,
    description: `${overrides.id} description`,
    category: 'code' as AgentTemplateCategory,
    instructions: `Instructions for ${overrides.id} — long enough to be real.`,
    modelTier: 'fast',
    tags: [`tag-${overrides.id}`],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('composeTemplates — errors', () => {
  it('throws on empty input', () => {
    expect(() => composeTemplates([])).toThrow()
  })

  it('error message mentions "at least one template"', () => {
    expect(() => composeTemplates([])).toThrow(/at least one template/i)
  })
})

// ---------------------------------------------------------------------------
// Single-template behavior
// ---------------------------------------------------------------------------

describe('composeTemplates — single template', () => {
  it('returns a shallow copy', () => {
    const t = makeTemplate({ id: 'alone' })
    const out = composeTemplates([t])
    expect(out).toEqual(t)
    expect(out).not.toBe(t)
  })

  it('does not mutate the single input', () => {
    const t = makeTemplate({ id: 'alone', tags: ['x', 'y'] })
    composeTemplates([t])
    expect(t.tags).toEqual(['x', 'y'])
  })

  it('preserves all fields verbatim', () => {
    const t = makeTemplate({
      id: 'solo',
      name: 'Solo Agent',
      description: 'Runs solo',
      category: 'data',
      instructions: 'Instructions that are long enough for a sensible agent persona prompt.',
      modelTier: 'powerful',
      suggestedTools: ['read_file', 'write_file'],
      guardrails: { maxTokens: 1000 },
      tags: ['solo', 'single'],
    })
    expect(composeTemplates([t])).toEqual(t)
  })
})

// ---------------------------------------------------------------------------
// ID / name / description concatenation
// ---------------------------------------------------------------------------

describe('composeTemplates — string concatenation', () => {
  it('joins ids with "+"', () => {
    const result = composeTemplates([
      makeTemplate({ id: 'alpha' }),
      makeTemplate({ id: 'beta' }),
      makeTemplate({ id: 'gamma' }),
    ])
    expect(result.id).toBe('alpha+beta+gamma')
  })

  it('joins names with " + "', () => {
    const result = composeTemplates([
      makeTemplate({ id: 'a', name: 'First' }),
      makeTemplate({ id: 'b', name: 'Second' }),
    ])
    expect(result.name).toBe('First + Second')
  })

  it('joins descriptions with " | "', () => {
    const result = composeTemplates([
      makeTemplate({ id: 'a', description: 'desc-a' }),
      makeTemplate({ id: 'b', description: 'desc-b' }),
    ])
    expect(result.description).toBe('desc-a | desc-b')
  })

  it('joins instructions with the \\n\\n---\\n\\n separator', () => {
    const result = composeTemplates([
      makeTemplate({ id: 'a', instructions: 'AAA instructions for test.' }),
      makeTemplate({ id: 'b', instructions: 'BBB instructions for test.' }),
    ])
    expect(result.instructions).toBe(
      'AAA instructions for test.\n\n---\n\nBBB instructions for test.',
    )
  })

  it('concatenates 4 templates with all separators applied consistently', () => {
    const result = composeTemplates([
      makeTemplate({ id: '1' }),
      makeTemplate({ id: '2' }),
      makeTemplate({ id: '3' }),
      makeTemplate({ id: '4' }),
    ])
    expect(result.id.split('+')).toHaveLength(4)
    expect(result.name.split(' + ')).toHaveLength(4)
    expect(result.description.split(' | ')).toHaveLength(4)
    expect(result.instructions.split('\n\n---\n\n')).toHaveLength(4)
  })
})

// ---------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------

describe('composeTemplates — category', () => {
  it('uses the first template\'s category', () => {
    const r = composeTemplates([
      makeTemplate({ id: 'a', category: 'research' }),
      makeTemplate({ id: 'b', category: 'code' }),
      makeTemplate({ id: 'c', category: 'data' }),
    ])
    expect(r.category).toBe('research')
  })

  it('ignores category of later templates', () => {
    const categories: AgentTemplateCategory[] = [
      'code',
      'data',
      'infrastructure',
      'content',
      'research',
      'automation',
    ]
    for (const first of categories) {
      const r = composeTemplates([
        makeTemplate({ id: 'a', category: first }),
        makeTemplate({ id: 'b', category: 'code' }),
      ])
      expect(r.category).toBe(first)
    }
  })
})

// ---------------------------------------------------------------------------
// Model tier — highest wins
// ---------------------------------------------------------------------------

describe('composeTemplates — modelTier', () => {
  it('fast + fast = fast', () => {
    const r = composeTemplates([
      makeTemplate({ id: 'a', modelTier: 'fast' }),
      makeTemplate({ id: 'b', modelTier: 'fast' }),
    ])
    expect(r.modelTier).toBe('fast')
  })

  it('fast + balanced = balanced', () => {
    const r = composeTemplates([
      makeTemplate({ id: 'a', modelTier: 'fast' }),
      makeTemplate({ id: 'b', modelTier: 'balanced' }),
    ])
    expect(r.modelTier).toBe('balanced')
  })

  it('balanced + fast = balanced (order-independent)', () => {
    const r = composeTemplates([
      makeTemplate({ id: 'a', modelTier: 'balanced' }),
      makeTemplate({ id: 'b', modelTier: 'fast' }),
    ])
    expect(r.modelTier).toBe('balanced')
  })

  it('fast + powerful = powerful', () => {
    const r = composeTemplates([
      makeTemplate({ id: 'a', modelTier: 'fast' }),
      makeTemplate({ id: 'b', modelTier: 'powerful' }),
    ])
    expect(r.modelTier).toBe('powerful')
  })

  it('powerful + balanced + fast = powerful', () => {
    const r = composeTemplates([
      makeTemplate({ id: 'a', modelTier: 'powerful' }),
      makeTemplate({ id: 'b', modelTier: 'balanced' }),
      makeTemplate({ id: 'c', modelTier: 'fast' }),
    ])
    expect(r.modelTier).toBe('powerful')
  })

  it('balanced + balanced = balanced (no upgrade without powerful)', () => {
    const r = composeTemplates([
      makeTemplate({ id: 'a', modelTier: 'balanced' }),
      makeTemplate({ id: 'b', modelTier: 'balanced' }),
    ])
    expect(r.modelTier).toBe('balanced')
  })
})

// ---------------------------------------------------------------------------
// suggestedTools union
// ---------------------------------------------------------------------------

describe('composeTemplates — suggestedTools', () => {
  it('returns undefined when NO template has tools', () => {
    const r = composeTemplates([
      makeTemplate({ id: 'a' }),
      makeTemplate({ id: 'b' }),
    ])
    expect(r.suggestedTools).toBeUndefined()
  })

  it('returns undefined when templates have explicitly empty tool arrays', () => {
    const r = composeTemplates([
      makeTemplate({ id: 'a', suggestedTools: [] }),
      makeTemplate({ id: 'b', suggestedTools: [] }),
    ])
    expect(r.suggestedTools).toBeUndefined()
  })

  it('keeps a single template\'s tools when others have none', () => {
    const r = composeTemplates([
      makeTemplate({ id: 'a', suggestedTools: ['tool_x', 'tool_y'] }),
      makeTemplate({ id: 'b' }),
    ])
    expect(r.suggestedTools).toEqual(expect.arrayContaining(['tool_x', 'tool_y']))
    expect(r.suggestedTools).toHaveLength(2)
  })

  it('deduplicates overlapping tools', () => {
    const r = composeTemplates([
      makeTemplate({ id: 'a', suggestedTools: ['shared', 'only_a'] }),
      makeTemplate({ id: 'b', suggestedTools: ['shared', 'only_b'] }),
      makeTemplate({ id: 'c', suggestedTools: ['shared'] }),
    ])
    expect(r.suggestedTools).toHaveLength(3)
    expect(new Set(r.suggestedTools)).toEqual(new Set(['shared', 'only_a', 'only_b']))
  })

  it('preserves insertion-order ordering of distinct tools', () => {
    const r = composeTemplates([
      makeTemplate({ id: 'a', suggestedTools: ['z'] }),
      makeTemplate({ id: 'b', suggestedTools: ['a'] }),
      makeTemplate({ id: 'c', suggestedTools: ['m'] }),
    ])
    expect(r.suggestedTools).toEqual(['z', 'a', 'm'])
  })
})

// ---------------------------------------------------------------------------
// Guardrails max-merge
// ---------------------------------------------------------------------------

describe('composeTemplates — guardrails', () => {
  it('undefined when no template has guardrails', () => {
    const r = composeTemplates([
      makeTemplate({ id: 'a' }),
      makeTemplate({ id: 'b' }),
    ])
    expect(r.guardrails).toBeUndefined()
  })

  it('takes max of maxTokens', () => {
    const r = composeTemplates([
      makeTemplate({ id: 'a', guardrails: { maxTokens: 1000 } }),
      makeTemplate({ id: 'b', guardrails: { maxTokens: 5000 } }),
    ])
    expect(r.guardrails?.maxTokens).toBe(5000)
  })

  it('takes max of maxCostCents', () => {
    const r = composeTemplates([
      makeTemplate({ id: 'a', guardrails: { maxCostCents: 10 } }),
      makeTemplate({ id: 'b', guardrails: { maxCostCents: 25 } }),
      makeTemplate({ id: 'c', guardrails: { maxCostCents: 5 } }),
    ])
    expect(r.guardrails?.maxCostCents).toBe(25)
  })

  it('takes max of maxIterations', () => {
    const r = composeTemplates([
      makeTemplate({ id: 'a', guardrails: { maxIterations: 3 } }),
      makeTemplate({ id: 'b', guardrails: { maxIterations: 20 } }),
    ])
    expect(r.guardrails?.maxIterations).toBe(20)
  })

  it('only includes keys that were defined in at least one template', () => {
    const r = composeTemplates([
      makeTemplate({ id: 'a', guardrails: { maxTokens: 100 } }),
      makeTemplate({ id: 'b', guardrails: { maxIterations: 10 } }),
    ])
    expect(r.guardrails).toEqual({ maxTokens: 100, maxIterations: 10 })
    expect(r.guardrails).not.toHaveProperty('maxCostCents')
  })

  it('one template with guardrails + others without still yields guardrails', () => {
    const r = composeTemplates([
      makeTemplate({ id: 'a' }),
      makeTemplate({ id: 'b', guardrails: { maxTokens: 500 } }),
      makeTemplate({ id: 'c' }),
    ])
    expect(r.guardrails).toEqual({ maxTokens: 500 })
  })

  it('empty guardrails object contributes nothing', () => {
    const r = composeTemplates([
      makeTemplate({ id: 'a', guardrails: {} }),
      makeTemplate({ id: 'b', guardrails: {} }),
    ])
    // hasGuardrails becomes true, but no numeric fields -> object with no props
    expect(r.guardrails).toEqual({})
  })

  it('zero value is preserved and wins over undefined', () => {
    const r = composeTemplates([
      makeTemplate({ id: 'a', guardrails: { maxTokens: 0 } }),
      makeTemplate({ id: 'b' }),
    ])
    expect(r.guardrails?.maxTokens).toBe(0)
  })

  it('negative values are floored by the implicit 0 starting value in max()', () => {
    // Implementation uses `Math.max(maxTokens ?? 0, t.guardrails.maxTokens)`,
    // so negatives can never beat the implicit 0 seed. This documents that
    // behavior so any future change is intentional.
    const r = composeTemplates([
      makeTemplate({ id: 'a', guardrails: { maxTokens: -10 } }),
      makeTemplate({ id: 'b', guardrails: { maxTokens: -1 } }),
    ])
    expect(r.guardrails?.maxTokens).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Tags union
// ---------------------------------------------------------------------------

describe('composeTemplates — tags', () => {
  it('empty array from the only tag source yields []', () => {
    const r = composeTemplates([
      makeTemplate({ id: 'a', tags: [] }),
      makeTemplate({ id: 'b', tags: [] }),
    ])
    expect(r.tags).toEqual([])
  })

  it('dedupes identical tags across templates', () => {
    const r = composeTemplates([
      makeTemplate({ id: 'a', tags: ['x', 'y'] }),
      makeTemplate({ id: 'b', tags: ['y', 'z'] }),
    ])
    expect(r.tags).toHaveLength(3)
    expect(new Set(r.tags)).toEqual(new Set(['x', 'y', 'z']))
  })

  it('preserves insertion order', () => {
    const r = composeTemplates([
      makeTemplate({ id: 'a', tags: ['c'] }),
      makeTemplate({ id: 'b', tags: ['a'] }),
      makeTemplate({ id: 'c', tags: ['b'] }),
    ])
    expect(r.tags).toEqual(['c', 'a', 'b'])
  })

  it('tags field is always an array (never undefined)', () => {
    const r = composeTemplates([
      makeTemplate({ id: 'a', tags: [] }),
      makeTemplate({ id: 'b', tags: [] }),
    ])
    expect(Array.isArray(r.tags)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Immutability of inputs
// ---------------------------------------------------------------------------

describe('composeTemplates — input immutability', () => {
  it('does not mutate the input templates\' tags arrays', () => {
    const a = makeTemplate({ id: 'a', tags: ['x'] })
    const b = makeTemplate({ id: 'b', tags: ['y'] })
    composeTemplates([a, b])
    expect(a.tags).toEqual(['x'])
    expect(b.tags).toEqual(['y'])
  })

  it('does not mutate the input templates\' suggestedTools', () => {
    const a = makeTemplate({ id: 'a', suggestedTools: ['t1'] })
    const b = makeTemplate({ id: 'b', suggestedTools: ['t2'] })
    composeTemplates([a, b])
    expect(a.suggestedTools).toEqual(['t1'])
    expect(b.suggestedTools).toEqual(['t2'])
  })

  it('does not mutate the input templates\' guardrails', () => {
    const a = makeTemplate({ id: 'a', guardrails: { maxTokens: 100 } })
    const b = makeTemplate({ id: 'b', guardrails: { maxTokens: 50 } })
    composeTemplates([a, b])
    expect(a.guardrails).toEqual({ maxTokens: 100 })
    expect(b.guardrails).toEqual({ maxTokens: 50 })
  })

  it('returns a new object, not a reference to any input', () => {
    const a = makeTemplate({ id: 'a' })
    const b = makeTemplate({ id: 'b' })
    const out = composeTemplates([a, b])
    expect(out).not.toBe(a)
    expect(out).not.toBe(b)
  })

  it('result.tags is not the same reference as input tags', () => {
    const a = makeTemplate({ id: 'a', tags: ['x'] })
    const out = composeTemplates([a, makeTemplate({ id: 'b', tags: ['x'] })])
    expect(out.tags).not.toBe(a.tags)
  })

  it('result.suggestedTools is a new array even with one source', () => {
    const a = makeTemplate({ id: 'a', suggestedTools: ['read'] })
    const out = composeTemplates([a, makeTemplate({ id: 'b' })])
    expect(out.suggestedTools).not.toBe(a.suggestedTools)
  })
})

// ---------------------------------------------------------------------------
// End-to-end shape guarantees
// ---------------------------------------------------------------------------

describe('composeTemplates — output shape', () => {
  it('returned object conforms to AgentTemplate shape', () => {
    const r = composeTemplates([
      makeTemplate({ id: 'a' }),
      makeTemplate({ id: 'b' }),
    ])
    expect(typeof r.id).toBe('string')
    expect(typeof r.name).toBe('string')
    expect(typeof r.description).toBe('string')
    expect(typeof r.category).toBe('string')
    expect(typeof r.instructions).toBe('string')
    expect(typeof r.modelTier).toBe('string')
    expect(Array.isArray(r.tags)).toBe(true)
  })

  it('instructions contain each input template\'s instructions', () => {
    const i1 = 'Do step one carefully and precisely for every request.'
    const i2 = 'Do step two carefully and precisely for every request.'
    const r = composeTemplates([
      makeTemplate({ id: 'a', instructions: i1 }),
      makeTemplate({ id: 'b', instructions: i2 }),
    ])
    expect(r.instructions).toContain(i1)
    expect(r.instructions).toContain(i2)
  })

  it('multiple composites with identical inputs produce equal outputs', () => {
    const a = makeTemplate({
      id: 'a',
      tags: ['x', 'y'],
      guardrails: { maxTokens: 1 },
      suggestedTools: ['r'],
    })
    const b = makeTemplate({
      id: 'b',
      tags: ['y', 'z'],
      guardrails: { maxCostCents: 10 },
      suggestedTools: ['w'],
    })
    const out1 = composeTemplates([a, b])
    const out2 = composeTemplates([a, b])
    expect(out1).toEqual(out2)
  })
})
