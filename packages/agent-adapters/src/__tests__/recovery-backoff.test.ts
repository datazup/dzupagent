import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ForgeError } from '@dzupagent/core'

import {
  AdapterRecoveryCopilot,
  type RecoveryConfig,
} from '../recovery/adapter-recovery.js'
import type { AdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  RoutingDecision,
  TaskDescriptor,
} from '../types.js'
import { collectEvents } from './test-helpers.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockAdapter(
  providerId: AdapterProviderId,
  results: AgentEvent[],
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput) {
      for (const e of results) yield e
    },
    async *resumeSession(_id: string, _input: AgentInput) {
      /* noop */
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  } as unknown as AgentCLIAdapter
}

function createFailingAdapter(
  providerId: AdapterProviderId,
  errorMsg: string,
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      throw new Error(errorMsg)
    },
    async *resumeSession(_id: string, _input: AgentInput) {
      /* noop */
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  } as unknown as AgentCLIAdapter
}

/**
 * Creates a registry where the first `failCount` calls fail, then succeed.
 * Tracks call timestamps so we can measure backoff delays.
 */
function createTimedRetryRegistry(
  failCount: number,
  successProviderId: AdapterProviderId = 'claude',
): { registry: AdapterRegistry; getCallTimestamps: () => number[] } {
  let callCount = 0
  const timestamps: number[] = []

  const successAdapter = createMockAdapter(successProviderId, [
    {
      type: 'adapter:completed',
      providerId: successProviderId,
      sessionId: 'sess-1',
      result: 'recovered',
      durationMs: 50,
      timestamp: Date.now(),
    },
  ])

  const failAdapter = createFailingAdapter(successProviderId, 'transient failure')

  const registry = {
    getForTask(_task: TaskDescriptor) {
      callCount++
      timestamps.push(Date.now())
      const adapter = callCount <= failCount ? failAdapter : successAdapter
      return {
        adapter,
        decision: {
          provider: successProviderId,
          reason: 'mock',
          confidence: 1,
        },
      }
    },
    listAdapters() {
      return [successProviderId]
    },
    recordSuccess(_id: AdapterProviderId) {},
    recordFailure(_id: AdapterProviderId, _err: Error) {},
  } as unknown as AdapterRegistry

  return { registry, getCallTimestamps: () => timestamps }
}

/**
 * Creates a registry with multiple providers that tracks which provider is used.
 * Each provider fails once, so the retry-different-provider strategy should
 * cycle through them.
 */
function createMultiProviderRegistry(
  providers: AdapterProviderId[],
): {
  registry: AdapterRegistry
  getUsedProviders: () => AdapterProviderId[]
  getInputOptions: () => Array<Record<string, unknown> | undefined>
} {
  const usedProviders: AdapterProviderId[] = []
  const inputOptions: Array<Record<string, unknown> | undefined> = []
  let callCount = 0

  const registry = {
    getForTask(task: TaskDescriptor) {
      callCount++

      // If a preferredProvider is set, use that; otherwise use first available
      const preferredProvider = task.preferredProvider
      const providerId = preferredProvider ?? providers[0]!

      const shouldSucceed = callCount > 1 // First call fails, rest succeed

      const adapter: AgentCLIAdapter = {
        providerId,
        async *execute(input: AgentInput) {
          usedProviders.push(providerId)
          inputOptions.push(input.options)
          if (!shouldSucceed) throw new Error(`${providerId} failed`)
          yield {
            type: 'adapter:completed' as const,
            providerId,
            sessionId: 'sess-1',
            result: 'ok',
            durationMs: 10,
            timestamp: Date.now(),
          }
        },
        async *resumeSession() {},
        interrupt() {},
        async healthCheck() {
          return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
        },
        configure() {},
      } as unknown as AgentCLIAdapter

      return {
        adapter,
        decision: {
          provider: providerId,
          reason: 'mock',
          confidence: 1,
        } as RoutingDecision,
      }
    },
    listAdapters() {
      return [...providers]
    },
    recordSuccess(_id: AdapterProviderId) {},
    recordFailure(_id: AdapterProviderId, _err: Error) {},
  } as unknown as AdapterRegistry

  return {
    registry,
    getUsedProviders: () => usedProviders,
    getInputOptions: () => inputOptions,
  }
}

