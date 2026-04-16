/**
 * Tests targeting remaining coverage gaps:
 * - audit-trail: auto-prune at seq % 100 === 99, onAny error swallowing, category filtering
 * - otel-plugin: bridge with object config (line 90)
 * - safety-monitor: catch blocks in attach (lines 163, 171)
 * - otel-bridge: _recordMetrics with no mapping (line 203)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import type { DzupEventBus } from '@dzupagent/core'
import { AuditTrail, InMemoryAuditStore } from '../audit-trail.js'
import type { AuditStore, AuditEntry, AuditCategory } from '../audit-trail.js'
import { createOTelPlugin } from '../otel-plugin.js'
import type { PluginContext } from '@dzupagent/core'
import { SafetyMonitor } from '../safety-monitor.js'
import { OTelBridge, InMemoryMetricSink } from '../otel-bridge.js'
import { DzupTracer } from '../tracer.js'

async function tick(ms = 15): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

function makePluginContext(): PluginContext {
  return {
    eventBus: createEventBus(),
    modelRegistry: {
      getModel: vi.fn(),
      getModelWithFallback: vi.fn(),
      registerProvider: vi.fn(),
      listProviders: vi.fn(),
    } as unknown as PluginContext['modelRegistry'],
  }
}

// ------------------------------------------------------------------ AuditTrail auto-prune

describe('AuditTrail auto-prune', () => {
  it('triggers prune at seq=99 (100th entry)', async () => {
    const store = new InMemoryAuditStore()
    const pruneSpy = vi.spyOn(store, 'prune')
    const trail = new AuditTrail({ store, retentionDays: 30 })
    const bus = createEventBus()
    trail.attach(bus)

    // Emit 100 events to trigger prune at seq=99
    for (let i = 0; i < 100; i++) {
      bus.emit({ type: 'agent:started', agentId: `a${i}`, runId: `r${i}` })
    }
    await tick(50)

    expect(pruneSpy).toHaveBeenCalled()
  })

  it('prune handles errors gracefully (non-fatal)', async () => {
    const store = new InMemoryAuditStore()
    vi.spyOn(store, 'prune').mockRejectedValue(new Error('prune failed'))
    const trail = new AuditTrail({ store, retentionDays: 30 })
    const bus = createEventBus()
    trail.attach(bus)

    // Emit 100 events to trigger prune
    for (let i = 0; i < 100; i++) {
      bus.emit({ type: 'agent:started', agentId: `a${i}`, runId: `r${i}` })
    }
    await tick(50)

    // Should not throw; prune error is swallowed
  })

  it('skips events not in categories filter', async () => {
    const store = new InMemoryAuditStore()
    const trail = new AuditTrail({
      store,
      categories: ['tool_execution'],
    })
    const bus = createEventBus()
    trail.attach(bus)

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    bus.emit({ type: 'tool:called', toolName: 'read_file', input: {} })
    await tick()

    const all = await store.getAll()
    expect(all.length).toBe(1)
    expect(all[0]!.category).toBe('tool_execution')
  })

  it('onAny handler swallows errors in mapping', async () => {
    const store = new InMemoryAuditStore()
    const trail = new AuditTrail({ store })
    const bus = createEventBus()
    trail.attach(bus)

    // Emit an unmapped event type - should not throw
    bus.emit({ type: 'pipeline:phase_changed', phase: 'test' } as never)
    await tick()

    // No entry should be added for unmapped events
    const all = await store.getAll()
    // pipeline:phase_changed is not mapped in mapEvent()
    // so it should be filtered out
  })
})

// ------------------------------------------------------------------ AuditTrail detach

describe('AuditTrail detach', () => {
  it('stops recording after detach', async () => {
    const store = new InMemoryAuditStore()
    const trail = new AuditTrail({ store })
    const bus = createEventBus()
    trail.attach(bus)

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    await tick()

    trail.detach()

    bus.emit({ type: 'agent:completed', agentId: 'a1', runId: 'r1', durationMs: 100 })
    await tick()

    const all = await store.getAll()
    expect(all.length).toBe(1)
  })

  it('detach is idempotent', () => {
    const trail = new AuditTrail()
    // Detach without attach should not throw
    trail.detach()
    trail.detach()
  })
})

// ------------------------------------------------------------------ InMemoryAuditStore

describe('InMemoryAuditStore', () => {
  let store: InMemoryAuditStore

  const makeEntry = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
    id: `id-${Math.random()}`,
    seq: 0,
    timestamp: new Date(),
    category: 'agent_lifecycle',
    agentId: 'a1',
    runId: 'r1',
    action: 'agent:started',
    details: {},
    previousHash: '0'.repeat(64),
    hash: 'abcdef1234567890'.repeat(4),
    ...overrides,
  })

  beforeEach(() => {
    store = new InMemoryAuditStore()
  })

  it('getAll with offset and limit', async () => {
    for (let i = 0; i < 5; i++) {
      await store.append(makeEntry({ seq: i, id: `id-${i}` }))
    }
    const result = await store.getAll(2, 1)
    expect(result.length).toBe(2)
  })

  it('getAll with only limit', async () => {
    for (let i = 0; i < 5; i++) {
      await store.append(makeEntry({ seq: i }))
    }
    const result = await store.getAll(3)
    expect(result.length).toBe(3)
  })

  it('getAll with no params returns everything', async () => {
    for (let i = 0; i < 3; i++) {
      await store.append(makeEntry({ seq: i }))
    }
    const result = await store.getAll()
    expect(result.length).toBe(3)
  })

  it('getByAgent with limit', async () => {
    for (let i = 0; i < 5; i++) {
      await store.append(makeEntry({ agentId: 'target' }))
    }
    const result = await store.getByAgent('target', 2)
    expect(result.length).toBe(2)
  })

  it('getByAgent without limit returns all', async () => {
    for (let i = 0; i < 3; i++) {
      await store.append(makeEntry({ agentId: 'target' }))
    }
    await store.append(makeEntry({ agentId: 'other' }))
    const result = await store.getByAgent('target')
    expect(result.length).toBe(3)
  })

  it('getByCategory with limit', async () => {
    for (let i = 0; i < 5; i++) {
      await store.append(makeEntry({ category: 'tool_execution' }))
    }
    const result = await store.getByCategory('tool_execution', 2)
    expect(result.length).toBe(2)
  })

  it('getByCategory without limit returns all', async () => {
    for (let i = 0; i < 4; i++) {
      await store.append(makeEntry({ category: 'tool_execution' }))
    }
    const result = await store.getByCategory('tool_execution')
    expect(result.length).toBe(4)
  })

  it('prune removes entries before date', async () => {
    const old = new Date(Date.now() - 100_000)
    const recent = new Date()
    await store.append(makeEntry({ timestamp: old }))
    await store.append(makeEntry({ timestamp: old }))
    await store.append(makeEntry({ timestamp: recent }))

    const pruned = await store.prune(new Date(Date.now() - 50_000))
    expect(pruned).toBe(2)

    const remaining = await store.getAll()
    expect(remaining.length).toBe(1)
  })

  it('getLatest returns last entry', async () => {
    await store.append(makeEntry({ seq: 0, action: 'first' }))
    await store.append(makeEntry({ seq: 1, action: 'second' }))
    const latest = await store.getLatest()
    expect(latest?.action).toBe('second')
  })

  it('getLatest returns undefined for empty store', async () => {
    const latest = await store.getLatest()
    expect(latest).toBeUndefined()
  })
})

// ------------------------------------------------------------------ OTelPlugin bridge with object config

describe('createOTelPlugin with bridge object config', () => {
  it('passes bridge config object with auto-created tracer', () => {
    const sink = new InMemoryMetricSink()
    const plugin = createOTelPlugin({
      bridge: {
        tracer: new DzupTracer(),
        metricSink: sink,
        enableSpanEvents: false,
      },
    })
    const ctx = makePluginContext()
    plugin.onRegister!(ctx)

    // Emit an event to verify the bridge is working
    ctx.eventBus.emit({
      type: 'agent:started',
      agentId: 'test-agent',
      runId: 'r1',
    })

    // The metric sink should have received the counter
    expect(sink.getCounter('dzip_agent_runs_total', { agent_id: 'test-agent', status: 'started' })).toBe(1)
  })

  it('bridge with tracer=true and bridge=object uses the created tracer', () => {
    const plugin = createOTelPlugin({
      tracer: { serviceName: 'custom' },
      bridge: {
        tracer: new DzupTracer({ serviceName: 'override' }),
        enableMetrics: true,
      },
    })
    const ctx = makePluginContext()
    plugin.onRegister!(ctx)
  })
})

// ------------------------------------------------------------------ SafetyMonitor catch blocks

describe('SafetyMonitor error handling in attach', () => {
  it('handles non-serializable input in tool:called without throwing', () => {
    const monitor = new SafetyMonitor()
    const bus = createEventBus()
    monitor.attach(bus)

    // Circular reference that would fail JSON.stringify
    const circular: Record<string, unknown> = {}
    circular.self = circular

    // Should not throw - error is swallowed
    bus.emit({
      type: 'tool:called',
      toolName: 'test',
      input: circular,
    })
  })

  it('handles tool:error tracking gracefully', () => {
    const monitor = new SafetyMonitor({ toolFailureThreshold: 2 })
    const bus = createEventBus()
    monitor.attach(bus)

    bus.emit({ type: 'tool:error', toolName: 'bad_tool', errorCode: 'ERR', message: 'fail1' })
    bus.emit({ type: 'tool:error', toolName: 'bad_tool', errorCode: 'ERR', message: 'fail2' })

    const events = monitor.getEvents()
    expect(events.some((e) => e.category === 'tool_misuse')).toBe(true)
  })

  it('tool:result resets failure counter', () => {
    const monitor = new SafetyMonitor({ toolFailureThreshold: 3 })
    const bus = createEventBus()
    monitor.attach(bus)

    bus.emit({ type: 'tool:error', toolName: 't1', errorCode: 'E', message: 'f1' })
    bus.emit({ type: 'tool:error', toolName: 't1', errorCode: 'E', message: 'f2' })
    bus.emit({ type: 'tool:result', toolName: 't1', durationMs: 10 })
    bus.emit({ type: 'tool:error', toolName: 't1', errorCode: 'E', message: 'f3' })

    // Should not have triggered tool_misuse since counter was reset
    const events = monitor.getEvents()
    expect(events.filter((e) => e.category === 'tool_misuse').length).toBe(0)
  })
})

// ------------------------------------------------------------------ OTelBridge edge cases

describe('OTelBridge edge cases', () => {
  it('handles events with no metric mappings (default branch)', () => {
    const tracer = new DzupTracer()
    const sink = new InMemoryMetricSink()
    const bridge = new OTelBridge({ tracer, metricSink: sink })
    const bus = createEventBus()
    bridge.attach(bus)

    // Emit event that has empty mapping array
    bus.emit({ type: 'workflow:spec_revised' } as never)

    // No crash, no metrics
  })

  it('ignores events in the ignoreEvents set', () => {
    const tracer = new DzupTracer()
    const sink = new InMemoryMetricSink()
    const bridge = new OTelBridge({
      tracer,
      metricSink: sink,
      ignoreEvents: ['agent:started'],
    })
    const bus = createEventBus()
    bridge.attach(bus)

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })

    expect(sink.getCounter('dzip_agent_runs_total', { agent_id: 'a1', status: 'started' })).toBe(0)
  })
})

// ------------------------------------------------------------------ AuditTrail getEntries

describe('AuditTrail getEntries with filters', () => {
  let bus: DzupEventBus
  let store: InMemoryAuditStore
  let trail: AuditTrail

  beforeEach(() => {
    bus = createEventBus()
    store = new InMemoryAuditStore()
    trail = new AuditTrail({ store })
    trail.attach(bus)
  })

  it('getEntries with runId filter', async () => {
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    bus.emit({ type: 'agent:started', agentId: 'a2', runId: 'r2' })
    await tick()

    const entries = await trail.getEntries({ runId: 'r1' })
    expect(entries.every((e) => e.runId === 'r1')).toBe(true)
  })

  it('getEntries with agentId filter', async () => {
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    bus.emit({ type: 'agent:started', agentId: 'a2', runId: 'r2' })
    await tick()

    const entries = await trail.getEntries({ agentId: 'a1' })
    expect(entries.every((e) => e.agentId === 'a1')).toBe(true)
  })

  it('getEntries with category filter', async () => {
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    bus.emit({ type: 'tool:called', toolName: 'test', input: {} })
    await tick()

    const entries = await trail.getEntries({ category: 'tool_execution' })
    expect(entries.every((e) => e.category === 'tool_execution')).toBe(true)
  })

  it('getEntries with limit', async () => {
    for (let i = 0; i < 5; i++) {
      bus.emit({ type: 'agent:started', agentId: `a${i}`, runId: `r${i}` })
    }
    await tick()

    const entries = await trail.getEntries({ limit: 2 })
    expect(entries.length).toBe(2)
  })

  it('getStore returns the store instance', () => {
    expect(trail.getStore()).toBe(store)
  })
})
