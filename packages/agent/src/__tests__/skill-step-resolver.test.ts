import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SkillRegistry } from '@dzupagent/core'
import type { LoadedSkill } from '@dzupagent/core'

// ---------------------------------------------------------------------------
// Mock DzupAgent — its real constructor pulls in heavy deps (ModelRegistry,
// LangChain BaseChatModel, etc.) so we replace it with a lightweight stub.
// ---------------------------------------------------------------------------

let agentConstructorCalls: Array<{ id: string; instructions: string }> = []

vi.mock('../agent/dzip-agent.js', () => {
  class FakeDzupAgent {
    readonly id: string
    private readonly _config: Record<string, unknown>

    constructor(config: Record<string, unknown>) {
      this.id = config['id'] as string
      this._config = config
      agentConstructorCalls.push({
        id: this.id,
        instructions: config['instructions'] as string,
      })
    }

    get agentConfig(): Readonly<Record<string, unknown>> {
      return this._config
    }

    async generate() {
      return { content: `output-from-${this.id}` }
    }
  }
  return { DzupAgent: FakeDzupAgent }
})

import {
  SharedAgentSkillResolver,
  type SharedAgentSkillResolverConfig,
} from '../skill-chain-executor/skill-step-resolver.js'
import { DzupAgent } from '../agent/dzip-agent.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistry(...skillIds: string[]): SkillRegistry {
  const reg = new SkillRegistry()
  for (const id of skillIds) {
    reg.register({
      id,
      name: id,
      description: `Skill ${id}`,
      instructions: `Do ${id} things`,
    })
  }
  return reg
}

function makeBaseAgent(): DzupAgent {
  return new DzupAgent({
    id: 'base',
    instructions: 'base instructions',
    model: 'chat',
  } as never)
}

