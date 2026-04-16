/**
 * Extended tests for TemplateRegistry, composeTemplates, and template helpers.
 *
 * Covers:
 * - Registry list() ordering stability
 * - Concurrent registration race safety
 * - Overwrite behavior (last write wins)
 * - Unknown template lookup
 * - Deep variable substitution / multi-template composition chains
 * - Missing fields handling
 * - Composed template inheritance (parent + child patterns)
 * - Edge cases in composeTemplates
 * - Registry removal + re-registration interactions
 * - listByTag / listByCategory after mutations
 */
import { describe, it, expect } from 'vitest'
import { TemplateRegistry } from '../templates/template-registry.js'
import { composeTemplates } from '../templates/template-composer.js'
import {
  ALL_AGENT_TEMPLATES,
  getAgentTemplate,
} from '../templates/agent-templates.js'
import type { AgentTemplate } from '../templates/agent-templates.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTemplate(overrides: Partial<AgentTemplate> & { id: string }): AgentTemplate {
  return {
    name: overrides.name ?? overrides.id,
    description: overrides.description ?? `Description for ${overrides.id}`,
    category: overrides.category ?? 'automation',
    instructions: overrides.instructions ?? `Instructions for ${overrides.id} that are longer than fifty characters for validation purposes.`,
    modelTier: overrides.modelTier ?? 'fast',
    tags: overrides.tags ?? [overrides.id],
    suggestedTools: overrides.suggestedTools,
    guardrails: overrides.guardrails,
    ...overrides,
  }
}

// ===========================================================================
// Registry list() ordering stability
// ===========================================================================

describe('TemplateRegistry list() ordering stability', () => {
  it('returns templates in consistent insertion order', () => {
    const reg = new TemplateRegistry(false)
    const ids = ['zeta', 'alpha', 'middle', 'beta', 'omega']
    for (const id of ids) {
      reg.register(makeTemplate({ id }))
    }

    const first = reg.list().map((t) => t.id)
    const second = reg.list().map((t) => t.id)
    const third = reg.list().map((t) => t.id)

    expect(first).toEqual(second)
    expect(second).toEqual(third)
    expect(first).toEqual(ids)
  })

  it('list() order is stable after overwrite of existing entry', () => {
    const reg = new TemplateRegistry(false)
    reg.register(makeTemplate({ id: 'a' }))
    reg.register(makeTemplate({ id: 'b' }))
    reg.register(makeTemplate({ id: 'c' }))

    // Overwrite 'b' -- Map preserves original insertion order for existing keys
    reg.register(makeTemplate({ id: 'b', name: 'B-updated' }))

    const order = reg.list().map((t) => t.id)
    expect(order).toEqual(['a', 'b', 'c'])
    expect(reg.get('b')!.name).toBe('B-updated')
  })

  it('list() order reflects removal gaps', () => {
    const reg = new TemplateRegistry(false)
    reg.register(makeTemplate({ id: 'a' }))
    reg.register(makeTemplate({ id: 'b' }))
    reg.register(makeTemplate({ id: 'c' }))

    reg.remove('b')
    expect(reg.list().map((t) => t.id)).toEqual(['a', 'c'])
  })
})

// ===========================================================================
// Concurrent registration race safety
// ===========================================================================

describe('TemplateRegistry concurrent registration', () => {
  it('all templates are present after rapid sequential registration', () => {
    const reg = new TemplateRegistry(false)
    const count = 50
    for (let i = 0; i < count; i++) {
      reg.register(makeTemplate({ id: `agent-${i}` }))
    }
    expect(reg.size).toBe(count)

    // Verify all are retrievable
    for (let i = 0; i < count; i++) {
      expect(reg.get(`agent-${i}`)).toBeDefined()
    }
  })

  it('concurrent-like registrations (Promise.all on sync ops) all land', async () => {
    const reg = new TemplateRegistry(false)
    const registrations = Array.from({ length: 20 }, (_, i) =>
      Promise.resolve().then(() => reg.register(makeTemplate({ id: `async-${i}` }))),
    )
    await Promise.all(registrations)
    expect(reg.size).toBe(20)
    for (let i = 0; i < 20; i++) {
      expect(reg.get(`async-${i}`)).toBeDefined()
    }
  })

  it('interleaved register/remove operations leave correct final state', () => {
    const reg = new TemplateRegistry(false)
    reg.register(makeTemplate({ id: 'keep-1' }))
    reg.register(makeTemplate({ id: 'remove-1' }))
    reg.register(makeTemplate({ id: 'keep-2' }))
    reg.remove('remove-1')
    reg.register(makeTemplate({ id: 'keep-3' }))
    reg.register(makeTemplate({ id: 'remove-2' }))
    reg.remove('remove-2')

    expect(reg.size).toBe(3)
    expect(reg.list().map((t) => t.id).sort()).toEqual(['keep-1', 'keep-2', 'keep-3'])
  })
})

