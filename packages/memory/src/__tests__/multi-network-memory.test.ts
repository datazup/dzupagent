import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  MultiNetworkMemory,
  DEFAULT_NETWORK_CONFIGS,
} from '../multi-network-memory.js'
import type {
  MultiNetworkMemoryConfig,
  MemoryNetwork,
} from '../multi-network-memory.js'
import type { MemoryService } from '../memory-service.js'

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function createMockMemoryService(): MemoryService {
  return {
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue([]),
    search: vi.fn().mockResolvedValue([]),
  } as unknown as MemoryService
}

function createMultiNet(
  memoryService?: MemoryService,
): { mnm: MultiNetworkMemory; memory: MemoryService } {
  const memory = memoryService ?? createMockMemoryService()
  const mnm = new MultiNetworkMemory({
    memoryService: memory,
    scope: { tenantId: 't1' },
  })
  return { mnm, memory }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MultiNetworkMemory', () => {
  let mnm: MultiNetworkMemory
  let memory: MemoryService

  beforeEach(() => {
    const created = createMultiNet()
    mnm = created.mnm
    memory = created.memory
  })

  // ---- Constructor --------------------------------------------------------

  describe('constructor', () => {
    it('should initialize 4 networks from defaults', () => {
      const networks = mnm.getNetworks()
      expect(networks).toHaveLength(4)
      const names = networks.map(n => n.network).sort()
      expect(names).toEqual(['entity', 'experiential', 'factual', 'opinion'])
    })

    it('should accept custom network configs', () => {
      const custom = new MultiNetworkMemory({
        memoryService: createMockMemoryService(),
        scope: { tenantId: 't1' },
        networks: [DEFAULT_NETWORK_CONFIGS[0]!],
      })
      expect(custom.getNetworks()).toHaveLength(1)
    })
  })

  // ---- put() --------------------------------------------------------------

  describe('put()', () => {
    it('should add _network metadata to stored value', async () => {
      await mnm.put('factual', 'k1', { text: 'fact' })

      const put = memory.put as ReturnType<typeof vi.fn>
      expect(put).toHaveBeenCalledOnce()

      const [ns, scope, key, value] = put.mock.calls[0]!
      expect(ns).toBe('net-factual')
      expect(scope).toEqual({ tenantId: 't1' })
      expect(key).toBe('k1')
      expect(value._network).toBe('factual')
      expect(value.text).toBe('fact')
    })

    it('should throw for unknown network', async () => {
      await expect(
        mnm.put('bogus' as MemoryNetwork, 'k1', { text: 'x' }),
      ).rejects.toThrow('Unknown network')
    })
  })

  // ---- get() --------------------------------------------------------------

  describe('get()', () => {
    it('should delegate to correct namespace', async () => {
      const records = [{ text: 'experience data' }]
      ;(memory.get as ReturnType<typeof vi.fn>).mockResolvedValue(records)

      const result = await mnm.get('experiential', 'k1')
      const get = memory.get as ReturnType<typeof vi.fn>
      expect(get).toHaveBeenCalledWith('net-experiential', { tenantId: 't1' }, 'k1')
      expect(result).toEqual(records)
    })

    it('should call without key when key is omitted', async () => {
      await mnm.get('factual')
      const get = memory.get as ReturnType<typeof vi.fn>
      expect(get).toHaveBeenCalledWith('net-factual', { tenantId: 't1' }, undefined)
    })

    it('should throw for unknown network', async () => {
      await expect(mnm.get('bogus' as MemoryNetwork)).rejects.toThrow('Unknown network')
    })
  })

  // ---- search() -----------------------------------------------------------

  describe('search()', () => {
    it('should delegate to correct namespace', async () => {
      const results = [{ text: 'opinion data' }]
      ;(memory.search as ReturnType<typeof vi.fn>).mockResolvedValue(results)

      const result = await mnm.search('opinion', 'best framework', 3)
      const search = memory.search as ReturnType<typeof vi.fn>
      expect(search).toHaveBeenCalledWith('net-opinion', { tenantId: 't1' }, 'best framework', 3)
      expect(result).toEqual(results)
    })

    it('should default limit to 10', async () => {
      await mnm.search('factual', 'query')
      const search = memory.search as ReturnType<typeof vi.fn>
      expect(search.mock.calls[0]![3]).toBe(10)
    })
  })

  // ---- searchAll() --------------------------------------------------------

  describe('searchAll()', () => {
    it('should search all 4 networks and merge results sorted by score', async () => {
      const search = memory.search as ReturnType<typeof vi.fn>
      // Each network returns 1 result
      search.mockImplementation((ns: string) => {
        if (ns === 'net-factual') return Promise.resolve([{ key: 'f1', text: 'fact' }])
        if (ns === 'net-experiential') return Promise.resolve([{ key: 'e1', text: 'exp' }])
        if (ns === 'net-opinion') return Promise.resolve([{ key: 'o1', text: 'opinion' }])
        if (ns === 'net-entity') return Promise.resolve([{ key: 'en1', text: 'entity' }])
        return Promise.resolve([])
      })

      const results = await mnm.searchAll('test query', 10)
      expect(results).toHaveLength(4)

      // Results should be sorted by score descending
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score)
      }

      // Each result should have a network tag
      const networks = new Set(results.map(r => r.network))
      expect(networks.size).toBe(4)
    })

    it('should still return results when one network fails', async () => {
      const search = memory.search as ReturnType<typeof vi.fn>
      let callCount = 0
      search.mockImplementation(() => {
        callCount++
        if (callCount === 2) return Promise.reject(new Error('network down'))
        return Promise.resolve([{ key: `k${callCount}`, text: 'data' }])
      })

      const results = await mnm.searchAll('query')
      // 4 networks, 1 fails, so 3 results
      expect(results).toHaveLength(3)
    })

    it('should respect limit', async () => {
      const search = memory.search as ReturnType<typeof vi.fn>
      search.mockResolvedValue([
        { key: 'r1', text: 'a' },
        { key: 'r2', text: 'b' },
      ])

      const results = await mnm.searchAll('query', 3)
      expect(results.length).toBeLessThanOrEqual(3)
    })
  })

  // ---- classifyNetwork() --------------------------------------------------

  describe('classifyNetwork()', () => {
    it('should classify factual text as "factual"', () => {
      expect(mnm.classifyNetwork('The sun is a star.')).toBe('factual')
    })

    it('should classify error reports as "experiential"', () => {
      // Needs 2+ matches: "error" + "debugged"
      expect(mnm.classifyNetwork('I noticed an error while debugging, we debugged it')).toBe('experiential')
    })

    it('should classify "I tried X and it failed" as "experiential"', () => {
      expect(mnm.classifyNetwork('I tried using that library and it failed')).toBe('experiential')
    })

    it('should classify preference text as "opinion"', () => {
      // Needs 2+ distinct pattern matches: pattern[0] (prefer) + pattern[2] (believe)
      expect(mnm.classifyNetwork('I prefer React because I believe it is the right choice')).toBe('opinion')
    })

    it('should classify recommendations as "opinion"', () => {
      expect(mnm.classifyNetwork('I recommend this. I think it should be used.')).toBe('opinion')
    })

    it('should classify identifier-like text as "entity"', () => {
      // Needs 2+ matches: PascalCase + backtick code
      expect(mnm.classifyNetwork('The `UserService` class has a UserProfile component')).toBe('entity')
    })

    it('should classify profile descriptions as "entity"', () => {
      expect(mnm.classifyNetwork('project: MyApp, stack: Node.js, version: 2.0')).toBe('entity')
    })

    it('should default to "factual" for ambiguous text', () => {
      expect(mnm.classifyNetwork('hello world')).toBe('factual')
    })
  })

  // ---- autoStore() --------------------------------------------------------

  describe('autoStore()', () => {
    it('should classify and store in correct network', async () => {
      // Text matches 2+ opinion patterns: "prefer" (pattern 0) + "believe" (pattern 2) + "pros" (pattern 3)
      const result = await mnm.autoStore('k1', {
        text: 'I prefer TypeScript because I believe the pros outweigh the cons',
      })

      expect(result.network).toBe('opinion')
      const put = memory.put as ReturnType<typeof vi.fn>
      expect(put).toHaveBeenCalledOnce()
      expect(put.mock.calls[0]![0]).toBe('net-opinion')
    })

    it('should use JSON.stringify when text field is missing', async () => {
      const result = await mnm.autoStore('k1', { data: 42 })
      // No strong pattern matches → defaults to factual
      expect(result.network).toBe('factual')
    })
  })

  // ---- getStats() ---------------------------------------------------------

  describe('getStats()', () => {
    it('should return counts per network', async () => {
      const get = memory.get as ReturnType<typeof vi.fn>
      get.mockImplementation((ns: string) => {
        if (ns === 'net-factual') return Promise.resolve([{ text: 'a' }, { text: 'b' }])
        return Promise.resolve([])
      })

      const stats = await mnm.getStats()
      expect(stats).toHaveLength(4)

      const factual = stats.find(s => s.network === 'factual')
      expect(factual).toBeDefined()
      expect(factual!.recordCount).toBe(2)
      expect(factual!.namespace).toBe('net-factual')

      const entity = stats.find(s => s.network === 'entity')
      expect(entity!.recordCount).toBe(0)
    })

    it('should return 0 count for networks that error', async () => {
      const get = memory.get as ReturnType<typeof vi.fn>
      get.mockRejectedValue(new Error('store error'))

      const stats = await mnm.getStats()
      expect(stats).toHaveLength(4)
      for (const s of stats) {
        expect(s.recordCount).toBe(0)
      }
    })
  })

  // ---- formatForPrompt() --------------------------------------------------

  describe('formatForPrompt()', () => {
    it('should group results by network with headers', async () => {
      const search = memory.search as ReturnType<typeof vi.fn>
      search.mockImplementation((ns: string) => {
        if (ns === 'net-factual') return Promise.resolve([{ text: 'fact 1' }])
        if (ns === 'net-opinion') return Promise.resolve([{ text: 'opinion 1' }])
        return Promise.resolve([])
      })

      const output = await mnm.formatForPrompt('query')
      expect(output).toContain('# Multi-Network Memory')
      expect(output).toContain('## Factual Memory')
      expect(output).toContain('- fact 1')
      expect(output).toContain('## Opinions & Preferences')
      expect(output).toContain('- opinion 1')
    })

    it('should return empty string when no results', async () => {
      const output = await mnm.formatForPrompt('query')
      expect(output).toBe('')
    })

    it('should respect custom header option', async () => {
      ;(memory.search as ReturnType<typeof vi.fn>).mockResolvedValue([{ text: 'x' }])
      const output = await mnm.formatForPrompt('q', { header: '# Custom' })
      expect(output).toContain('# Custom')
    })
  })

  // ---- getNetworkConfig() / getNetworks() ---------------------------------

  describe('accessors', () => {
    it('getNetworkConfig should return config for valid network', () => {
      const config = mnm.getNetworkConfig('factual')
      expect(config).toBeDefined()
      expect(config!.namespace).toBe('net-factual')
      expect(config!.contradictionPolicy).toBe('flag-for-review')
    })

    it('getNetworkConfig should return undefined for unknown network', () => {
      expect(mnm.getNetworkConfig('bogus' as MemoryNetwork)).toBeUndefined()
    })

    it('getNetworks should return all network configs', () => {
      const networks = mnm.getNetworks()
      expect(networks).toHaveLength(4)
    })
  })

  // ---- Static helper: getNamespaceConfigs() -------------------------------

  describe('MultiNetworkMemory.getNamespaceConfigs()', () => {
    it('should return namespace configs for all default networks', () => {
      const configs = MultiNetworkMemory.getNamespaceConfigs()
      expect(configs).toHaveLength(4)
      expect(configs[0]!.name).toBe('net-factual')
      expect(configs[0]!.scopeKeys).toEqual(['tenantId', 'network'])
      expect(configs[0]!.searchable).toBe(true)
    })

    it('should accept custom networks and scope keys', () => {
      const configs = MultiNetworkMemory.getNamespaceConfigs(
        [DEFAULT_NETWORK_CONFIGS[0]!],
        ['orgId'],
      )
      expect(configs).toHaveLength(1)
      expect(configs[0]!.scopeKeys).toEqual(['orgId'])
    })
  })
})
