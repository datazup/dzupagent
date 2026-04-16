import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AgentCircuitBreaker } from '../circuit-breaker.js'

describe('AgentCircuitBreaker', () => {
  let breaker: AgentCircuitBreaker

  beforeEach(() => {
    breaker = new AgentCircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 })
  })

  it('starts available for unknown agents', () => {
    expect(breaker.isAvailable('agent-a')).toBe(true)
    expect(breaker.getState('agent-a')).toBe('closed')
  })

  it('trips after consecutive timeouts reaching threshold', () => {
    breaker.recordTimeout('agent-a')
    expect(breaker.isAvailable('agent-a')).toBe(true)

    breaker.recordTimeout('agent-a')
    expect(breaker.isAvailable('agent-a')).toBe(true)

    breaker.recordTimeout('agent-a')
    // Now at threshold (3), circuit should be open
    expect(breaker.isAvailable('agent-a')).toBe(false)
    expect(breaker.getState('agent-a')).toBe('open')
  })

  it('recordSuccess after open resets to closed', () => {
    // Trip the circuit
    breaker.recordTimeout('agent-a')
    breaker.recordTimeout('agent-a')
    breaker.recordTimeout('agent-a')
    expect(breaker.isAvailable('agent-a')).toBe(false)

    // Record success resets
    breaker.recordSuccess('agent-a')
    expect(breaker.isAvailable('agent-a')).toBe(true)
    expect(breaker.getState('agent-a')).toBe('closed')
  })

  it('filterAvailable removes tripped agents', () => {
    const agents = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

    // Trip agent 'b'
    breaker.recordTimeout('b')
    breaker.recordTimeout('b')
    breaker.recordTimeout('b')

    const available = breaker.filterAvailable(agents)
    expect(available.map((a) => a.id)).toEqual(['a', 'c'])
  })

  it('transitions to half-open after cooldown period', () => {
    // Trip the breaker
    breaker.recordTimeout('agent-a')
    breaker.recordTimeout('agent-a')
    breaker.recordTimeout('agent-a')
    expect(breaker.isAvailable('agent-a')).toBe(false)

    // Fast-forward past cooldown
    vi.useFakeTimers()
    try {
      vi.advanceTimersByTime(1001)
      // Should transition to half-open and allow through
      expect(breaker.isAvailable('agent-a')).toBe(true)
      expect(breaker.getState('agent-a')).toBe('half-open')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reset() clears all state', () => {
    breaker.recordTimeout('agent-a')
    breaker.recordTimeout('agent-a')
    breaker.recordTimeout('agent-a')
    expect(breaker.isAvailable('agent-a')).toBe(false)

    breaker.reset()
    expect(breaker.isAvailable('agent-a')).toBe(true)
    expect(breaker.getState('agent-a')).toBe('closed')
  })

  it('does not trip if successes intervene', () => {
    breaker.recordTimeout('agent-a')
    breaker.recordTimeout('agent-a')
    breaker.recordSuccess('agent-a') // resets consecutive count
    breaker.recordTimeout('agent-a')
    breaker.recordTimeout('agent-a')
    // Only 2 consecutive timeouts, not 3
    expect(breaker.isAvailable('agent-a')).toBe(true)
    expect(breaker.getState('agent-a')).toBe('closed')
  })
})
