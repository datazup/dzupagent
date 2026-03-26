import { describe, it, expect, vi, afterEach } from 'vitest'
import { ModelTierEscalationPolicy } from '../router/escalation-policy.js'

describe('ModelTierEscalationPolicy', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not escalate when scores are above threshold', () => {
    const policy = new ModelTierEscalationPolicy()
    const result = policy.recordScore('agent-1', 0.8, 'chat')
    expect(result.shouldEscalate).toBe(false)
    expect(result.consecutiveLowScores).toBe(0)
    expect(result.reason).toBe('score above threshold')
  })

  it('triggers escalation after 3 consecutive low scores (chat -> codegen)', () => {
    const policy = new ModelTierEscalationPolicy()
    policy.recordScore('agent-1', 0.3, 'chat')
    policy.recordScore('agent-1', 0.4, 'chat')
    const result = policy.recordScore('agent-1', 0.2, 'chat')

    expect(result.shouldEscalate).toBe(true)
    expect(result.fromTier).toBe('chat')
    expect(result.toTier).toBe('codegen')
    expect(result.consecutiveLowScores).toBe(3)
  })

  it('resets consecutive count when a high score arrives', () => {
    const policy = new ModelTierEscalationPolicy()
    policy.recordScore('agent-1', 0.3, 'chat')
    policy.recordScore('agent-1', 0.4, 'chat')

    // Good score resets
    const reset = policy.recordScore('agent-1', 0.7, 'chat')
    expect(reset.consecutiveLowScores).toBe(0)

    // Need 3 more low scores to trigger
    policy.recordScore('agent-1', 0.3, 'chat')
    const result = policy.recordScore('agent-1', 0.2, 'chat')
    expect(result.shouldEscalate).toBe(false)
    expect(result.consecutiveLowScores).toBe(2)
  })

  it('does not trigger with mixed scores', () => {
    const policy = new ModelTierEscalationPolicy()
    policy.recordScore('agent-1', 0.3, 'chat')
    policy.recordScore('agent-1', 0.6, 'chat') // resets
    policy.recordScore('agent-1', 0.4, 'chat')
    const result = policy.recordScore('agent-1', 0.2, 'chat')

    expect(result.shouldEscalate).toBe(false)
    expect(result.consecutiveLowScores).toBe(2)
  })

  it('returns shouldEscalate=false when already at highest tier (reasoning)', () => {
    const policy = new ModelTierEscalationPolicy()
    policy.recordScore('agent-1', 0.1, 'reasoning')
    policy.recordScore('agent-1', 0.2, 'reasoning')
    const result = policy.recordScore('agent-1', 0.1, 'reasoning')

    expect(result.shouldEscalate).toBe(false)
    expect(result.reason).toBe('already at highest tier')
    expect(result.consecutiveLowScores).toBe(3)
  })

  it('respects cooldown period after escalation', () => {
    vi.useFakeTimers()

    const policy = new ModelTierEscalationPolicy({ cooldownMs: 10_000 })

    // Trigger first escalation
    policy.recordScore('agent-1', 0.1, 'chat')
    policy.recordScore('agent-1', 0.1, 'chat')
    const first = policy.recordScore('agent-1', 0.1, 'chat')
    expect(first.shouldEscalate).toBe(true)

    // Immediately try again (still on chat in the caller's view)
    policy.recordScore('agent-1', 0.1, 'chat')
    policy.recordScore('agent-1', 0.1, 'chat')
    const blocked = policy.recordScore('agent-1', 0.1, 'chat')
    expect(blocked.shouldEscalate).toBe(false)
    expect(blocked.reason).toBe('escalation cooldown active')

    // Advance past cooldown — buffered low scores from blocked phase still count
    vi.advanceTimersByTime(10_001)
    // First score after cooldown: 3 are already buffered, so this triggers immediately
    const allowed = policy.recordScore('agent-1', 0.1, 'chat')
    expect(allowed.shouldEscalate).toBe(true)
  })

  it('uses custom config overrides', () => {
    const policy = new ModelTierEscalationPolicy({
      lowScoreThreshold: 0.7,
      consecutiveCount: 2,
      tierChain: ['chat', 'reasoning'],
    })

    // Score 0.6 is below 0.7 threshold
    policy.recordScore('agent-1', 0.6, 'chat')
    const result = policy.recordScore('agent-1', 0.5, 'chat')

    expect(result.shouldEscalate).toBe(true)
    expect(result.fromTier).toBe('chat')
    expect(result.toTier).toBe('reasoning') // skipped codegen since not in chain
  })

  it('tracks different keys independently', () => {
    const policy = new ModelTierEscalationPolicy()

    policy.recordScore('agent-A', 0.1, 'chat')
    policy.recordScore('agent-A', 0.1, 'chat')
    policy.recordScore('agent-B', 0.1, 'chat')

    expect(policy.getConsecutiveLowCount('agent-A')).toBe(2)
    expect(policy.getConsecutiveLowCount('agent-B')).toBe(1)

    // Escalate A but not B
    const resultA = policy.recordScore('agent-A', 0.1, 'chat')
    expect(resultA.shouldEscalate).toBe(true)

    const resultB = policy.recordScore('agent-B', 0.1, 'chat')
    expect(resultB.shouldEscalate).toBe(false)
    expect(resultB.consecutiveLowScores).toBe(2)
  })

  it('reset() clears tracking for a key', () => {
    const policy = new ModelTierEscalationPolicy()
    policy.recordScore('agent-1', 0.1, 'chat')
    policy.recordScore('agent-1', 0.2, 'chat')
    expect(policy.getConsecutiveLowCount('agent-1')).toBe(2)

    policy.reset('agent-1')
    expect(policy.getConsecutiveLowCount('agent-1')).toBe(0)
  })

  it('getConsecutiveLowCount returns 0 for unknown keys', () => {
    const policy = new ModelTierEscalationPolicy()
    expect(policy.getConsecutiveLowCount('unknown')).toBe(0)
  })

  it('escalates through the full chain: chat -> codegen -> reasoning', () => {
    vi.useFakeTimers()

    const policy = new ModelTierEscalationPolicy({ cooldownMs: 1000 })

    // chat -> codegen
    policy.recordScore('agent-1', 0.1, 'chat')
    policy.recordScore('agent-1', 0.1, 'chat')
    const first = policy.recordScore('agent-1', 0.1, 'chat')
    expect(first.shouldEscalate).toBe(true)
    expect(first.toTier).toBe('codegen')

    // Wait for cooldown then codegen -> reasoning
    vi.advanceTimersByTime(1001)
    policy.recordScore('agent-1', 0.1, 'codegen')
    policy.recordScore('agent-1', 0.1, 'codegen')
    const second = policy.recordScore('agent-1', 0.1, 'codegen')
    expect(second.shouldEscalate).toBe(true)
    expect(second.toTier).toBe('reasoning')

    // reasoning is max — no further escalation
    vi.advanceTimersByTime(1001)
    policy.recordScore('agent-1', 0.1, 'reasoning')
    policy.recordScore('agent-1', 0.1, 'reasoning')
    const third = policy.recordScore('agent-1', 0.1, 'reasoning')
    expect(third.shouldEscalate).toBe(false)
    expect(third.reason).toBe('already at highest tier')
  })

  it('treats score exactly at threshold as passing', () => {
    const policy = new ModelTierEscalationPolicy({ lowScoreThreshold: 0.5 })
    const result = policy.recordScore('agent-1', 0.5, 'chat')
    expect(result.shouldEscalate).toBe(false)
    expect(result.consecutiveLowScores).toBe(0)
    expect(result.reason).toBe('score above threshold')
  })
})
