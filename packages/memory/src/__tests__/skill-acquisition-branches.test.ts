import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SkillAcquisitionEngine } from '../skill-acquisition.js'
import type { ScanLesson, ScanRule } from '../skill-acquisition.js'
import type { BaseStore } from '@langchain/langgraph'

function createMockStore() {
  const data = new Map<string, Record<string, unknown>>()
  const store = {
    search: vi.fn(async (_ns: string[], opts?: { query?: string; limit?: number }) => {
      const items = [...data.entries()].map(([key, value]) => ({ key, value }))
      return items.slice(0, opts?.limit ?? items.length)
    }),
    put: vi.fn(async (_ns: string[], key: string, value: Record<string, unknown>) => {
      data.set(key, value)
    }),
    delete: vi.fn(async (_ns: string[], key: string) => {
      data.delete(key)
    }),
    get: vi.fn(async (_ns: string[], key: string) => {
      const value = data.get(key)
      return value ? { key, value } : undefined
    }),
    _data: data,
  }
  return store as unknown as BaseStore & {
    _data: Map<string, Record<string, unknown>>
    put: ReturnType<typeof vi.fn>
    get: ReturnType<typeof vi.fn>
    delete: ReturnType<typeof vi.fn>
    search: ReturnType<typeof vi.fn>
  }
}

function failingStore(): BaseStore {
  return {
    search: vi.fn().mockRejectedValue(new Error('fail')),
    put: vi.fn().mockRejectedValue(new Error('fail')),
    delete: vi.fn().mockRejectedValue(new Error('fail')),
    get: vi.fn().mockRejectedValue(new Error('fail')),
  } as unknown as BaseStore
}

const baseLesson = (o: Partial<ScanLesson> = {}): ScanLesson => ({
  id: 'lesson-1',
  summary: 'Always validate schema',
  confidence: 0.9,
  applyCount: 5,
  type: 'pattern',
  ...o,
})

const baseRule = (o: Partial<ScanRule> = {}): ScanRule => ({
  id: 'rule-1',
  content: 'never skip tests',
  confidence: 0.9,
  applyCount: 5,
  successRate: 0.9,
  scope: ['backend'],
  ...o,
})

