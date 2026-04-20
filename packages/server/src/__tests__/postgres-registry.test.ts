/**
 * Tests for PostgresRegistry and InMemoryRegistryStore.
 *
 * Covers the public AgentRegistry surface: register, deregister, update,
 * discover, getAgent, updateHealth, subscribe, listAgents, evictExpired,
 * stats. InMemoryRegistryStore is used as the backing store so we exercise
 * the full lookup/insert/update/delete paths without a Postgres dependency.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  PostgresRegistry,
  InMemoryRegistryStore,
  type AgentRow,
} from '../persistence/postgres-registry.js'
import type { ForgeCapability, RegisterAgentInput, RegistryEvent, AgentHealth, DzupEventBus } from '@dzupagent/core'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cap(name: string, tags?: string[]): ForgeCapability {
  return {
    name,
    version: '1.0.0',
    description: `${name} capability`,
    ...(tags ? { tags } : {}),
  }
}

function makeInput(overrides: Partial<RegisterAgentInput> = {}): RegisterAgentInput {
  return {
    name: 'agent-a',
    description: 'Alpha agent',
    protocols: ['a2a'],
    capabilities: [cap('code.review')],
    ...overrides,
  }
}

function makeRow(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: 'row-1',
    name: 'row-agent',
    description: 'Row agent',
    endpoint: null,
    protocols: ['a2a'],
    capabilities: [cap('code.review')],
    authentication_type: null,
    authentication_config: null,
    version: null,
    sla: null,
    health_status: 'unknown',
    health_data: null,
    metadata: null,
    registered_at: new Date().toISOString(),
    last_updated_at: new Date().toISOString(),
    ttl_ms: null,
    identity: null,
    uri: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// InMemoryRegistryStore
// ---------------------------------------------------------------------------

describe('InMemoryRegistryStore', () => {
  let store: InMemoryRegistryStore

  beforeEach(() => {
    store = new InMemoryRegistryStore()
  })

  it('inserts and retrieves a row by id', async () => {
    await store.insert(makeRow({ id: 'x' }))
    const row = await store.getById('x')
    expect(row?.id).toBe('x')
  })

  it('returns undefined for unknown id', async () => {
    expect(await store.getById('missing')).toBeUndefined()
  })

  it('update() merges partial fields', async () => {
    await store.insert(makeRow({ id: 'x', name: 'old' }))
    await store.update('x', { name: 'new' })
    const row = await store.getById('x')
    expect(row?.name).toBe('new')
  })

  it('update() is a no-op for unknown id', async () => {
    await store.update('missing', { name: 'x' })
    expect(await store.getById('missing')).toBeUndefined()
  })

  it('delete() removes the row', async () => {
    await store.insert(makeRow({ id: 'x' }))
    await store.delete('x')
    expect(await store.getById('x')).toBeUndefined()
  })

  it('count() returns the number of rows', async () => {
    expect(await store.count()).toBe(0)
    await store.insert(makeRow({ id: 'a' }))
    await store.insert(makeRow({ id: 'b' }))
    expect(await store.count()).toBe(2)
  })

  it('list() returns rows sliced by offset and limit', async () => {
    await store.insert(makeRow({ id: 'a' }))
    await store.insert(makeRow({ id: 'b' }))
    await store.insert(makeRow({ id: 'c' }))

    const first = await store.list(2, 0)
    expect(first).toHaveLength(2)
    const second = await store.list(2, 2)
    expect(second).toHaveLength(1)
  })

  it('findByCapabilityPrefix() matches case-insensitively', async () => {
    await store.insert(makeRow({ id: 'a', capabilities: [cap('Code.Review')] }))
    await store.insert(makeRow({ id: 'b', capabilities: [cap('data.export')] }))

    const rows = await store.findByCapabilityPrefix('code.', 10, 0)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe('a')
  })

  it('findByCapabilityExact() matches exact name only', async () => {
    await store.insert(makeRow({ id: 'a', capabilities: [cap('code.review')] }))
    await store.insert(makeRow({ id: 'b', capabilities: [cap('code.review.v2')] }))

    const rows = await store.findByCapabilityExact('code.review', 10, 0)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe('a')
  })

  it('findExpired() returns only rows past their ttl', async () => {
    const past = new Date(Date.now() - 100_000).toISOString()
    const now = new Date().toISOString()

    await store.insert(makeRow({ id: 'old', registered_at: past, ttl_ms: 1_000 }))
    await store.insert(makeRow({ id: 'fresh', registered_at: now, ttl_ms: 60_000 }))
    await store.insert(makeRow({ id: 'no-ttl', ttl_ms: null }))

    const expired = await store.findExpired(Date.now())
    expect(expired.map((r) => r.id)).toEqual(['old'])
  })
})

// ---------------------------------------------------------------------------
// PostgresRegistry — validation
// ---------------------------------------------------------------------------

describe('PostgresRegistry — register() validation', () => {
  it('throws when name is empty', async () => {
    const reg = new PostgresRegistry()
    await expect(reg.register(makeInput({ name: '' }))).rejects.toThrow(
      /Agent name and description are required/,
    )
  })

  it('throws when description is empty', async () => {
    const reg = new PostgresRegistry()
    await expect(reg.register(makeInput({ description: '' }))).rejects.toThrow(
      /Agent name and description are required/,
    )
  })

  it('throws when capabilities are empty', async () => {
    const reg = new PostgresRegistry()
    await expect(reg.register(makeInput({ capabilities: [] }))).rejects.toThrow(
      /At least one capability is required/,
    )
  })
})

// ---------------------------------------------------------------------------
// PostgresRegistry — basic lifecycle
// ---------------------------------------------------------------------------

describe('PostgresRegistry — lifecycle', () => {
  it('registers an agent and returns a RegisteredAgent', async () => {
    const reg = new PostgresRegistry()
    const agent = await reg.register(makeInput({ name: 'alpha' }))

    expect(agent.name).toBe('alpha')
    expect(agent.health.status).toBe('unknown')
    expect(agent.capabilities).toHaveLength(1)
  })

  it('generates distinct ids for each register call', async () => {
    const reg = new PostgresRegistry()
    const a = await reg.register(makeInput({ name: 'a' }))
    const b = await reg.register(makeInput({ name: 'b' }))
    expect(a.id).not.toBe(b.id)
  })

  it('emits registry:agent_registered to subscribers', async () => {
    const reg = new PostgresRegistry()
    const events: RegistryEvent[] = []
    reg.subscribe({}, (e) => events.push(e))

    await reg.register(makeInput({ name: 'obs' }))

    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('registry:agent_registered')
  })

  it('getAgent() returns the registered agent', async () => {
    const reg = new PostgresRegistry()
    const registered = await reg.register(makeInput())
    const fetched = await reg.getAgent(registered.id)
    expect(fetched?.id).toBe(registered.id)
  })

  it('getAgent() returns undefined for unknown id', async () => {
    const reg = new PostgresRegistry()
    expect(await reg.getAgent('missing')).toBeUndefined()
  })

  it('deregister() removes the agent and emits deregistered event', async () => {
    const reg = new PostgresRegistry()
    const registered = await reg.register(makeInput())
    const events: RegistryEvent[] = []
    reg.subscribe({}, (e) => events.push(e))

    await reg.deregister(registered.id)

    expect(await reg.getAgent(registered.id)).toBeUndefined()
    expect(events.some((e) => e.type === 'registry:agent_deregistered')).toBe(true)
  })

  it('deregister() throws for unknown agent id', async () => {
    const reg = new PostgresRegistry()
    await expect(reg.deregister('missing')).rejects.toThrow(/Agent not found/)
  })
})

// ---------------------------------------------------------------------------
// PostgresRegistry — update
// ---------------------------------------------------------------------------

describe('PostgresRegistry — update()', () => {
  it('throws for unknown agent id', async () => {
    const reg = new PostgresRegistry()
    await expect(reg.update('missing', { name: 'x' })).rejects.toThrow(/Agent not found/)
  })

  it('updates name and emits agent_updated with changed fields', async () => {
    const reg = new PostgresRegistry()
    const agent = await reg.register(makeInput({ name: 'old' }))
    const events: RegistryEvent[] = []
    reg.subscribe({}, (e) => events.push(e))

    const updated = await reg.update(agent.id, { name: 'new' })

    expect(updated.name).toBe('new')
    const updEvt = events.find((e) => e.type === 'registry:agent_updated')
    expect(updEvt).toBeDefined()
  })

  it('emits capability_added for new capabilities only', async () => {
    const reg = new PostgresRegistry()
    const agent = await reg.register(makeInput({ capabilities: [cap('a')] }))
    const events: RegistryEvent[] = []
    reg.subscribe({}, (e) => events.push(e))

    await reg.update(agent.id, { capabilities: [cap('a'), cap('b')] })

    const added = events.filter((e) => e.type === 'registry:capability_added')
    expect(added).toHaveLength(1)
  })

  it('updates description, endpoint, protocols, version, sla, metadata, ttlMs, uri', async () => {
    const reg = new PostgresRegistry()
    const agent = await reg.register(makeInput())

    const updated = await reg.update(agent.id, {
      description: 'new desc',
      endpoint: 'https://new.example.com',
      protocols: ['mcp'],
      version: '2.0.0',
      sla: { maxLatencyMs: 1000 },
      metadata: { team: 'b' },
      ttlMs: 5000,
      uri: 'forge://new',
    })

    expect(updated.description).toBe('new desc')
    expect(updated.endpoint).toBe('https://new.example.com')
    expect(updated.protocols).toEqual(['mcp'])
    expect(updated.version).toBe('2.0.0')
    expect(updated.sla).toEqual({ maxLatencyMs: 1000 })
    expect(updated.metadata).toEqual({ team: 'b' })
    expect(updated.ttlMs).toBe(5000)
    expect(updated.uri).toBe('forge://new')
  })

  it('updates authentication block', async () => {
    const reg = new PostgresRegistry()
    const agent = await reg.register(makeInput({
      authentication: { type: 'bearer', config: { scope: 'r' } },
    }))

    const updated = await reg.update(agent.id, {
      authentication: { type: 'api-key', config: { keyId: 'k' } },
    })

    expect(updated.authentication).toEqual({
      type: 'api-key',
      config: { keyId: 'k' },
    })
  })

  it('updates identity block', async () => {
    const reg = new PostgresRegistry()
    const agent = await reg.register(makeInput())

    const updated = await reg.update(agent.id, {
      identity: { id: 'new-id', uri: 'forge://x', displayName: 'X' },
    })

    expect(updated.identity?.id).toBe('new-id')
  })

  it('does not emit agent_updated when no fields change', async () => {
    const reg = new PostgresRegistry()
    const agent = await reg.register(makeInput())
    const events: RegistryEvent[] = []
    reg.subscribe({}, (e) => events.push(e))

    await reg.update(agent.id, {})

    expect(events.find((e) => e.type === 'registry:agent_updated')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// PostgresRegistry — health
// ---------------------------------------------------------------------------

describe('PostgresRegistry — health', () => {
  it('getHealth() returns the initial unknown status', async () => {
    const reg = new PostgresRegistry()
    const agent = await reg.register(makeInput())
    expect((await reg.getHealth(agent.id))?.status).toBe('unknown')
  })

  it('getHealth() returns undefined for unknown agent', async () => {
    const reg = new PostgresRegistry()
    expect(await reg.getHealth('missing')).toBeUndefined()
  })

  it('updateHealth() throws for unknown agent', async () => {
    const reg = new PostgresRegistry()
    await expect(reg.updateHealth('missing', { status: 'healthy' })).rejects.toThrow(/Agent not found/)
  })

  it('updateHealth() emits health_changed only on transition', async () => {
    const reg = new PostgresRegistry()
    const agent = await reg.register(makeInput())
    const events: RegistryEvent[] = []
    reg.subscribe({}, (e) => events.push(e))

    await reg.updateHealth(agent.id, { status: 'healthy' })
    await reg.updateHealth(agent.id, { status: 'healthy' })

    const changes = events.filter((e) => e.type === 'registry:health_changed')
    expect(changes).toHaveLength(1)
  })

  it('updateHealth() merges additional health fields', async () => {
    const reg = new PostgresRegistry()
    const agent = await reg.register(makeInput())

    await reg.updateHealth(agent.id, { status: 'healthy', latencyMs: 42 } as Partial<AgentHealth>)

    const health = await reg.getHealth(agent.id)
    expect(health?.status).toBe('healthy')
  })
})

// ---------------------------------------------------------------------------
// PostgresRegistry — discover
// ---------------------------------------------------------------------------

describe('PostgresRegistry — discover()', () => {
  it('returns all agents for an unfiltered query', async () => {
    const reg = new PostgresRegistry()
    await reg.register(makeInput({ name: 'a' }))
    await reg.register(makeInput({ name: 'b' }))

    const page = await reg.discover({})

    expect(page.results).toHaveLength(2)
    expect(page.total).toBe(2)
  })

  it('scores capability prefix matches higher than non-matches', async () => {
    const reg = new PostgresRegistry()
    await reg.register(makeInput({ name: 'code', capabilities: [cap('code.review')] }))
    await reg.register(makeInput({ name: 'data', capabilities: [cap('data.export')] }))

    const page = await reg.discover({ capabilityPrefix: 'code.' })

    // Matching agent is ranked first (higher capabilityScore)
    expect(page.results[0]!.agent.name).toBe('code')
    expect(page.results[0]!.scoreBreakdown.capabilityScore).toBe(1)
  })

  it('scores capabilityExact matches', async () => {
    const reg = new PostgresRegistry()
    const a = await reg.register(makeInput({ name: 'a', capabilities: [cap('ping')] }))
    await reg.register(makeInput({ name: 'b', capabilities: [cap('pong')] }))

    const page = await reg.discover({
      capabilityExact: { name: 'ping', version: '1.0.0' },
    })

    const matched = page.results.find((r) => r.agent.id === a.id)
    expect(matched?.scoreBreakdown.capabilityScore).toBe(1)
  })

  it('filters by protocols', async () => {
    const reg = new PostgresRegistry()
    await reg.register(makeInput({ name: 'a', protocols: ['a2a'] }))
    await reg.register(makeInput({ name: 'b', protocols: ['mcp'] }))

    const page = await reg.discover({ protocols: ['mcp'] })

    expect(page.results).toHaveLength(1)
    expect(page.results[0]!.agent.name).toBe('b')
  })

  it('filters by health status', async () => {
    const reg = new PostgresRegistry()
    const a = await reg.register(makeInput({ name: 'a' }))
    await reg.register(makeInput({ name: 'b' }))

    await reg.updateHealth(a.id, { status: 'healthy' })

    const page = await reg.discover({ healthFilter: ['healthy'] })

    expect(page.results).toHaveLength(1)
    expect(page.results[0]!.agent.name).toBe('a')
  })

  it('sorts results by matchScore descending', async () => {
    const reg = new PostgresRegistry()
    await reg.register(makeInput({ name: 'match', capabilities: [cap('code.review')] }))
    const noMatch = await reg.register(makeInput({ name: 'nomatch', capabilities: [cap('other')] }))

    // Mark "nomatch" as unhealthy so it scores lower
    await reg.updateHealth(noMatch.id, { status: 'unhealthy' })

    const page = await reg.discover({ capabilityPrefix: 'code.' })

    expect(page.results[0]!.agent.name).toBe('match')
  })

  it('applies limit and offset', async () => {
    const reg = new PostgresRegistry()
    await reg.register(makeInput({ name: 'a' }))
    await reg.register(makeInput({ name: 'b' }))
    await reg.register(makeInput({ name: 'c' }))

    const page = await reg.discover({ limit: 1, offset: 1 })

    expect(page.results).toHaveLength(1)
    expect(page.limit).toBe(1)
    expect(page.offset).toBe(1)
  })

  it('scores tag matches when tags filter is provided', async () => {
    const reg = new PostgresRegistry()
    await reg.register(makeInput({ name: 'tagged', capabilities: [cap('x', ['red', 'blue'])] }))

    const page = await reg.discover({ tags: ['red'] })

    expect(page.results).toHaveLength(1)
    expect(page.results[0]!.scoreBreakdown.tagScore).toBeGreaterThan(0)
  })

  it('scores SLA when slaFilter is provided', async () => {
    const reg = new PostgresRegistry()
    await reg.register(makeInput({ name: 'fast', sla: { maxLatencyMs: 100 } }))

    const page = await reg.discover({ slaFilter: { maxLatencyMs: 500 } })

    expect(page.results[0]!.scoreBreakdown.slaScore).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// PostgresRegistry — subscribe / listAgents / stats / evictExpired
// ---------------------------------------------------------------------------

describe('PostgresRegistry — subscription & stats', () => {
  it('subscribe() returns an unsubscribe handle that stops event delivery', async () => {
    const reg = new PostgresRegistry()
    const events: RegistryEvent[] = []
    const sub = reg.subscribe({}, (e) => events.push(e))

    await reg.register(makeInput({ name: 'a' }))
    sub.unsubscribe()
    await reg.register(makeInput({ name: 'b' }))

    expect(events).toHaveLength(1)
  })

  it('subscribe filter.eventTypes restricts delivered events', async () => {
    const reg = new PostgresRegistry()
    const events: RegistryEvent[] = []
    reg.subscribe({ eventTypes: ['registry:agent_deregistered'] }, (e) => events.push(e))

    const a = await reg.register(makeInput({ name: 'a' }))
    await reg.deregister(a.id)

    expect(events.every((e) => e.type === 'registry:agent_deregistered')).toBe(true)
    expect(events).toHaveLength(1)
  })

  it('subscribe filter.agentIds restricts to matching agent ids', async () => {
    const reg = new PostgresRegistry()
    const a = await reg.register(makeInput({ name: 'a' }))
    const events: RegistryEvent[] = []
    reg.subscribe({ agentIds: [a.id] }, (e) => events.push(e))

    await reg.register(makeInput({ name: 'b' }))
    await reg.updateHealth(a.id, { status: 'healthy' })

    // Only the health_changed event for a matches
    expect(events.some((e) => e.agentId === a.id)).toBe(true)
  })

  it('forwards events to the provided eventBus when configured', async () => {
    const emit = vi.fn()
    const eventBus = { emit, on: vi.fn(), off: vi.fn() } as unknown as DzupEventBus
    const reg = new PostgresRegistry({ eventBus })

    await reg.register(makeInput())

    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('handler errors are swallowed and do not break delivery', async () => {
    const reg = new PostgresRegistry()
    reg.subscribe({}, () => { throw new Error('boom') })

    // Should not throw despite the handler error
    await expect(reg.register(makeInput())).resolves.toBeDefined()
  })

  it('listAgents() returns agents and total count', async () => {
    const reg = new PostgresRegistry()
    await reg.register(makeInput({ name: 'a' }))
    await reg.register(makeInput({ name: 'b' }))

    const { agents, total } = await reg.listAgents()

    expect(agents).toHaveLength(2)
    expect(total).toBe(2)
  })

  it('listAgents() supports limit and offset', async () => {
    const reg = new PostgresRegistry()
    await reg.register(makeInput({ name: 'a' }))
    await reg.register(makeInput({ name: 'b' }))
    await reg.register(makeInput({ name: 'c' }))

    const { agents } = await reg.listAgents(2, 1)

    expect(agents).toHaveLength(2)
  })

  it('stats() aggregates health, capabilities, protocols', async () => {
    const reg = new PostgresRegistry()
    const a = await reg.register(makeInput({ name: 'a', protocols: ['a2a'] }))
    const b = await reg.register(makeInput({ name: 'b', protocols: ['mcp'], capabilities: [cap('other')] }))
    await reg.updateHealth(a.id, { status: 'healthy' })
    await reg.updateHealth(b.id, { status: 'unhealthy' })

    const s = await reg.stats()

    expect(s.totalAgents).toBe(2)
    expect(s.healthyAgents).toBe(1)
    expect(s.unhealthyAgents).toBe(1)
    expect(s.capabilityCount).toBe(2)
    expect(s.protocolCounts['a2a']).toBe(1)
    expect(s.protocolCounts['mcp']).toBe(1)
  })

  it('stats() counts degraded separately', async () => {
    const reg = new PostgresRegistry()
    const a = await reg.register(makeInput())
    await reg.updateHealth(a.id, { status: 'degraded' })

    const s = await reg.stats()
    expect(s.degradedAgents).toBe(1)
  })

  it('evictExpired() removes past-TTL agents and returns their ids', async () => {
    const store = new InMemoryRegistryStore()
    const reg = new PostgresRegistry({ store })

    // Insert a row directly with a past registration and small ttl
    await store.insert(makeRow({
      id: 'expired-1',
      registered_at: new Date(Date.now() - 10_000).toISOString(),
      ttl_ms: 1,
    }))

    const events: RegistryEvent[] = []
    reg.subscribe({}, (e) => events.push(e))

    const evicted = await reg.evictExpired()

    expect(evicted).toEqual(['expired-1'])
    expect(events.some((e) => e.type === 'registry:agent_deregistered')).toBe(true)
  })

  it('evictExpired() returns empty array when nothing is expired', async () => {
    const reg = new PostgresRegistry()
    await reg.register(makeInput())
    expect(await reg.evictExpired()).toEqual([])
  })

  it('registerFromCard() rejects with REGISTRY_CARD_FETCH_FAILED', async () => {
    const reg = new PostgresRegistry()
    await expect(reg.registerFromCard('https://x')).rejects.toThrow(/PostgresRegistry does not support/)
  })
})

// ---------------------------------------------------------------------------
// Row mapping edge cases
// ---------------------------------------------------------------------------

describe('PostgresRegistry — row mapping edge cases', () => {
  it('handles rows with null optional fields', async () => {
    const store = new InMemoryRegistryStore()
    await store.insert(makeRow({
      id: 'r1',
      authentication_type: null,
      authentication_config: null,
      version: null,
      sla: null,
      metadata: null,
      ttl_ms: null,
      identity: null,
      uri: null,
    }))

    const reg = new PostgresRegistry({ store })
    const agent = await reg.getAgent('r1')

    expect(agent?.authentication).toBeUndefined()
    expect(agent?.version).toBeUndefined()
    expect(agent?.ttlMs).toBeUndefined()
  })

  it('strips unknown authentication types on read', async () => {
    const store = new InMemoryRegistryStore()
    await store.insert(makeRow({
      id: 'r1',
      authentication_type: 'not-a-real-type',
      authentication_config: { foo: 'bar' },
    }))

    const reg = new PostgresRegistry({ store })
    const agent = await reg.getAgent('r1')
    expect(agent?.authentication).toBeUndefined()
  })

  it('accepts all documented auth types', async () => {
    const store = new InMemoryRegistryStore()
    const types = ['none', 'bearer', 'api-key', 'oauth2', 'mtls', 'delegation'] as const

    for (const t of types) {
      await store.insert(makeRow({
        id: `id-${t}`,
        authentication_type: t,
        authentication_config: {},
      }))
    }

    const reg = new PostgresRegistry({ store })
    for (const t of types) {
      const agent = await reg.getAgent(`id-${t}`)
      expect(agent?.authentication?.type).toBe(t)
    }
  })
})
