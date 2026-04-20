/**
 * Unit tests for the LRU cache in SharedAgentSkillResolver.
 *
 * Covers:
 *  - TTL expiry via vi.setSystemTime()
 *  - LRU eviction when cacheMaxSize is exceeded
 *  - invalidate(skillId) removes a single entry
 *  - clearCache() wipes all entries
 *  - TTL not-yet-expired returns entry
 *  - cacheMaxSize=0 means unlimited (no eviction)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import type { DzupAgentConfig } from '../agent/agent-types.js'
import type { DzupAgent } from '../agent/dzip-agent.js'
import type { SkillRegistry } from '@dzupagent/core'
import { SharedAgentSkillResolver } from '../skill-step-resolver.js'

// ---------------------------------------------------------------------------
// Minimal DzupAgent mock
// We only need the shape; cache tests never invoke generate() or agentConfig.
// ---------------------------------------------------------------------------

function makeMockAgent(id: string): DzupAgent {
  return { id } as unknown as DzupAgent
}

// ---------------------------------------------------------------------------
// Minimal SkillRegistry mock
// The resolver constructor requires a registry, but cache tests never call
// resolve(), so we only need the interface surface.
// ---------------------------------------------------------------------------

function makeMockRegistry(): SkillRegistry {
  return {
    get: (_id: string) => undefined,
    has: (_id: string) => false,
    list: () => [],
    register: () => { /* no-op */ },
    unregister: () => false,
  } as unknown as SkillRegistry
}

// ---------------------------------------------------------------------------
// Minimal baseAgent mock
// buildAgent() calls baseAgent.agentConfig — not exercised in cache tests,
// but the constructor needs the config object to be present.
// ---------------------------------------------------------------------------

function makeMockBaseAgent(): DzupAgent {
  const config: Pick<DzupAgentConfig, 'id' | 'instructions' | 'model'> = {
    id: 'base-agent',
    instructions: 'base instructions',
    model: 'chat',
  }
  return {
    id: 'base-agent',
    agentConfig: config,
  } as unknown as DzupAgent
}

// ---------------------------------------------------------------------------
// Factory for the system under test
// ---------------------------------------------------------------------------

function buildResolver(opts: {
  cacheMaxSize?: number
  cacheTtlMs?: number
}): SharedAgentSkillResolver {
  return new SharedAgentSkillResolver({
    baseAgent: makeMockBaseAgent(),
    registry: makeMockRegistry(),
    cacheMaxSize: opts.cacheMaxSize,
    cacheTtlMs: opts.cacheTtlMs,
  })
}

// ---------------------------------------------------------------------------
// Accessor helpers — private methods exposed via (resolver as any)
// ---------------------------------------------------------------------------

function getCachedAgent(
  resolver: SharedAgentSkillResolver,
  skillId: string,
): DzupAgent | undefined {
  return (resolver as unknown as Record<string, (id: string) => DzupAgent | undefined>)
    ['getCachedAgent'](skillId)
}

function putCache(
  resolver: SharedAgentSkillResolver,
  skillId: string,
  agent: DzupAgent,
): void {
  ;(resolver as unknown as Record<string, (id: string, a: DzupAgent) => void>)
    ['putCache'](skillId, agent)
}

// ===========================================================================
// Test suites
// ===========================================================================

