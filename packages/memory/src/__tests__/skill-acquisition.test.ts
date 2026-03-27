import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SkillAcquisitionEngine } from '../skill-acquisition.js'
import type { AcquiredSkill, ScanLesson, ScanRule } from '../skill-acquisition.js'
import type { BaseStore } from '@langchain/langgraph'

// ---------------------------------------------------------------------------
// Mock store factory (mirrors lesson-pipeline.test.ts pattern)
// ---------------------------------------------------------------------------

function createMockStore() {
  const data = new Map<string, Record<string, unknown>>()

  const store = {
    search: vi.fn().mockImplementation((_ns: string[], opts?: { query?: string; limit?: number }) => {
      const items = [...data.entries()].map(([key, value]) => ({ key, value }))
      return Promise.resolve(items.slice(0, opts?.limit ?? items.length))
    }),
    put: vi.fn().mockImplementation((_ns: string[], key: string, value: Record<string, unknown>) => {
      data.set(key, value)
      return Promise.resolve()
    }),
    delete: vi.fn().mockImplementation((_ns: string[], key: string) => {
      data.delete(key)
      return Promise.resolve()
    }),
    get: vi.fn().mockImplementation((_ns: string[], key: string) => {
      const value = data.get(key)
      return Promise.resolve(value ? { key, value } : undefined)
    }),
    _data: data,
  }

  return store as unknown as BaseStore & {
    _data: Map<string, Record<string, unknown>>
    put: ReturnType<typeof vi.fn>
    get: ReturnType<typeof vi.fn>
    search: ReturnType<typeof vi.fn>
    delete: ReturnType<typeof vi.fn>
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLesson(overrides: Partial<ScanLesson> = {}): ScanLesson {
  return {
    id: 'lesson-1',
    summary: 'Always validate Prisma schema before migration',
    confidence: 0.9,
    applyCount: 5,
    type: 'gen_backend',
    ...overrides,
  }
}

function makeRule(overrides: Partial<ScanRule> = {}): ScanRule {
  return {
    id: 'rule-1',
    content: 'When ValidationError occurs at gen_backend: check schema types first',
    confidence: 0.85,
    applyCount: 4,
    successRate: 0.9,
    scope: ['gen_backend', 'validation'],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SkillAcquisitionEngine', () => {
  let store: ReturnType<typeof createMockStore>
  let engine: SkillAcquisitionEngine

  beforeEach(() => {
    store = createMockStore()
    engine = new SkillAcquisitionEngine({ store })
  })

  // ---- scan with qualifying lessons ----------------------------------------

  describe('scan — qualifying lessons', () => {
    it('should create skills from high-confidence, frequently-applied lessons', async () => {
      const lessons = [makeLesson()]
      const skills = await engine.scan({ lessons, rules: [] })

      expect(skills).toHaveLength(1)
      expect(skills[0].applicationType).toBe('prompt_injection')
      expect(skills[0].content).toBe('Always validate Prisma schema before migration')
      expect(skills[0].evidence.lessonIds).toEqual(['lesson-1'])
      expect(skills[0].confidence).toBe(0.9)

      // Should be persisted in the store
      const count = await engine.count()
      expect(count).toBe(1)
    })

    it('should generate a name from the first 5 words of the description', async () => {
      const lessons = [makeLesson({ summary: 'Always validate Prisma schema before running migrations in production' })]
      const skills = await engine.scan({ lessons, rules: [] })

      expect(skills[0].name).toBe('Always validate Prisma schema before')
    })

    it('should generate unique skill IDs with skill_ prefix', async () => {
      const lessons = [
        makeLesson({ id: 'l1', summary: 'Lesson one about backend validation' }),
        makeLesson({ id: 'l2', summary: 'Lesson two about frontend testing patterns' }),
      ]
      const skills = await engine.scan({ lessons, rules: [] })

      expect(skills).toHaveLength(2)
      expect(skills[0].id).toMatch(/^skill_\d+_[a-z0-9]+$/)
      expect(skills[1].id).toMatch(/^skill_\d+_[a-z0-9]+$/)
      expect(skills[0].id).not.toBe(skills[1].id)
    })
  })

  // ---- scan with low-confidence lessons ------------------------------------

  describe('scan — low-confidence lessons', () => {
    it('should not create skills from low-confidence lessons', async () => {
      const lessons = [makeLesson({ confidence: 0.4 })]
      const skills = await engine.scan({ lessons, rules: [] })
      expect(skills).toHaveLength(0)
    })

    it('should not create skills from low-usage lessons', async () => {
      const lessons = [makeLesson({ applyCount: 1 })]
      const skills = await engine.scan({ lessons, rules: [] })
      expect(skills).toHaveLength(0)
    })

    it('should respect custom minConfidence and minUsageCount', async () => {
      const customEngine = new SkillAcquisitionEngine({
        store,
        minConfidence: 0.95,
        minUsageCount: 10,
      })
      const lessons = [makeLesson({ confidence: 0.9, applyCount: 5 })]
      const skills = await customEngine.scan({ lessons, rules: [] })
      expect(skills).toHaveLength(0)
    })
  })

  // ---- scan with qualifying rules ------------------------------------------

  describe('scan — qualifying rules', () => {
    it('should create skills from high-confidence, successful rules', async () => {
      const rules = [makeRule()]
      const skills = await engine.scan({ lessons: [], rules })

      expect(skills).toHaveLength(1)
      expect(skills[0].applicationType).toBe('prompt_injection')
      expect(skills[0].content).toContain('ValidationError')
      expect(skills[0].evidence.ruleIds).toEqual(['rule-1'])
      expect(skills[0].applicableWhen).toBe('gen_backend, validation')
    })

    it('should not create skills from rules below minSuccessRate', async () => {
      const rules = [makeRule({ successRate: 0.5 })]
      const skills = await engine.scan({ lessons: [], rules })
      expect(skills).toHaveLength(0)
    })

    it('should not create skills from rules below minConfidence', async () => {
      const rules = [makeRule({ confidence: 0.3 })]
      const skills = await engine.scan({ lessons: [], rules })
      expect(skills).toHaveLength(0)
    })

    it('should not create skills from rules below minUsageCount', async () => {
      const rules = [makeRule({ applyCount: 1 })]
      const skills = await engine.scan({ lessons: [], rules })
      expect(skills).toHaveLength(0)
    })
  })

  // ---- dedup ---------------------------------------------------------------

  describe('scan — deduplication', () => {
    it('should not create duplicate skills with similar content', async () => {
      // First scan
      const lessons1 = [makeLesson({ id: 'l1', summary: 'Always validate Prisma schema before migration' })]
      const skills1 = await engine.scan({ lessons: lessons1, rules: [] })
      expect(skills1).toHaveLength(1)

      // Second scan with very similar lesson
      const lessons2 = [makeLesson({ id: 'l2', summary: 'Always validate the Prisma schema before a migration' })]
      const skills2 = await engine.scan({ lessons: lessons2, rules: [] })
      expect(skills2).toHaveLength(0)

      // Total should still be 1
      const count = await engine.count()
      expect(count).toBe(1)
    })

    it('should create skills for genuinely different content', async () => {
      const lessons = [
        makeLesson({ id: 'l1', summary: 'Always validate Prisma schema before migration' }),
        makeLesson({ id: 'l2', summary: 'Use try-catch blocks around all database operations for safety' }),
      ]
      const skills = await engine.scan({ lessons, rules: [] })
      expect(skills).toHaveLength(2)
    })

    it('should dedup within the same scan batch (lessons vs rules)', async () => {
      const lessons = [makeLesson({ summary: 'Check schema types first when ValidationError occurs at gen_backend' })]
      const rules = [makeRule({ content: 'When ValidationError occurs at gen_backend: check schema types first' })]

      const skills = await engine.scan({ lessons, rules })
      // These are very similar — only one should be created
      expect(skills).toHaveLength(1)
    })
  })

  // ---- getApplicableSkills -------------------------------------------------

  describe('getApplicableSkills', () => {
    it('should return skills matching by nodeId', async () => {
      await engine.scan({
        lessons: [makeLesson({ type: 'gen_backend' })],
        rules: [],
      })

      const applicable = await engine.getApplicableSkills({ nodeId: 'gen_backend' })
      expect(applicable).toHaveLength(1)
    })

    it('should return skills matching by taskType', async () => {
      const rules = [makeRule({ scope: ['validation', 'testing'] })]
      await engine.scan({ lessons: [], rules })

      const applicable = await engine.getApplicableSkills({ taskType: 'validation' })
      expect(applicable).toHaveLength(1)
    })

    it('should return empty for non-matching context', async () => {
      await engine.scan({
        lessons: [makeLesson({ type: 'gen_backend' })],
        rules: [],
      })

      const applicable = await engine.getApplicableSkills({ nodeId: 'gen_frontend' })
      expect(applicable).toHaveLength(0)
    })

    it('should return all skills when no filter is provided', async () => {
      await engine.scan({
        lessons: [makeLesson()],
        rules: [makeRule({ content: 'Completely different rule about testing frameworks' })],
      })

      const applicable = await engine.getApplicableSkills({})
      expect(applicable).toHaveLength(2)
    })

    it('should match case-insensitively', async () => {
      await engine.scan({
        lessons: [makeLesson({ type: 'Gen_Backend' })],
        rules: [],
      })

      const applicable = await engine.getApplicableSkills({ nodeId: 'gen_backend' })
      expect(applicable).toHaveLength(1)
    })
  })

  // ---- formatForPrompt -----------------------------------------------------

  describe('formatForPrompt', () => {
    it('should format skills as markdown', async () => {
      const skills = await engine.scan({
        lessons: [makeLesson()],
        rules: [],
      })

      const prompt = engine.formatForPrompt(skills)
      expect(prompt).toContain('## Acquired Skills')
      expect(prompt).toContain('Always validate Prisma schema before migration')
    })

    it('should return empty string for empty skills array', () => {
      const prompt = engine.formatForPrompt([])
      expect(prompt).toBe('')
    })

    it('should include skill name and content in each line', async () => {
      const skills = await engine.scan({
        lessons: [makeLesson({ summary: 'Use strict TypeScript settings always' })],
        rules: [],
      })

      const prompt = engine.formatForPrompt(skills)
      expect(prompt).toContain('[Use strict TypeScript settings always]:')
      expect(prompt).toContain('Use strict TypeScript settings always')
    })
  })

  // ---- markUsed ------------------------------------------------------------

  describe('markUsed', () => {
    it('should update lastUsedAt when marking a skill as used', async () => {
      const skills = await engine.scan({
        lessons: [makeLesson()],
        rules: [],
      })
      expect(skills[0].lastUsedAt).toBeUndefined()

      await engine.markUsed(skills[0].id)

      const allSkills = await engine.getSkills()
      expect(allSkills[0].lastUsedAt).toBeInstanceOf(Date)
    })

    it('should not throw for non-existent skill', async () => {
      await expect(engine.markUsed('non-existent')).resolves.not.toThrow()
    })
  })

  // ---- removeSkill ---------------------------------------------------------

  describe('removeSkill', () => {
    it('should remove a skill from the store', async () => {
      const skills = await engine.scan({
        lessons: [makeLesson()],
        rules: [],
      })
      expect(await engine.count()).toBe(1)

      await engine.removeSkill(skills[0].id)
      expect(await engine.count()).toBe(0)
    })

    it('should not throw for non-existent skill', async () => {
      await expect(engine.removeSkill('non-existent')).resolves.not.toThrow()
    })
  })

  // ---- count ---------------------------------------------------------------

  describe('count', () => {
    it('should return 0 for empty store', async () => {
      expect(await engine.count()).toBe(0)
    })

    it('should return correct count after scanning', async () => {
      await engine.scan({
        lessons: [
          makeLesson({ id: 'l1', summary: 'Lesson about backend validation patterns' }),
          makeLesson({ id: 'l2', summary: 'Lesson about frontend component testing' }),
        ],
        rules: [],
      })

      expect(await engine.count()).toBe(2)
    })
  })

  // ---- maxSkills limit (pruning) -------------------------------------------

  describe('maxSkills pruning', () => {
    it('should prune lowest-confidence skills when exceeding maxSkills', async () => {
      const smallEngine = new SkillAcquisitionEngine({
        store,
        maxSkills: 2,
        minConfidence: 0.8,
        minUsageCount: 3,
      })

      const lessons: ScanLesson[] = [
        makeLesson({ id: 'l1', summary: 'First lesson about database indexing strategies', confidence: 0.85 }),
        makeLesson({ id: 'l2', summary: 'Second lesson about API response formatting', confidence: 0.95 }),
        makeLesson({ id: 'l3', summary: 'Third lesson about error handling in middleware', confidence: 0.9 }),
      ]

      await smallEngine.scan({ lessons, rules: [] })

      // Should have pruned down to 2
      const count = await smallEngine.count()
      expect(count).toBe(2)

      // The two highest-confidence skills should remain (0.95 and 0.9)
      const remaining = await smallEngine.getSkills()
      const confidences = remaining.map(s => s.confidence).sort((a, b) => b - a)
      expect(confidences).toEqual([0.95, 0.9])
    })
  })

  // ---- getSkills -----------------------------------------------------------

  describe('getSkills', () => {
    it('should return all stored skills', async () => {
      await engine.scan({
        lessons: [makeLesson()],
        rules: [makeRule({ content: 'Completely different rule about testing frameworks' })],
      })

      const skills = await engine.getSkills()
      expect(skills).toHaveLength(2)
    })

    it('should return empty array for empty store', async () => {
      const skills = await engine.getSkills()
      expect(skills).toHaveLength(0)
    })
  })

  // ---- store error resilience ----------------------------------------------

  describe('error resilience', () => {
    it('should handle store.search failures gracefully', async () => {
      store.search.mockRejectedValueOnce(new Error('store down'))
      const count = await engine.count()
      expect(count).toBe(0)
    })

    it('should handle store.put failures gracefully during scan', async () => {
      store.put.mockRejectedValue(new Error('write failed'))
      const skills = await engine.scan({ lessons: [makeLesson()], rules: [] })
      // Skills are still returned (created in memory), just not persisted
      expect(skills).toHaveLength(1)
    })
  })
})
