import { describe, it, expect, beforeEach } from 'vitest'
import {
  createEventBus,
  AgentBus,
  runHooks,
  runModifierHook,
  mergeHooks,
  IntentRouter,
  CostAwareRouter,
  isSimpleTurn,
  scoreComplexity,
  InMemoryRunStore,
  InMemoryAgentStore,
  InMemoryEventLog,
  Semaphore,
  ConcurrencyPool,
  HealthAggregator,
  injectTraceContext,
  extractTraceContext,
  formatTraceparent,
  parseTraceparent,
  createForgeMessage,
  createResponse,
  isMessageAlive,
  createMessageId,
  PipelineDefinitionSchema,
  serializePipeline,
  deserializePipeline,
  autoLayout,
} from '../facades/orchestration.js'
import type { DzupEventBus } from '../facades/orchestration.js'

// ---------------------------------------------------------------------------
// AgentBus — peer-to-peer messaging
// ---------------------------------------------------------------------------

describe('AgentBus', () => {
  let bus: InstanceType<typeof AgentBus>

  beforeEach(() => {
    bus = new AgentBus()
  })

  it('subscribe and publish delivers messages', () => {
    const received: unknown[] = []
    bus.subscribe('channel-1', 'agent-a', (msg) => { received.push(msg) })
    bus.publish('agent-b', 'channel-1', { data: 42 })
    expect(received).toHaveLength(1)
    expect((received[0] as Record<string, unknown>).from).toBe('agent-b')
  })

  it('unsubscribe stops delivery', () => {
    let count = 0
    const unsub = bus.subscribe('ch', 'a1', () => { count++ })
    bus.publish('sender', 'ch', {})
    unsub()
    bus.publish('sender', 'ch', {})
    expect(count).toBe(1)
  })

  it('unsubscribeAll removes agent from all channels', () => {
    let countA = 0
    let countB = 0
    bus.subscribe('ch1', 'a', () => { countA++ })
    bus.subscribe('ch2', 'a', () => { countB++ })
    bus.unsubscribeAll('a')
    bus.publish('x', 'ch1', {})
    bus.publish('x', 'ch2', {})
    expect(countA).toBe(0)
    expect(countB).toBe(0)
  })

  it('getHistory returns channel messages with limit', () => {
    bus.publish('a', 'ch', { i: 1 })
    bus.publish('a', 'ch', { i: 2 })
    bus.publish('a', 'ch', { i: 3 })
    const history = bus.getHistory('ch', 2)
    expect(history).toHaveLength(2)
  })

  it('listChannels returns channels with subscribers', () => {
    bus.subscribe('alpha', 'a1', () => {})
    bus.subscribe('beta', 'a2', () => {})
    expect(bus.listChannels().sort()).toEqual(['alpha', 'beta'])
  })

  it('listSubscribers returns agent IDs for a channel', () => {
    bus.subscribe('ch', 'a1', () => {})
    bus.subscribe('ch', 'a2', () => {})
    expect(bus.listSubscribers('ch').sort()).toEqual(['a1', 'a2'])
  })
})

// ---------------------------------------------------------------------------
// Hook Runner
// ---------------------------------------------------------------------------

describe('runHooks', () => {
  it('runs all hooks sequentially', async () => {
    const order: number[] = []
    const hooks = [
      async () => { order.push(1) },
      async () => { order.push(2) },
    ]
    await runHooks(hooks, undefined, 'test')
    expect(order).toEqual([1, 2])
  })

  it('continues after a hook throws (error isolation)', async () => {
    const order: number[] = []
    const bus = createEventBus()
    const hooks = [
      async () => { throw new Error('boom') },
      async () => { order.push(2) },
    ]
    await runHooks(hooks, bus, 'test')
    expect(order).toEqual([2])
  })

  it('does nothing when hooks array is undefined', async () => {
    await runHooks(undefined, undefined, 'test')
    // No throw
  })
})

