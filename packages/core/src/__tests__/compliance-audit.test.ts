import { describe, it, expect, vi } from 'vitest'
import { InMemoryAuditStore } from '../security/audit/in-memory-audit-store.js'
import { ComplianceAuditLogger } from '../security/audit/audit-logger.js'
import { createEventBus } from '../events/event-bus.js'
import type { ComplianceAuditEntry } from '../security/audit/audit-types.js'
import type { DzupEvent } from '../events/event-types.js'

// ---------------------------------------------------------------------------
// InMemoryAuditStore
// ---------------------------------------------------------------------------
describe('InMemoryAuditStore', () => {
  function makeEntry(
    overrides: Partial<Omit<ComplianceAuditEntry, 'seq' | 'previousHash' | 'hash'>> = {},
  ): Omit<ComplianceAuditEntry, 'seq' | 'previousHash' | 'hash'> {
    return {
      id: overrides.id ?? 'e1',
      timestamp: overrides.timestamp ?? new Date('2026-01-01T00:00:00Z'),
      actor: overrides.actor ?? { id: 'user1', type: 'user' },
      action: overrides.action ?? 'tool.execute',
      result: overrides.result ?? 'success',
      details: overrides.details ?? {},
      resource: overrides.resource,
      traceId: overrides.traceId,
      spanId: overrides.spanId,
    }
  }

  it('append assigns seq, previousHash, and hash', async () => {
    const store = new InMemoryAuditStore()
    const entry = await store.append(makeEntry())

    expect(entry.seq).toBe(1)
    expect(entry.previousHash).toBe('')
    expect(entry.hash).toBeTruthy()
    expect(typeof entry.hash).toBe('string')
    expect(entry.hash.length).toBeGreaterThan(0)
  })

  it('builds a hash chain across multiple entries', async () => {
    const store = new InMemoryAuditStore()
    const e1 = await store.append(makeEntry({ id: 'e1' }))
    const e2 = await store.append(makeEntry({ id: 'e2' }))
    const e3 = await store.append(makeEntry({ id: 'e3' }))

    expect(e1.seq).toBe(1)
    expect(e2.seq).toBe(2)
    expect(e3.seq).toBe(3)

    expect(e1.previousHash).toBe('')
    expect(e2.previousHash).toBe(e1.hash)
    expect(e3.previousHash).toBe(e2.hash)

    // Each hash should be unique
    const hashes = new Set([e1.hash, e2.hash, e3.hash])
    expect(hashes.size).toBe(3)
  })

  it('search by actorId', async () => {
    const store = new InMemoryAuditStore()
    await store.append(makeEntry({ id: 'e1', actor: { id: 'a1', type: 'user' } }))
    await store.append(makeEntry({ id: 'e2', actor: { id: 'a2', type: 'agent' } }))
    await store.append(makeEntry({ id: 'e3', actor: { id: 'a1', type: 'user' } }))

    const results = await store.search({ actorId: 'a1' })
    expect(results).toHaveLength(2)
    expect(results.every((r) => r.actor.id === 'a1')).toBe(true)
  })

  it('search by actorType', async () => {
    const store = new InMemoryAuditStore()
    await store.append(makeEntry({ id: 'e1', actor: { id: 'a1', type: 'user' } }))
    await store.append(makeEntry({ id: 'e2', actor: { id: 'a2', type: 'agent' } }))

    const results = await store.search({ actorType: 'agent' })
    expect(results).toHaveLength(1)
    expect(results[0]!.actor.type).toBe('agent')
  })

  it('search by action', async () => {
    const store = new InMemoryAuditStore()
    await store.append(makeEntry({ id: 'e1', action: 'tool.execute' }))
    await store.append(makeEntry({ id: 'e2', action: 'memory.write' }))

    const results = await store.search({ action: 'memory.write' })
    expect(results).toHaveLength(1)
    expect(results[0]!.action).toBe('memory.write')
  })

  it('search by result', async () => {
    const store = new InMemoryAuditStore()
    await store.append(makeEntry({ id: 'e1', result: 'success' }))
    await store.append(makeEntry({ id: 'e2', result: 'denied' }))
    await store.append(makeEntry({ id: 'e3', result: 'denied' }))

    const results = await store.search({ result: 'denied' })
    expect(results).toHaveLength(2)
  })

  it('search by date range', async () => {
    const store = new InMemoryAuditStore()
    await store.append(makeEntry({ id: 'e1', timestamp: new Date('2026-01-01') }))
    await store.append(makeEntry({ id: 'e2', timestamp: new Date('2026-06-15') }))
    await store.append(makeEntry({ id: 'e3', timestamp: new Date('2026-12-31') }))

    const results = await store.search({
      fromDate: new Date('2026-03-01'),
      toDate: new Date('2026-09-01'),
    })
    expect(results).toHaveLength(1)
    expect(results[0]!.id).toBe('e2')
  })

  it('search with limit and offset', async () => {
    const store = new InMemoryAuditStore()
    for (let i = 0; i < 10; i++) {
      await store.append(makeEntry({ id: `e${i}` }))
    }

    const results = await store.search({ limit: 3, offset: 2 })
    expect(results).toHaveLength(3)
    expect(results[0]!.seq).toBe(3)
    expect(results[2]!.seq).toBe(5)
  })

  it('count returns matching entry count', async () => {
    const store = new InMemoryAuditStore()
    await store.append(makeEntry({ id: 'e1', result: 'success' }))
    await store.append(makeEntry({ id: 'e2', result: 'denied' }))
    await store.append(makeEntry({ id: 'e3', result: 'success' }))

    expect(await store.count({ result: 'success' })).toBe(2)
    expect(await store.count({ result: 'denied' })).toBe(1)
    expect(await store.count({})).toBe(3)
  })

  it('verifyIntegrity returns valid for intact chain', async () => {
    const store = new InMemoryAuditStore()
    await store.append(makeEntry({ id: 'e1' }))
    await store.append(makeEntry({ id: 'e2' }))
    await store.append(makeEntry({ id: 'e3' }))

    const result = await store.verifyIntegrity()
    expect(result.valid).toBe(true)
    expect(result.totalEntries).toBe(3)
    expect(result.brokenAtSeq).toBeUndefined()
  })

  it('verifyIntegrity returns valid for empty store', async () => {
    const store = new InMemoryAuditStore()
    const result = await store.verifyIntegrity()
    expect(result.valid).toBe(true)
    expect(result.totalEntries).toBe(0)
  })

  it('verifyIntegrity detects tampered entries', async () => {
    const store = new InMemoryAuditStore()
    await store.append(makeEntry({ id: 'e1' }))
    await store.append(makeEntry({ id: 'e2' }))
    await store.append(makeEntry({ id: 'e3' }))

    // Tamper with internal state — cast to access private entries
    const entries = (store as unknown as { entries: ComplianceAuditEntry[] }).entries
    entries[1]!.hash = 'tampered_hash'

    const result = await store.verifyIntegrity()
    expect(result.valid).toBe(false)
    expect(result.brokenAtSeq).toBeDefined()
  })

  it('applyRetention removes old entries', async () => {
    const store = new InMemoryAuditStore()
    const now = Date.now()
    await store.append(makeEntry({ id: 'old', timestamp: new Date(now - 100 * 24 * 60 * 60 * 1000) }))
    await store.append(makeEntry({ id: 'recent', timestamp: new Date(now - 10 * 24 * 60 * 60 * 1000) }))

    const result = await store.applyRetention([{ maxAgeDays: 30, action: 'delete' }])
    expect(result.deleted).toBe(1)
    expect(result.archived).toBe(0)

    const remaining = await store.search({})
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.id).toBe('recent')
  })

  it('applyRetention counts archived entries', async () => {
    const store = new InMemoryAuditStore()
    const now = Date.now()
    await store.append(makeEntry({ id: 'old', timestamp: new Date(now - 400 * 24 * 60 * 60 * 1000) }))
    await store.append(makeEntry({ id: 'recent', timestamp: new Date() }))

    const result = await store.applyRetention([
      { maxAgeDays: 365, action: 'archive', regulation: 'SOX' },
    ])
    expect(result.archived).toBe(1)
    expect(result.deleted).toBe(0)
  })

  it('export yields NDJSON lines', async () => {
    const store = new InMemoryAuditStore()
    await store.append(makeEntry({ id: 'e1' }))
    await store.append(makeEntry({ id: 'e2' }))

    const lines: string[] = []
    for await (const line of store.export()) {
      lines.push(line)
    }

    expect(lines).toHaveLength(2)
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>
      expect(parsed).toHaveProperty('id')
      expect(parsed).toHaveProperty('hash')
      expect(parsed).toHaveProperty('timestamp')
      expect(typeof parsed['timestamp']).toBe('string') // ISO string
    }
  })
})

