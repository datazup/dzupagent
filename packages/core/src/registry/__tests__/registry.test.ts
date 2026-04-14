import { describe, it, expect, vi } from 'vitest'
import { CapabilityMatcher, compareSemver } from '../capability-matcher.js'
import {
  isStandardCapability,
  getCapabilityDescription,
  listStandardCapabilities,
} from '../capability-taxonomy.js'
import { InMemoryRegistry } from '../in-memory-registry.js'
import type {
  RegisterAgentInput,
  RegistryEvent,
} from '../types.js'
import type { ForgeCapability } from '../../identity/index.js'
import { createEventBus } from '../../events/event-bus.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCapability(name: string, version = '1.0.0', tags?: string[]): ForgeCapability {
  return {
    name,
    version,
    description: `Capability: ${name}`,
    tags,
  }
}

function makeInput(overrides?: Partial<RegisterAgentInput>): RegisterAgentInput {
  return {
    name: 'test-agent',
    description: 'A test agent',
    capabilities: [makeCapability('code.review')],
    protocols: ['a2a'],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// compareSemver
// ---------------------------------------------------------------------------

describe('compareSemver', () => {
  it('returns 0 for equal versions', () => {
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0)
  })

  it('returns -1 when a < b', () => {
    expect(compareSemver('1.0.0', '1.0.1')).toBe(-1)
    expect(compareSemver('1.0.0', '2.0.0')).toBe(-1)
    expect(compareSemver('1.9.9', '2.0.0')).toBe(-1)
  })

  it('returns 1 when a > b', () => {
    expect(compareSemver('1.0.1', '1.0.0')).toBe(1)
    expect(compareSemver('2.0.0', '1.0.0')).toBe(1)
  })

  it('uses numeric comparison, not lexicographic (S7 fix)', () => {
    // "10.0.0" > "2.0.0" numerically, but "10.0.0" < "2.0.0" lexicographically
    expect(compareSemver('10.0.0', '2.0.0')).toBe(1)
    expect(compareSemver('2.0.0', '10.0.0')).toBe(-1)
  })

  it('handles missing patch segments', () => {
    expect(compareSemver('1.0', '1.0.0')).toBe(0)
    expect(compareSemver('1', '1.0.0')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// CapabilityMatcher
// ---------------------------------------------------------------------------

describe('CapabilityMatcher', () => {
  const matcher = new CapabilityMatcher()

  describe('match()', () => {
    it('exact match returns 1.0', () => {
      expect(matcher.match('code.review', 'code.review')).toBe(1.0)
    })

    it('child match returns < 1.0 but > 0', () => {
      const score = matcher.match('code.review', 'code.review.security')
      expect(score).toBeGreaterThan(0)
      expect(score).toBeLessThan(1.0)
    })

    it('parent match returns > 0 but lower than child match', () => {
      const parentScore = matcher.match('code.review.security', 'code.review')
      const childScore = matcher.match('code.review', 'code.review.security')
      expect(parentScore).toBeGreaterThan(0)
      expect(parentScore).toBeLessThan(childScore)
    })

    it('no relationship returns 0', () => {
      expect(matcher.match('code.review', 'data.analyze')).toBe(0)
    })

    it('partial segment mismatch returns 0', () => {
      expect(matcher.match('code.review', 'code.generate')).toBe(0)
    })
  })

  describe('matchesPattern()', () => {
    it('exact match', () => {
      expect(matcher.matchesPattern('code.review', 'code.review')).toBe(true)
    })

    it('"code.*" matches "code.review"', () => {
      expect(matcher.matchesPattern('code.*', 'code.review')).toBe(true)
    })

    it('"code.*" matches "code.review.security"', () => {
      expect(matcher.matchesPattern('code.*', 'code.review.security')).toBe(true)
    })

    it('"code.*" matches "code" (the prefix itself)', () => {
      expect(matcher.matchesPattern('code.*', 'code')).toBe(true)
    })

    it('"code.review.*" does not match "code.generate"', () => {
      expect(matcher.matchesPattern('code.review.*', 'code.generate')).toBe(false)
    })

    it('no wildcard — exact match only', () => {
      expect(matcher.matchesPattern('code.review', 'code.review.security')).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// Capability Taxonomy
// ---------------------------------------------------------------------------

describe('CapabilityTaxonomy', () => {
  it('isStandardCapability returns true for known capabilities', () => {
    expect(isStandardCapability('code.review.security')).toBe(true)
    expect(isStandardCapability('code.generate')).toBe(true)
    expect(isStandardCapability('data.analyze')).toBe(true)
    expect(isStandardCapability('memory.store')).toBe(true)
  })

  it('isStandardCapability returns false for unknown capabilities', () => {
    expect(isStandardCapability('nonexistent')).toBe(false)
    expect(isStandardCapability('code.fly')).toBe(false)
  })

  it('getCapabilityDescription returns description for known capability', () => {
    const desc = getCapabilityDescription('code.review.security')
    expect(desc).toBe('Security-focused code review')
  })

  it('getCapabilityDescription returns undefined for unknown capability', () => {
    expect(getCapabilityDescription('nonexistent')).toBeUndefined()
  })

  it('listStandardCapabilities returns all capabilities', () => {
    const caps = listStandardCapabilities()
    expect(caps.length).toBeGreaterThan(10)
    expect(caps).toContain('code.review')
    expect(caps).toContain('code.review.security')
    expect(caps).toContain('planning.decompose')
  })
})

// ---------------------------------------------------------------------------
// InMemoryRegistry
// ---------------------------------------------------------------------------

describe('InMemoryRegistry', () => {
  describe('register()', () => {
    it('creates agent with generated ID and default health', async () => {
      const registry = new InMemoryRegistry()
      const agent = await registry.register(makeInput())

      expect(agent.id).toBeTruthy()
      expect(agent.name).toBe('test-agent')
      expect(agent.description).toBe('A test agent')
      expect(agent.health.status).toBe('unknown')
      expect(agent.registeredAt).toBeInstanceOf(Date)
      expect(agent.capabilities).toHaveLength(1)
      expect(agent.protocols).toEqual(['a2a'])
    })

    it('throws on missing name', async () => {
      const registry = new InMemoryRegistry()
      await expect(
        registry.register(makeInput({ name: '' })),
      ).rejects.toThrow('name and description are required')
    })

    it('throws on empty capabilities', async () => {
      const registry = new InMemoryRegistry()
      await expect(
        registry.register(makeInput({ capabilities: [] })),
      ).rejects.toThrow('At least one capability')
    })
  })

  describe('getAgent()', () => {
    it('returns the agent by ID', async () => {
      const registry = new InMemoryRegistry()
      const registered = await registry.register(makeInput())
      const fetched = await registry.getAgent(registered.id)

      expect(fetched).toBeDefined()
      expect(fetched!.id).toBe(registered.id)
    })

    it('returns undefined for unknown ID', async () => {
      const registry = new InMemoryRegistry()
      const result = await registry.getAgent('nonexistent')
      expect(result).toBeUndefined()
    })

    it('returns a copy, not the internal reference (S6)', async () => {
      const registry = new InMemoryRegistry()
      const registered = await registry.register(makeInput())
      const fetched = await registry.getAgent(registered.id)

      // Mutating the returned object should not affect internal state
      fetched!.name = 'MUTATED'
      const refetched = await registry.getAgent(registered.id)
      expect(refetched!.name).toBe('test-agent')
    })
  })

  describe('deregister()', () => {
    it('removes the agent', async () => {
      const registry = new InMemoryRegistry()
      const agent = await registry.register(makeInput())
      await registry.deregister(agent.id)
      const result = await registry.getAgent(agent.id)
      expect(result).toBeUndefined()
    })

    it('throws for unknown agent', async () => {
      const registry = new InMemoryRegistry()
      await expect(registry.deregister('nonexistent')).rejects.toThrow('Agent not found')
    })
  })

  describe('update() (S6 fix: immutable updates)', () => {
    it('updates fields and returns new object', async () => {
      const registry = new InMemoryRegistry()
      const original = await registry.register(makeInput())
      const updated = await registry.update(original.id, { name: 'updated-agent' })

      expect(updated.name).toBe('updated-agent')
      expect(updated.id).toBe(original.id)
      expect(updated.lastUpdatedAt.getTime()).toBeGreaterThanOrEqual(original.lastUpdatedAt.getTime())
    })

    it('original object is not mutated', async () => {
      const registry = new InMemoryRegistry()
      const original = await registry.register(makeInput())
      const originalName = original.name

      await registry.update(original.id, { name: 'updated-agent' })

      // The original returned object should still have its old name
      expect(original.name).toBe(originalName)
    })

    it('throws for unknown agent', async () => {
      const registry = new InMemoryRegistry()
      await expect(registry.update('nonexistent', { name: 'x' })).rejects.toThrow('Agent not found')
    })
  })

  describe('discover()', () => {
    it('discovers by capability prefix', async () => {
      const registry = new InMemoryRegistry()
      await registry.register(makeInput({
        name: 'reviewer',
        capabilities: [makeCapability('code.review.security')],
      }))
      await registry.register(makeInput({
        name: 'generator',
        capabilities: [makeCapability('code.generate')],
      }))

      const result = await registry.discover({ capabilityPrefix: 'code.review' })
      expect(result.results.length).toBeGreaterThanOrEqual(1)
      // The reviewer should score higher
      expect(result.results[0]!.agent.name).toBe('reviewer')
    })

    it('discovers by tags', async () => {
      const registry = new InMemoryRegistry()
      await registry.register(makeInput({
        name: 'ts-reviewer',
        capabilities: [makeCapability('code.review', '1.0.0', ['typescript', 'security'])],
      }))
      await registry.register(makeInput({
        name: 'py-reviewer',
        capabilities: [makeCapability('code.review', '1.0.0', ['python'])],
      }))

      const result = await registry.discover({ tags: ['typescript'] })
      // ts-reviewer should score higher on tags
      const names = result.results.map((r) => r.agent.name)
      expect(names[0]).toBe('ts-reviewer')
    })

    it('discovers by health filter', async () => {
      const registry = new InMemoryRegistry()
      const a1 = await registry.register(makeInput({ name: 'healthy-agent' }))
      const a2 = await registry.register(makeInput({ name: 'unhealthy-agent' }))

      await registry.updateHealth(a1.id, { status: 'healthy' })
      await registry.updateHealth(a2.id, { status: 'unhealthy' })

      const result = await registry.discover({ healthFilter: ['healthy'] })
      expect(result.results).toHaveLength(1)
      expect(result.results[0]!.agent.name).toBe('healthy-agent')
    })

    it('paginates results', async () => {
      const registry = new InMemoryRegistry()
      for (let i = 0; i < 5; i++) {
        await registry.register(makeInput({ name: `agent-${i}` }))
      }

      const page1 = await registry.discover({ limit: 2, offset: 0 })
      expect(page1.results).toHaveLength(2)
      expect(page1.total).toBe(5)
      expect(page1.offset).toBe(0)
      expect(page1.limit).toBe(2)

      const page2 = await registry.discover({ limit: 2, offset: 2 })
      expect(page2.results).toHaveLength(2)
      expect(page2.offset).toBe(2)
    })

    it('returns all agents for empty query', async () => {
      const registry = new InMemoryRegistry()
      await registry.register(makeInput({ name: 'a1' }))
      await registry.register(makeInput({ name: 'a2' }))

      const result = await registry.discover({})
      expect(result.total).toBe(2)
    })

    it('filters by protocol', async () => {
      const registry = new InMemoryRegistry()
      await registry.register(makeInput({ name: 'a2a-agent', protocols: ['a2a'] }))
      await registry.register(makeInput({ name: 'mcp-agent', protocols: ['mcp'] }))

      const result = await registry.discover({ protocols: ['mcp'] })
      expect(result.results).toHaveLength(1)
      expect(result.results[0]!.agent.name).toBe('mcp-agent')
    })

    it('uses numeric semver for capabilityExact version check (S7 fix)', async () => {
      const registry = new InMemoryRegistry()
      await registry.register(makeInput({
        name: 'v10-agent',
        capabilities: [makeCapability('code.review', '10.0.0')],
      }))
      await registry.register(makeInput({
        name: 'v2-agent',
        capabilities: [makeCapability('code.review', '2.0.0')],
      }))

      const result = await registry.discover({
        capabilityExact: { name: 'code.review', minVersion: '3.0.0' },
      })

      // Only v10-agent meets minVersion=3.0.0
      const matchingNames = result.results
        .filter((r) => r.scoreBreakdown.capabilityScore === 1.0)
        .map((r) => r.agent.name)
      expect(matchingNames).toContain('v10-agent')
      expect(matchingNames).not.toContain('v2-agent')
    })
  })

  describe('updateHealth()', () => {
    it('updates health status', async () => {
      const registry = new InMemoryRegistry()
      const agent = await registry.register(makeInput())
      await registry.updateHealth(agent.id, { status: 'healthy' })

      const health = await registry.getHealth(agent.id)
      expect(health!.status).toBe('healthy')
    })

    it('throws for unknown agent', async () => {
      const registry = new InMemoryRegistry()
      await expect(
        registry.updateHealth('nonexistent', { status: 'healthy' }),
      ).rejects.toThrow('Agent not found')
    })
  })

  describe('evictExpired()', () => {
    it('removes agents past their TTL', async () => {
      const registry = new InMemoryRegistry()
      const agent = await registry.register(makeInput({ ttlMs: 1 }))

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 10))

      const evicted = await registry.evictExpired()
      expect(evicted).toContain(agent.id)

      const result = await registry.getAgent(agent.id)
      expect(result).toBeUndefined()
    })

    it('does not evict agents without TTL', async () => {
      const registry = new InMemoryRegistry()
      await registry.register(makeInput())

      const evicted = await registry.evictExpired()
      expect(evicted).toHaveLength(0)
    })

    it('does not evict agents within TTL', async () => {
      const registry = new InMemoryRegistry()
      await registry.register(makeInput({ ttlMs: 60_000 }))

      const evicted = await registry.evictExpired()
      expect(evicted).toHaveLength(0)
    })
  })

  describe('subscribe()', () => {
    it('receives events on register', async () => {
      const registry = new InMemoryRegistry()
      const events: RegistryEvent[] = []

      registry.subscribe({}, (e) => events.push(e))

      await registry.register(makeInput({ name: 'sub-agent' }))

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe('registry:agent_registered')
    })

    it('receives events on deregister', async () => {
      const registry = new InMemoryRegistry()
      const events: RegistryEvent[] = []

      const agent = await registry.register(makeInput())
      registry.subscribe({}, (e) => events.push(e))

      await registry.deregister(agent.id, 'manual')

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe('registry:agent_deregistered')
      if (events[0]!.type === 'registry:agent_deregistered') {
        expect(events[0]!.reason).toBe('manual')
      }
    })

    it('filters by event type', async () => {
      const registry = new InMemoryRegistry()
      const events: RegistryEvent[] = []

      registry.subscribe(
        { eventTypes: ['registry:agent_deregistered'] },
        (e) => events.push(e),
      )

      const agent = await registry.register(makeInput())
      await registry.deregister(agent.id)

      // Should only receive the deregister event, not the register event
      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe('registry:agent_deregistered')
    })

    it('unsubscribe stops notifications', async () => {
      const registry = new InMemoryRegistry()
      const events: RegistryEvent[] = []

      const sub = registry.subscribe({}, (e) => events.push(e))
      await registry.register(makeInput({ name: 'agent-1' }))
      expect(events).toHaveLength(1)

      sub.unsubscribe()
      await registry.register(makeInput({ name: 'agent-2' }))
      expect(events).toHaveLength(1) // no new event
    })

    it('emits health_changed on status change', async () => {
      const registry = new InMemoryRegistry()
      const events: RegistryEvent[] = []

      const agent = await registry.register(makeInput())
      registry.subscribe({}, (e) => events.push(e))

      await registry.updateHealth(agent.id, { status: 'healthy' })

      const healthEvent = events.find((e) => e.type === 'registry:health_changed')
      expect(healthEvent).toBeDefined()
      if (healthEvent?.type === 'registry:health_changed') {
        expect(healthEvent.previousStatus).toBe('unknown')
        expect(healthEvent.newStatus).toBe('healthy')
      }
    })
  })

  describe('listAgents()', () => {
    it('returns all agents with pagination', async () => {
      const registry = new InMemoryRegistry()
      await registry.register(makeInput({ name: 'a' }))
      await registry.register(makeInput({ name: 'b' }))
      await registry.register(makeInput({ name: 'c' }))

      const result = await registry.listAgents(2, 0)
      expect(result.agents).toHaveLength(2)
      expect(result.total).toBe(3)
    })
  })

  describe('stats()', () => {
    it('returns correct counts', async () => {
      const registry = new InMemoryRegistry()

      const a1 = await registry.register(makeInput({
        name: 'healthy-1',
        protocols: ['a2a'],
      }))
      const a2 = await registry.register(makeInput({
        name: 'degraded-1',
        protocols: ['mcp'],
        capabilities: [makeCapability('data.analyze')],
      }))
      const a3 = await registry.register(makeInput({
        name: 'unhealthy-1',
        protocols: ['a2a', 'mcp'],
      }))

      await registry.updateHealth(a1.id, { status: 'healthy' })
      await registry.updateHealth(a2.id, { status: 'degraded' })
      await registry.updateHealth(a3.id, { status: 'unhealthy' })

      const s = await registry.stats()
      expect(s.totalAgents).toBe(3)
      expect(s.healthyAgents).toBe(1)
      expect(s.degradedAgents).toBe(1)
      expect(s.unhealthyAgents).toBe(1)
      expect(s.capabilityCount).toBe(2) // code.review + data.analyze
      expect(s.protocolCounts['a2a']).toBe(2)
      expect(s.protocolCounts['mcp']).toBe(2)
    })
  })

  describe('registerFromCard()', () => {
    it('throws in InMemoryRegistry', async () => {
      const registry = new InMemoryRegistry()
      await expect(
        registry.registerFromCard('https://example.com/.well-known/agent.json'),
      ).rejects.toThrow('Cannot fetch agent card')
    })
  })

  describe('DzupEventBus integration', () => {
    it('forwards registry events to the event bus', async () => {
      const bus = createEventBus()
      const handler = vi.fn()
      bus.on('registry:agent_registered', handler)

      const registry = new InMemoryRegistry({ eventBus: bus })
      await registry.register(makeInput({ name: 'bus-agent' }))

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'registry:agent_registered',
          name: 'bus-agent',
        }),
      )
    })
  })

  describe('identity integration (C4 fix)', () => {
    it('stores identity and uri on registration', async () => {
      const registry = new InMemoryRegistry()
      const agent = await registry.register(makeInput({
        identity: { id: 'id-001', uri: 'forge://acme/reviewer', displayName: 'Reviewer' },
        uri: 'forge://acme/reviewer',
      }))

      expect(agent.identity).toEqual({
        id: 'id-001',
        uri: 'forge://acme/reviewer',
        displayName: 'Reviewer',
      })
      expect(agent.uri).toBe('forge://acme/reviewer')
    })

    it('identity is optional', async () => {
      const registry = new InMemoryRegistry()
      const agent = await registry.register(makeInput())
      expect(agent.identity).toBeUndefined()
      expect(agent.uri).toBeUndefined()
    })
  })
})