function makeResolver(
  overrides: Partial<SharedAgentSkillResolverConfig> = {},
): SharedAgentSkillResolver {
  const registry = overrides.registry ?? makeRegistry('skill-a', 'skill-b', 'skill-c')
  return new SharedAgentSkillResolver({
    baseAgent: makeBaseAgent(),
    registry,
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SharedAgentSkillResolver', () => {
  beforeEach(() => {
    agentConstructorCalls = []
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // -----------------------------------------------------------------------
  // Basic caching
  // -----------------------------------------------------------------------
  describe('basic caching', () => {
    it('reuses the same agent on repeated resolve() calls', async () => {
      const resolver = makeResolver()

      await resolver.resolve('skill-a')
      await resolver.resolve('skill-a')

      // DzupAgent constructor should have been called only once for 'skill-a'
      const skillACalls = agentConstructorCalls.filter(c => c.id === 'base:skill-a')
      expect(skillACalls).toHaveLength(1)
    })

    it('creates separate agents for different skills', async () => {
      const resolver = makeResolver()

      await resolver.resolve('skill-a')
      await resolver.resolve('skill-b')

      expect(agentConstructorCalls.filter(c => c.id === 'base:skill-a')).toHaveLength(1)
      expect(agentConstructorCalls.filter(c => c.id === 'base:skill-b')).toHaveLength(1)
    })
  })

  // -----------------------------------------------------------------------
  // LRU eviction (cacheMaxSize)
  // -----------------------------------------------------------------------
  describe('LRU eviction (cacheMaxSize)', () => {
    it('evicts the least recently used entry when cache exceeds maxSize', async () => {
      const resolver = makeResolver({ cacheMaxSize: 2 })

      // Fill cache: skill-a, then skill-b
      await resolver.resolve('skill-a')
      await resolver.resolve('skill-b')
      expect(agentConstructorCalls).toHaveLength(3) // 1 base + 2 skills

      // Adding skill-c should evict skill-a (LRU)
      agentConstructorCalls = []
      await resolver.resolve('skill-c')
      expect(agentConstructorCalls).toHaveLength(1)

      // skill-a should be re-created (was evicted)
      agentConstructorCalls = []
      await resolver.resolve('skill-a')
      expect(agentConstructorCalls).toHaveLength(1)

      // skill-b should still be cached (was not evicted — skill-c evicted skill-b,
      // then skill-a evicted skill-c, leaving skill-b and skill-a)
      // Actually: after adding skill-c, cache = [skill-b, skill-c]
      // Then resolving skill-a evicts skill-b (LRU), cache = [skill-c, skill-a]
      // So skill-b should be re-created:
      agentConstructorCalls = []
      await resolver.resolve('skill-b')
      expect(agentConstructorCalls).toHaveLength(1) // re-created
    })

    it('refreshes LRU order on cache hit', async () => {
      const resolver = makeResolver({ cacheMaxSize: 2 })

      // Fill: skill-a, skill-b
      await resolver.resolve('skill-a')
      await resolver.resolve('skill-b')

      // Access skill-a again — moves it to most recently used
      await resolver.resolve('skill-a')

      // Add skill-c — should evict skill-b (now LRU), not skill-a
      agentConstructorCalls = []
      await resolver.resolve('skill-c')

      // skill-a should still be cached
      agentConstructorCalls = []
      await resolver.resolve('skill-a')
      expect(agentConstructorCalls).toHaveLength(0)

      // skill-b was evicted, should be re-created
      agentConstructorCalls = []
      await resolver.resolve('skill-b')
      expect(agentConstructorCalls).toHaveLength(1)
    })

    it('unlimited cache when cacheMaxSize is not set', async () => {
      const resolver = makeResolver()

      await resolver.resolve('skill-a')
      await resolver.resolve('skill-b')
      await resolver.resolve('skill-c')

      // All three should be cached (no eviction)
      agentConstructorCalls = []
      await resolver.resolve('skill-a')
      await resolver.resolve('skill-b')
      await resolver.resolve('skill-c')
      expect(agentConstructorCalls).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // TTL expiry (cacheTtlMs)
  // -----------------------------------------------------------------------
  describe('TTL expiry (cacheTtlMs)', () => {
    it('returns cached entry within TTL window', async () => {
      const resolver = makeResolver({ cacheTtlMs: 5_000 })

      await resolver.resolve('skill-a')
      agentConstructorCalls = []

      // Still within TTL — should use cache
      await resolver.resolve('skill-a')
      expect(agentConstructorCalls).toHaveLength(0)
    })

    it('evicts and re-creates agent after TTL expires', async () => {
      const resolver = makeResolver({ cacheTtlMs: 100 })

      await resolver.resolve('skill-a')
      agentConstructorCalls = []

      // Advance time past TTL
      const realDateNow = Date.now
      let time = realDateNow()
      vi.spyOn(Date, 'now').mockImplementation(() => time)

      time += 200 // 200ms > 100ms TTL

      await resolver.resolve('skill-a')
      // Should have re-created the agent
      expect(agentConstructorCalls).toHaveLength(1)

      Date.now = realDateNow
    })

    it('no TTL expiry when cacheTtlMs is not set', async () => {
      const resolver = makeResolver()

      await resolver.resolve('skill-a')

      // Fast-forward time significantly
      const realDateNow = Date.now
      let time = realDateNow()
      vi.spyOn(Date, 'now').mockImplementation(() => time)
      time += 999_999_999

      agentConstructorCalls = []
      await resolver.resolve('skill-a')
      expect(agentConstructorCalls).toHaveLength(0)

      Date.now = realDateNow
    })
  })

  // -----------------------------------------------------------------------
  // clearCache()
  // -----------------------------------------------------------------------
  describe('clearCache()', () => {
    it('removes all cached agents', async () => {
      const resolver = makeResolver()

      await resolver.resolve('skill-a')
      await resolver.resolve('skill-b')
      agentConstructorCalls = []

      resolver.clearCache()

      await resolver.resolve('skill-a')
      await resolver.resolve('skill-b')
      expect(agentConstructorCalls).toHaveLength(2)
    })
  })

  // -----------------------------------------------------------------------
  // invalidate()
  // -----------------------------------------------------------------------
  describe('invalidate()', () => {
    it('removes a specific skill from cache', async () => {
      const resolver = makeResolver()

      await resolver.resolve('skill-a')
      await resolver.resolve('skill-b')
      agentConstructorCalls = []

      resolver.invalidate('skill-a')

      // skill-a should be re-created
      await resolver.resolve('skill-a')
      expect(agentConstructorCalls).toHaveLength(1)

      // skill-b should still be cached
      agentConstructorCalls = []
      await resolver.resolve('skill-b')
      expect(agentConstructorCalls).toHaveLength(0)
    })

    it('is a no-op for a non-existent cache key', () => {
      const resolver = makeResolver()
      // Should not throw
      resolver.invalidate('does-not-exist')
    })
  })
})