// ---------------------------------------------------------------------------
// ComplianceAuditLogger
// ---------------------------------------------------------------------------
describe('ComplianceAuditLogger', () => {
  it('record creates entry with hash and seq', async () => {
    const store = new InMemoryAuditStore()
    const logger = new ComplianceAuditLogger({ store })

    const entry = await logger.record({
      actor: { id: 'agent-1', type: 'agent', name: 'CodeGen' },
      action: 'file.write',
      result: 'success',
      details: { path: '/src/main.ts' },
    })

    expect(entry.id).toBeTruthy()
    expect(entry.seq).toBe(1)
    expect(entry.hash).toBeTruthy()
    expect(entry.previousHash).toBe('')
    expect(entry.actor.id).toBe('agent-1')
    expect(entry.action).toBe('file.write')
    expect(entry.timestamp).toBeInstanceOf(Date)
  })

  it('attach records security events from event bus', async () => {
    const store = new InMemoryAuditStore()
    const logger = new ComplianceAuditLogger({ store })
    const bus = createEventBus()

    logger.attach(bus)

    // Emit a security event that should be recorded
    bus.emit({
      type: 'policy:denied',
      policySetId: 'ps-1',
      action: 'tool:execute',
      principalId: 'user-1',
      reason: 'insufficient permissions',
    } as DzupEvent)

    // Give the async handler time to complete
    await new Promise((resolve) => setTimeout(resolve, 10))

    const entries = await store.search({})
    expect(entries.length).toBeGreaterThanOrEqual(1)

    const denied = entries.find((e) => e.action === 'policy.denied')
    expect(denied).toBeDefined()
    expect(denied!.result).toBe('denied')
  })

  it('redacts legacy tool input values before storing audit details', async () => {
    const store = new InMemoryAuditStore()
    const logger = new ComplianceAuditLogger({ store })
    const bus = createEventBus()
    const secret = 'sk-live-secret-do-not-store'

    logger.attach(bus)

    bus.emit({
      type: 'tool:called',
      toolName: 'deploy',
      agentId: 'agent-1',
      runId: 'run-1',
      toolCallId: 'call-1',
      input: { token: secret, region: 'eu' },
    })

    await new Promise((resolve) => setTimeout(resolve, 10))

    const entries = await store.search({})
    expect(entries).toHaveLength(1)
    expect(entries[0]!.action).toBe('tool.called')
    expect(entries[0]!.details).toMatchObject({
      toolName: 'deploy',
      agentId: 'agent-1',
      runId: 'run-1',
      toolCallId: 'call-1',
      inputMetadataKeys: ['token', 'region'],
      inputRedacted: true,
    })
    expect(entries[0]!.details).not.toHaveProperty('input')
    expect(JSON.stringify(entries[0])).not.toContain(secret)
  })

  it('attach ignores non-security events', async () => {
    const store = new InMemoryAuditStore()
    const logger = new ComplianceAuditLogger({ store })
    const bus = createEventBus()

    logger.attach(bus)

    // Emit an event NOT in the security mapping
    bus.emit({
      type: 'mcp:connected',
      serverName: 'test',
      toolCount: 3,
    })

    await new Promise((resolve) => setTimeout(resolve, 10))

    const entries = await store.search({})
    expect(entries).toHaveLength(0)
  })

  it('detach stops recording events', async () => {
    const store = new InMemoryAuditStore()
    const logger = new ComplianceAuditLogger({ store })
    const bus = createEventBus()

    logger.attach(bus)
    logger.detach()

    bus.emit({
      type: 'safety:violation',
      category: 'prompt_injection',
      severity: 'high',
      message: 'detected injection attempt',
    } as DzupEvent)

    await new Promise((resolve) => setTimeout(resolve, 10))

    const entries = await store.search({})
    expect(entries).toHaveLength(0)
  })

  it('dispose is equivalent to detach', () => {
    const store = new InMemoryAuditStore()
    const logger = new ComplianceAuditLogger({ store })
    const bus = createEventBus()

    logger.attach(bus)
    // Should not throw
    logger.dispose()
    logger.dispose() // Idempotent
  })
})

