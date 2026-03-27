import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SkillPackLoader, BUILT_IN_PACKS } from '../skill-packs.js'
import type { SkillPack } from '../skill-packs.js'
import type { BaseStore } from '@langchain/langgraph'

// ---------------------------------------------------------------------------
// Mock store factory — namespace-aware (mirrors real BaseStore behavior)
// ---------------------------------------------------------------------------

function createMockStore() {
  // Map<serializedNamespace, Map<key, record>>
  const namespaces = new Map<string, Map<string, Record<string, unknown>>>()

  function nsKey(ns: string[]): string {
    return ns.join('::')
  }

  function getOrCreateNs(ns: string[]): Map<string, Record<string, unknown>> {
    const k = nsKey(ns)
    let map = namespaces.get(k)
    if (!map) {
      map = new Map()
      namespaces.set(k, map)
    }
    return map
  }

  const store = {
    put: vi.fn().mockImplementation((ns: string[], key: string, value: Record<string, unknown>) => {
      getOrCreateNs(ns).set(key, value)
      return Promise.resolve()
    }),
    get: vi.fn().mockImplementation((ns: string[], key: string) => {
      const map = namespaces.get(nsKey(ns))
      if (!map) return Promise.resolve(undefined)
      const value = map.get(key)
      return Promise.resolve(value ? { key, value } : undefined)
    }),
    search: vi.fn().mockImplementation((ns: string[], _opts?: { limit?: number }) => {
      const map = namespaces.get(nsKey(ns))
      if (!map) return Promise.resolve([])
      const items = [...map.entries()].map(([key, value]) => ({ key, value }))
      return Promise.resolve(items.slice(0, _opts?.limit ?? items.length))
    }),
    delete: vi.fn().mockImplementation((ns: string[], key: string) => {
      const map = namespaces.get(nsKey(ns))
      if (map) map.delete(key)
      return Promise.resolve()
    }),
    _namespaces: namespaces,
    _getNamespaceMap(ns: string[]): Map<string, Record<string, unknown>> | undefined {
      return namespaces.get(nsKey(ns))
    },
  }

  return store as unknown as BaseStore & {
    _namespaces: Map<string, Map<string, Record<string, unknown>>>
    _getNamespaceMap: (ns: string[]) => Map<string, Record<string, unknown>> | undefined
    put: ReturnType<typeof vi.fn>
    get: ReturnType<typeof vi.fn>
    search: ReturnType<typeof vi.fn>
    delete: ReturnType<typeof vi.fn>
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeCustomPack(overrides: Partial<SkillPack> = {}): SkillPack {
  return {
    id: 'test-pack-v1',
    name: 'Test Pack',
    description: 'A test skill pack',
    featureCategory: 'testing',
    version: '1.0.0',
    entries: [
      {
        type: 'skill',
        content: 'Test skill entry',
        category: 'testing',
        scope: ['test'],
        confidence: 0.9,
      },
      {
        type: 'rule',
        content: 'Test rule entry',
        category: 'testing',
        scope: ['test'],
        confidence: 0.95,
      },
      {
        type: 'convention',
        content: 'Test convention entry',
        category: 'testing',
        scope: ['test'],
        confidence: 0.85,
      },
    ],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SkillPackLoader', () => {
  let store: ReturnType<typeof createMockStore>
  let loader: SkillPackLoader

  beforeEach(() => {
    store = createMockStore()
    loader = new SkillPackLoader(store)
  })

  // ---- Load a single pack ------------------------------------------------

  describe('loadPack', () => {
    it('loads a single pack and stores entries in correct namespaces', async () => {
      const pack = makeCustomPack()
      const result = await loader.loadPack(pack)

      expect(result.loaded).toBe(3)
      expect(result.skipped).toBe(0)

      // Skill stored in acquired_skills namespace
      const skillsNs = store._getNamespaceMap(['acquired_skills'])
      expect(skillsNs).toBeDefined()
      expect(skillsNs!.size).toBe(1)
      const skillEntry = skillsNs!.get('test-pack-v1_skill_0')
      expect(skillEntry).toBeDefined()
      expect(skillEntry!['content']).toBe('Test skill entry')
      expect(skillEntry!['packId']).toBe('test-pack-v1')
      expect(skillEntry!['text']).toBe('Test skill entry')

      // Rule stored in rules namespace
      const rulesNs = store._getNamespaceMap(['rules'])
      expect(rulesNs).toBeDefined()
      expect(rulesNs!.size).toBe(1)
      const ruleEntry = rulesNs!.get('test-pack-v1_rule_1')
      expect(ruleEntry).toBeDefined()
      expect(ruleEntry!['content']).toBe('Test rule entry')
      expect(ruleEntry!['source']).toBe('convention')

      // Convention stored in conventions namespace
      const convNs = store._getNamespaceMap(['conventions'])
      expect(convNs).toBeDefined()
      expect(convNs!.size).toBe(1)
      const convEntry = convNs!.get('test-pack-v1_convention_2')
      expect(convEntry).toBeDefined()
      expect(convEntry!['content']).toBe('Test convention entry')
    })

    it('stores metadata in skill_packs_meta namespace', async () => {
      const pack = makeCustomPack()
      await loader.loadPack(pack)

      const metaNs = store._getNamespaceMap(['skill_packs_meta'])
      expect(metaNs).toBeDefined()
      expect(metaNs!.has('test-pack-v1')).toBe(true)
      const meta = metaNs!.get('test-pack-v1')!
      expect(meta['name']).toBe('Test Pack')
      expect(meta['version']).toBe('1.0.0')
      expect(meta['entryCount']).toBe(3)
    })
  })

  // ---- Idempotent loading ------------------------------------------------

  describe('idempotent loading', () => {
    it('skips all entries when pack is already loaded', async () => {
      const pack = makeCustomPack()

      const first = await loader.loadPack(pack)
      expect(first.loaded).toBe(3)
      expect(first.skipped).toBe(0)

      const second = await loader.loadPack(pack)
      expect(second.loaded).toBe(0)
      expect(second.skipped).toBe(3)

      // Store.put should not have been called again for entries
      // First load: 3 entries + 1 metadata = 4 calls
      // Second load: 0 additional calls
      expect(store.put).toHaveBeenCalledTimes(4)
    })
  })

  // ---- Load all built-in packs -------------------------------------------

  describe('loadAllBuiltIn', () => {
    it('loads all 6 built-in packs', async () => {
      const result = await loader.loadAllBuiltIn()

      expect(result.packsLoaded).toBe(6)

      const totalEntries = BUILT_IN_PACKS.reduce((sum, p) => sum + p.entries.length, 0)
      expect(result.totalEntries).toBe(totalEntries)
    })

    it('does not reload on second call', async () => {
      await loader.loadAllBuiltIn()
      const second = await loader.loadAllBuiltIn()

      expect(second.packsLoaded).toBe(0)
      expect(second.totalEntries).toBe(0)
    })
  })

  // ---- isPackLoaded ------------------------------------------------------

  describe('isPackLoaded', () => {
    it('returns false for unloaded pack', async () => {
      const loaded = await loader.isPackLoaded('nonexistent-pack')
      expect(loaded).toBe(false)
    })

    it('returns true after loading a pack', async () => {
      const pack = makeCustomPack()
      await loader.loadPack(pack)

      const loaded = await loader.isPackLoaded('test-pack-v1')
      expect(loaded).toBe(true)
    })

    it('returns false gracefully when store throws', async () => {
      store.get.mockRejectedValueOnce(new Error('store failure'))
      const loaded = await loader.isPackLoaded('test-pack-v1')
      expect(loaded).toBe(false)
    })
  })

  // ---- getLoadedPacks ----------------------------------------------------

  describe('getLoadedPacks', () => {
    it('returns empty array when no packs loaded', async () => {
      const packs = await loader.getLoadedPacks()
      expect(packs).toEqual([])
    })

    it('returns list of loaded pack IDs', async () => {
      await loader.loadPack(makeCustomPack({ id: 'pack-a' }))
      await loader.loadPack(makeCustomPack({ id: 'pack-b' }))

      const packs = await loader.getLoadedPacks()
      expect(packs).toContain('pack-a')
      expect(packs).toContain('pack-b')
      expect(packs).toHaveLength(2)
    })

    it('returns empty array gracefully when store throws', async () => {
      store.search.mockRejectedValueOnce(new Error('store failure'))
      const packs = await loader.getLoadedPacks()
      expect(packs).toEqual([])
    })
  })

  // ---- unloadPack --------------------------------------------------------

  describe('unloadPack', () => {
    it('removes entries and metadata for a built-in pack', async () => {
      const pack = makeCustomPack()
      await loader.loadPack(pack)

      // Verify entries exist
      expect(store._getNamespaceMap(['acquired_skills'])!.size).toBe(1)
      expect(store._getNamespaceMap(['rules'])!.size).toBe(1)
      expect(store._getNamespaceMap(['conventions'])!.size).toBe(1)

      const removed = await loader.unloadPack('test-pack-v1')
      expect(removed).toBe(3)

      // Entries gone
      expect(store._getNamespaceMap(['acquired_skills'])!.size).toBe(0)
      expect(store._getNamespaceMap(['rules'])!.size).toBe(0)
      expect(store._getNamespaceMap(['conventions'])!.size).toBe(0)

      // Metadata gone
      const loaded = await loader.isPackLoaded('test-pack-v1')
      expect(loaded).toBe(false)
    })

    it('returns 0 when unloading a pack that was never loaded', async () => {
      const removed = await loader.unloadPack('nonexistent-pack')
      expect(removed).toBe(0)
    })
  })

  // ---- Pack structure validation -----------------------------------------

  describe('pack structure validation', () => {
    it('all 6 built-in packs have valid structure', () => {
      expect(BUILT_IN_PACKS).toHaveLength(6)

      for (const pack of BUILT_IN_PACKS) {
        expect(pack.id).toBeTruthy()
        expect(pack.name).toBeTruthy()
        expect(pack.description).toBeTruthy()
        expect(pack.featureCategory).toBeTruthy()
        expect(pack.version).toBeTruthy()
        expect(pack.entries.length).toBeGreaterThan(0)

        for (const entry of pack.entries) {
          expect(['skill', 'convention', 'rule']).toContain(entry.type)
          expect(entry.content).toBeTruthy()
          expect(entry.confidence).toBeGreaterThan(0)
          expect(entry.confidence).toBeLessThanOrEqual(1)
        }
      }
    })

    it('each built-in pack has at least one entry of each type present across all packs', () => {
      const allTypes = new Set<string>()
      for (const pack of BUILT_IN_PACKS) {
        for (const entry of pack.entries) {
          allTypes.add(entry.type)
        }
      }
      expect(allTypes).toContain('skill')
      expect(allTypes).toContain('rule')
      expect(allTypes).toContain('convention')
    })

    it('all packs have unique IDs', () => {
      const ids = BUILT_IN_PACKS.map(p => p.id)
      expect(new Set(ids).size).toBe(ids.length)
    })
  })

  // ---- Entries stored in correct namespaces ------------------------------

  describe('entry namespace correctness', () => {
    it('skills go to acquired_skills namespace', async () => {
      const pack = BUILT_IN_PACKS.find(p => p.id === 'auth-pack-v1')!
      await loader.loadPack(pack)

      const skillsNs = store._getNamespaceMap(['acquired_skills'])
      expect(skillsNs).toBeDefined()

      const skillEntries = pack.entries.filter(e => e.type === 'skill')
      expect(skillsNs!.size).toBe(skillEntries.length)

      for (const [, value] of skillsNs!) {
        // Verify it has AcquiredSkill-compatible fields
        expect(value['applicationType']).toBe('prompt_injection')
        expect(value['evidence']).toBeDefined()
        expect(value['text']).toBeTruthy()
      }
    })

    it('rules go to rules namespace', async () => {
      const pack = BUILT_IN_PACKS.find(p => p.id === 'auth-pack-v1')!
      await loader.loadPack(pack)

      const rulesNs = store._getNamespaceMap(['rules'])
      expect(rulesNs).toBeDefined()

      const ruleEntries = pack.entries.filter(e => e.type === 'rule')
      expect(rulesNs!.size).toBe(ruleEntries.length)

      for (const [, value] of rulesNs!) {
        // Verify it has Rule-compatible fields
        expect(value['source']).toBe('convention')
        expect(value['applyCount']).toBe(0)
        expect(value['successRate']).toBe(1)
        expect(value['text']).toBeTruthy()
      }
    })

    it('conventions go to conventions namespace', async () => {
      const pack = BUILT_IN_PACKS.find(p => p.id === 'auth-pack-v1')!
      await loader.loadPack(pack)

      const convNs = store._getNamespaceMap(['conventions'])
      expect(convNs).toBeDefined()

      const convEntries = pack.entries.filter(e => e.type === 'convention')
      expect(convNs!.size).toBe(convEntries.length)

      for (const [, value] of convNs!) {
        expect(value['content']).toBeTruthy()
        expect(value['text']).toBeTruthy()
      }
    })
  })

  // ---- Custom namespace prefix -------------------------------------------

  describe('custom namespace prefix', () => {
    it('prepends namespace prefix to all store operations', async () => {
      const customLoader = new SkillPackLoader(store, ['tenant', 'abc'])
      const pack = makeCustomPack()
      await customLoader.loadPack(pack)

      // Entries stored under prefixed namespaces
      const skillsNs = store._getNamespaceMap(['tenant', 'abc', 'acquired_skills'])
      expect(skillsNs).toBeDefined()
      expect(skillsNs!.size).toBe(1)

      const metaNs = store._getNamespaceMap(['tenant', 'abc', 'skill_packs_meta'])
      expect(metaNs).toBeDefined()
      expect(metaNs!.has('test-pack-v1')).toBe(true)
    })
  })

  // ---- Error resilience --------------------------------------------------

  describe('error resilience', () => {
    it('continues loading remaining entries when one store.put fails', async () => {
      let callCount = 0
      store.put.mockImplementation((ns: string[], key: string, value: Record<string, unknown>) => {
        callCount++
        // Fail on the second put
        if (callCount === 2) {
          return Promise.reject(new Error('transient failure'))
        }
        const nsKey = ns.join('::')
        let map = store._namespaces.get(nsKey)
        if (!map) {
          map = new Map()
          store._namespaces.set(nsKey, map)
        }
        map.set(key, value)
        return Promise.resolve()
      })

      const pack = makeCustomPack()
      const result = await loader.loadPack(pack)

      // 3 entries attempted, 1 failed, so 2 loaded
      expect(result.loaded).toBe(2)
    })
  })
})
