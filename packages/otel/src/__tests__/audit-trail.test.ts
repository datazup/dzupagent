import { describe, it, expect, beforeEach } from 'vitest'
import { createEventBus } from '@forgeagent/core'
import type { ForgeEventBus } from '@forgeagent/core'
import { AuditTrail, InMemoryAuditStore } from '../audit-trail.js'
import type { AuditEntry } from '../audit-trail.js'

/**
 * Small helper — wait for async event handler to process.
 */
async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10))
}

describe('AuditTrail', () => {
  let bus: ForgeEventBus
  let store: InMemoryAuditStore
  let trail: AuditTrail

  beforeEach(() => {
    bus = createEventBus()
    store = new InMemoryAuditStore()
    trail = new AuditTrail({ store })
  })

  describe('hash chain validity', () => {
    it('produces a valid hash chain', async () => {
      trail.attach(bus)

      bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
      bus.emit({ type: 'agent:completed', agentId: 'a1', runId: 'r1', durationMs: 500 })
      await tick()

      const entries = await store.getAll()
      expect(entries.length).toBe(2)

      const result = trail.verifyChain(entries)
      expect(result.valid).toBe(true)
      expect(result.brokenAt).toBeUndefined()
    })

    it('first entry has zero previousHash', async () => {
      trail.attach(bus)

      bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
      await tick()

      const entries = await store.getAll()
      expect(entries[0]!.previousHash).toBe('0'.repeat(64))
    })

    it('second entry references first entry hash', async () => {
      trail.attach(bus)

      bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
      bus.emit({ type: 'agent:completed', agentId: 'a1', runId: 'r1', durationMs: 100 })
      await tick()

      const entries = await store.getAll()
      expect(entries[1]!.previousHash).toBe(entries[0]!.hash)
    })
  })

  describe('tamper detection', () => {
    it('detects tampered entry via verifyChain()', async () => {
      trail.attach(bus)

      bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
      bus.emit({ type: 'agent:completed', agentId: 'a1', runId: 'r1', durationMs: 500 })
      bus.emit({ type: 'tool:called', toolName: 'read_file', input: {} })
      await tick()

      const entries = await store.getAll()

      // Tamper with the second entry
      const tampered: AuditEntry[] = entries.map((e, i) =>
        i === 1
          ? { ...e, action: 'TAMPERED_ACTION' }
          : e,
      )

      const result = trail.verifyChain(tampered)
      expect(result.valid).toBe(false)
      expect(result.brokenAt).toBe(1)
    })

    it('detects broken chain link', async () => {
      trail.attach(bus)

      bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
      bus.emit({ type: 'agent:completed', agentId: 'a1', runId: 'r1', durationMs: 100 })
      await tick()

      const entries = await store.getAll()

      // Break the chain by modifying previousHash of entry 1
      const broken: AuditEntry[] = [
        entries[0]!,
        { ...entries[1]!, previousHash: 'deadbeef'.repeat(8) },
      ]

      const result = trail.verifyChain(broken)
      expect(result.valid).toBe(false)
      expect(result.brokenAt).toBe(1)
    })
  })

  describe('event bus mapping', () => {
    beforeEach(() => {
      trail.attach(bus)
    })

    it('maps agent:started to agent_lifecycle', async () => {
      bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
      await tick()

      const entries = await store.getByCategory('agent_lifecycle')
      expect(entries).toHaveLength(1)
      expect(entries[0]!.action).toBe('agent:started')
      expect(entries[0]!.agentId).toBe('a1')
      expect(entries[0]!.runId).toBe('r1')
    })

    it('maps agent:completed to agent_lifecycle', async () => {
      bus.emit({ type: 'agent:completed', agentId: 'a1', runId: 'r1', durationMs: 1000 })
      await tick()

      const entries = await store.getByCategory('agent_lifecycle')
      expect(entries).toHaveLength(1)
      expect(entries[0]!.action).toBe('agent:completed')
      expect(entries[0]!.details['durationMs']).toBe(1000)
    })

    it('maps agent:failed to agent_lifecycle', async () => {
      bus.emit({
        type: 'agent:failed',
        agentId: 'a1',
        runId: 'r1',
        errorCode: 'PROVIDER_UNAVAILABLE',
        message: 'down',
      })
      await tick()

      const entries = await store.getByCategory('agent_lifecycle')
      expect(entries).toHaveLength(1)
      expect(entries[0]!.action).toBe('agent:failed')
    })

    it('maps tool:called to tool_execution', async () => {
      bus.emit({ type: 'tool:called', toolName: 'git_status', input: {} })
      await tick()

      const entries = await store.getByCategory('tool_execution')
      expect(entries).toHaveLength(1)
      expect(entries[0]!.action).toBe('tool:called:git_status')
    })

    it('maps tool:result to tool_execution', async () => {
      bus.emit({ type: 'tool:result', toolName: 'read_file', durationMs: 50 })
      await tick()

      const entries = await store.getByCategory('tool_execution')
      expect(entries).toHaveLength(1)
      expect(entries[0]!.action).toBe('tool:result:read_file')
    })

    it('maps tool:error to tool_execution', async () => {
      bus.emit({
        type: 'tool:error',
        toolName: 'write_file',
        errorCode: 'TOOL_EXECUTION_FAILED',
        message: 'denied',
      })
      await tick()

      const entries = await store.getByCategory('tool_execution')
      expect(entries).toHaveLength(1)
      expect(entries[0]!.action).toBe('tool:error:write_file')
    })

    it('maps memory:written to memory_mutation', async () => {
      bus.emit({ type: 'memory:written', namespace: 'lessons', key: 'k1' })
      await tick()

      const entries = await store.getByCategory('memory_mutation')
      expect(entries).toHaveLength(1)
      expect(entries[0]!.details['namespace']).toBe('lessons')
    })

    it('maps approval:requested to approval_action', async () => {
      bus.emit({ type: 'approval:requested', runId: 'r1', plan: {} })
      await tick()

      const entries = await store.getByCategory('approval_action')
      expect(entries).toHaveLength(1)
      expect(entries[0]!.runId).toBe('r1')
    })

    it('maps approval:granted to approval_action', async () => {
      bus.emit({ type: 'approval:granted', runId: 'r1', approvedBy: 'user1' })
      await tick()

      const entries = await store.getByCategory('approval_action')
      expect(entries).toHaveLength(1)
      expect(entries[0]!.details['approvedBy']).toBe('user1')
    })

    it('maps approval:rejected to approval_action', async () => {
      bus.emit({ type: 'approval:rejected', runId: 'r1', reason: 'unsafe' })
      await tick()

      const entries = await store.getByCategory('approval_action')
      expect(entries).toHaveLength(1)
      expect(entries[0]!.details['reason']).toBe('unsafe')
    })

    it('maps budget:warning to cost_threshold', async () => {
      bus.emit({
        type: 'budget:warning',
        level: 'warn',
        usage: {
          tokensUsed: 5000, tokensLimit: 10000,
          costCents: 50, costLimitCents: 100,
          iterations: 3, iterationsLimit: 10, percent: 50,
        },
      })
      await tick()

      const entries = await store.getByCategory('cost_threshold')
      expect(entries).toHaveLength(1)
      expect(entries[0]!.action).toBe('budget:warning')
    })

    it('maps budget:exceeded to cost_threshold', async () => {
      bus.emit({
        type: 'budget:exceeded',
        reason: 'tokens',
        usage: {
          tokensUsed: 10000, tokensLimit: 10000,
          costCents: 100, costLimitCents: 100,
          iterations: 10, iterationsLimit: 10, percent: 100,
        },
      })
      await tick()

      const entries = await store.getByCategory('cost_threshold')
      expect(entries).toHaveLength(1)
      expect(entries[0]!.action).toBe('budget:exceeded')
    })

    it('ignores unmapped events', async () => {
      bus.emit({ type: 'plugin:registered', pluginName: 'my-plugin' })
      await tick()

      const entries = await store.getAll()
      expect(entries).toHaveLength(0)
    })
  })

  describe('InMemoryAuditStore', () => {
    it('append and getAll', async () => {
      const entry: AuditEntry = {
        id: 'id-1', seq: 0, timestamp: new Date(),
        category: 'agent_lifecycle', action: 'test',
        details: {}, previousHash: '0'.repeat(64), hash: 'abc',
      }
      await store.append(entry)

      const all = await store.getAll()
      expect(all).toHaveLength(1)
      expect(all[0]).toEqual(entry)
    })

    it('getByRun filters correctly', async () => {
      await store.append({
        id: '1', seq: 0, timestamp: new Date(), category: 'agent_lifecycle',
        action: 'start', details: {}, runId: 'r1',
        previousHash: '0'.repeat(64), hash: 'a',
      })
      await store.append({
        id: '2', seq: 1, timestamp: new Date(), category: 'agent_lifecycle',
        action: 'start', details: {}, runId: 'r2',
        previousHash: 'a', hash: 'b',
      })

      const r1 = await store.getByRun('r1')
      expect(r1).toHaveLength(1)
      expect(r1[0]!.runId).toBe('r1')
    })

    it('getByCategory filters correctly', async () => {
      await store.append({
        id: '1', seq: 0, timestamp: new Date(), category: 'agent_lifecycle',
        action: 'start', details: {},
        previousHash: '0'.repeat(64), hash: 'a',
      })
      await store.append({
        id: '2', seq: 1, timestamp: new Date(), category: 'tool_execution',
        action: 'call', details: {},
        previousHash: 'a', hash: 'b',
      })

      const tools = await store.getByCategory('tool_execution')
      expect(tools).toHaveLength(1)
      expect(tools[0]!.category).toBe('tool_execution')
    })

    it('getByCategory respects limit', async () => {
      for (let i = 0; i < 5; i++) {
        await store.append({
          id: `id-${i}`, seq: i, timestamp: new Date(),
          category: 'tool_execution', action: `action-${i}`, details: {},
          previousHash: '0'.repeat(64), hash: `h${i}`,
        })
      }

      const limited = await store.getByCategory('tool_execution', 2)
      expect(limited).toHaveLength(2)
    })

    it('getLatest returns last entry', async () => {
      await store.append({
        id: '1', seq: 0, timestamp: new Date(), category: 'agent_lifecycle',
        action: 'first', details: {},
        previousHash: '0'.repeat(64), hash: 'a',
      })
      await store.append({
        id: '2', seq: 1, timestamp: new Date(), category: 'agent_lifecycle',
        action: 'second', details: {},
        previousHash: 'a', hash: 'b',
      })

      const latest = await store.getLatest()
      expect(latest!.action).toBe('second')
    })

    it('getLatest returns undefined for empty store', async () => {
      const latest = await store.getLatest()
      expect(latest).toBeUndefined()
    })

    it('prune removes old entries', async () => {
      const old = new Date('2020-01-01')
      const recent = new Date()

      await store.append({
        id: '1', seq: 0, timestamp: old, category: 'agent_lifecycle',
        action: 'old', details: {},
        previousHash: '0'.repeat(64), hash: 'a',
      })
      await store.append({
        id: '2', seq: 1, timestamp: recent, category: 'agent_lifecycle',
        action: 'recent', details: {},
        previousHash: 'a', hash: 'b',
      })

      const pruned = await store.prune(new Date('2023-01-01'))
      expect(pruned).toBe(1)

      const remaining = await store.getAll()
      expect(remaining).toHaveLength(1)
      expect(remaining[0]!.action).toBe('recent')
    })

    it('getAll with offset and limit', async () => {
      for (let i = 0; i < 5; i++) {
        await store.append({
          id: `id-${i}`, seq: i, timestamp: new Date(),
          category: 'agent_lifecycle', action: `action-${i}`, details: {},
          previousHash: '0'.repeat(64), hash: `h${i}`,
        })
      }

      const page = await store.getAll(2, 1)
      expect(page).toHaveLength(2)
      expect(page[0]!.action).toBe('action-1')
      expect(page[1]!.action).toBe('action-2')
    })
  })

  describe('retention pruning', () => {
    it('handles prune returning zero for all-recent entries', async () => {
      const pruned = await store.prune(new Date('2020-01-01'))
      expect(pruned).toBe(0)
    })
  })

  describe('category filtering', () => {
    it('only records specified categories', async () => {
      const filtered = new AuditTrail({
        store,
        categories: ['agent_lifecycle'],
      })
      filtered.attach(bus)

      bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
      bus.emit({ type: 'tool:called', toolName: 'read_file', input: {} })
      await tick()

      const all = await store.getAll()
      expect(all).toHaveLength(1)
      expect(all[0]!.category).toBe('agent_lifecycle')
    })
  })

  describe('verifyChain edge cases', () => {
    it('returns valid for empty entries', () => {
      const result = trail.verifyChain([])
      expect(result.valid).toBe(true)
    })

    it('returns valid for undefined entries', () => {
      const result = trail.verifyChain(undefined as unknown as AuditEntry[])
      expect(result.valid).toBe(true)
    })
  })

  describe('getEntries()', () => {
    it('filters by category', async () => {
      trail.attach(bus)
      bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
      bus.emit({ type: 'tool:called', toolName: 'x', input: {} })
      await tick()

      const result = await trail.getEntries({ category: 'tool_execution' })
      expect(result).toHaveLength(1)
    })

    it('filters by runId', async () => {
      trail.attach(bus)
      bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'run-42' })
      bus.emit({ type: 'agent:started', agentId: 'a2', runId: 'run-99' })
      await tick()

      const result = await trail.getEntries({ runId: 'run-42' })
      expect(result).toHaveLength(1)
      expect(result[0]!.runId).toBe('run-42')
    })

    it('filters by agentId', async () => {
      trail.attach(bus)
      bus.emit({ type: 'agent:started', agentId: 'alpha', runId: 'r1' })
      bus.emit({ type: 'agent:started', agentId: 'beta', runId: 'r2' })
      await tick()

      const result = await trail.getEntries({ agentId: 'alpha' })
      expect(result).toHaveLength(1)
    })
  })

  describe('getStore()', () => {
    it('returns the underlying store', () => {
      expect(trail.getStore()).toBe(store)
    })
  })

  describe('attach / detach lifecycle', () => {
    it('stops recording after detach', async () => {
      trail.attach(bus)
      trail.detach()

      bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
      await tick()

      const all = await store.getAll()
      expect(all).toHaveLength(0)
    })
  })
})