describe('runModifierHook', () => {
  it('returns modified value when hook returns non-undefined', async () => {
    const hook = async () => 'modified'
    const result = await runModifierHook(hook, undefined, 'test', 'original')
    expect(result).toBe('modified')
  })

  it('returns original value when hook returns undefined', async () => {
    const hook = async () => undefined
    const result = await runModifierHook(hook, undefined, 'test', 'original')
    expect(result).toBe('original')
  })

  it('returns original on hook error', async () => {
    const hook = async () => { throw new Error('oops') }
    const result = await runModifierHook(hook, undefined, 'test', 'original')
    expect(result).toBe('original')
  })

  it('returns original when hook is undefined', async () => {
    const result = await runModifierHook(undefined, undefined, 'test', 'original')
    expect(result).toBe('original')
  })
})

describe('mergeHooks', () => {
  it('merges multiple hook sets into arrays per key', () => {
    const a = { beforeTool: async () => {} }
    const b = { beforeTool: async () => {}, afterTool: async () => {} }
    const merged = mergeHooks(a, b)
    expect((merged as Record<string, unknown[]>).beforeTool).toHaveLength(2)
    expect((merged as Record<string, unknown[]>).afterTool).toHaveLength(1)
  })

  it('handles undefined inputs gracefully', () => {
    const merged = mergeHooks(undefined, undefined)
    expect(Object.keys(merged)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// InMemoryRunStore
// ---------------------------------------------------------------------------

describe('InMemoryRunStore', () => {
  let store: InstanceType<typeof InMemoryRunStore>

  beforeEach(() => {
    store = new InMemoryRunStore()
  })

  it('creates and retrieves a run', async () => {
    const run = await store.create({ agentId: 'a1', input: 'test' })
    expect(run.id).toBeDefined()
    expect(run.agentId).toBe('a1')
    const fetched = await store.get(run.id)
    expect(fetched).not.toBeNull()
    expect(fetched!.id).toBe(run.id)
  })

  it('returns null for unknown run ID', async () => {
    const fetched = await store.get('nonexistent')
    expect(fetched).toBeNull()
  })

  it('updates run fields', async () => {
    const run = await store.create({ agentId: 'a1', input: 'x' })
    await store.update(run.id, { status: 'completed' })
    const fetched = await store.get(run.id)
    expect(fetched!.status).toBe('completed')
  })

  it('adds and retrieves log entries', async () => {
    const run = await store.create({ agentId: 'a1', input: 'x' })
    await store.addLog(run.id, { level: 'info', message: 'hello' })
    const logs = await store.getLogs(run.id)
    expect(logs).toHaveLength(1)
    expect(logs[0]!.message).toBe('hello')
  })

  it('list filters by agentId', async () => {
    await store.create({ agentId: 'a1', input: 'x' })
    await store.create({ agentId: 'a2', input: 'y' })
    const results = await store.list({ agentId: 'a1' })
    expect(results).toHaveLength(1)
    expect(results[0]!.agentId).toBe('a1')
  })

  it('clear removes all data', async () => {
    await store.create({ agentId: 'a1', input: 'x' })
    store.clear()
    const results = await store.list()
    expect(results).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// InMemoryAgentStore
// ---------------------------------------------------------------------------

describe('InMemoryAgentStore', () => {
  let store: InstanceType<typeof InMemoryAgentStore>

  beforeEach(() => {
    store = new InMemoryAgentStore()
  })

  it('save and get an agent definition', async () => {
    await store.save({ id: 'a1', name: 'Agent One', active: true, createdAt: new Date(), updatedAt: new Date() })
    const fetched = await store.get('a1')
    expect(fetched).not.toBeNull()
    expect(fetched!.name).toBe('Agent One')
  })

  it('returns null for unknown agent', async () => {
    expect(await store.get('nope')).toBeNull()
  })

  it('delete removes agent', async () => {
    await store.save({ id: 'a1', name: 'A', active: true, createdAt: new Date(), updatedAt: new Date() })
    await store.delete('a1')
    expect(await store.get('a1')).toBeNull()
  })

  it('list filters by active flag', async () => {
    await store.save({ id: 'a1', name: 'A', active: true, createdAt: new Date(), updatedAt: new Date() })
    await store.save({ id: 'a2', name: 'B', active: false, createdAt: new Date(), updatedAt: new Date() })
    const actives = await store.list({ active: true })
    expect(actives).toHaveLength(1)
    expect(actives[0]!.id).toBe('a1')
  })
})

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------

describe('Semaphore', () => {
  it('allows up to maxPermits concurrent acquires', async () => {
    const sem = new Semaphore(2)
    expect(sem.available).toBe(2)
    await sem.acquire()
    expect(sem.available).toBe(1)
    await sem.acquire()
    expect(sem.available).toBe(0)
  })

  it('release unblocks waiting acquires', async () => {
    const sem = new Semaphore(1)
    await sem.acquire()
    let resolved = false
    const p = sem.acquire().then(() => { resolved = true })
    expect(resolved).toBe(false)
    sem.release()
    await p
    expect(resolved).toBe(true)
  })

  it('run auto-releases on completion', async () => {
    const sem = new Semaphore(1)
    const result = await sem.run(async () => 42)
    expect(result).toBe(42)
    expect(sem.available).toBe(1)
  })

  it('run auto-releases on error', async () => {
    const sem = new Semaphore(1)
    await expect(sem.run(async () => { throw new Error('fail') })).rejects.toThrow('fail')
    expect(sem.available).toBe(1)
  })

  it('throws for maxPermits < 1', () => {
    expect(() => new Semaphore(0)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// HealthAggregator
// ---------------------------------------------------------------------------

describe('HealthAggregator', () => {
  it('reports ok when all checks pass', async () => {
    const agg = new HealthAggregator()
    agg.register(async () => ({ name: 'db', status: 'ok' }))
    agg.register(async () => ({ name: 'cache', status: 'ok' }))
    const report = await agg.check()
    expect(report.status).toBe('ok')
    expect(report.checks).toHaveLength(2)
    expect(report.timestamp).toBeDefined()
  })

  it('reports error when any check is error', async () => {
    const agg = new HealthAggregator()
    agg.register(async () => ({ name: 'db', status: 'ok' }))
    agg.register(async () => ({ name: 'external', status: 'error', message: 'down' }))
    const report = await agg.check()
    expect(report.status).toBe('error')
  })

  it('reports degraded when check is degraded but none error', async () => {
    const agg = new HealthAggregator()
    agg.register(async () => ({ name: 'db', status: 'degraded' }))
    const report = await agg.check()
    expect(report.status).toBe('degraded')
  })

  it('handles check function that throws', async () => {
    const agg = new HealthAggregator()
    agg.register(async () => { throw new Error('crash') })
    const report = await agg.check()
    expect(report.status).toBe('error')
    expect(report.checks[0]!.message).toContain('crash')
  })
})

// ---------------------------------------------------------------------------
// Trace Propagation
// ---------------------------------------------------------------------------

describe('trace propagation', () => {
  it('injectTraceContext adds _trace to metadata', () => {
    const meta = injectTraceContext({})
    expect(meta).toHaveProperty('_trace')
    const trace = extractTraceContext(meta)
    expect(trace).not.toBeNull()
    expect(trace!.traceId).toHaveLength(32)
    expect(trace!.spanId).toHaveLength(16)
  })

  it('injectTraceContext is idempotent', () => {
    const meta1 = injectTraceContext({})
    const meta2 = injectTraceContext(meta1)
    const t1 = extractTraceContext(meta1)
    const t2 = extractTraceContext(meta2)
    expect(t1!.traceId).toBe(t2!.traceId)
  })

  it('parseTraceparent / formatTraceparent round-trip', () => {
    const ctx = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }
    const formatted = formatTraceparent(ctx)
    const parsed = parseTraceparent(formatted)
    expect(parsed).toEqual(ctx)
  })

  it('parseTraceparent returns null for invalid input', () => {
    expect(parseTraceparent('invalid')).toBeNull()
    expect(parseTraceparent('00-short-id-01')).toBeNull()
  })

  it('extractTraceContext returns null for empty metadata', () => {
    expect(extractTraceContext({})).toBeNull()
    expect(extractTraceContext(undefined)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// CostAwareRouter helpers
// ---------------------------------------------------------------------------

describe('CostAwareRouter helpers', () => {
  it('isSimpleTurn returns boolean', () => {
    expect(typeof isSimpleTurn('hello')).toBe('boolean')
  })

  it('scoreComplexity returns a complexity level string', () => {
    const score = scoreComplexity('Write a complex multi-step algorithm')
    expect(typeof score).toBe('string')
  })
})
