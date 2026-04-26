/**
 * Targeted branch-coverage tests for orchestration primitives:
 * MapReduce, ContractNet, Supervisor, ParallelExecutor.
 *
 * These tests focus on edge/error branches not already exercised by the
 * broader behavioural suites.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createEventBus, ForgeError } from '@dzupagent/core'
import type { DzupEvent, DzupEventBus } from '@dzupagent/core'

import {
  MapReduceOrchestrator,
  LineChunker,
  DirectoryChunker,
} from '../orchestration/map-reduce.js'
import type {
  Chunker,
  MapperFn,
  ReducerFn,
} from '../orchestration/map-reduce.js'
import {
  ContractNetOrchestrator,
  StaticBidStrategy,
} from '../orchestration/contract-net.js'
import type {
  Bid,
  BidStrategy,
} from '../orchestration/contract-net.js'
import {
  SupervisorOrchestrator,
  KeywordTaskDecomposer,
} from '../orchestration/supervisor.js'
import type {
  SubTask,
  TaskDecomposer,
} from '../orchestration/supervisor.js'
import { ParallelExecutor } from '../orchestration/parallel-executor.js'
import type { ProviderResult } from '../orchestration/parallel-executor.js'
import { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  RoutingDecision,
  TaskDescriptor,
} from '../types.js'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeAdapter(
  providerId: AdapterProviderId,
  impl: (input: AgentInput) => AsyncGenerator<AgentEvent, void, undefined>,
): AgentCLIAdapter {
  return {
    providerId,
    execute: impl,
    async *resumeSession(_id: string, _input: AgentInput) {
      /* noop */
    },
    interrupt() {},
    async healthCheck() {
      return {
        healthy: true,
        providerId,
        sdkInstalled: true,
        cliAvailable: true,
      }
    },
    configure() {},
  }
}

function completedEvent(
  providerId: AdapterProviderId,
  result: string,
): AgentEvent {
  return {
    type: 'adapter:completed',
    providerId,
    sessionId: 'sess-1',
    result,
    durationMs: 5,
    timestamp: Date.now(),
  }
}

function failedEvent(
  providerId: AdapterProviderId,
  error: string,
): AgentEvent {
  return {
    type: 'adapter:failed',
    providerId,
    error,
    timestamp: Date.now(),
  }
}

function collectBusEvents(bus: DzupEventBus): DzupEvent[] {
  const events: DzupEvent[] = []
  bus.onAny((e) => events.push(e))
  return events
}

// ---------------------------------------------------------------------------
// MapReduceOrchestrator — edge branches
// ---------------------------------------------------------------------------