describe('SkillAcquisitionEngine — branch targeting', () => {
  let store: ReturnType<typeof createMockStore>

  beforeEach(() => {
    store = createMockStore()
  })

  describe('scan — filter thresholds', () => {
    it('drops lessons below minConfidence', async () => {
      const engine = new SkillAcquisitionEngine({ store, minConfidence: 0.9 })
      const skills = await engine.scan({
        lessons: [baseLesson({ confidence: 0.5 })],
        rules: [],
      })
      expect(skills).toEqual([])
    })

    it('drops lessons below minUsageCount', async () => {
      const engine = new SkillAcquisitionEngine({ store, minUsageCount: 10 })
      const skills = await engine.scan({
        lessons: [baseLesson({ applyCount: 2 })],
        rules: [],
      })
      expect(skills).toEqual([])
    })

    it('drops rules below minSuccessRate', async () => {
      const engine = new SkillAcquisitionEngine({ store, minSuccessRate: 0.95 })
      const skills = await engine.scan({
        lessons: [],
        rules: [baseRule({ successRate: 0.5 })],
      })
      expect(skills).toEqual([])
    })

    it('drops rules below minConfidence', async () => {
      const engine = new SkillAcquisitionEngine({ store, minConfidence: 0.95 })
      const skills = await engine.scan({
        lessons: [],
        rules: [baseRule({ confidence: 0.5 })],
      })
      expect(skills).toEqual([])
    })

    it('crystallizes lessons meeting all thresholds', async () => {
      const engine = new SkillAcquisitionEngine({ store })
      const skills = await engine.scan({
        lessons: [baseLesson()],
        rules: [],
      })
      expect(skills.length).toBeGreaterThan(0)
      expect(skills[0]!.evidence.lessonIds).toContain('lesson-1')
    })

    it('crystallizes rules meeting all thresholds', async () => {
      const engine = new SkillAcquisitionEngine({ store })
      const skills = await engine.scan({
        lessons: [],
        rules: [baseRule()],
      })
      expect(skills.length).toBeGreaterThan(0)
      expect(skills[0]!.evidence.ruleIds).toContain('rule-1')
    })
  })

  describe('scan — dedup across existing + newly created', () => {
    it('skips a lesson that duplicates an existing skill (Jaccard > 0.7)', async () => {
      const engine = new SkillAcquisitionEngine({ store })
      // First scan creates a skill from one lesson
      await engine.scan({
        lessons: [
          baseLesson({
            id: 'l1',
            summary: 'Use Prisma for database access layer',
          }),
        ],
        rules: [],
      })

      // Second scan with nearly identical lesson — should be deduped
      const newSkills = await engine.scan({
        lessons: [
          baseLesson({
            id: 'l2',
            summary: 'Use Prisma for database access layer',
          }),
        ],
        rules: [],
      })
      expect(newSkills).toEqual([])
    })

    it('dedups rule against already-queued lesson within one scan', async () => {
      const engine = new SkillAcquisitionEngine({ store })
      const skills = await engine.scan({
        lessons: [baseLesson({ id: 'l1', summary: 'validate schema always' })],
        rules: [baseRule({ id: 'r1', content: 'validate schema always' })],
      })
      // Only one skill should be created
      expect(skills).toHaveLength(1)
    })
  })

  describe('scan — persistence error handling', () => {
    it('continues through store.put failures', async () => {
      const badStore = failingStore()
      const engine = new SkillAcquisitionEngine({ store: badStore })
      await expect(
        engine.scan({ lessons: [baseLesson()], rules: [] }),
      ).resolves.toBeDefined()
    })
  })

  describe('getSkills / getApplicableSkills', () => {
    it('returns empty array when none stored', async () => {
      const engine = new SkillAcquisitionEngine({ store })
      expect(await engine.getSkills()).toEqual([])
    })

    it('returns all skills when no filters provided', async () => {
      const engine = new SkillAcquisitionEngine({ store })
      await engine.scan({
        lessons: [baseLesson({ id: 'l1' })],
        rules: [],
      })
      const all = await engine.getApplicableSkills({})
      expect(all.length).toBeGreaterThan(0)
    })

    it('filters by nodeId (match on applicableWhen)', async () => {
      const engine = new SkillAcquisitionEngine({ store })
      await engine.scan({
        lessons: [baseLesson({ type: 'backend-worker' })],
        rules: [],
      })
      const matched = await engine.getApplicableSkills({ nodeId: 'backend' })
      expect(matched.length).toBeGreaterThan(0)
    })

    it('filters by taskType (match on applicableWhen)', async () => {
      const engine = new SkillAcquisitionEngine({ store })
      await engine.scan({
        lessons: [],
        rules: [baseRule({ scope: ['backend', 'validation'] })],
      })
      const matched = await engine.getApplicableSkills({ taskType: 'validation' })
      expect(matched.length).toBeGreaterThan(0)
    })

    it('returns empty when no filter matches', async () => {
      const engine = new SkillAcquisitionEngine({ store })
      await engine.scan({
        lessons: [baseLesson({ type: 'specific-node' })],
        rules: [],
      })
      const matched = await engine.getApplicableSkills({ nodeId: 'other' })
      expect(matched).toEqual([])
    })
  })

  describe('formatForPrompt', () => {
    it('returns empty string for empty array', () => {
      const engine = new SkillAcquisitionEngine({ store })
      expect(engine.formatForPrompt([])).toBe('')
    })

    it('renders header and bullets for populated skills', async () => {
      const engine = new SkillAcquisitionEngine({ store })
      const skills = await engine.scan({
        lessons: [baseLesson()],
        rules: [],
      })
      const out = engine.formatForPrompt(skills)
      expect(out).toContain('## Acquired Skills')
      expect(out).toContain('-')
    })
  })

  describe('markUsed', () => {
    it('no-ops when skill not found', async () => {
      const engine = new SkillAcquisitionEngine({ store })
      await expect(engine.markUsed('nope')).resolves.toBeUndefined()
    })

    it('updates lastUsedAt on existing skill', async () => {
      const engine = new SkillAcquisitionEngine({ store })
      const skills = await engine.scan({
        lessons: [baseLesson()],
        rules: [],
      })
      await engine.markUsed(skills[0]!.id)

      const all = await engine.getSkills()
      expect(all[0]!.lastUsedAt).toBeDefined()
    })

    it('swallows store errors', async () => {
      const badStore = failingStore()
      const engine = new SkillAcquisitionEngine({ store: badStore })
      await expect(engine.markUsed('any')).resolves.toBeUndefined()
    })
  })

  describe('removeSkill', () => {
    it('swallows errors when skill does not exist', async () => {
      const badStore = failingStore()
      const engine = new SkillAcquisitionEngine({ store: badStore })
      await expect(engine.removeSkill('nope')).resolves.toBeUndefined()
    })

    it('deletes an existing skill', async () => {
      const engine = new SkillAcquisitionEngine({ store })
      const skills = await engine.scan({
        lessons: [baseLesson()],
        rules: [],
      })
      await engine.removeSkill(skills[0]!.id)
      const remaining = await engine.getSkills()
      expect(remaining).toEqual([])
    })
  })

  describe('count', () => {
    it('returns 0 on error', async () => {
      const engine = new SkillAcquisitionEngine({ store: failingStore() })
      expect(await engine.count()).toBe(0)
    })

    it('returns correct count', async () => {
      const engine = new SkillAcquisitionEngine({ store })
      await engine.scan({
        lessons: [baseLesson({ id: 'a', summary: 'foo' })],
        rules: [baseRule({ id: 'b', content: 'totally different rule' })],
      })
      expect(await engine.count()).toBeGreaterThanOrEqual(2)
    })
  })

  describe('pruneIfNeeded', () => {
    it('does not prune when under maxSkills', async () => {
      const engine = new SkillAcquisitionEngine({ store, maxSkills: 10 })
      await engine.scan({
        lessons: [baseLesson({ id: 'a', summary: 'unique one' })],
        rules: [],
      })
      expect(await engine.count()).toBe(1)
    })

    it('prunes lowest-confidence skills when over maxSkills', async () => {
      const engine = new SkillAcquisitionEngine({ store, maxSkills: 1 })
      await engine.scan({
        lessons: [
          baseLesson({
            id: 'lo',
            summary: 'first unique lesson content',
            confidence: 0.81,
          }),
        ],
        rules: [
          baseRule({
            id: 'hi',
            content: 'completely different higher confidence rule',
            confidence: 0.99,
          }),
        ],
      })
      const skills = await engine.getSkills()
      // Only one should remain, the higher-confidence one
      expect(skills.length).toBeLessThanOrEqual(1)
      if (skills.length === 1) {
        expect(skills[0]!.confidence).toBeGreaterThanOrEqual(0.9)
      }
    })
  })
})
