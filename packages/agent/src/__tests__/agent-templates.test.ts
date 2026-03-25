import { describe, it, expect } from 'vitest'
import {
  AGENT_TEMPLATES,
  ALL_AGENT_TEMPLATES,
  getAgentTemplate,
  listAgentTemplates,
} from '../templates/agent-templates.js'
import type { AgentTemplate, AgentTemplateCategory } from '../templates/agent-templates.js'
import { composeTemplates } from '../templates/template-composer.js'
import { TemplateRegistry } from '../templates/template-registry.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATEGORIES: AgentTemplateCategory[] = [
  'code',
  'data',
  'infrastructure',
  'content',
  'research',
  'automation',
]

const MIN_TEMPLATES_PER_CATEGORY = 3

// ---------------------------------------------------------------------------
// Template validation helpers
// ---------------------------------------------------------------------------

function assertValidTemplate(t: AgentTemplate): void {
  expect(t.id).toBeTruthy()
  expect(t.name).toBeTruthy()
  expect(t.description).toBeTruthy()
  expect(t.instructions.length).toBeGreaterThan(50)
  expect(['fast', 'balanced', 'powerful']).toContain(t.modelTier)
  expect(CATEGORIES).toContain(t.category)
  expect(t.tags.length).toBeGreaterThan(0)
}

// ---------------------------------------------------------------------------
// ALL_AGENT_TEMPLATES — structural validation
// ---------------------------------------------------------------------------