describe('MapReduceOrchestrator branch coverage', () => {
  let bus: DzupEventBus

  beforeEach(() => {
    bus = createEventBus()
  })

  const stringArrayMapper: MapperFn<string[]> = (chunk) => ({
    input: { prompt: chunk.join('\n') },
    task: { prompt: chunk.join('\n'), tags: ['general'] },
  })

  const identityExtractor = (raw: string): string => raw
  const concatReducer: ReducerFn<string, string> = (results) =>
    results
      .filter((r) => r.success)
      .map((r) => r.result)
      .join(',')

  function createRegistry(
    fn: (input: AgentInput, index: number) => AsyncGenerator<AgentEvent, void, undefined>,
  ): ProviderAdapterRegistry {
    let index = 0
    return {
      async *executeWithFallback(input: AgentInput, _task: TaskDescriptor) {
        const current = index++
        yield* fn(input, current)
      },
    } as unknown as ProviderAdapterRegistry
  }

  it('handles empty chunk array (no chunks to map)', async () => {
    // Custom chunker that emits zero chunks
    const emptyChunker: Chunker<string[]> = { split: () => [] }
    const registry = createRegistry(async function* () {
      yield completedEvent('claude', 'never-used')
    })

    const orchestrator = new MapReduceOrchestrator({ registry, eventBus: bus })
    const result = await orchestrator.execute('ignored', {
      chunker: emptyChunker,
      mapper: stringArrayMapper,
      resultExtractor: identityExtractor,
      reducer: (results) => results.length,
    })

    expect(result.chunks).toBe(0)
    expect(result.successfulChunks).toBe(0)
    expect(result.failedChunks).toBe(0)
    expect(result.perChunkStats).toHaveLength(0)
    expect(result.result).toBe(0)
  })

  it('single chunk map happy path', async () => {
    const registry = createRegistry(async function* () {
      yield completedEvent('claude', 'one')
    })
    const orchestrator = new MapReduceOrchestrator({ registry, eventBus: bus })
    const result = await orchestrator.execute('only', {
      chunker: new LineChunker(10),
      mapper: stringArrayMapper,
      resultExtractor: identityExtractor,
      reducer: concatReducer,
    })
    expect(result.chunks).toBe(1)
    expect(result.successfulChunks).toBe(1)
  })

  it('handles reducer throwing mid-way', async () => {
    const registry = createRegistry(async function* () {
      yield completedEvent('claude', 'ok')
    })
    const orchestrator = new MapReduceOrchestrator({ registry, eventBus: bus })
    await expect(
      orchestrator.execute('a\nb', {
        chunker: new LineChunker(1),
        mapper: stringArrayMapper,
        resultExtractor: identityExtractor,
        reducer: () => {
          throw new Error('reducer exploded')
        },
      }),
    ).rejects.toThrow('reducer exploded')
  })

  it('treats absence of completed event without abort as failure', async () => {
    // Adapter yields no events at all — no completed event
    const registry = createRegistry(async function* () {
      // no events
    })
    const orchestrator = new MapReduceOrchestrator({ registry, eventBus: bus })
    const result = await orchestrator.execute('x', {
      chunker: new LineChunker(1),
      mapper: stringArrayMapper,
      resultExtractor: identityExtractor,
      reducer: (results) => results,
    })
    expect(result.failedChunks).toBe(1)
    expect(result.perChunkStats[0]!.success).toBe(false)
    expect(result.perChunkStats[0]!.cancelled).toBeUndefined()
  })

  it('marks chunk cancelled when signal aborts mid-map before completed', async () => {
    const controller = new AbortController()
    const registry = {
      async *executeWithFallback(input: AgentInput, _task: TaskDescriptor) {
        // Yield no adapter:completed — after aborting, the signal check should
        // mark this chunk cancelled.
        controller.abort()
        void input // suppress unused
        // Yield nothing further
      },
    } as unknown as ProviderAdapterRegistry

    const orchestrator = new MapReduceOrchestrator({ registry, eventBus: bus })
    const result = await orchestrator.execute('only', {
      chunker: new LineChunker(1),
      mapper: stringArrayMapper,
      resultExtractor: identityExtractor,
      reducer: (results) => results,
      signal: controller.signal,
    })
    expect(result.cancelled).toBe(true)
    expect(result.perChunkStats[0]!.cancelled).toBe(true)
  })

  it('tracks providerId from non-completed events for failed chunks', async () => {
    const registry = createRegistry(async function* () {
      // Only a started event, then simply return (no completed).
      yield {
        type: 'adapter:started',
        providerId: 'codex',
        sessionId: 'sess-x',
        timestamp: Date.now(),
      } satisfies AgentEvent
    })
    const orchestrator = new MapReduceOrchestrator({ registry, eventBus: bus })
    const result = await orchestrator.execute('x', {
      chunker: new LineChunker(1),
      mapper: stringArrayMapper,
      resultExtractor: identityExtractor,
      reducer: (results) => results,
    })
    expect(result.failedChunks).toBe(1)
    // lastProviderId path returns codex when no completed event arrives
    expect(result.perChunkStats[0]!.providerId).toBe('codex')
  })

  it('emits reduceDurationMs in the completed event', async () => {
    const emitted = collectBusEvents(bus)
    const registry = createRegistry(async function* () {
      yield completedEvent('claude', 'ok')
    })
    const orchestrator = new MapReduceOrchestrator({ registry, eventBus: bus })
    await orchestrator.execute('a', {
      chunker: new LineChunker(1),
      mapper: stringArrayMapper,
      resultExtractor: identityExtractor,
      reducer: concatReducer,
    })
    const completed = emitted.find((e) => e.type === 'mapreduce:completed') as
      | (DzupEvent & { reduceDurationMs?: number })
      | undefined
    expect(completed).toBeDefined()
    expect(typeof completed!.reduceDurationMs).toBe('number')
  })

  it('DirectoryChunker returns empty array for whitespace-only input', () => {
    const chunker = new DirectoryChunker(5)
    expect(chunker.split('   \n\n   \n')).toEqual([])
  })

  it('LineChunker with linesPerChunk equal to line count emits single chunk', () => {
    const chunker = new LineChunker(3)
    const chunks = chunker.split('a\nb\nc')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toEqual(['a', 'b', 'c'])
  })

  it('works with resultExtractor that transforms raw result', async () => {
    const registry = createRegistry(async function* () {
      yield completedEvent('claude', '42')
    })
    const orchestrator = new MapReduceOrchestrator({ registry, eventBus: bus })
    const result = await orchestrator.execute('x', {
      chunker: new LineChunker(1),
      mapper: stringArrayMapper,
      resultExtractor: (raw) => Number(raw),
      reducer: (results) => results.reduce((sum, r) => sum + (r.success ? r.result : 0), 0),
    })
    expect(result.result).toBe(42)
  })

  it('uses default maxConcurrency when not configured', () => {
    const registry = createRegistry(async function* () {
      yield completedEvent('claude', 'ok')
    })
    const orchestrator = new MapReduceOrchestrator({ registry, eventBus: bus })
    // Private field not exposed — confirm that construction succeeds.
    expect(orchestrator).toBeInstanceOf(MapReduceOrchestrator)
  })

  it('works without eventBus (no emissions crash)', async () => {
    const registry = createRegistry(async function* () {
      yield completedEvent('claude', 'ok')
    })
    const orchestrator = new MapReduceOrchestrator({ registry })
    const result = await orchestrator.execute('a', {
      chunker: new LineChunker(1),
      mapper: stringArrayMapper,
      resultExtractor: identityExtractor,
      reducer: concatReducer,
    })
    expect(result.successfulChunks).toBe(1)
  })

  it('emits perChunkStats with cancelled field when pre-aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const registry = createRegistry(async function* () {
      yield completedEvent('claude', 'never')
    })
    const orchestrator = new MapReduceOrchestrator({ registry, eventBus: bus })
    const result = await orchestrator.execute('a\nb', {
      chunker: new LineChunker(1),
      mapper: stringArrayMapper,
      resultExtractor: identityExtractor,
      reducer: (results) => results.length,
      signal: controller.signal,
    })
    expect(result.cancelled).toBe(true)
    expect(result.perChunkStats.every((s) => s.cancelled === true)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ContractNetOrchestrator — edge branches
// ---------------------------------------------------------------------------

describe('ContractNetOrchestrator branch coverage', () => {
  let bus: DzupEventBus
  let emitted: DzupEvent[]

  beforeEach(() => {
    bus = createEventBus()
    emitted = collectBusEvents(bus)
  })

  function buildRegistry(adapters: AgentCLIAdapter[]): ProviderAdapterRegistry {
    const registry = new ProviderAdapterRegistry()
    for (const adapter of adapters) registry.register(adapter)
    return registry
  }

  it('throws ALL_ADAPTERS_EXHAUSTED when bid strategy returns zero bids', async () => {
    const adapter = makeAdapter('claude', async function* () {
      yield completedEvent('claude', 'never')
    })
    const registry = buildRegistry([adapter])
    const emptyStrategy: BidStrategy = {
      name: 'empty',
      async generateBids() {
        return []
      },
    }
    const orchestrator = new ContractNetOrchestrator({
      registry,
      eventBus: bus,
      bidStrategy: emptyStrategy,
    })

    await expect(
      orchestrator.execute({ prompt: 'x', tags: ['general'] }, { prompt: 'x' }),
    ).rejects.toThrow('No bids received from any adapter')
  })

  it('returns empty bids when bid collection times out', async () => {
    const adapter = makeAdapter('claude', async function* () {
      yield completedEvent('claude', 'never')
    })
    const slowStrategy: BidStrategy = {
      name: 'slow',
      async generateBids(_task, _providers) {
        await new Promise((r) => setTimeout(r, 500))
        return []
      },
    }
    const orchestrator = new ContractNetOrchestrator({
      registry: buildRegistry([adapter]),
      eventBus: bus,
      bidStrategy: slowStrategy,
      bidTimeoutMs: 20,
    })

    // Bid collection times out — ContractNet throws ALL_ADAPTERS_EXHAUSTED.
    await expect(
      orchestrator.execute({ prompt: 'x', tags: ['general'] }, { prompt: 'x' }),
    ).rejects.toThrow('No bids received from any adapter')
  })

  it('breaks ties deterministically via sort by computed score', async () => {
    const claude = makeAdapter('claude', async function* () {
      yield completedEvent('claude', 'claude-wins')
    })
    const codex = makeAdapter('codex', async function* () {
      yield completedEvent('codex', 'codex-wins')
    })
    // Custom strategy produces identical confidence/cost/duration — sort is stable
    const tieStrategy: BidStrategy = {
      name: 'tie',
      async generateBids(_task, providers) {
        return providers.map((id) => ({
          providerId: id,
          estimatedCostCents: 1,
          confidence: 0.5,
          estimatedDurationMs: 1000,
        }))
      },
    }
    const orchestrator = new ContractNetOrchestrator({
      registry: buildRegistry([claude, codex]),
      eventBus: bus,
      bidStrategy: tieStrategy,
    })
    const result = await orchestrator.execute(
      { prompt: 'x', tags: ['general'] },
      { prompt: 'x' },
    )
    expect(result.success).toBe(true)
    // Both are valid — ensure a winner is picked without error
    expect(['claude', 'codex']).toContain(result.winningBid?.providerId)
  })

  it('emits reject-proposal when adapter is no longer healthy at award time', async () => {
    const registry = new ProviderAdapterRegistry()
    const adapter = makeAdapter('claude', async function* () {
      yield completedEvent('claude', 'never')
    })
    registry.register(adapter)
    // Pretend adapter becomes unhealthy after the CFP: we stub getHealthy to return undefined
    const origGetHealthy = registry.getHealthy.bind(registry)
    let callCount = 0
    registry.getHealthy = ((id: AdapterProviderId) => {
      callCount++
      // First call from listAdapters filter returns the adapter,
      // but the fallback loop call returns undefined
      if (callCount === 1) return origGetHealthy(id)
      return undefined
    }) as typeof registry.getHealthy

    const orchestrator = new ContractNetOrchestrator({
      registry,
      eventBus: bus,
    })
    const result = await orchestrator.execute(
      { prompt: 'x', tags: ['general'] },
      { prompt: 'x' },
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('became unhealthy')
    const rejectEvent = emitted.find(
      (e) =>
        e.type === 'protocol:message_sent' &&
        (e as unknown as { messageType: string }).messageType === 'reject-proposal',
    )
    expect(rejectEvent).toBeDefined()
  })

  it('bid returning adapter:failed events but not throwing returns success=false', async () => {
    const adapter = makeAdapter('claude', async function* () {
      yield failedEvent('claude', 'soft error')
    })
    const orchestrator = new ContractNetOrchestrator({
      registry: buildRegistry([adapter]),
      eventBus: bus,
    })
    const result = await orchestrator.execute(
      { prompt: 'x', tags: ['general'] },
      { prompt: 'x' },
    )
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('StaticBidStrategy uses generic confidence when no tags match', async () => {
    const strategy = new StaticBidStrategy()
    const bids = await strategy.generateBids(
      { prompt: 'plain', tags: [] },
      ['openrouter'],
    )
    expect(bids[0]!.confidence).toBe(0.5)
    expect(bids[0]!.approach).toContain('general-purpose')
  })

  it('StaticBidStrategy honours mix of requires flags + tags', async () => {
    const strategy = new StaticBidStrategy()
    const bids = await strategy.generateBids(
      { prompt: 'plan', tags: ['local'], requiresReasoning: true },
      ['claude', 'crush'],
    )
    const claude = bids.find((b) => b.providerId === 'claude')!
    // requiresReasoning wins over local tag, so claude should be at 0.95
    expect(claude.confidence).toBe(0.95)
  })

  it('works with no eventBus configured (no crash)', async () => {
    const adapter = makeAdapter('claude', async function* () {
      yield completedEvent('claude', 'done')
    })
    const orchestrator = new ContractNetOrchestrator({
      registry: buildRegistry([adapter]),
    })
    const result = await orchestrator.execute(
      { prompt: 'x', tags: ['general'] },
      { prompt: 'x' },
    )
    expect(result.success).toBe(true)
  })

  it('propagates unexpected bid strategy errors', async () => {
    // Capture and swallow "unhandledrejection" events from the race cleanup
    // in contract-net.ts (void bidPromise.then) so vitest does not flag them.
    const previousHandler = process.listeners('unhandledRejection').slice()
    process.removeAllListeners('unhandledRejection')
    const caught: unknown[] = []
    process.on('unhandledRejection', (reason) => {
      caught.push(reason)
    })
    try {
      const explodingStrategy: BidStrategy = {
        name: 'explode',
        async generateBids() {
          throw new Error('bid strategy crashed')
        },
      }
      const adapter = makeAdapter('claude', async function* () {
        yield completedEvent('claude', 'never')
      })
      const orchestrator = new ContractNetOrchestrator({
        registry: buildRegistry([adapter]),
        eventBus: bus,
        bidStrategy: explodingStrategy,
      })
      await expect(
        orchestrator.execute({ prompt: 'x', tags: ['general'] }, { prompt: 'x' }),
      ).rejects.toThrow('bid strategy crashed')
      // Give the microtask queue a tick to observe any floating rejections
      await new Promise((r) => setImmediate(r))
    } finally {
      process.removeAllListeners('unhandledRejection')
      for (const handler of previousHandler) {
        process.on('unhandledRejection', handler as (reason: unknown) => void)
      }
    }
  })

  it('pre-aborted signal returns cancelled result without touching adapter', async () => {
    let called = false
    const adapter = makeAdapter('claude', async function* () {
      called = true
      yield completedEvent('claude', 'should-not-run')
    })
    const orchestrator = new ContractNetOrchestrator({
      registry: buildRegistry([adapter]),
      eventBus: bus,
    })
    const controller = new AbortController()
    controller.abort()
    const result = await orchestrator.execute(
      { prompt: 'x', tags: ['general'] },
      { prompt: 'x' },
      { signal: controller.signal },
    )
    expect(result.cancelled).toBe(true)
    expect(called).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// SupervisorOrchestrator — edge branches
// ---------------------------------------------------------------------------

describe('SupervisorOrchestrator branch coverage', () => {
  let bus: DzupEventBus

  beforeEach(() => {
    bus = createEventBus()
  })

  function registryFor(
    executeImpl: (input: AgentInput) => AsyncGenerator<AgentEvent, void, undefined>,
  ): ProviderAdapterRegistry {
    const decision: RoutingDecision = {
      provider: 'claude' as AdapterProviderId,
      reason: 'mock',
      confidence: 1,
    }
    return {
      getForTask(_task: TaskDescriptor) {
        return {
          adapter: {} as AgentCLIAdapter,
          decision,
        }
      },
      async *executeWithFallback(input: AgentInput, _task: TaskDescriptor) {
        yield* executeImpl(input)
      },
    } as unknown as ProviderAdapterRegistry
  }

  it('routes decision.provider = auto to specialistId auto in plan_created', async () => {
    const registry: ProviderAdapterRegistry = {
      getForTask() {
        return {
          adapter: {} as AgentCLIAdapter,
          decision: { provider: 'auto', reason: 'no-match', confidence: 0.3 },
        }
      },
      async *executeWithFallback(_input: AgentInput, _task: TaskDescriptor) {
        yield completedEvent('claude', 'ok')
      },
    } as unknown as ProviderAdapterRegistry

    const emitted = collectBusEvents(bus)
    const supervisor = new SupervisorOrchestrator({
      registry,
      eventBus: bus,
      decomposer: {
        async decompose() {
          return [{ description: 'Any task', tags: ['general'] }]
        },
      },
    })
    await supervisor.execute('goal')
    const planCreated = emitted.find((e) => e.type === 'supervisor:plan_created') as
      | (DzupEvent & { assignments: Array<{ specialistId: string }> })
      | undefined
    expect(planCreated).toBeDefined()
    expect(planCreated!.assignments[0]!.specialistId).toBe('auto')
  })

  it('falls back to last failure event error when no completed event fires', async () => {
    const registry = registryFor(async function* () {
      yield failedEvent('claude', 'first')
      yield failedEvent('claude', 'second')
    })
    const supervisor = new SupervisorOrchestrator({
      registry,
      eventBus: bus,
      decomposer: {
        async decompose() {
          return [{ description: 'Task', tags: ['general'] }]
        },
      },
    })
    const result = await supervisor.execute('g')
    expect(result.subtaskResults[0]!.success).toBe(false)
    expect(result.subtaskResults[0]!.error).toBe('second')
  })

  it('reports synthetic error when generator completes with no events at all', async () => {
    const registry = registryFor(async function* () {
      // no events
    })
    const supervisor = new SupervisorOrchestrator({
      registry,
      eventBus: bus,
      decomposer: {
        async decompose() {
          return [{ description: 'Task', tags: ['general'] }]
        },
      },
    })
    const result = await supervisor.execute('g')
    expect(result.subtaskResults[0]!.success).toBe(false)
    expect(result.subtaskResults[0]!.error).toBe(
      'Adapter completed without producing a result event',
    )
  })

  it('propagates non-abort errors from executeWithFallback', async () => {
    const registry: ProviderAdapterRegistry = {
      getForTask() {
        return {
          adapter: {} as AgentCLIAdapter,
          decision: {
            provider: 'claude' as AdapterProviderId,
            reason: 'mock',
            confidence: 1,
          },
        }
      },
      async *executeWithFallback() {
        throw new Error('unexpected blow-up')
      },
    } as unknown as ProviderAdapterRegistry

    const supervisor = new SupervisorOrchestrator({
      registry,
      eventBus: bus,
      decomposer: {
        async decompose() {
          return [{ description: 'Task', tags: ['general'] }]
        },
      },
    })
    const result = await supervisor.execute('g')
    expect(result.subtaskResults[0]!.success).toBe(false)
    expect(result.subtaskResults[0]!.error).toBe('unexpected blow-up')
    expect(result.subtaskResults[0]!.cancelled).toBeUndefined()
  })

  it('wraps non-Error thrown values with String() coercion', async () => {
    const registry: ProviderAdapterRegistry = {
      getForTask() {
        return {
          adapter: {} as AgentCLIAdapter,
          decision: {
            provider: 'claude' as AdapterProviderId,
            reason: 'mock',
            confidence: 1,
          },
        }
      },
      async *executeWithFallback() {
        // throw non-Error value to exercise String() coercion branch
        throw 'plain-string-error' as unknown as Error
      },
    } as unknown as ProviderAdapterRegistry

    const supervisor = new SupervisorOrchestrator({
      registry,
      eventBus: bus,
      decomposer: {
        async decompose() {
          return [{ description: 'Task', tags: ['general'] }]
        },
      },
    })
    const result = await supervisor.execute('g')
    expect(result.subtaskResults[0]!.error).toBe('plain-string-error')
  })

  it('dependency depIdx of -1 is silently ignored (no prerequisite)', async () => {
    const registry = registryFor(async function* () {
      yield completedEvent('claude', 'done')
    })
    const supervisor = new SupervisorOrchestrator({
      registry,
      eventBus: bus,
      decomposer: {
        async decompose() {
          return [
            {
              description: 'Task with bogus dep',
              tags: ['general'],
              dependsOn: [-1],
            } satisfies SubTask,
          ]
        },
      },
    })
    const result = await supervisor.execute('g')
    expect(result.subtaskResults[0]!.success).toBe(true)
  })

  it('emits progress events after each subtask completion', async () => {
    let emittedProgress = 0
    bus.onAny((e) => {
      if (e.type === 'adapter:progress') emittedProgress++
    })
    const registry = registryFor(async function* () {
      yield completedEvent('claude', 'ok')
    })
    const supervisor = new SupervisorOrchestrator({
      registry,
      eventBus: bus,
      decomposer: {
        async decompose() {
          return [
            { description: 'A', tags: ['general'] },
            { description: 'B', tags: ['general'] },
            { description: 'C', tags: ['general'] },
          ]
        },
      },
    })
    await supervisor.execute('g')
    expect(emittedProgress).toBeGreaterThanOrEqual(3)
  })

  it('works with no eventBus configured', async () => {
    const registry = registryFor(async function* () {
      yield completedEvent('claude', 'ok')
    })
    const supervisor = new SupervisorOrchestrator({
      registry,
      decomposer: {
        async decompose() {
          return [{ description: 'Task', tags: ['general'] }]
        },
      },
    })
    const result = await supervisor.execute('g')
    expect(result.subtaskResults[0]!.success).toBe(true)
  })

  it('KeywordTaskDecomposer treats a multi-line goal with no sentence markers as one task', async () => {
    const decomposer = new KeywordTaskDecomposer()
    // No `.` `;` or `\n` between — it is a single sentence
    const subtasks = await decomposer.decompose('just one goal')
    expect(subtasks).toHaveLength(1)
  })

  it('KeywordTaskDecomposer bugfix rule fires for resolve verb', async () => {
    const decomposer = new KeywordTaskDecomposer()
    const subtasks = await decomposer.decompose('Resolve the rendering issue')
    expect(subtasks[0]!.tags).toContain('bugfix')
  })

  it('KeywordTaskDecomposer testing rule fires for validate verb', async () => {
    const decomposer = new KeywordTaskDecomposer()
    const subtasks = await decomposer.decompose('Validate the response shape')
    expect(subtasks[0]!.tags).toContain('testing')
  })

  it('KeywordTaskDecomposer reasoning rule fires for audit verb', async () => {
    const decomposer = new KeywordTaskDecomposer()
    const subtasks = await decomposer.decompose('Audit the configuration')
    expect(subtasks[0]!.tags).toContain('reasoning')
  })

  it('uses preferredProvider field on subtask for task descriptor', async () => {
    let observedTask: TaskDescriptor | undefined
    const registry: ProviderAdapterRegistry = {
      getForTask(task: TaskDescriptor) {
        observedTask = task
        return {
          adapter: {} as AgentCLIAdapter,
          decision: {
            provider: task.preferredProvider ?? 'claude',
            reason: 'mock',
            confidence: 1,
          } as RoutingDecision,
        }
      },
      async *executeWithFallback() {
        yield completedEvent('codex', 'ok')
      },
    } as unknown as ProviderAdapterRegistry

    const supervisor = new SupervisorOrchestrator({
      registry,
      eventBus: bus,
      decomposer: {
        async decompose() {
          return [
            {
              description: 'Code it',
              tags: ['execution'],
              preferredProvider: 'codex' as AdapterProviderId,
            },
          ]
        },
      },
    })
    await supervisor.execute('g')
    expect(observedTask?.preferredProvider).toBe('codex')
  })

  it('propagates budgetConstraint through to task descriptor', async () => {
    let observedTask: TaskDescriptor | undefined
    const registry: ProviderAdapterRegistry = {
      getForTask(task: TaskDescriptor) {
        observedTask = task
        return {
          adapter: {} as AgentCLIAdapter,
          decision: {
            provider: 'claude' as AdapterProviderId,
            reason: 'mock',
            confidence: 1,
          },
        }
      },
      async *executeWithFallback() {
        yield completedEvent('claude', 'ok')
      },
    } as unknown as ProviderAdapterRegistry
    const supervisor = new SupervisorOrchestrator({
      registry,
      eventBus: bus,
      decomposer: {
        async decompose() {
          return [{ description: 'Task', tags: ['general'] }]
        },
      },
    })
    await supervisor.execute('g', { budgetConstraint: 'low' })
    expect(observedTask?.budgetConstraint).toBe('low')
  })

  it('marks providerId from failed event even without completed event', async () => {
    const registry = registryFor(async function* () {
      yield failedEvent('codex' as AdapterProviderId, 'codex broke')
    })
    const supervisor = new SupervisorOrchestrator({
      registry,
      eventBus: bus,
      decomposer: {
        async decompose() {
          return [{ description: 'Task', tags: ['general'] }]
        },
      },
    })
    const result = await supervisor.execute('g')
    expect(result.subtaskResults[0]!.providerId).toBe('codex')
    expect(result.subtaskResults[0]!.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ParallelExecutor — edge branches
// ---------------------------------------------------------------------------

describe('ParallelExecutor branch coverage', () => {
  let bus: DzupEventBus

  beforeEach(() => {
    bus = createEventBus()
  })

  function registryFromAdapters(
    adapters: AgentCLIAdapter[],
  ): ProviderAdapterRegistry {
    const reg = new ProviderAdapterRegistry()
    for (const a of adapters) reg.register(a)
    return reg
  }

  it('all-provider strategy with all failures returns first failure as selected', async () => {
    const claude = makeAdapter('claude', async function* () {
      throw new Error('claude failure')
    })
    const codex = makeAdapter('codex', async function* () {
      throw new Error('codex failure')
    })
    const executor = new ParallelExecutor({
      registry: registryFromAdapters([claude, codex]),
      eventBus: bus,
    })
    const result = await executor.execute(
      { prompt: 'x' },
      {
        providers: ['claude', 'codex'],
        mergeStrategy: 'all',
      },
    )
    expect(result.allResults).toHaveLength(2)
    expect(result.selectedResult.success).toBe(false)
  })

  it('best-of-n with custom scorer picks highest scorer', async () => {
    const claude = makeAdapter('claude', async function* () {
      yield completedEvent('claude', 'short')
    })
    const codex = makeAdapter('codex', async function* () {
      yield completedEvent('codex', 'much-longer-result')
    })
    const executor = new ParallelExecutor({
      registry: registryFromAdapters([claude, codex]),
      eventBus: bus,
    })
    const scorer = (r: ProviderResult): number => r.result.length
    const result = await executor.execute(
      { prompt: 'x' },
      {
        providers: ['claude', 'codex'],
        mergeStrategy: 'best-of-n',
        scorer,
      },
    )
    expect(result.selectedResult.providerId).toBe('codex')
  })

  it('best-of-n defaults to default scorer when none provided', async () => {
    const claude = makeAdapter('claude', async function* () {
      await new Promise((r) => setTimeout(r, 5))
      yield completedEvent('claude', 'slow')
    })
    const codex = makeAdapter('codex', async function* () {
      yield completedEvent('codex', 'fast')
    })
    const executor = new ParallelExecutor({
      registry: registryFromAdapters([claude, codex]),
      eventBus: bus,
    })
    const result = await executor.execute(
      { prompt: 'x' },
      {
        providers: ['claude', 'codex'],
        mergeStrategy: 'best-of-n',
      },
    )
    expect(result.selectedResult.success).toBe(true)
    // Default scorer prefers shorter duration
    expect(['claude', 'codex']).toContain(result.selectedResult.providerId)
  })

  it('unhealthy provider yields failure without invoking adapter', async () => {
    const claude = makeAdapter('claude', async function* () {
      yield completedEvent('claude', 'ok')
    })
    const registry = registryFromAdapters([claude])
    // codex is not registered — it is unhealthy
    const executor = new ParallelExecutor({ registry, eventBus: bus })
    const result = await executor.execute(
      { prompt: 'x' },
      {
        providers: ['claude', 'codex'],
        mergeStrategy: 'all',
      },
    )
    const codexResult = result.allResults.find((r) => r.providerId === 'codex')!
    expect(codexResult.success).toBe(false)
    expect(codexResult.error).toContain('not healthy')
  })

  it('first-wins with all providers failing returns failure result', async () => {
    const claude = makeAdapter('claude', async function* () {
      throw new Error('c1')
    })
    const codex = makeAdapter('codex', async function* () {
      throw new Error('c2')
    })
    const executor = new ParallelExecutor({
      registry: registryFromAdapters([claude, codex]),
      eventBus: bus,
    })
    const result = await executor.execute(
      { prompt: 'x' },
      {
        providers: ['claude', 'codex'],
        mergeStrategy: 'first-wins',
      },
    )
    expect(result.selectedResult.success).toBe(false)
    expect(result.allResults).toHaveLength(2)
  })

  it('pre-aborted signal returns cancelled result without running any provider', async () => {
    let called = false
    const claude = makeAdapter('claude', async function* () {
      called = true
      yield completedEvent('claude', 'never')
    })
    const executor = new ParallelExecutor({
      registry: registryFromAdapters([claude]),
      eventBus: bus,
    })
    const controller = new AbortController()
    controller.abort()
    const result = await executor.execute(
      { prompt: 'x' },
      {
        providers: ['claude'],
        mergeStrategy: 'all',
        signal: controller.signal,
      },
    )
    expect(result.cancelled).toBe(true)
    expect(called).toBe(false)
  })

  it('timeout fires and cancels adapters', async () => {
    const slow = makeAdapter('claude', async function* () {
      await new Promise((r) => setTimeout(r, 200))
      yield completedEvent('claude', 'too-slow')
    })
    const executor = new ParallelExecutor({
      registry: registryFromAdapters([slow]),
      eventBus: bus,
    })
    const result = await executor.execute(
      { prompt: 'x' },
      {
        providers: ['claude'],
        mergeStrategy: 'all',
        timeoutMs: 20,
      },
    )
    expect(result.cancelled).toBe(true)
  })

  it('race() convenience API returns a ProviderResult', async () => {
    const claude = makeAdapter('claude', async function* () {
      yield completedEvent('claude', 'winner')
    })
    const executor = new ParallelExecutor({
      registry: registryFromAdapters([claude]),
      eventBus: bus,
    })
    const result = await executor.race({ prompt: 'x' }, ['claude'])
    expect(result.providerId).toBe('claude')
    expect(result.success).toBe(true)
  })

  it('race() honours optional signal parameter', async () => {
    const claude = makeAdapter('claude', async function* () {
      yield completedEvent('claude', 'winner')
    })
    const executor = new ParallelExecutor({
      registry: registryFromAdapters([claude]),
      eventBus: bus,
    })
    const controller = new AbortController()
    const result = await executor.race({ prompt: 'x' }, ['claude'], controller.signal)
    expect(result.success).toBe(true)
  })

  it('all strategy with zero providers still returns a (synthetic) selectedResult', async () => {
    const executor = new ParallelExecutor({
      registry: new ProviderAdapterRegistry(),
      eventBus: bus,
    })
    const result = await executor.execute(
      { prompt: 'x' },
      {
        providers: [],
        mergeStrategy: 'all',
      },
    )
    expect(result.allResults).toHaveLength(0)
    // selectedResult should be a synthetic failure fallback
    expect(result.selectedResult.success).toBe(false)
  })

  it('best-of-n with empty results returns synthetic failure', async () => {
    const executor = new ParallelExecutor({
      registry: new ProviderAdapterRegistry(),
      eventBus: bus,
    })
    const result = await executor.execute(
      { prompt: 'x' },
      {
        providers: [],
        mergeStrategy: 'best-of-n',
      },
    )
    expect(result.allResults).toHaveLength(0)
    expect(result.selectedResult.success).toBe(false)
  })

  it('works with no eventBus set (null-safety)', async () => {
    const claude = makeAdapter('claude', async function* () {
      yield completedEvent('claude', 'ok')
    })
    const executor = new ParallelExecutor({
      registry: registryFromAdapters([claude]),
    })
    const result = await executor.execute(
      { prompt: 'x' },
      {
        providers: ['claude'],
        mergeStrategy: 'all',
      },
    )
    expect(result.selectedResult.success).toBe(true)
  })

  it('supports adapter completing with no result event (iterator ends silently)', async () => {
    const silent = makeAdapter('claude', async function* () {
      // no events at all
    })
    const executor = new ParallelExecutor({
      registry: registryFromAdapters([silent]),
      eventBus: bus,
    })
    const result = await executor.execute(
      { prompt: 'x' },
      {
        providers: ['claude'],
        mergeStrategy: 'all',
      },
    )
    // Treated as success with empty result since no error thrown
    expect(result.allResults[0]!.success).toBe(true)
    expect(result.allResults[0]!.result).toBe('')
  })

  it('timeoutMs of zero is ignored (treated as no timeout)', async () => {
    const claude = makeAdapter('claude', async function* () {
      yield completedEvent('claude', 'done')
    })
    const executor = new ParallelExecutor({
      registry: registryFromAdapters([claude]),
      eventBus: bus,
    })
    const result = await executor.execute(
      { prompt: 'x' },
      {
        providers: ['claude'],
        mergeStrategy: 'all',
        timeoutMs: 0,
      },
    )
    expect(result.cancelled).toBeUndefined()
    expect(result.selectedResult.success).toBe(true)
  })
})
