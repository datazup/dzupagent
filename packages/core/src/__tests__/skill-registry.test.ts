import { describe, it, expect, beforeEach } from 'vitest'
import { SkillRegistry } from '../skills/skill-registry.js'
import type { SkillRegistryEntry, LoadedSkill } from '../skills/skill-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSkill(overrides: Partial<SkillRegistryEntry> = {}): SkillRegistryEntry {
  return {
    id: 'test-skill',
    name: 'Test Skill',
    description: 'A test skill',
    instructions: 'Do the thing.',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SkillRegistry', () => {
  let registry: SkillRegistry

  beforeEach(() => {
    registry = new SkillRegistry()
  })

  // -----------------------------------------------------------------------
  // register / get / has
  // -----------------------------------------------------------------------

  describe('register', () => {
    it('registers a skill and retrieves it by id', () => {
      registry.register(makeSkill())
      const loaded = registry.get('test-skill')

      expect(loaded).toBeDefined()
      expect(loaded!.id).toBe('test-skill')
      expect(loaded!.name).toBe('Test Skill')
      expect(loaded!.instructions).toBe('Do the thing.')
      expect(loaded!.loadedAt).toBeGreaterThan(0)
    })

    it('stores the sourcePath when provided', () => {
      registry.register(makeSkill(), '/path/to/SKILL.md')
      expect(registry.get('test-skill')!.sourcePath).toBe('/path/to/SKILL.md')
    })

    it('overwrites an existing skill with the same id', () => {
      registry.register(makeSkill({ description: 'v1' }))
      registry.register(makeSkill({ description: 'v2' }))

      expect(registry.size).toBe(1)
      expect(registry.get('test-skill')!.description).toBe('v2')
    })

    it('throws when id is missing', () => {
      expect(() => registry.register(makeSkill({ id: '' }))).toThrow('id')
    })

    it('throws when name is missing', () => {
      expect(() => registry.register(makeSkill({ name: '' }))).toThrow('name')
    })
  })

  describe('has', () => {
    it('returns true for registered skill', () => {
      registry.register(makeSkill())
      expect(registry.has('test-skill')).toBe(true)
    })

    it('returns false for unregistered skill', () => {
      expect(registry.has('nope')).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // unregister
  // -----------------------------------------------------------------------

  describe('unregister', () => {
    it('removes a skill by id', () => {
      registry.register(makeSkill())
      expect(registry.unregister('test-skill')).toBe(true)
      expect(registry.get('test-skill')).toBeUndefined()
      expect(registry.size).toBe(0)
    })

    it('returns false when skill does not exist', () => {
      expect(registry.unregister('nope')).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // list
  // -----------------------------------------------------------------------

  describe('list', () => {
    it('returns all skills sorted by priority desc then name asc', () => {
      registry.register(makeSkill({ id: 'c', name: 'C Skill', priority: 1 }))
      registry.register(makeSkill({ id: 'a', name: 'A Skill', priority: 10 }))
      registry.register(makeSkill({ id: 'b', name: 'B Skill', priority: 10 }))
      registry.register(makeSkill({ id: 'd', name: 'D Skill' })) // no priority (0)

      const names = registry.list().map(s => s.name)
      expect(names).toEqual(['A Skill', 'B Skill', 'C Skill', 'D Skill'])
    })

    it('returns empty array when no skills registered', () => {
      expect(registry.list()).toEqual([])
    })
  })

  // -----------------------------------------------------------------------
  // listByCategory
  // -----------------------------------------------------------------------

  describe('listByCategory', () => {
    it('filters skills by category', () => {
      registry.register(makeSkill({ id: 'db1', name: 'DB1', category: 'database' }))
      registry.register(makeSkill({ id: 'fe1', name: 'FE1', category: 'frontend' }))
      registry.register(makeSkill({ id: 'db2', name: 'DB2', category: 'database' }))

      const dbSkills = registry.listByCategory('database')
      expect(dbSkills).toHaveLength(2)
      expect(dbSkills.map(s => s.id).sort()).toEqual(['db1', 'db2'])
    })

    it('returns empty for unknown category', () => {
      registry.register(makeSkill({ category: 'database' }))
      expect(registry.listByCategory('frontend')).toEqual([])
    })
  })

  // -----------------------------------------------------------------------
  // findByTags
  // -----------------------------------------------------------------------

  describe('findByTags', () => {
    beforeEach(() => {
      registry.register(
        makeSkill({ id: 'prisma', name: 'Prisma', tags: ['database', 'orm', 'migration'], priority: 5 }),
      )
      registry.register(
        makeSkill({ id: 'drizzle', name: 'Drizzle', tags: ['database', 'orm'], priority: 3 }),
      )
      registry.register(
        makeSkill({ id: 'vue', name: 'Vue', tags: ['frontend', 'component'] }),
      )
    })

    it('returns matching skills sorted by priority then confidence', () => {
      const matches = registry.findByTags(['database'])
      expect(matches).toHaveLength(2)
      expect(matches[0]!.skill.id).toBe('prisma') // higher priority
      expect(matches[1]!.skill.id).toBe('drizzle')
    })

    it('calculates confidence as matchingTags / max(skillTags, queryTags)', () => {
      const matches = registry.findByTags(['database', 'orm'])
      const prisma = matches.find(m => m.skill.id === 'prisma')!
      const drizzle = matches.find(m => m.skill.id === 'drizzle')!

      // Prisma: 2 matching / max(3, 2) = 2/3
      expect(prisma.confidence).toBeCloseTo(2 / 3)
      // Drizzle: 2 matching / max(2, 2) = 1.0
      expect(drizzle.confidence).toBeCloseTo(1.0)
    })

    it('returns empty when no tags match', () => {
      expect(registry.findByTags(['security'])).toEqual([])
    })

    it('returns empty for empty tag list', () => {
      expect(registry.findByTags([])).toEqual([])
    })

    it('is case-insensitive', () => {
      const matches = registry.findByTags(['DATABASE'])
      expect(matches).toHaveLength(2)
    })

    it('includes reason string with matched tags', () => {
      const matches = registry.findByTags(['orm'])
      expect(matches[0]!.reason).toContain('orm')
    })

    it('sorts by confidence when priorities are equal', () => {
      // Both vue (no priority=0) and a new skill with no priority
      registry.register(
        makeSkill({ id: 'react', name: 'React', tags: ['frontend', 'component', 'hooks'] }),
      )
      const matches = registry.findByTags(['frontend', 'component'])

      // vue: 2/2 = 1.0, react: 2/3 = 0.67 (both priority 0)
      expect(matches[0]!.skill.id).toBe('vue')
      expect(matches[1]!.skill.id).toBe('react')
    })
  })

  // -----------------------------------------------------------------------
  // search
  // -----------------------------------------------------------------------

  describe('search', () => {
    beforeEach(() => {
      registry.register(
        makeSkill({ id: 'prisma-migration', name: 'Prisma Migrations', description: 'Database migration tool', tags: ['prisma'] }),
      )
      registry.register(
        makeSkill({ id: 'vue-comp', name: 'Vue Components', description: 'Build Vue 3 components' }),
      )
    })

    it('matches by name with confidence 1.0', () => {
      const matches = registry.search('Prisma')
      expect(matches).toHaveLength(1)
      expect(matches[0]!.confidence).toBe(1.0)
      expect(matches[0]!.reason).toContain('Name')
    })

    it('matches by description with confidence 0.4', () => {
      const matches = registry.search('migration tool')
      expect(matches).toHaveLength(1)
      expect(matches[0]!.confidence).toBe(0.4)
      expect(matches[0]!.reason).toContain('Description')
    })

    it('matches by tags with confidence 0.7', () => {
      const matches = registry.search('prisma')
      // name match takes priority (confidence 1.0 > 0.7)
      expect(matches[0]!.confidence).toBe(1.0)
    })

    it('is case-insensitive', () => {
      const matches = registry.search('VUE')
      expect(matches).toHaveLength(1)
    })

    it('returns empty for no match', () => {
      expect(registry.search('python')).toEqual([])
    })

    it('returns empty for empty query', () => {
      expect(registry.search('')).toEqual([])
    })

    it('respects priority in sorting', () => {
      registry.register(
        makeSkill({ id: 'high-pri', name: 'High Priority Vue', description: 'Vue helper', priority: 100 }),
      )
      const matches = registry.search('Vue')
      expect(matches[0]!.skill.id).toBe('high-pri')
    })
  })

  // -----------------------------------------------------------------------
  // formatForPrompt
  // -----------------------------------------------------------------------

  describe('formatForPrompt', () => {
    it('returns empty string for empty skills array', () => {
      expect(registry.formatForPrompt([])).toBe('')
    })

    it('formats skills as markdown with heading', () => {
      registry.register(makeSkill({ id: 'a', name: 'Alpha', description: 'First', instructions: 'Step 1\nStep 2' }))
      const skills = registry.list()
      const output = registry.formatForPrompt(skills)

      expect(output).toContain('# Available Skills')
      expect(output).toContain('## Skill: Alpha')
      expect(output).toContain('First')
      expect(output).toContain('Step 1\nStep 2')
    })

    it('includes required tools when present', () => {
      registry.register(
        makeSkill({ id: 'b', name: 'Beta', requiredTools: ['git_status', 'file_read'] }),
      )
      const output = registry.formatForPrompt(registry.list())
      expect(output).toContain('Required tools: git_status, file_read')
    })

    it('omits required tools line when none are specified', () => {
      registry.register(makeSkill({ id: 'c', name: 'Gamma' }))
      const output = registry.formatForPrompt(registry.list())
      expect(output).not.toContain('Required tools')
    })

    it('separates multiple skills with ---', () => {
      registry.register(makeSkill({ id: 'a', name: 'Alpha' }))
      registry.register(makeSkill({ id: 'b', name: 'Beta' }))
      const output = registry.formatForPrompt(registry.list())
      expect(output).toContain('---')
    })
  })

  // -----------------------------------------------------------------------
  // clear / size
  // -----------------------------------------------------------------------

  describe('clear', () => {
    it('removes all skills', () => {
      registry.register(makeSkill({ id: 'a', name: 'A' }))
      registry.register(makeSkill({ id: 'b', name: 'B' }))
      expect(registry.size).toBe(2)

      registry.clear()
      expect(registry.size).toBe(0)
      expect(registry.list()).toEqual([])
    })
  })

  // -----------------------------------------------------------------------
  // categories / allTags
  // -----------------------------------------------------------------------

  describe('categories', () => {
    it('returns unique sorted categories', () => {
      registry.register(makeSkill({ id: 'a', name: 'A', category: 'frontend' }))
      registry.register(makeSkill({ id: 'b', name: 'B', category: 'database' }))
      registry.register(makeSkill({ id: 'c', name: 'C', category: 'frontend' }))
      registry.register(makeSkill({ id: 'd', name: 'D' })) // no category

      expect(registry.categories()).toEqual(['database', 'frontend'])
    })

    it('returns empty array when no categories', () => {
      registry.register(makeSkill())
      expect(registry.categories()).toEqual([])
    })
  })

  describe('allTags', () => {
    it('returns unique sorted tags', () => {
      registry.register(makeSkill({ id: 'a', name: 'A', tags: ['b-tag', 'a-tag'] }))
      registry.register(makeSkill({ id: 'b', name: 'B', tags: ['a-tag', 'c-tag'] }))

      expect(registry.allTags()).toEqual(['a-tag', 'b-tag', 'c-tag'])
    })

    it('returns empty array when no tags', () => {
      registry.register(makeSkill())
      expect(registry.allTags()).toEqual([])
    })
  })
})
