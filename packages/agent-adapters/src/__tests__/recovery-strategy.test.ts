import { describe, expect, it } from 'vitest'
import type { AdapterProviderId } from '../types.js'
import type { FailureContext, RecoveryStrategy } from '../recovery/adapter-recovery.js'
import { selectRecoveryStrategy } from '../recovery/recovery-strategy.js'

const DEFAULT_ORDER: RecoveryStrategy[] = [
  'retry-different-provider',
  'retry-same-provider',
  'increase-budget',
  'escalate-human',
  'abort',
]

function makeFailure(overrides: Partial<FailureContext> = {}): FailureContext {
  return {
    input: { prompt: 'test' },
    failedProvider: 'claude' as AdapterProviderId,
    error: 'boom',
    attemptNumber: 1,
    exhaustedProviders: [],
    durationMs: 0,
    ...overrides,
  }
}

describe('selectRecoveryStrategy', () => {
  it('returns the custom selector result when provided, ignoring everything else', () => {
    const result = selectRecoveryStrategy({
      failure: makeFailure({ attemptNumber: 5, exhaustedProviders: [] }),
      strategyOrder: DEFAULT_ORDER,
      availableProviders: ['claude' as AdapterProviderId],
      strategySelector: () => 'simplify-task',
    })
    expect(result).toBe('simplify-task')
  })

  it('starts walking the order at attemptNumber - 1 (1-based to 0-based)', () => {
    // attempt 1 -> index 0 -> retry-different-provider (with available providers)
    expect(
      selectRecoveryStrategy({
        failure: makeFailure({ attemptNumber: 1 }),
        strategyOrder: DEFAULT_ORDER,
        availableProviders: ['claude' as AdapterProviderId, 'openai' as AdapterProviderId],
      }),
    ).toBe('retry-different-provider')

    // attempt 2 -> index 1 -> retry-same-provider
    expect(
      selectRecoveryStrategy({
        failure: makeFailure({ attemptNumber: 2 }),
        strategyOrder: DEFAULT_ORDER,
        availableProviders: ['claude' as AdapterProviderId],
      }),
    ).toBe('retry-same-provider')

    // attempt 3 -> index 2 -> increase-budget
    expect(
      selectRecoveryStrategy({
        failure: makeFailure({ attemptNumber: 3 }),
        strategyOrder: DEFAULT_ORDER,
        availableProviders: ['claude' as AdapterProviderId],
      }),
    ).toBe('increase-budget')
  })

  it('skips retry-different-provider only when every available provider is exhausted', () => {
    // All providers exhausted -> skip retry-different, fall through to retry-same.
    const exhausted = ['claude', 'openai'] as AdapterProviderId[]
    const result = selectRecoveryStrategy({
      failure: makeFailure({ attemptNumber: 1, exhaustedProviders: exhausted }),
      strategyOrder: DEFAULT_ORDER,
      availableProviders: ['claude' as AdapterProviderId, 'openai' as AdapterProviderId],
    })
    expect(result).toBe('retry-same-provider')
  })

  it('does NOT skip retry-different-provider when at least one fresh provider remains', () => {
    const result = selectRecoveryStrategy({
      failure: makeFailure({
        attemptNumber: 1,
        exhaustedProviders: ['claude'] as AdapterProviderId[],
      }),
      strategyOrder: DEFAULT_ORDER,
      availableProviders: ['claude' as AdapterProviderId, 'openai' as AdapterProviderId],
    })
    expect(result).toBe('retry-different-provider')
  })

  it('falls back to abort when the walk runs off the end of the order', () => {
    const order: RecoveryStrategy[] = ['retry-same-provider']
    const result = selectRecoveryStrategy({
      failure: makeFailure({ attemptNumber: 5 }), // index 4 — past the end
      strategyOrder: order,
      availableProviders: ['claude' as AdapterProviderId],
    })
    expect(result).toBe('abort')
  })

  it('falls back to abort when every entry from attemptIndex onward is skipped', () => {
    // Only retry-different-provider remains, and all providers are exhausted.
    const order: RecoveryStrategy[] = ['retry-same-provider', 'retry-different-provider']
    const result = selectRecoveryStrategy({
      failure: makeFailure({
        attemptNumber: 2, // index 1 -> retry-different-provider
        exhaustedProviders: ['claude'] as AdapterProviderId[],
      }),
      strategyOrder: order,
      availableProviders: ['claude' as AdapterProviderId],
    })
    expect(result).toBe('abort')
  })

  it('skips undefined slots in the strategy order without consuming attempts', () => {
    // Sparse arrays can leak undefined when constructed by index assignment.
    const order = [] as RecoveryStrategy[]
    order[0] = 'retry-different-provider'
    // index 1 is intentionally a hole -> undefined
    order[2] = 'increase-budget'
    const result = selectRecoveryStrategy({
      failure: makeFailure({ attemptNumber: 2 }), // start at index 1 (hole)
      strategyOrder: order,
      availableProviders: ['claude' as AdapterProviderId],
    })
    expect(result).toBe('increase-budget')
  })

  it('returns abort directly when abort sits at the chosen index', () => {
    const result = selectRecoveryStrategy({
      failure: makeFailure({ attemptNumber: 5 }),
      strategyOrder: DEFAULT_ORDER,
      availableProviders: ['claude' as AdapterProviderId],
    })
    expect(result).toBe('abort')
  })
})