// ===========================================================================
// Overwrite existing template behavior
// ===========================================================================

describe('TemplateRegistry overwrite behavior', () => {
  it('last write wins for same ID', () => {
    const reg = new TemplateRegistry(false)
    reg.register(makeTemplate({ id: 'agent', name: 'Version 1', modelTier: 'fast' }))
    reg.register(makeTemplate({ id: 'agent', name: 'Version 2', modelTier: 'powerful' }))
    reg.register(makeTemplate({ id: 'agent', name: 'Version 3', modelTier: 'balanced' }))

    const result = reg.get('agent')!
    expect(result.name).toBe('Version 3')
    expect(result.modelTier).toBe('balanced')
    expect(reg.size).toBe(1)
  })

  it('overwriting a built-in template replaces it', () => {
    const reg = new TemplateRegistry(true)
    const originalName = reg.get('code-reviewer')!.name
    expect(originalName).toBe('Code Reviewer')

    reg.register(makeTemplate({
      id: 'code-reviewer',
      name: 'Custom Code Reviewer',
      category: 'code',
      tags: ['custom', 'code-quality'],
    }))

    expect(reg.get('code-reviewer')!.name).toBe('Custom Code Reviewer')
    // Size unchanged since we overwrote
    expect(reg.size).toBe(ALL_AGENT_TEMPLATES.length)
  })
})

// ===========================================================================
// Unknown template lookup
// ===========================================================================

describe('TemplateRegistry unknown template lookup', () => {
  it('get() returns undefined for non-existent ID', () => {
    const reg = new TemplateRegistry()
    expect(reg.get('does-not-exist')).toBeUndefined()
  })

  it('get() returns undefined for empty string ID', () => {
    const reg = new TemplateRegistry()
    expect(reg.get('')).toBeUndefined()
  })

  it('listByTag returns empty array for non-existent tag', () => {
    const reg = new TemplateRegistry()
    expect(reg.listByTag('nonexistent-tag-xyz')).toEqual([])
  })

  it('listByCategory returns empty array for empty registry', () => {
    const reg = new TemplateRegistry(false)
    expect(reg.listByCategory('code')).toEqual([])
  })

  it('remove returns false for non-existent ID', () => {
    const reg = new TemplateRegistry(false)
    expect(reg.remove('ghost')).toBe(false)
  })
})

// ===========================================================================
// composeTemplates edge cases
// ===========================================================================

