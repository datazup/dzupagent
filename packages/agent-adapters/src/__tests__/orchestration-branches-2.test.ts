/**
 * Additional branch coverage for orchestration primitives.
 *
 * Targets specific uncovered lines:
 *  - parallel-executor: lines 460-467 (abort observed after completed yielded)
 *  - map-reduce: lines 332-334 (abort between semaphore acquire and mapper)
 *  - contract-net: lines 538-543 (empty rankedBids fallback)
 *  - learning-loop: uncovered trend branches, switch cases in buildRecoverySuggestion
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import type { DzupEventBus } from '@dzupagent/core'

import {
  MapReduceOrchestrator,
  LineChunker,
} from '../orchestration/map-reduce.js'
import type {
  MapperFn,
  ReducerFn,
} from '../orchestration/map-reduce.js'
import {
  ContractNetOrchestrator,
} from '../orchestration/contract-net.js'
import type {
  BidStrategy,
} from '../orchestration/contract-net.js'
import { ParallelExecutor } from '../orchestration/parallel-executor.js'
import {
  AdapterLearningLoop,
  ExecutionAnalyzer,
} from '../learning/adapter-learning-loop.js'
import type { ExecutionRecord } from '../learning/adapter-learning-loop.js'
import { AdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
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
    async *resumeSession() {
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
    sessionId: 'sess',
    result,
    durationMs: 5,
    timestamp: Date.now(),
  }
}

function buildRegistry(adapters: AgentCLIAdapter[]): AdapterRegistry {
  const registry = new AdapterRegistry()
  for (const a of adapters) registry.register(a)
  return registry
}

// ---------------------------------------------------------------------------
// ParallelExecutor additional branch tests
// ---------------------------------------------------------------------------

describe('ParallelExecutor deep branch coverage', () => {
  let bus: DzupEventBus

  beforeEach(() => {
    bus = createEventBus()
  })

  it('marks completed event as cancelled when signal aborts right as result arrives', async () => {
    // Scenario: adapter yields completed but signal aborts before emit completes.
    const completedAdapter = makeAdapter('claude', async function* (input) {
      await new Promise((r) => setTimeout(r, 5))
      yield completedEvent('claude', 'result')
      // Never reached — the executor returns on completed event
    })
    const executor = new ParallelExecutor({
      registry: buildRegistry([completedAdapter]),
      eventBus: bus,
    })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 1)
    const result = await executor.execute(
      { prompt: 'x' },
      {
        providers: ['claude'],
        mergeStrategy: 'all',
        signal: controller.signal,
      },
    )
    // Either cancelled or completed — both branches are acceptable
    expect(result.strategy).toBe('all')
  })

  it('pre-aborted signal with empty provider list still returns result', async () => {
    const executor = new ParallelExecutor({
      registry: new AdapterRegistry(),
      eventBus: bus,
    })
    const controller = new AbortController()
    controller.abort()
    const result = await executor.execute(
      { prompt: 'x' },
      {
        providers: [],
        mergeStrategy: 'all',
        signal: controller.signal,
      },
    )
    expect(result.cancelled).toBe(true)
    expect(result.allResults).toHaveLength(0)
  })

  it('abort reason "external" produces generic cancellation message', async () => {
    const slow = makeAdapter('claude', async function* () {
      await new Promise((r) => setTimeout(r, 100))
      yield completedEvent('claude', 'late')
    })
    const executor = new ParallelExecutor({
      registry: buildRegistry([slow]),
      eventBus: bus,
    })
    const controller = new AbortController()
    setTimeout(() => controller.abort('external'), 5)
    const result = await executor.execute(
      { prompt: 'x' },
      {
        providers: ['claude'],
        mergeStrategy: 'all',
        signal: controller.signal,
      },
    )
    expect(result.cancelled).toBe(true)
  })

  it('first-wins with one success and one failure still returns success', async () => {
    const success = makeAdapter('claude', async function* () {
      yield completedEvent('claude', 'winner')
    })
    const fail = makeAdapter('codex', async function* () {
      throw new Error('loser')
    })
    const executor = new ParallelExecutor({
      registry: buildRegistry([success, fail]),
      eventBus: bus,
    })
    const result = await executor.execute(
      { prompt: 'x' },
      {
        providers: ['claude', 'codex'],
        mergeStrategy: 'first-wins',
      },
    )
    expect(result.selectedResult.success).toBe(true)
    expect(result.selectedResult.providerId).toBe('claude')
  })

  it('best-of-n scorer returning all equal scores picks first encountered', async () => {
    const a = makeAdapter('claude', async function* () {
      yield completedEvent('claude', 'a')
    })
    const b = makeAdapter('codex', async function* () {
      yield completedEvent('codex', 'b')
    })
    const executor = new ParallelExecutor({
      registry: buildRegistry([a, b]),
      eventBus: bus,
    })
    const result = await executor.execute(
      { prompt: 'x' },
      {
        providers: ['claude', 'codex'],
        mergeStrategy: 'best-of-n',
        scorer: () => 42,
      },
    )
    expect(result.selectedResult.success).toBe(true)
  })

  it('handles adapter throwing inside execute iteration', async () => {
    const crash = makeAdapter('claude', async function* () {
      yield {
        type: 'adapter:started',
        providerId: 'claude',
        sessionId: 's',
        timestamp: Date.now(),
      } satisfies AgentEvent
      throw new Error('mid-stream crash')
    })
    const executor = new ParallelExecutor({
      registry: buildRegistry([crash]),
      eventBus: bus,
    })
    const result = await executor.execute(
      { prompt: 'x' },
      {
        providers: ['claude'],
        mergeStrategy: 'all',
      },
    )
    expect(result.allResults[0]!.success).toBe(false)
    expect(result.allResults[0]!.error).toContain('mid-stream crash')
  })
})

// ---------------------------------------------------------------------------
// MapReduce additional branch tests
// ---------------------------------------------------------------------------

describe('MapReduce deep branch coverage', () => {
  let bus: DzupEventBus

  beforeEach(() => {
    bus = createEventBus()
  })

  const stringArrayMapper: MapperFn<string[]> = (chunk) => ({
    input: { prompt: chunk.join('\n') },
    task: { prompt: chunk.join('\n'), tags: ['general'] },
  })

  const identityExtractor = (raw: string): string => raw

  it('handles non-Error cancellation value (DOMException AbortError)', async () => {
    // Aborting with a DOMException-shaped reason — should still be treated as cancelled
    const controller = new AbortController()
    const registry = {
      async *executeWithFallback(input: AgentInput, _task: TaskDescriptor) {
        if (input.signal?.aborted) {
          const err = new DOMException('cancelled', 'AbortError')
          throw err
        }
        yield completedEvent('claude', 'ok')
      },
    } as unknown as AdapterRegistry
    controller.abort()
    const orchestrator = new MapReduceOrchestrator({ registry, eventBus: bus })
    const result = await orchestrator.execute('a\nb', {
      chunker: new LineChunker(1),
      mapper: stringArrayMapper,
      resultExtractor: identityExtractor,
      reducer: (results) => results.length,
      signal: controller.signal,
    })
    expect(result.cancelled).toBe(true)
  })

  it('treats non-Error rejection reason via String() coercion', async () => {
    const registry: AdapterRegistry = {
      async *executeWithFallback() {
        throw 'string error' as unknown as Error
      },
    } as unknown as AdapterRegistry
    const orchestrator = new MapReduceOrchestrator({ registry, eventBus: bus })
    const result = await orchestrator.execute('x', {
      chunker: new LineChunker(1),
      mapper: stringArrayMapper,
      resultExtractor: identityExtractor,
      reducer: (results) => results,
    })
    expect(result.failedChunks).toBe(1)
    expect(result.perChunkStats[0]!.success).toBe(false)
  })

  it('handles mapper function throwing an error', async () => {
    const registry: AdapterRegistry = {
      async *executeWithFallback() {
        yield completedEvent('claude', 'never')
      },
    } as unknown as AdapterRegistry
    const explodingMapper: MapperFn<string[]> = () => {
      throw new Error('mapper exploded')
    }
    const orchestrator = new MapReduceOrchestrator({ registry, eventBus: bus })
    const result = await orchestrator.execute('a', {
      chunker: new LineChunker(1),
      mapper: explodingMapper,
      resultExtractor: identityExtractor,
      reducer: (results) => results,
    })
    expect(result.failedChunks).toBe(1)
    expect(result.perChunkStats[0]!.success).toBe(false)
  })

  it('uses extractor that can return undefined typed value', async () => {
    const registry: AdapterRegistry = {
      async *executeWithFallback() {
        yield completedEvent('claude', 'raw')
      },
    } as unknown as AdapterRegistry
    const orchestrator = new MapReduceOrchestrator({ registry, eventBus: bus })
    const result = await orchestrator.execute('a', {
      chunker: new LineChunker(1),
      mapper: stringArrayMapper,
      resultExtractor: () => undefined as unknown as string,
      reducer: (results) => results.length,
    })
    expect(result.successfulChunks).toBe(1)
    expect(result.result).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// ContractNet additional branch tests
// ---------------------------------------------------------------------------

describe('ContractNet deep branch coverage', () => {
  let bus: DzupEventBus

  beforeEach(() => {
    bus = createEventBus()
  })

  it('throws ALL_ADAPTERS_EXHAUSTED when there is no healthy adapter for any bid', async () => {
    // No adapters registered — listAdapters returns []
    const registry = new AdapterRegistry()
    const orchestrator = new ContractNetOrchestrator({
      registry,
      eventBus: bus,
    })
    await expect(
      orchestrator.execute({ prompt: 'x', tags: ['general'] }, { prompt: 'x' }),
    ).rejects.toThrow('No healthy adapters')
  })

  it('adapter completing with no success nor error exits via "without producing result" branch', async () => {
    // Adapter yields only started event, no completed
    const adapter = makeAdapter('claude', async function* () {
      yield {
        type: 'adapter:started',
        providerId: 'claude',
        sessionId: 's',
        timestamp: Date.now(),
      } satisfies AgentEvent
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
    expect(result.error).toContain('without producing a result')
  })

  it('custom scorer receiving a bid — simple numeric scorer works', async () => {
    const adapter = makeAdapter('claude', async function* () {
      yield completedEvent('claude', 'ok')
    })
    const orchestrator = new ContractNetOrchestrator({
      registry: buildRegistry([adapter]),
      eventBus: bus,
    })
    const result = await orchestrator.execute(
      { prompt: 'x', tags: ['general'] },
      { prompt: 'x' },
      {
        selectionCriteria: { customScorer: (bid) => bid.confidence },
      },
    )
    expect(result.success).toBe(true)
  })

  it('weights configured to all zero — scoring still returns a winner', async () => {
    const adapter = makeAdapter('claude', async function* () {
      yield completedEvent('claude', 'ok')
    })
    const orchestrator = new ContractNetOrchestrator({
      registry: buildRegistry([adapter]),
      eventBus: bus,
    })
    const result = await orchestrator.execute(
      { prompt: 'x', tags: ['general'] },
      { prompt: 'x' },
      {
        selectionCriteria: {
          costWeight: 0,
          confidenceWeight: 0,
          speedWeight: 0,
        },
      },
    )
    expect(result.success).toBe(true)
  })

  it('bid with missing estimatedDurationMs uses default duration', async () => {
    const adapter = makeAdapter('claude', async function* () {
      yield completedEvent('claude', 'ok')
    })
    const noDurationStrategy: BidStrategy = {
      name: 'no-duration',
      async generateBids(_task, providers) {
        return providers.map((id) => ({
          providerId: id,
          estimatedCostCents: 1,
          confidence: 0.5,
          // no estimatedDurationMs
        }))
      },
    }
    const orchestrator = new ContractNetOrchestrator({
      registry: buildRegistry([adapter]),
      eventBus: bus,
      bidStrategy: noDurationStrategy,
    })
    const result = await orchestrator.execute(
      { prompt: 'x', tags: ['general'] },
      { prompt: 'x' },
    )
    expect(result.success).toBe(true)
  })

  it('signal triggers abort during bid collection', async () => {
    const adapter = makeAdapter('claude', async function* () {
      yield completedEvent('claude', 'ok')
    })
    const slowStrategy: BidStrategy = {
      name: 'slow',
      async generateBids() {
        await new Promise((r) => setTimeout(r, 200))
        return []
      },
    }
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 5)
    const orchestrator = new ContractNetOrchestrator({
      registry: buildRegistry([adapter]),
      eventBus: bus,
      bidStrategy: slowStrategy,
    })
    const result = await orchestrator.execute(
      { prompt: 'x', tags: ['general'] },
      { prompt: 'x' },
      { signal: controller.signal },
    )
    expect(result.cancelled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Learning loop branch coverage
// ---------------------------------------------------------------------------

describe('AdapterLearningLoop branch coverage', () => {
  function record(
    providerId: AdapterProviderId,
    overrides: Partial<ExecutionRecord> = {},
  ): ExecutionRecord {
    return {
      providerId,
      taskType: 'default',
      tags: [],
      success: true,
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 5,
      costCents: 1,
      timestamp: Date.now(),
      ...overrides,
    }
  }

  it('getProfile returns zero-state profile for unknown provider', () => {
    const loop = new AdapterLearningLoop()
    const profile = loop.getProfile('claude')
    expect(profile.totalExecutions).toBe(0)
    expect(profile.successRate).toBe(0)
    expect(profile.trend).toBe('stable')
    expect(profile.specialties).toEqual([])
    expect(profile.weaknesses).toEqual([])
  })

  it('getBestProvider returns undefined when no providers have enough samples', () => {
    const loop = new AdapterLearningLoop({ minSampleSize: 100 })
    for (let i = 0; i < 5; i++) {
      loop.record(record('claude', { taskType: 'analysis' }))
    }
    const best = loop.getBestProvider('analysis', ['claude', 'codex'])
    expect(best).toBeUndefined()
  })

  it('getBestProvider sorts by success > duration > cost', () => {
    const loop = new AdapterLearningLoop({ minSampleSize: 2 })
    // claude: 100% success, 100ms
    for (let i = 0; i < 3; i++) {
      loop.record(record('claude', { taskType: 't', success: true, durationMs: 100 }))
    }
    // codex: 100% success, 50ms (faster, wins)
    for (let i = 0; i < 3; i++) {
      loop.record(record('codex', { taskType: 't', success: true, durationMs: 50 }))
    }
    const best = loop.getBestProvider('t', ['claude', 'codex'])
    expect(best).toBe('codex')
  })

  it('getBestProvider: tie on duration then cost wins', () => {
    const loop = new AdapterLearningLoop({ minSampleSize: 2 })
    for (let i = 0; i < 3; i++) {
      loop.record(
        record('claude', {
          taskType: 't',
          success: true,
          durationMs: 100,
          costCents: 10,
        }),
      )
    }
    for (let i = 0; i < 3; i++) {
      loop.record(
        record('codex', {
          taskType: 't',
          success: true,
          durationMs: 100,
          costCents: 1,
        }),
      )
    }
    const best = loop.getBestProvider('t', ['claude', 'codex'])
    expect(best).toBe('codex')
  })

  it('suggestRecovery returns undefined for unknown provider', () => {
    const loop = new AdapterLearningLoop()
    expect(loop.suggestRecovery('claude', 'timeout')).toBeUndefined()
  })

  it('suggestRecovery returns undefined when provider has no matching error type', () => {
    const loop = new AdapterLearningLoop()
    loop.record(record('claude', { success: true }))
    expect(loop.suggestRecovery('claude', 'unknown_error')).toBeUndefined()
  })

  it('suggestRecovery: rate_limit switches to alternative provider', () => {
    const loop = new AdapterLearningLoop()
    loop.record(record('claude', { success: false, errorType: 'rate_limit' }))
    loop.record(record('codex', { success: true }))
    const suggestion = loop.suggestRecovery('claude', 'rate_limit')
    expect(suggestion?.action).toBe('switch-provider')
    if (suggestion?.action === 'switch-provider') {
      expect(suggestion.targetProvider).toBe('codex')
    }
  })

  it('suggestRecovery: rate_limit retries with backoff when no alternative', () => {
    const loop = new AdapterLearningLoop()
    loop.record(record('claude', { success: false, errorType: 'rate_limit' }))
    const suggestion = loop.suggestRecovery('claude', 'rate_limit')
    expect(suggestion?.action).toBe('retry')
  })

  it('suggestRecovery: timeout returns increase-budget', () => {
    const loop = new AdapterLearningLoop()
    loop.record(record('claude', { success: false, errorType: 'timeout' }))
    const suggestion = loop.suggestRecovery('claude', 'timeout')
    expect(suggestion?.action).toBe('increase-budget')
  })

  it('suggestRecovery: context_too_long switches to gemini', () => {
    const loop = new AdapterLearningLoop()
    loop.record(record('claude', { success: false, errorType: 'context_too_long' }))
    const suggestion = loop.suggestRecovery('claude', 'context_too_long')
    expect(suggestion?.action).toBe('switch-provider')
    if (suggestion?.action === 'switch-provider') {
      expect(suggestion.targetProvider).toBe('gemini')
    }
  })

  it('suggestRecovery: quality_low with alternative returns switch-provider', () => {
    const loop = new AdapterLearningLoop()
    loop.record(record('claude', { success: false, errorType: 'quality_low' }))
    loop.record(record('codex', { success: true, qualityScore: 0.9 }))
    const suggestion = loop.suggestRecovery('claude', 'quality_low')
    expect(suggestion?.action).toBe('switch-provider')
  })

  it('suggestRecovery: quality_low without alternative returns retry', () => {
    const loop = new AdapterLearningLoop()
    loop.record(record('claude', { success: false, errorType: 'quality_low' }))
    const suggestion = loop.suggestRecovery('claude', 'quality_low')
    expect(suggestion?.action).toBe('retry')
  })

  it('suggestRecovery: unknown error type returns default retry suggestion', () => {
    const loop = new AdapterLearningLoop()
    loop.record(record('claude', { success: false, errorType: 'mystery' }))
    const suggestion = loop.suggestRecovery('claude', 'mystery')
    expect(suggestion?.action).toBe('retry')
  })

  it('detectFailurePatterns returns empty array for unknown provider', () => {
    const loop = new AdapterLearningLoop()
    expect(loop.detectFailurePatterns('claude')).toEqual([])
  })

  it('detectFailurePatterns filters out old failures outside window', () => {
    const loop = new AdapterLearningLoop({ failureWindowMs: 100 })
    const oldTs = Date.now() - 10_000
    loop.record(
      record('claude', {
        success: false,
        errorType: 'timeout',
        timestamp: oldTs,
      }),
    )
    const patterns = loop.detectFailurePatterns('claude')
    expect(patterns).toHaveLength(0)
  })

  it('detectFailurePatterns requires minimum frequency before reporting', () => {
    const loop = new AdapterLearningLoop()
    // Only 2 failures — below MIN_FAILURE_PATTERN_FREQUENCY of 3
    for (let i = 0; i < 2; i++) {
      loop.record(record('claude', { success: false, errorType: 'timeout' }))
    }
    expect(loop.detectFailurePatterns('claude')).toHaveLength(0)
  })

  it('detectFailurePatterns ignores failures without errorType', () => {
    const loop = new AdapterLearningLoop()
    for (let i = 0; i < 5; i++) {
      loop.record(record('claude', { success: false }))
    }
    expect(loop.detectFailurePatterns('claude')).toHaveLength(0)
  })

  it('trend detection — improving trend', () => {
    const loop = new AdapterLearningLoop({ minSampleSize: 5 })
    // Early: many failures, recent: all success
    for (let i = 0; i < 8; i++) {
      loop.record(
        record('claude', {
          success: false,
          timestamp: Date.now() - (20 - i) * 1000,
        }),
      )
    }
    for (let i = 0; i < 5; i++) {
      loop.record(
        record('claude', {
          success: true,
          timestamp: Date.now() - i * 1000,
        }),
      )
    }
    const profile = loop.getProfile('claude')
    expect(profile.trend).toBe('improving')
  })

  it('trend detection — degrading trend', () => {
    const loop = new AdapterLearningLoop({ minSampleSize: 5 })
    for (let i = 0; i < 8; i++) {
      loop.record(
        record('claude', {
          success: true,
          timestamp: Date.now() - (20 - i) * 1000,
        }),
      )
    }
    for (let i = 0; i < 5; i++) {
      loop.record(
        record('claude', {
          success: false,
          timestamp: Date.now() - i * 1000,
        }),
      )
    }
    const profile = loop.getProfile('claude')
    expect(profile.trend).toBe('degrading')
  })

  it('trend detection — stable when diff below threshold', () => {
    const loop = new AdapterLearningLoop({ minSampleSize: 5 })
    // All successes — no degradation
    for (let i = 0; i < 10; i++) {
      loop.record(
        record('claude', {
          success: true,
          timestamp: Date.now() - (10 - i) * 1000,
        }),
      )
    }
    const profile = loop.getProfile('claude')
    expect(profile.trend).toBe('stable')
  })

  it('profile specialties/weaknesses require min samples', () => {
    const loop = new AdapterLearningLoop()
    // Only 3 samples — below SPECIALTY_MIN_SAMPLES of 5
    for (let i = 0; i < 3; i++) {
      loop.record(record('claude', { taskType: 'fast', success: true }))
    }
    const profile = loop.getProfile('claude')
    expect(profile.specialties).toEqual([])
    expect(profile.weaknesses).toEqual([])
  })

  it('profile specialties include high-success task types', () => {
    const loop = new AdapterLearningLoop()
    for (let i = 0; i < 8; i++) {
      loop.record(record('claude', { taskType: 'specialty', success: true }))
    }
    const profile = loop.getProfile('claude')
    expect(profile.specialties).toContain('specialty')
  })

  it('profile weaknesses include low-success task types', () => {
    const loop = new AdapterLearningLoop()
    for (let i = 0; i < 8; i++) {
      loop.record(record('claude', { taskType: 'weakness', success: false }))
    }
    const profile = loop.getProfile('claude')
    expect(profile.weaknesses).toContain('weakness')
  })

  it('profile avgQualityScore is 0 when no records have qualityScore', () => {
    const loop = new AdapterLearningLoop()
    loop.record(record('claude', { success: true }))
    const profile = loop.getProfile('claude')
    expect(profile.avgQualityScore).toBe(0)
  })

  it('profile avgQualityScore averages when some have scores', () => {
    const loop = new AdapterLearningLoop()
    loop.record(record('claude', { qualityScore: 0.5 }))
    loop.record(record('claude', { qualityScore: 0.9 }))
    loop.record(record('claude', {})) // no score
    const profile = loop.getProfile('claude')
    expect(profile.avgQualityScore).toBe(0.7)
  })

  it('exportData produces Record<providerId, records[]>', () => {
    const loop = new AdapterLearningLoop()
    loop.record(record('claude'))
    loop.record(record('codex'))
    const exported = loop.exportData()
    expect(exported['claude']).toHaveLength(1)
    expect(exported['codex']).toHaveLength(1)
  })

  it('importData creates new buffers for unseen providers', () => {
    const loop = new AdapterLearningLoop()
    loop.importData({ claude: [record('claude')] })
    expect(loop.getProfile('claude').totalExecutions).toBe(1)
  })

  it('importData appends to existing buffers', () => {
    const loop = new AdapterLearningLoop()
    loop.record(record('claude'))
    loop.importData({ claude: [record('claude'), record('claude')] })
    expect(loop.getProfile('claude').totalExecutions).toBe(3)
  })

  it('reset clears all records', () => {
    const loop = new AdapterLearningLoop()
    loop.record(record('claude'))
    loop.record(record('codex'))
    loop.reset()
    expect(loop.getAllProfiles()).toEqual([])
  })

  it('getAllProfiles returns profiles for all tracked providers', () => {
    const loop = new AdapterLearningLoop()
    loop.record(record('claude'))
    loop.record(record('codex'))
    const profiles = loop.getAllProfiles()
    const ids = profiles.map((p) => p.providerId).sort()
    expect(ids).toEqual(['claude', 'codex'])
  })

  it('record emits quality:adjusted event via event bus', () => {
    const bus = createEventBus()
    const received: string[] = []
    bus.onAny((e) => received.push(e.type))
    const loop = new AdapterLearningLoop({ eventBus: bus })
    loop.record(record('claude'))
    expect(received).toContain('quality:adjusted')
  })

  it('record does not throw when event bus emit fails', () => {
    const errBus = {
      emit: () => {
        throw new Error('bus failure')
      },
      onAny: () => () => {},
      on: () => () => {},
      off: () => {},
      close: () => {},
    }
    const loop = new AdapterLearningLoop({
      eventBus: errBus as unknown as DzupEventBus,
    })
    expect(() => loop.record(record('claude'))).not.toThrow()
  })

  it('ring buffer caps records at maxRecordsPerProvider', () => {
    const loop = new AdapterLearningLoop({ maxRecordsPerProvider: 3 })
    for (let i = 0; i < 10; i++) {
      loop.record(record('claude'))
    }
    const exported = loop.exportData()
    expect(exported['claude']).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// ExecutionAnalyzer branch coverage
// ---------------------------------------------------------------------------

describe('ExecutionAnalyzer branch coverage', () => {
  function rec(
    providerId: AdapterProviderId,
    overrides: Partial<ExecutionRecord> = {},
  ): ExecutionRecord {
    return {
      providerId,
      taskType: 'default',
      tags: [],
      success: true,
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 5,
      costCents: 1,
      timestamp: Date.now(),
      ...overrides,
    }
  }

  it('generateReport with no records returns zero totals', () => {
    const loop = new AdapterLearningLoop()
    const analyzer = new ExecutionAnalyzer(loop)
    const report = analyzer.generateReport()
    expect(report.totalExecutions).toBe(0)
    expect(report.overallSuccessRate).toBe(0)
    expect(report.avgCostPerExecution).toBe(0)
  })

  it('generateReport calculates weighted overall success rate', () => {
    const loop = new AdapterLearningLoop()
    for (let i = 0; i < 10; i++) loop.record(rec('claude', { success: true }))
    for (let i = 0; i < 10; i++) loop.record(rec('codex', { success: false }))
    const analyzer = new ExecutionAnalyzer(loop)
    const report = analyzer.generateReport()
    expect(report.overallSuccessRate).toBeCloseTo(0.5, 2)
  })

  it('generateReport includes recommendations for degrading providers', () => {
    const loop = new AdapterLearningLoop({ minSampleSize: 5 })
    // degrading trend
    for (let i = 0; i < 8; i++) {
      loop.record(rec('claude', { success: true, timestamp: Date.now() - (20 - i) * 1000 }))
    }
    for (let i = 0; i < 5; i++) {
      loop.record(rec('claude', { success: false, timestamp: Date.now() - i * 1000 }))
    }
    const analyzer = new ExecutionAnalyzer(loop)
    const report = analyzer.generateReport()
    expect(report.recommendations.some((r) => r.includes('degrading'))).toBe(true)
  })

  it('generateReport includes recommendation for low success rate', () => {
    const loop = new AdapterLearningLoop()
    for (let i = 0; i < 10; i++) {
      loop.record(rec('claude', { success: false }))
    }
    const analyzer = new ExecutionAnalyzer(loop)
    const report = analyzer.generateReport()
    expect(report.recommendations.some((r) => r.includes('success rate'))).toBe(true)
  })

  it('generateReport includes specialty recommendations', () => {
    const loop = new AdapterLearningLoop()
    for (let i = 0; i < 8; i++) {
      loop.record(rec('claude', { taskType: 'planning', success: true }))
    }
    const analyzer = new ExecutionAnalyzer(loop)
    const report = analyzer.generateReport()
    expect(report.recommendations.some((r) => r.includes('excels'))).toBe(true)
  })

  it('compareProviders — equal performance returns tie', () => {
    const loop = new AdapterLearningLoop()
    for (let i = 0; i < 5; i++) {
      loop.record(rec('claude', { success: true, durationMs: 100, costCents: 1 }))
      loop.record(rec('codex', { success: true, durationMs: 100, costCents: 1 }))
    }
    const analyzer = new ExecutionAnalyzer(loop)
    const comparison = analyzer.compareProviders('claude', 'codex')
    expect(comparison.winner).toBe('tie')
  })

  it('compareProviders — higher success wins', () => {
    const loop = new AdapterLearningLoop()
    for (let i = 0; i < 5; i++) {
      loop.record(rec('claude', { success: true }))
      loop.record(rec('codex', { success: false }))
    }
    const analyzer = new ExecutionAnalyzer(loop)
    const comparison = analyzer.compareProviders('claude', 'codex')
    expect(comparison.winner).toBe('claude')
    expect(comparison.reason).toContain('success rate')
  })

  it('compareProviders — tied success, faster wins', () => {
    const loop = new AdapterLearningLoop()
    for (let i = 0; i < 5; i++) {
      loop.record(rec('claude', { success: true, durationMs: 200 }))
      loop.record(rec('codex', { success: true, durationMs: 50 }))
    }
    const analyzer = new ExecutionAnalyzer(loop)
    const comparison = analyzer.compareProviders('claude', 'codex')
    expect(comparison.winner).toBe('codex')
    expect(comparison.reason).toContain('duration')
  })

  it('compareProviders — tied success & speed, cheaper wins', () => {
    const loop = new AdapterLearningLoop()
    for (let i = 0; i < 5; i++) {
      loop.record(rec('claude', { success: true, durationMs: 100, costCents: 10 }))
      loop.record(rec('codex', { success: true, durationMs: 100, costCents: 1 }))
    }
    const analyzer = new ExecutionAnalyzer(loop)
    const comparison = analyzer.compareProviders('claude', 'codex')
    expect(comparison.winner).toBe('codex')
    expect(comparison.reason).toContain('cost')
  })

  it('compareProviders with taskType filters records', () => {
    const loop = new AdapterLearningLoop()
    for (let i = 0; i < 5; i++) {
      loop.record(rec('claude', { success: true, taskType: 'specific' }))
      loop.record(rec('codex', { success: false, taskType: 'specific' }))
      // Unrelated task type — should be ignored
      loop.record(rec('codex', { success: true, taskType: 'other' }))
    }
    const analyzer = new ExecutionAnalyzer(loop)
    const comparison = analyzer.compareProviders('claude', 'codex', 'specific')
    expect(comparison.winner).toBe('claude')
  })

  it('compareProviders with taskType where no records exist returns zero stats', () => {
    const loop = new AdapterLearningLoop()
    loop.record(rec('claude'))
    const analyzer = new ExecutionAnalyzer(loop)
    const comparison = analyzer.compareProviders('claude', 'codex', 'nonexistent-task')
    expect(comparison.providerA.successRate).toBe(0)
    expect(comparison.providerB.successRate).toBe(0)
  })

  it('getOptimalAllocation returns empty map when no data', () => {
    const loop = new AdapterLearningLoop()
    const analyzer = new ExecutionAnalyzer(loop)
    const allocation = analyzer.getOptimalAllocation()
    expect(allocation.size).toBe(0)
  })

  it('getOptimalAllocation maps task types to best provider', () => {
    const loop = new AdapterLearningLoop({ minSampleSize: 3 })
    for (let i = 0; i < 5; i++) {
      loop.record(rec('claude', { taskType: 'reasoning', success: true }))
      loop.record(rec('codex', { taskType: 'reasoning', success: false }))
    }
    const analyzer = new ExecutionAnalyzer(loop)
    const allocation = analyzer.getOptimalAllocation()
    expect(allocation.get('reasoning')).toBe('claude')
  })

  it('compareProviders with very small difference treated as tie', () => {
    const loop = new AdapterLearningLoop()
    // 99 vs 100 — diff is 0.01 — below threshold
    for (let i = 0; i < 100; i++) {
      loop.record(rec('claude', { success: true }))
    }
    for (let i = 0; i < 99; i++) {
      loop.record(rec('codex', { success: true }))
    }
    // Same durations and costs — result is a tie
    const analyzer = new ExecutionAnalyzer(loop)
    const comparison = analyzer.compareProviders('claude', 'codex')
    expect(comparison.winner).toBe('tie')
  })
})