// ---------------------------------------------------------------------------
// Pipeline event types — compile-time discriminated union tests
// ---------------------------------------------------------------------------
describe('Pipeline event types', () => {
  it('pipeline:run_started has correct shape', () => {
    const event: DzupEvent = {
      type: 'pipeline:run_started',
      pipelineId: 'p1',
      runId: 'r1',
    }
    expect(event.type).toBe('pipeline:run_started')
  })

  it('pipeline:node_completed has durationMs', () => {
    const event: DzupEvent = {
      type: 'pipeline:node_completed',
      pipelineId: 'p1',
      runId: 'r1',
      nodeId: 'n1',
      durationMs: 150,
    }
    expect(event.type).toBe('pipeline:node_completed')
  })

  it('pipeline:run_cancelled has optional reason', () => {
    const event: DzupEvent = {
      type: 'pipeline:run_cancelled',
      pipelineId: 'p1',
      runId: 'r1',
    }
    expect(event.type).toBe('pipeline:run_cancelled')

    const eventWithReason: DzupEvent = {
      type: 'pipeline:run_cancelled',
      pipelineId: 'p1',
      runId: 'r1',
      reason: 'user requested',
    }
    expect(eventWithReason.type).toBe('pipeline:run_cancelled')
  })

  it('pipeline:loop_iteration has iteration number', () => {
    const event: DzupEvent = {
      type: 'pipeline:loop_iteration',
      pipelineId: 'p1',
      runId: 'r1',
      nodeId: 'loop1',
      iteration: 3,
    }
    expect(event.type).toBe('pipeline:loop_iteration')
  })
})

// ---------------------------------------------------------------------------
// Security event types — compile-time discriminated union tests
// ---------------------------------------------------------------------------
describe('Security event types', () => {
  it('policy:evaluated has correct shape', () => {
    const event: DzupEvent = {
      type: 'policy:evaluated',
      policySetId: 'ps1',
      action: 'tool:execute',
      effect: 'allow',
      durationUs: 42,
    }
    expect(event.type).toBe('policy:evaluated')
  })

  it('safety:violation has optional agentId', () => {
    const event: DzupEvent = {
      type: 'safety:violation',
      category: 'prompt_injection',
      severity: 'critical',
      message: 'detected injection',
    }
    expect(event.type).toBe('safety:violation')
  })

  it('memory:threat_detected has optional key', () => {
    const event: DzupEvent = {
      type: 'memory:threat_detected',
      threatType: 'injection',
      namespace: 'lessons',
    }
    expect(event.type).toBe('memory:threat_detected')
  })

  it('memory:quarantined has required fields', () => {
    const event: DzupEvent = {
      type: 'memory:quarantined',
      namespace: 'lessons',
      key: 'bad-entry',
      reason: 'suspicious content detected',
    }
    expect(event.type).toBe('memory:quarantined')
  })
})
