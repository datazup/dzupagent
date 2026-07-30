/* eslint-disable no-restricted-syntax -- These are BaseStore doubles, not memory
 * services. The whole point of this file is a store whose reads REJECT, which
 * createMemoryHarness() (a real MemoryService over a working InMemoryStore)
 * cannot express. Assertions read the backing Map and put() effects, never a
 * spy call count, so the rule's rationale does not apply here. */
import { describe, it, expect, vi } from 'vitest'
import { SkillAcquisitionEngine } from '../skill-acquisition.js'
import type { ScanLesson } from '../skill-acquisition.js'
import type { BaseStore } from '@langchain/langgraph'

function createMockStore() {
  const data = new Map<string, Record<string, unknown>>()
  const store = {
    search: vi.fn(async (_ns: string[], opts?: { limit?: number }) => {
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
  }
}

/** Reads fail, writes succeed — isolates the read path from the write path. */
function unreadableStore() {
  const data = new Map<string, Record<string, unknown>>()
  const store = {
    search: vi.fn().mockRejectedValue(new Error('store unavailable')),
    put: vi.fn(async (_ns: string[], key: string, value: Record<string, unknown>) => {
      data.set(key, value)
    }),
    delete: vi.fn(async () => {}),
    get: vi.fn().mockRejectedValue(new Error('store unavailable')),
    _data: data,
  }
  return store as unknown as BaseStore & {
    _data: Map<string, Record<string, unknown>>
    put: ReturnType<typeof vi.fn>
  }
}

const baseLesson = (o: Partial<ScanLesson> = {}): ScanLesson => ({
  id: 'lesson-1',
  summary: 'Always validate schema',
  confidence: 0.9,
  applyCount: 5,
  type: 'pattern',
  ...o,
})

describe('SkillAcquisitionEngine — an unreadable store is not an empty one', () => {
  describe('scan — will not re-crystallize against an unverifiable corpus', () => {
    it('acquires nothing when existing skills cannot be read', async () => {
      const store = unreadableStore()
      const engine = new SkillAcquisitionEngine({ store })

      const skills = await engine.scan({ lessons: [baseLesson()], rules: [] })

      // isDuplicate() would return false for every candidate, so scanning here
      // would duplicate every already-crystallized skill and report each as a
      // new discovery.
      expect(skills).toEqual([])
      expect(store.put).not.toHaveBeenCalled()
    })

    it('still acquires skills when the corpus is readable', async () => {
      // The converse: proves the guard rejects only the unreadable case
      // rather than disabling acquisition outright.
      const store = createMockStore()
      const engine = new SkillAcquisitionEngine({ store })

      const skills = await engine.scan({ lessons: [baseLesson()], rules: [] })

      expect(skills).toHaveLength(1)
      expect(store.put).toHaveBeenCalled()
    })

    it('still dedups against a readable corpus on a second scan', async () => {
      const store = createMockStore()
      const engine = new SkillAcquisitionEngine({ store })

      await engine.scan({ lessons: [baseLesson()], rules: [] })
      const second = await engine.scan({ lessons: [baseLesson()], rules: [] })

      expect(second).toEqual([])
      expect(await engine.count()).toBe(1)
    })
  })

  describe('retrieveApplicableSkills', () => {
    it('reports skillsUnavailable when the store cannot be read', async () => {
      const engine = new SkillAcquisitionEngine({ store: unreadableStore() })

      const result = await engine.retrieveApplicableSkills({})

      expect(result.skillsUnavailable).toBe(true)
      expect(result.skills).toEqual([])
    })

    it('reports skillsUnavailable as false for a genuinely empty store', async () => {
      const engine = new SkillAcquisitionEngine({ store: createMockStore() })

      const result = await engine.retrieveApplicableSkills({})

      expect(result.skillsUnavailable).toBe(false)
      expect(result.skills).toEqual([])
    })

    it('reports skillsUnavailable as false when skills are returned', async () => {
      const engine = new SkillAcquisitionEngine({ store: createMockStore() })
      await engine.scan({ lessons: [baseLesson()], rules: [] })

      const result = await engine.retrieveApplicableSkills({})

      expect(result.skillsUnavailable).toBe(false)
      expect(result.skills).toHaveLength(1)
    })

    it('distinguishes an outage from an agent that has acquired nothing', async () => {
      const empty = await new SkillAcquisitionEngine({
        store: createMockStore(),
      }).retrieveApplicableSkills({})
      const outage = await new SkillAcquisitionEngine({
        store: unreadableStore(),
      }).retrieveApplicableSkills({})

      expect(empty.skills).toEqual(outage.skills)
      expect(empty.skillsUnavailable).not.toBe(outage.skillsUnavailable)
    })
  })

  describe('the pinned non-fatal contracts still hold', () => {
    it('getApplicableSkills still resolves to a bare array', async () => {
      const engine = new SkillAcquisitionEngine({ store: unreadableStore() })
      await expect(engine.getApplicableSkills({})).resolves.toEqual([])
    })

    it('getSkills still resolves to a bare array', async () => {
      const engine = new SkillAcquisitionEngine({ store: unreadableStore() })
      await expect(engine.getSkills()).resolves.toEqual([])
    })

    it('count still returns 0 on a failing store', async () => {
      const engine = new SkillAcquisitionEngine({ store: unreadableStore() })
      expect(await engine.count()).toBe(0)
    })
  })
})
