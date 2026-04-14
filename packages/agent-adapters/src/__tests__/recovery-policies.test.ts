import { describe, it, expect } from 'vitest'
import { RecoveryPolicySelector, RECOVERY_POLICIES } from '../recovery/recovery-policies.js'

describe('RecoveryPolicySelector', () => {
  it('selects research policy for research tags', () => {
    const selector = new RecoveryPolicySelector()
    const policy = selector.select({ taskTags: ['research'], attemptNumber: 1 })
    expect(policy.name).toBe('research')
  })

  it('selects codegen policy for code tags', () => {
    const selector = new RecoveryPolicySelector()
    const policy = selector.select({ taskTags: ['code'], attemptNumber: 1 })
    expect(policy.name).toBe('codegen')
  })

  it('falls back to default policy', () => {
    const selector = new RecoveryPolicySelector()
    const policy = selector.select({ taskTags: ['other'], attemptNumber: 1 })
    expect(policy.name).toBe('default')
  })

  it('getNextStrategy returns first non-skipped strategy', () => {
    const selector = new RecoveryPolicySelector()
    const policy = RECOVERY_POLICIES.default
    const ctx = { attemptNumber: 1 }
    const strategy = selector.getNextStrategy(policy, ctx, 0)
    expect(strategy).toBe('retry-different-provider')
  })

  it('getNextStrategy skips when skipIf returns true', () => {
    const policy = {
      name: 'test',
      strategies: [
        { strategy: 'retry-same-provider' as const, skipIf: () => true },
        { strategy: 'retry-different-provider' as const },
      ],
    }
    const selector = new RecoveryPolicySelector()
    const strategy = selector.getNextStrategy(policy, { attemptNumber: 1 }, 0)
    expect(strategy).toBe('retry-different-provider')
  })

  it('getNextStrategy returns undefined when all exhausted', () => {
    const selector = new RecoveryPolicySelector()
    const policy = RECOVERY_POLICIES.default
    const strategy = selector.getNextStrategy(policy, { attemptNumber: 1 }, 999)
    expect(strategy).toBeUndefined()
  })

  it('custom policies can be provided', () => {
    const custom = {
      name: 'custom',
      strategies: [{ strategy: 'abort' as const }],
      appliesTo: () => true,
    }
    const selector = new RecoveryPolicySelector([custom])
    const policy = selector.select({ attemptNumber: 1 })
    expect(policy.name).toBe('custom')
  })
})