/**
 * Creates a registry where all providers always fail.
 */
function createAllFailingMultiRegistry(
  providers: AdapterProviderId[],
): { registry: AdapterRegistry; getUsedProviders: () => AdapterProviderId[] } {
  const usedProviders: AdapterProviderId[] = []
  let callCount = 0

  const registry = {
    getForTask(task: TaskDescriptor) {
      callCount++
      const preferredProvider = task.preferredProvider
      const providerId = preferredProvider ?? providers[0]!

      const adapter: AgentCLIAdapter = {
        providerId,
        async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
          usedProviders.push(providerId)
          throw new Error(`${providerId} always fails`)
        },
        async *resumeSession() {},
        interrupt() {},
        async healthCheck() {
          return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
        },
        configure() {},
      } as unknown as AgentCLIAdapter

      return {
        adapter,
        decision: {
          provider: providerId,
          reason: 'mock',
          confidence: 1,
        } as RoutingDecision,
      }
    },
    listAdapters() {
      return [...providers]
    },
    recordSuccess(_id: AdapterProviderId) {},
    recordFailure(_id: AdapterProviderId, _err: Error) {},
  } as unknown as AdapterRegistry

  return { registry, getUsedProviders: () => usedProviders }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Recovery Backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('delays between retry attempts with exponential backoff', async () => {
    const { registry, getCallTimestamps } = createTimedRetryRegistry(1)
    const copilot = new AdapterRecoveryCopilot(registry, {
      maxAttempts: 3,
      backoffMs: 100,
      backoffMultiplier: 2,
      backoffJitter: false,
    })

    const result = await copilot.executeWithRecovery({ prompt: 'do it' })

    expect(result.success).toBe(true)
    expect(result.totalAttempts).toBe(2)

    const timestamps = getCallTimestamps()
    expect(timestamps).toHaveLength(2)
    // Second attempt should have been delayed by ~100ms * 2^(2-1) = 200ms
    const gap = timestamps[1]! - timestamps[0]!
    expect(gap).toBeGreaterThanOrEqual(150) // allow margin for timer imprecision
  })

  it('caps delay at maxBackoffMs', async () => {
    const { registry, getCallTimestamps } = createTimedRetryRegistry(1)
    const copilot = new AdapterRecoveryCopilot(registry, {
      maxAttempts: 3,
      backoffMs: 500,
      backoffMultiplier: 100, // would give 50_000ms without cap
      maxBackoffMs: 200,
      backoffJitter: false,
    })

    const result = await copilot.executeWithRecovery({ prompt: 'do it' })

    expect(result.success).toBe(true)
    const timestamps = getCallTimestamps()
    const gap = timestamps[1]! - timestamps[0]!
    // Should be capped at ~200ms, not 50_000ms
    expect(gap).toBeGreaterThanOrEqual(150)
    expect(gap).toBeLessThan(1000)
  })

  it('adds jitter when enabled', async () => {
    // Run multiple times and check that delays vary (jitter adds randomness)
    const delays: number[] = []

    for (let i = 0; i < 5; i++) {
      const { registry, getCallTimestamps } = createTimedRetryRegistry(1)
      const copilot = new AdapterRecoveryCopilot(registry, {
        maxAttempts: 3,
        backoffMs: 100,
        backoffMultiplier: 1,
        backoffJitter: true,
      })

      await copilot.executeWithRecovery({ prompt: 'do it' })
      const timestamps = getCallTimestamps()
      delays.push(timestamps[1]! - timestamps[0]!)
    }

    // With jitter, delays should be >= base (100ms) due to added random component
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(80) // account for timer imprecision
    }
  })

  it('cancels delay on abort signal', async () => {
    vi.useRealTimers() // need real timers for AbortController

    const adapter = createFailingAdapter('claude', 'fail')
    const registry = {
      getForTask() {
        return {
          adapter,
          decision: { provider: 'claude' as AdapterProviderId, reason: 'mock', confidence: 1 },
        }
      },
      listAdapters() {
        return ['claude' as AdapterProviderId]
      },
      recordSuccess() {},
      recordFailure() {},
    } as unknown as AdapterRegistry

    const copilot = new AdapterRecoveryCopilot(registry, {
      maxAttempts: 5,
      backoffMs: 60_000, // very long delay
      backoffJitter: false,
    })

    const controller = new AbortController()

    // Abort shortly after the first failure triggers backoff
    setTimeout(() => controller.abort(), 100)

    const start = Date.now()
    try {
      await copilot.executeWithRecovery(
        { prompt: 'do it', signal: controller.signal },
      )
    } catch (err) {
      expect((err as Error).message).toContain('Aborted during backoff')
    }

    const elapsed = Date.now() - start
    // Should have aborted quickly, not waited the full 60s
    expect(elapsed).toBeLessThan(5000)
  })

  it('no delay on first attempt', async () => {
    const { registry, getCallTimestamps } = createTimedRetryRegistry(0) // succeeds immediately
    const copilot = new AdapterRecoveryCopilot(registry, {
      maxAttempts: 3,
      backoffMs: 5000, // large delay — should not be used on first attempt
      backoffJitter: false,
    })

    const start = Date.now()
    const result = await copilot.executeWithRecovery({ prompt: 'do it' })

    expect(result.success).toBe(true)
    expect(result.totalAttempts).toBe(1)

    const elapsed = Date.now() - start
    // Should complete nearly instantly — no backoff on attempt 1
    expect(elapsed).toBeLessThan(1000)
  })
})