describe('ALL_AGENT_TEMPLATES', () => {
  it('contains at least 20 templates', () => {
    expect(ALL_AGENT_TEMPLATES.length).toBeGreaterThanOrEqual(20)
  })

  it('every template has required fields and valid values', () => {
    for (const t of ALL_AGENT_TEMPLATES) {
      assertValidTemplate(t)
    }
  })

  it('all template IDs are unique', () => {
    const ids = ALL_AGENT_TEMPLATES.map(t => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  for (const category of CATEGORIES) {
    it(`has at least ${MIN_TEMPLATES_PER_CATEGORY} templates in category "${category}"`, () => {
      const count = ALL_AGENT_TEMPLATES.filter(t => t.category === category).length
      expect(count).toBeGreaterThanOrEqual(MIN_TEMPLATES_PER_CATEGORY)
    })
  }
})

// ---------------------------------------------------------------------------
// AGENT_TEMPLATES record + lookup helpers
// ---------------------------------------------------------------------------

describe('AGENT_TEMPLATES / getAgentTemplate / listAgentTemplates', () => {
  it('AGENT_TEMPLATES is keyed by id', () => {
    for (const [key, t] of Object.entries(AGENT_TEMPLATES)) {
      expect(key).toBe(t.id)
    }
  })

  it('getAgentTemplate returns the correct template', () => {
    const t = getAgentTemplate('code-reviewer')
    expect(t).toBeDefined()
    expect(t!.id).toBe('code-reviewer')
  })

  it('getAgentTemplate returns undefined for unknown id', () => {
    expect(getAgentTemplate('nonexistent-agent')).toBeUndefined()
  })

  it('listAgentTemplates returns all IDs', () => {
    const ids = listAgentTemplates()
    expect(ids.length).toBe(ALL_AGENT_TEMPLATES.length)
    expect(ids).toContain('code-reviewer')
    expect(ids).toContain('data-analyst')
  })
})

// ---------------------------------------------------------------------------
// composeTemplates
// ---------------------------------------------------------------------------

describe('composeTemplates', () => {
  it('throws on empty array', () => {
    expect(() => composeTemplates([])).toThrow('at least one template')
  })

  it('returns a copy for a single template', () => {
    const original = getAgentTemplate('code-reviewer')!
    const composed = composeTemplates([original])
    expect(composed).toEqual(original)
    expect(composed).not.toBe(original) // distinct object
  })

  it('concatenates instructions with separator', () => {
    const a = getAgentTemplate('code-reviewer')!
    const b = getAgentTemplate('test-writer')!
    const c = composeTemplates([a, b])
    expect(c.instructions).toContain(a.instructions)
    expect(c.instructions).toContain(b.instructions)
    expect(c.instructions).toContain('\n\n---\n\n')
  })

  it('unions suggestedTools (deduplicated)', () => {
    const a = getAgentTemplate('code-reviewer')! // has read_file, search_code, git_diff
    const b = getAgentTemplate('code-generator')! // has read_file, write_file, edit_file, search_code
    const c = composeTemplates([a, b])
    const tools = c.suggestedTools!
    // Should contain union without duplicates
    expect(tools).toContain('read_file')
    expect(tools).toContain('search_code')
    expect(tools).toContain('git_diff')
    expect(tools).toContain('write_file')
    expect(tools).toContain('edit_file')
    // No duplicates
    expect(new Set(tools).size).toBe(tools.length)
  })

  it('unions tags (deduplicated)', () => {
    const a = getAgentTemplate('code-reviewer')!
    const b = getAgentTemplate('security-auditor')!
    const c = composeTemplates([a, b])
    const allTags = [...new Set([...a.tags, ...b.tags])]
    expect(c.tags.length).toBe(allTags.length)
    for (const tag of allTags) {
      expect(c.tags).toContain(tag)
    }
  })

  it('uses highest model tier', () => {
    const fast = getAgentTemplate('changelog-writer')! // fast
    const powerful = getAgentTemplate('code-reviewer')! // powerful
    expect(composeTemplates([fast, powerful]).modelTier).toBe('powerful')
    expect(composeTemplates([powerful, fast]).modelTier).toBe('powerful')
  })

  it('takes max of each guardrail value', () => {
    const a: AgentTemplate = {
      id: 'a', name: 'A', description: 'A template', category: 'code',
      instructions: 'Instructions for template A that are longer than fifty characters for validation.',
      modelTier: 'fast', tags: ['a'],
      guardrails: { maxTokens: 100, maxCostCents: 10, maxIterations: 5 },
    }
    const b: AgentTemplate = {
      id: 'b', name: 'B', description: 'B template', category: 'code',
      instructions: 'Instructions for template B that are also longer than fifty characters for validation.',
      modelTier: 'fast', tags: ['b'],
      guardrails: { maxTokens: 200, maxCostCents: 5, maxIterations: 15 },
    }
    const c = composeTemplates([a, b])
    expect(c.guardrails).toEqual({ maxTokens: 200, maxCostCents: 10, maxIterations: 15 })
  })

  it('handles templates without guardrails', () => {
    const a: AgentTemplate = {
      id: 'a', name: 'A', description: 'A template', category: 'code',
      instructions: 'Instructions for template A that are longer than fifty characters for validation.',
      modelTier: 'fast', tags: ['a'],
    }
    const b: AgentTemplate = {
      id: 'b', name: 'B', description: 'B template', category: 'code',
      instructions: 'Instructions for template B that are also longer than fifty characters for validation.',
      modelTier: 'fast', tags: ['b'],
    }
    const c = composeTemplates([a, b])
    expect(c.guardrails).toBeUndefined()
  })

  it('handles templates without suggestedTools', () => {
    const a: AgentTemplate = {
      id: 'a', name: 'A', description: 'A template', category: 'code',
      instructions: 'Instructions for template A that are longer than fifty characters for validation.',
      modelTier: 'fast', tags: ['a'],
    }
    const c = composeTemplates([a, a])
    expect(c.suggestedTools).toBeUndefined()
  })

  it('uses first template category', () => {
    const a = getAgentTemplate('data-analyst')! // data
    const b = getAgentTemplate('code-reviewer')! // code
    expect(composeTemplates([a, b]).category).toBe('data')
    expect(composeTemplates([b, a]).category).toBe('code')
  })

  it('concatenates id with + separator', () => {
    const a = getAgentTemplate('code-reviewer')!
    const b = getAgentTemplate('test-writer')!
    expect(composeTemplates([a, b]).id).toBe('code-reviewer+test-writer')
  })
})

// ---------------------------------------------------------------------------
// TemplateRegistry
// ---------------------------------------------------------------------------

describe('TemplateRegistry', () => {
  it('pre-populates with built-in templates by default', () => {
    const reg = new TemplateRegistry()
    expect(reg.size).toBe(ALL_AGENT_TEMPLATES.length)
  })

  it('can be created empty', () => {
    const reg = new TemplateRegistry(false)
    expect(reg.size).toBe(0)
  })

  it('get() returns a registered template', () => {
    const reg = new TemplateRegistry()
    const t = reg.get('code-reviewer')
    expect(t).toBeDefined()
    expect(t!.id).toBe('code-reviewer')
  })

  it('get() returns undefined for unknown id', () => {
    const reg = new TemplateRegistry()
    expect(reg.get('unknown')).toBeUndefined()
  })

  it('register() adds a custom template', () => {
    const reg = new TemplateRegistry(false)
    const custom: AgentTemplate = {
      id: 'custom-agent', name: 'Custom', description: 'Custom agent',
      category: 'automation',
      instructions: 'You are a custom agent. Perform custom tasks with care and precision always.',
      modelTier: 'fast', tags: ['custom'],
    }
    reg.register(custom)
    expect(reg.get('custom-agent')).toEqual(custom)
    expect(reg.size).toBe(1)
  })

  it('register() overwrites existing template with same id', () => {
    const reg = new TemplateRegistry(false)
    const v1: AgentTemplate = {
      id: 'my-agent', name: 'V1', description: 'Version 1', category: 'code',
      instructions: 'Version 1 instructions that are longer than fifty characters to pass validation.',
      modelTier: 'fast', tags: ['v1'],
    }
    const v2: AgentTemplate = {
      id: 'my-agent', name: 'V2', description: 'Version 2', category: 'code',
      instructions: 'Version 2 instructions that are longer than fifty characters to pass validation.',
      modelTier: 'powerful', tags: ['v2'],
    }
    reg.register(v1)
    reg.register(v2)
    expect(reg.get('my-agent')!.name).toBe('V2')
    expect(reg.size).toBe(1)
  })

  it('list() returns all templates', () => {
    const reg = new TemplateRegistry()
    const all = reg.list()
    expect(all.length).toBe(ALL_AGENT_TEMPLATES.length)
  })

  it('listByTag() filters by tag', () => {
    const reg = new TemplateRegistry()
    const securityTemplates = reg.listByTag('security')
    expect(securityTemplates.length).toBeGreaterThanOrEqual(1)
    for (const t of securityTemplates) {
      expect(t.tags).toContain('security')
    }
  })

  it('listByTag() returns empty for unknown tag', () => {
    const reg = new TemplateRegistry()
    expect(reg.listByTag('nonexistent-tag')).toEqual([])
  })

  it('listByCategory() filters by category', () => {
    const reg = new TemplateRegistry()
    for (const cat of CATEGORIES) {
      const results = reg.listByCategory(cat)
      expect(results.length).toBeGreaterThanOrEqual(MIN_TEMPLATES_PER_CATEGORY)
      for (const t of results) {
        expect(t.category).toBe(cat)
      }
    }
  })

  it('remove() deletes a template and returns true', () => {
    const reg = new TemplateRegistry()
    const before = reg.size
    const removed = reg.remove('code-reviewer')
    expect(removed).toBe(true)
    expect(reg.size).toBe(before - 1)
    expect(reg.get('code-reviewer')).toBeUndefined()
  })

  it('remove() returns false for unknown id', () => {
    const reg = new TemplateRegistry()
    expect(reg.remove('nonexistent')).toBe(false)
  })
})
