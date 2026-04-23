import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import type { DzupEvent, DzupEventBus } from '@dzupagent/core'

import {
  ContractNetOrchestrator,
  StaticBidStrategy,
} from '../orchestration/contract-net.js'
import type {
  Bid,
  BidStrategy,
  ContractNetConfig,
} from '../orchestration/contract-net.js'
import { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  TaskDescriptor,
} from '../types.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockAdapter(
  providerId: AdapterProviderId,
  events: AgentEvent[],
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput) {
      for (const e of events) yield e
    },
    async *resumeSession(_id: string, _input: AgentInput) {
      /* noop */
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

function completedEvents(providerId: AdapterProviderId, result: string): AgentEvent[] {
  return [
    {
      type: 'adapter:started' as const,
      providerId,
      sessionId: 'sess-1',
      timestamp: Date.now(),
    },
    {
      type: 'adapter:completed' as const,
      providerId,
      sessionId: 'sess-1',
      result,
      durationMs: 50,
      timestamp: Date.now(),
    },
  ]
}

function failedEvents(providerId: AdapterProviderId, error: string): AgentEvent[] {
  return [
    {
      type: 'adapter:failed' as const,
      providerId,
      error,
      timestamp: Date.now(),
    },
  ]
}

function collectBusEvents(bus: DzupEventBus): DzupEvent[] {
  const events: DzupEvent[] = []
  bus.onAny((e) => events.push(e))
  return events
}

function makeTask(tags: string[], overrides?: Partial<TaskDescriptor>): TaskDescriptor {
  return {
    prompt: 'test prompt',
    tags,
    ...overrides,
  }
}

function makeInput(prompt = 'test prompt'): AgentInput {
  return { prompt }
}

// ---------------------------------------------------------------------------
// StaticBidStrategy tests
// ---------------------------------------------------------------------------

describe('StaticBidStrategy', () => {
  const strategy = new StaticBidStrategy()

  it('generates bids for all available providers', async () => {
    const providers: AdapterProviderId[] = ['claude', 'codex', 'gemini']
    const bids = await strategy.generateBids(makeTask(['general']), providers)

    expect(bids).toHaveLength(3)
    const ids = bids.map((b) => b.providerId)
    expect(ids).toEqual(['claude', 'codex', 'gemini'])
  })

  it('boosts claude confidence for reasoning tags', async () => {
    const providers: AdapterProviderId[] = ['claude', 'codex', 'crush']
    const bids = await strategy.generateBids(makeTask(['reasoning']), providers)

    const claudeBid = bids.find((b) => b.providerId === 'claude')!
    const codexBid = bids.find((b) => b.providerId === 'codex')!

    expect(claudeBid.confidence).toBe(0.95)
    expect(codexBid.confidence).toBe(0.6)
    expect(claudeBid.confidence).toBeGreaterThan(codexBid.confidence)
  })

  it('boosts codex confidence for execution tags', async () => {
    const providers: AdapterProviderId[] = ['claude', 'codex', 'crush']
    const bids = await strategy.generateBids(makeTask(['implement']), providers)

    const codexBid = bids.find((b) => b.providerId === 'codex')!
    const crushBid = bids.find((b) => b.providerId === 'crush')!

    expect(codexBid.confidence).toBe(0.9)
    expect(crushBid.confidence).toBe(0.5)
  })

  it('boosts crush confidence for local tags', async () => {
    const providers: AdapterProviderId[] = ['claude', 'crush', 'qwen']
    const bids = await strategy.generateBids(makeTask(['local']), providers)

    const crushBid = bids.find((b) => b.providerId === 'crush')!
    const qwenBid = bids.find((b) => b.providerId === 'qwen')!
    const claudeBid = bids.find((b) => b.providerId === 'claude')!

    expect(crushBid.confidence).toBe(0.85)
    expect(qwenBid.confidence).toBe(0.8)
    expect(claudeBid.confidence).toBe(0.5)
  })

  it('uses requiresReasoning flag', async () => {
    const providers: AdapterProviderId[] = ['claude', 'codex']
    const bids = await strategy.generateBids(
      makeTask([], { requiresReasoning: true }),
      providers,
    )

    const claudeBid = bids.find((b) => b.providerId === 'claude')!
    expect(claudeBid.confidence).toBe(0.95)
  })

  it('uses requiresExecution flag', async () => {
    const providers: AdapterProviderId[] = ['claude', 'codex']
    const bids = await strategy.generateBids(
      makeTask([], { requiresExecution: true }),
      providers,
    )

    const codexBid = bids.find((b) => b.providerId === 'codex')!
    expect(codexBid.confidence).toBe(0.9)
  })

  it('includes cost and duration estimates', async () => {
    const bids = await strategy.generateBids(
      makeTask(['general']),
      ['claude', 'crush'],
    )

    const claudeBid = bids.find((b) => b.providerId === 'claude')!
    const crushBid = bids.find((b) => b.providerId === 'crush')!

    expect(claudeBid.estimatedCostCents).toBe(5)
    expect(crushBid.estimatedCostCents).toBe(1)
    expect(claudeBid.estimatedDurationMs).toBe(5000)
    expect(crushBid.estimatedDurationMs).toBe(2000)
  })

  it('includes approach description', async () => {
    const bids = await strategy.generateBids(
      makeTask(['reasoning']),
      ['claude'],
    )
    expect(bids[0]!.approach).toContain('claude')
    expect(bids[0]!.approach).toContain('reasoning')
  })
})

// ---------------------------------------------------------------------------
// ContractNetOrchestrator tests
// ---------------------------------------------------------------------------

describe('ContractNetOrchestrator', () => {
  let bus: DzupEventBus
  let emitted: DzupEvent[]

  beforeEach(() => {
    bus = createEventBus()
    emitted = collectBusEvents(bus)
  })

  function buildRegistry(adapters: AgentCLIAdapter[]): ProviderAdapterRegistry {
    const registry = new ProviderAdapterRegistry()
    for (const adapter of adapters) {
      registry.register(adapter)
    }
    return registry
  }

  function buildOrchestrator(
    registry: ProviderAdapterRegistry,
    overrides?: Partial<ContractNetConfig>,
  ): ContractNetOrchestrator {
    return new ContractNetOrchestrator({
      registry,
      eventBus: bus,
      ...overrides,
    })
  }

  it('executes winning bid successfully', async () => {
    const adapter = createMockAdapter('claude', completedEvents('claude', 'Hello'))
    const registry = buildRegistry([adapter])
    const orchestrator = buildOrchestrator(registry)

    const result = await orchestrator.execute(
      makeTask(['reasoning']),
      makeInput(),
    )

    expect(result.success).toBe(true)
    expect(result.executionResult).toBe('Hello')
    expect(result.winningBid.providerId).toBe('claude')
    expect(result.allBids).toHaveLength(1)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('falls back to next-best bid on failure', async () => {
    const failingAdapter: AgentCLIAdapter = {
      providerId: 'claude',
      async *execute() {
        throw new Error('claude failed')
      },
      async *resumeSession() { /* noop */ },
      interrupt() {},
      async healthCheck() {
        return { healthy: true, providerId: 'claude', sdkInstalled: true, cliAvailable: true }
      },
      configure() {},
    }
    const backupAdapter = createMockAdapter('codex', completedEvents('codex', 'Backup result'))

    const registry = buildRegistry([failingAdapter, backupAdapter])
    const orchestrator = buildOrchestrator(registry)

    const result = await orchestrator.execute(
      makeTask(['reasoning']),
      makeInput(),
    )

    expect(result.success).toBe(true)
    expect(result.executionResult).toBe('Backup result')
  })

  it('throws when no healthy adapters are available', async () => {
    const registry = new ProviderAdapterRegistry()
    const orchestrator = buildOrchestrator(registry)

    await expect(
      orchestrator.execute(makeTask(['general']), makeInput()),
    ).rejects.toThrow('No healthy adapters')
  })

  it('all adapters fail returns unsuccessful result', async () => {
    const failAdapter1: AgentCLIAdapter = {
      providerId: 'claude',
      async *execute() {
        throw new Error('claude exploded')
      },
      async *resumeSession() { /* noop */ },
      interrupt() {},
      async healthCheck() {
        return { healthy: true, providerId: 'claude', sdkInstalled: true, cliAvailable: true }
      },
      configure() {},
    }
    const failAdapter2: AgentCLIAdapter = {
      providerId: 'codex',
      async *execute() {
        throw new Error('codex exploded')
      },
      async *resumeSession() { /* noop */ },
      interrupt() {},
      async healthCheck() {
        return { healthy: true, providerId: 'codex', sdkInstalled: true, cliAvailable: true }
      },
      configure() {},
    }

    const registry = buildRegistry([failAdapter1, failAdapter2])
    const orchestrator = buildOrchestrator(registry)

    const result = await orchestrator.execute(
      makeTask(['general']),
      makeInput(),
    )

    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('respects abort signal', async () => {
    const adapter = createMockAdapter('claude', completedEvents('claude', 'Hello'))
    const registry = buildRegistry([adapter])
    const orchestrator = buildOrchestrator(registry)

    const controller = new AbortController()
    controller.abort()

    const result = await orchestrator.execute(makeTask(['general']), makeInput(), {
      signal: controller.signal,
    })

    expect(result.cancelled).toBe(true)
    expect(result.success).toBe(false)
    expect(result.winningBid).toBeNull()
    expect(result.error).toBe('Contract-Net execution was aborted')
  })

  it('returns an explicit cancelled result when aborted during bid collection', async () => {
    const adapter = createMockAdapter('claude', completedEvents('claude', 'Hello'))
    const slowStrategy: BidStrategy = {
      name: 'slow',
      async generateBids(_task, providers) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        return providers.map((providerId) => ({
          providerId,
          estimatedCostCents: 1,
          confidence: 0.5,
        }))
      },
    }

    const registry = buildRegistry([adapter])
    const orchestrator = buildOrchestrator(registry, { bidStrategy: slowStrategy })
    const controller = new AbortController()

    setTimeout(() => {
      controller.abort()
    }, 10)

    const result = await orchestrator.execute(makeTask(['general']), makeInput(), {
      signal: controller.signal,
    })

    expect(result.cancelled).toBe(true)
    expect(result.success).toBe(false)
    expect(result.winningBid).toBeNull()
    expect(result.allBids).toEqual([])
    expect(result.error).toBe('Bid collection aborted')
  })

  it('returns an explicit cancelled result when aborted during adapter execution', async () => {
    const adapter: AgentCLIAdapter = {
      providerId: 'claude',
      async *execute(input: AgentInput) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        if (input.signal?.aborted) {
          return
        }
        yield {
          type: 'adapter:completed' as const,
          providerId: 'claude',
          sessionId: 'sess-1',
          result: 'late result',
          durationMs: 50,
          timestamp: Date.now(),
        }
      },
      async *resumeSession() { /* noop */ },
      interrupt() {},
      async healthCheck() {
        return { healthy: true, providerId: 'claude', sdkInstalled: true, cliAvailable: true }
      },
      configure() {},
    }
    const registry = buildRegistry([adapter])
    const orchestrator = buildOrchestrator(registry)
    const controller = new AbortController()

    setTimeout(() => {
      controller.abort()
    }, 10)

    const result = await orchestrator.execute(makeTask(['general']), makeInput(), {
      signal: controller.signal,
    })

    expect(result.cancelled).toBe(true)
    expect(result.success).toBe(false)
    expect(result.winningBid?.providerId).toBe('claude')
    expect(result.error).toContain('aborted')
  })

  it('prefers cancellation when abort is observed after adapter completion but before final return', async () => {
    const controller = new AbortController()

    let releaseFinalReturn: (() => void) | undefined
    let completedBoundaryReached: (() => void) | undefined
    const completedBoundary = new Promise<void>((resolve) => {
      completedBoundaryReached = resolve
    })
    const finalReturnGate = new Promise<void>((resolve) => {
      releaseFinalReturn = resolve
    })

    const adapter: AgentCLIAdapter = {
      providerId: 'claude',
      async *execute() {
        yield {
          type: 'adapter:completed' as const,
          providerId: 'claude',
          sessionId: 'sess-1',
          result: 'boundary result',
          durationMs: 1,
          timestamp: Date.now(),
        }

        completedBoundaryReached?.()
        await finalReturnGate
      },
      async *resumeSession() { /* noop */ },
      interrupt() {},
      async healthCheck() {
        return { healthy: true, providerId: 'claude', sdkInstalled: true, cliAvailable: true }
      },
      configure() {},
    }

    const registry = buildRegistry([adapter])
    const orchestrator = buildOrchestrator(registry)

    const execution = orchestrator.execute(makeTask(['general']), makeInput(), {
      signal: controller.signal,
    })

    await completedBoundary
    controller.abort()
    releaseFinalReturn?.()

    const result = await execution

    expect(result.cancelled).toBe(true)
    expect(result.success).toBe(false)
    expect(result.winningBid?.providerId).toBe('claude')
    expect(result.executionResult).toBe('')
    expect(result.error).toBe('Contract-Net execution was aborted')
  })

  it('uses custom bid selection criteria with customScorer', async () => {
    const claudeAdapter = createMockAdapter('claude', completedEvents('claude', 'Claude result'))
    const crushAdapter = createMockAdapter('crush', completedEvents('crush', 'Crush result'))
    const registry = buildRegistry([claudeAdapter, crushAdapter])
    const orchestrator = buildOrchestrator(registry)

    // Custom scorer that always prefers the cheapest (crush)
    const result = await orchestrator.execute(
      makeTask(['general']),
      makeInput(),
      {
        selectionCriteria: {
          customScorer: (bid: Bid) => 1 / (bid.estimatedCostCents + 1),
        },
      },
    )

    expect(result.success).toBe(true)
    // Crush is cheapest (cost=1), so custom scorer should pick it
    expect(result.winningBid.providerId).toBe('crush')
  })

  it('emits protocol events', async () => {
    const adapter = createMockAdapter('claude', completedEvents('claude', 'done'))
    const registry = buildRegistry([adapter])
    const orchestrator = buildOrchestrator(registry)

    await orchestrator.execute(makeTask(['general']), makeInput())

    const eventTypes = emitted.map((e) => e.type)
    // CFP broadcast
    expect(eventTypes).toContain('protocol:message_sent')
    // Bid received
    expect(eventTypes).toContain('protocol:message_received')
  })

  it('uses custom bid strategy', async () => {
    const adapter = createMockAdapter('claude', completedEvents('claude', 'done'))
    const registry = buildRegistry([adapter])

    const customStrategy: BidStrategy = {
      name: 'custom',
      async generateBids(_task, providers) {
        return providers.map((p) => ({
          providerId: p,
          estimatedCostCents: 1,
          confidence: 0.99,
          approach: 'custom approach',
        }))
      },
    }

    const orchestrator = buildOrchestrator(registry, { bidStrategy: customStrategy })
    const result = await orchestrator.execute(makeTask(['general']), makeInput())

    expect(result.success).toBe(true)
    expect(result.allBids[0]!.confidence).toBe(0.99)
    expect(result.allBids[0]!.approach).toBe('custom approach')
  })

  it('handles adapter:failed events gracefully', async () => {
    const adapter = createMockAdapter('claude', failedEvents('claude', 'soft failure'))
    const registry = buildRegistry([adapter])
    const orchestrator = buildOrchestrator(registry)

    const result = await orchestrator.execute(makeTask(['general']), makeInput())

    // The adapter emitted a failed event but did not throw, so the iterator
    // completes without success
    expect(result.success).toBe(false)
  })
})