describe('SharedAgentSkillResolver — LRU cache', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // -------------------------------------------------------------------------
  // TTL expiry
  // -------------------------------------------------------------------------

  describe('TTL expiry', () => {
    it('returns undefined after TTL has elapsed', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))

      const resolver = buildResolver({ cacheTtlMs: 1000 })
      const agent = makeMockAgent('skill-a')
      putCache(resolver, 'skill-a', agent)

      // Advance past the TTL
      vi.setSystemTime(new Date('2024-01-01T00:00:01.001Z'))

      expect(getCachedAgent(resolver, 'skill-a')).toBeUndefined()
    })

    it('still returns the entry when TTL has not yet elapsed', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))

      const resolver = buildResolver({ cacheTtlMs: 1000 })
      const agent = makeMockAgent('skill-b')
      putCache(resolver, 'skill-b', agent)

      // Advance to just under the TTL (999 ms elapsed)
      vi.setSystemTime(new Date('2024-01-01T00:00:00.999Z'))

      expect(getCachedAgent(resolver, 'skill-b')).toBe(agent)
    })

    it('returns undefined for a key that was never cached', () => {
      const resolver = buildResolver({ cacheTtlMs: 5000 })
      expect(getCachedAgent(resolver, 'never-added')).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // LRU eviction
  // -------------------------------------------------------------------------

  describe('LRU eviction when cacheMaxSize is exceeded', () => {
    it('evicts the least-recently-used entry when size exceeds max', () => {
      const resolver = buildResolver({ cacheMaxSize: 3 })

      const agentA = makeMockAgent('skill-a')
      const agentB = makeMockAgent('skill-b')
      const agentC = makeMockAgent('skill-c')
      const agentD = makeMockAgent('skill-d')

      putCache(resolver, 'skill-a', agentA)
      putCache(resolver, 'skill-b', agentB)
      putCache(resolver, 'skill-c', agentC)

      // Adding a 4th entry should evict 'skill-a' (oldest / LRU)
      putCache(resolver, 'skill-d', agentD)

      expect(getCachedAgent(resolver, 'skill-a')).toBeUndefined()
      expect(getCachedAgent(resolver, 'skill-b')).toBe(agentB)
      expect(getCachedAgent(resolver, 'skill-c')).toBe(agentC)
      expect(getCachedAgent(resolver, 'skill-d')).toBe(agentD)
    })

    it('refreshes LRU order on getCachedAgent, preventing eviction of recently accessed entry', () => {
      const resolver = buildResolver({ cacheMaxSize: 2 })

      const agentA = makeMockAgent('skill-a')
      const agentB = makeMockAgent('skill-b')
      const agentC = makeMockAgent('skill-c')

      putCache(resolver, 'skill-a', agentA)
      putCache(resolver, 'skill-b', agentB)

      // Access 'skill-a' to refresh its LRU position — now 'skill-b' is LRU
      getCachedAgent(resolver, 'skill-a')

      // Adding 'skill-c' should evict 'skill-b' (now the least recently used)
      putCache(resolver, 'skill-c', agentC)

      expect(getCachedAgent(resolver, 'skill-b')).toBeUndefined()
      expect(getCachedAgent(resolver, 'skill-a')).toBe(agentA)
      expect(getCachedAgent(resolver, 'skill-c')).toBe(agentC)
    })

    it('evicts the correct entry across multiple overflow additions', () => {
      const resolver = buildResolver({ cacheMaxSize: 2 })

      const agentA = makeMockAgent('skill-a')
      const agentB = makeMockAgent('skill-b')
      const agentC = makeMockAgent('skill-c')
      const agentD = makeMockAgent('skill-d')

      putCache(resolver, 'skill-a', agentA)
      putCache(resolver, 'skill-b', agentB)
      // skill-a evicted here
      putCache(resolver, 'skill-c', agentC)
      // skill-b evicted here
      putCache(resolver, 'skill-d', agentD)

      expect(getCachedAgent(resolver, 'skill-a')).toBeUndefined()
      expect(getCachedAgent(resolver, 'skill-b')).toBeUndefined()
      expect(getCachedAgent(resolver, 'skill-c')).toBe(agentC)
      expect(getCachedAgent(resolver, 'skill-d')).toBe(agentD)
    })
  })

  // -------------------------------------------------------------------------
  // invalidate()
  // -------------------------------------------------------------------------

  describe('invalidate(skillId)', () => {
    it('removes only the specified entry', () => {
      const resolver = buildResolver({})

      const agentA = makeMockAgent('skill-a')
      const agentB = makeMockAgent('skill-b')
      putCache(resolver, 'skill-a', agentA)
      putCache(resolver, 'skill-b', agentB)

      resolver.invalidate('skill-a')

      expect(getCachedAgent(resolver, 'skill-a')).toBeUndefined()
      expect(getCachedAgent(resolver, 'skill-b')).toBe(agentB)
    })

    it('is a no-op when the skillId is not in cache', () => {
      const resolver = buildResolver({})
      const agent = makeMockAgent('skill-a')
      putCache(resolver, 'skill-a', agent)

      // Should not throw
      expect(() => resolver.invalidate('non-existent')).not.toThrow()

      // The present entry should remain intact
      expect(getCachedAgent(resolver, 'skill-a')).toBe(agent)
    })
  })

  // -------------------------------------------------------------------------
  // clearCache()
  // -------------------------------------------------------------------------

  describe('clearCache()', () => {
    it('removes all entries from the cache', () => {
      const resolver = buildResolver({})

      putCache(resolver, 'skill-a', makeMockAgent('skill-a'))
      putCache(resolver, 'skill-b', makeMockAgent('skill-b'))
      putCache(resolver, 'skill-c', makeMockAgent('skill-c'))

      resolver.clearCache()

      expect(getCachedAgent(resolver, 'skill-a')).toBeUndefined()
      expect(getCachedAgent(resolver, 'skill-b')).toBeUndefined()
      expect(getCachedAgent(resolver, 'skill-c')).toBeUndefined()
    })

    it('is safe to call on an already-empty cache', () => {
      const resolver = buildResolver({})
      expect(() => resolver.clearCache()).not.toThrow()
    })

    it('allows new entries to be cached after clearing', () => {
      const resolver = buildResolver({})

      putCache(resolver, 'skill-a', makeMockAgent('skill-a'))
      resolver.clearCache()

      const newAgent = makeMockAgent('skill-a')
      putCache(resolver, 'skill-a', newAgent)

      expect(getCachedAgent(resolver, 'skill-a')).toBe(newAgent)
    })
  })

  // -------------------------------------------------------------------------
  // cacheMaxSize = 0 means unlimited
  // -------------------------------------------------------------------------

  describe('cacheMaxSize=0 — unlimited cache', () => {
    it('does not evict any entry when cacheMaxSize is 0 (default unlimited)', () => {
      const resolver = buildResolver({ cacheMaxSize: 0 })

      const agents: Array<[string, DzupAgent]> = Array.from({ length: 20 }, (_, i) => {
        const id = `skill-${i}`
        return [id, makeMockAgent(id)]
      })

      for (const [id, agent] of agents) {
        putCache(resolver, id, agent)
      }

      for (const [id, agent] of agents) {
        expect(getCachedAgent(resolver, id)).toBe(agent)
      }
    })

    it('does not evict when cacheMaxSize is omitted (defaults to 0)', () => {
      // No cacheMaxSize provided at all
      const resolver = new SharedAgentSkillResolver({
        baseAgent: makeMockBaseAgent(),
        registry: makeMockRegistry(),
      })

      const agentA = makeMockAgent('skill-a')
      const agentB = makeMockAgent('skill-b')
      putCache(resolver, 'skill-a', agentA)
      putCache(resolver, 'skill-b', agentB)

      expect(getCachedAgent(resolver, 'skill-a')).toBe(agentA)
      expect(getCachedAgent(resolver, 'skill-b')).toBe(agentB)
    })
  })

  // -------------------------------------------------------------------------
  // cacheTtlMs = 0 means no expiry
  // -------------------------------------------------------------------------

  describe('cacheTtlMs=0 — no expiry', () => {
    it('never expires entries when cacheTtlMs is 0 (default)', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))

      // No cacheTtlMs → defaults to 0 (no expiry)
      const resolver = buildResolver({ cacheTtlMs: 0 })
      const agent = makeMockAgent('skill-a')
      putCache(resolver, 'skill-a', agent)

      // Advance time by 1 year — should still be present
      vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'))

      expect(getCachedAgent(resolver, 'skill-a')).toBe(agent)
    })
  })
})