describe('composeTemplates — extended edge cases', () => {
  it('composes 3+ templates correctly', () => {
    const a = makeTemplate({ id: 'a', modelTier: 'fast', tags: ['tag-a'] })
    const b = makeTemplate({ id: 'b', modelTier: 'balanced', tags: ['tag-b'] })
    const c = makeTemplate({ id: 'c', modelTier: 'powerful', tags: ['tag-c'] })

    const composed = composeTemplates([a, b, c])
    expect(composed.id).toBe('a+b+c')
    expect(composed.name).toBe('a + b + c')
    expect(composed.modelTier).toBe('powerful')
    expect(composed.tags).toContain('tag-a')
    expect(composed.tags).toContain('tag-b')
    expect(composed.tags).toContain('tag-c')
  })

  it('merges guardrails across 3 templates taking max of each', () => {
    const a = makeTemplate({ id: 'a', guardrails: { maxTokens: 100, maxCostCents: 50 } })
    const b = makeTemplate({ id: 'b', guardrails: { maxTokens: 200, maxIterations: 10 } })
    const c = makeTemplate({ id: 'c', guardrails: { maxCostCents: 75, maxIterations: 5 } })

    const composed = composeTemplates([a, b, c])
    expect(composed.guardrails).toEqual({
      maxTokens: 200,
      maxCostCents: 75,
      maxIterations: 10,
    })
  })

  it('handles mix of templates with and without guardrails', () => {
    const withGuardrails = makeTemplate({
      id: 'with',
      guardrails: { maxTokens: 100, maxCostCents: 10, maxIterations: 5 },
    })
    const without = makeTemplate({ id: 'without' })

    const composed = composeTemplates([without, withGuardrails])
    expect(composed.guardrails).toEqual({ maxTokens: 100, maxCostCents: 10, maxIterations: 5 })
  })

  it('handles mix of templates with and without suggestedTools', () => {
    const withTools = makeTemplate({ id: 'with', suggestedTools: ['read_file', 'write_file'] })
    const without = makeTemplate({ id: 'without' })

    const composed = composeTemplates([without, withTools])
    expect(composed.suggestedTools).toEqual(['read_file', 'write_file'])
  })

  it('deduplicates overlapping tags from multiple templates', () => {
    const a = makeTemplate({ id: 'a', tags: ['shared', 'unique-a'] })
    const b = makeTemplate({ id: 'b', tags: ['shared', 'unique-b'] })

    const composed = composeTemplates([a, b])
    expect(composed.tags.filter((t) => t === 'shared')).toHaveLength(1)
    expect(composed.tags).toContain('unique-a')
    expect(composed.tags).toContain('unique-b')
  })

  it('deduplicates overlapping suggestedTools', () => {
    const a = makeTemplate({ id: 'a', suggestedTools: ['read_file', 'search_code'] })
    const b = makeTemplate({ id: 'b', suggestedTools: ['search_code', 'write_file'] })

    const composed = composeTemplates([a, b])
    expect(composed.suggestedTools).toHaveLength(3)
    expect(new Set(composed.suggestedTools).size).toBe(3)
  })

  it('description uses pipe separator for multiple templates', () => {
    const a = makeTemplate({ id: 'a', description: 'First desc' })
    const b = makeTemplate({ id: 'b', description: 'Second desc' })

    const composed = composeTemplates([a, b])
    expect(composed.description).toBe('First desc | Second desc')
  })

  it('instructions use separator for multiple templates', () => {
    const a = makeTemplate({ id: 'a', instructions: 'Instructions A that are longer than fifty characters for validation purposes.' })
    const b = makeTemplate({ id: 'b', instructions: 'Instructions B that are also longer than fifty characters for validation purposes.' })

    const composed = composeTemplates([a, b])
    expect(composed.instructions).toContain('Instructions A')
    expect(composed.instructions).toContain('---')
    expect(composed.instructions).toContain('Instructions B')
  })
})

// ===========================================================================
// Deep composition chain (3+ levels)
// ===========================================================================

describe('composeTemplates — deep composition chain', () => {
  it('can compose already-composed templates (3 levels deep)', () => {
    const base = makeTemplate({
      id: 'base',
      modelTier: 'fast',
      suggestedTools: ['read_file'],
      guardrails: { maxTokens: 100 },
      tags: ['base'],
    })
    const mid = makeTemplate({
      id: 'mid',
      modelTier: 'balanced',
      suggestedTools: ['write_file'],
      guardrails: { maxTokens: 200, maxCostCents: 10 },
      tags: ['mid'],
    })
    const top = makeTemplate({
      id: 'top',
      modelTier: 'powerful',
      suggestedTools: ['read_file', 'execute_command'],
      guardrails: { maxIterations: 20 },
      tags: ['top'],
    })

    // Level 1: compose base + mid
    const level1 = composeTemplates([base, mid])
    // Level 2: compose level1 + top
    const level2 = composeTemplates([level1, top])

    expect(level2.id).toBe('base+mid+top')
    expect(level2.modelTier).toBe('powerful')
    expect(level2.suggestedTools).toContain('read_file')
    expect(level2.suggestedTools).toContain('write_file')
    expect(level2.suggestedTools).toContain('execute_command')
    expect(new Set(level2.suggestedTools).size).toBe(level2.suggestedTools!.length)
    expect(level2.guardrails!.maxTokens).toBe(200)
    expect(level2.guardrails!.maxCostCents).toBe(10)
    expect(level2.guardrails!.maxIterations).toBe(20)
    expect(level2.tags).toContain('base')
    expect(level2.tags).toContain('mid')
    expect(level2.tags).toContain('top')
  })

  it('composed template can be registered and retrieved from registry', () => {
    const a = getAgentTemplate('code-reviewer')!
    const b = getAgentTemplate('security-auditor')!
    const composed = composeTemplates([a, b])

    const reg = new TemplateRegistry(false)
    reg.register(composed)

    const retrieved = reg.get('code-reviewer+security-auditor')
    expect(retrieved).toBeDefined()
    expect(retrieved!.modelTier).toBe('powerful')
    expect(retrieved!.tags).toContain('security')
    expect(retrieved!.tags).toContain('code-quality')
  })
})