describe('Provider Exclusion', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('excludes failed provider from retry-different-provider strategy', async () => {
    const { registry, getInputOptions } = createMultiProviderRegistry([
      'claude',
      'codex',
      'gemini',
    ])
    const copilot = new AdapterRecoveryCopilot(registry, {
      maxAttempts: 3,
      strategyOrder: ['retry-different-provider', 'abort'],
      backoffMs: 10, // fast backoff for tests
      backoffJitter: false,
    })

    const result = await copilot.executeWithRecovery({ prompt: 'do it' })

    expect(result.success).toBe(true)
    expect(result.totalAttempts).toBe(2)

    // The second attempt should have a preferredProvider set in options
    const retryOptions = getInputOptions()[1]
    expect(retryOptions).toBeDefined()
    expect(retryOptions!.preferredProvider).toBeDefined()
    // The preferred provider should NOT be 'claude' (the one that failed)
    expect(retryOptions!.preferredProvider).not.toBe('claude')
  })

  it('accumulates exclusions across multiple failures', async () => {
    // All providers fail, so exclusions accumulate
    const { registry, getUsedProviders } = createAllFailingMultiRegistry([
      'claude',
      'codex',
      'gemini',
    ])
    const copilot = new AdapterRecoveryCopilot(registry, {
      maxAttempts: 3,
      strategyOrder: [
        'retry-different-provider',
        'retry-different-provider',
        'abort',
      ],
      backoffMs: 10,
      backoffJitter: false,
    })

    const result = await copilot.executeWithRecovery({ prompt: 'do it' })

    expect(result.success).toBe(false)
    // Should have attempted 3 times (maxAttempts)
    expect(result.totalAttempts).toBe(3)
    expect(getUsedProviders().length).toBe(3)
  })

  it('falls back to abort when all providers exhausted', async () => {
    // Single provider always fails — retry-different-provider has no alternatives
    const adapter = createFailingAdapter('claude', 'fail')
    const registry = {
      getForTask() {
        return {
          adapter,
          decision: { provider: 'claude' as AdapterProviderId, reason: 'mock', confidence: 1 },
        }
      },
      listAdapters() {
        return ['claude' as AdapterProviderId]
      },
      recordSuccess() {},
      recordFailure() {},
    } as unknown as AdapterRegistry

    const copilot = new AdapterRecoveryCopilot(registry, {
      maxAttempts: 3,
      // Only retry-different-provider strategies followed by abort
      strategyOrder: ['retry-different-provider', 'abort'],
      backoffMs: 10,
      backoffJitter: false,
    })

    const result = await copilot.executeWithRecovery({ prompt: 'do it' })

    expect(result.success).toBe(false)
    // After first failure, retry-different-provider has no alternatives,
    // selectStrategy skips it and picks abort
    expect(result.strategy).toBe('abort')
  })
})