// ===========================================================================
// Registry mutations and queries
// ===========================================================================

describe('TemplateRegistry — mutation + query interactions', () => {
  it('listByTag reflects newly registered templates', () => {
    const reg = new TemplateRegistry(false)
    reg.register(makeTemplate({ id: 'a', tags: ['special'] }))
    expect(reg.listByTag('special')).toHaveLength(1)

    reg.register(makeTemplate({ id: 'b', tags: ['special', 'other'] }))
    expect(reg.listByTag('special')).toHaveLength(2)
  })

  it('listByTag reflects removed templates', () => {
    const reg = new TemplateRegistry(false)
    reg.register(makeTemplate({ id: 'a', tags: ['special'] }))
    reg.register(makeTemplate({ id: 'b', tags: ['special'] }))
    expect(reg.listByTag('special')).toHaveLength(2)

    reg.remove('a')
    expect(reg.listByTag('special')).toHaveLength(1)
    expect(reg.listByTag('special')[0]!.id).toBe('b')
  })

  it('listByCategory reflects mutations', () => {
    const reg = new TemplateRegistry(false)
    reg.register(makeTemplate({ id: 'x', category: 'code' }))
    reg.register(makeTemplate({ id: 'y', category: 'code' }))
    reg.register(makeTemplate({ id: 'z', category: 'data' }))

    expect(reg.listByCategory('code')).toHaveLength(2)
    expect(reg.listByCategory('data')).toHaveLength(1)

    reg.remove('x')
    expect(reg.listByCategory('code')).toHaveLength(1)
    expect(reg.listByCategory('code')[0]!.id).toBe('y')
  })

  it('re-registering after remove creates fresh entry', () => {
    const reg = new TemplateRegistry(false)
    reg.register(makeTemplate({ id: 'temp', name: 'V1' }))
    reg.remove('temp')
    expect(reg.get('temp')).toBeUndefined()

    reg.register(makeTemplate({ id: 'temp', name: 'V2' }))
    expect(reg.get('temp')!.name).toBe('V2')
    expect(reg.size).toBe(1)
  })

  it('size is accurate after mixed operations', () => {
    const reg = new TemplateRegistry(false)
    expect(reg.size).toBe(0)

    reg.register(makeTemplate({ id: 'a' }))
    reg.register(makeTemplate({ id: 'b' }))
    reg.register(makeTemplate({ id: 'c' }))
    expect(reg.size).toBe(3)

    reg.remove('b')
    expect(reg.size).toBe(2)

    reg.register(makeTemplate({ id: 'b' })) // re-add
    expect(reg.size).toBe(3)

    reg.register(makeTemplate({ id: 'a' })) // overwrite
    expect(reg.size).toBe(3)
  })
})

// ===========================================================================
// Built-in template registry integration
// ===========================================================================

describe('TemplateRegistry — built-in template integration', () => {
  it('all built-in templates are retrievable by ID', () => {
    const reg = new TemplateRegistry()
    for (const t of ALL_AGENT_TEMPLATES) {
      expect(reg.get(t.id)).toBeDefined()
      expect(reg.get(t.id)!.id).toBe(t.id)
    }
  })

  it('listByTag("security") returns at least 1 built-in template', () => {
    const reg = new TemplateRegistry()
    const results = reg.listByTag('security')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results.every((t) => t.tags.includes('security'))).toBe(true)
  })

  it('listByCategory for every category returns non-empty from defaults', () => {
    const reg = new TemplateRegistry()
    const categories = ['code', 'data', 'infrastructure', 'content', 'research', 'automation'] as const
    for (const cat of categories) {
      expect(reg.listByCategory(cat).length).toBeGreaterThan(0)
    }
  })

  it('custom templates do not interfere with built-in templates', () => {
    const reg = new TemplateRegistry()
    const before = reg.size
    reg.register(makeTemplate({ id: 'my-custom-agent' }))
    expect(reg.size).toBe(before + 1)
    // Built-ins still accessible
    expect(reg.get('code-reviewer')).toBeDefined()
    expect(reg.get('my-custom-agent')).toBeDefined()
  })
})
