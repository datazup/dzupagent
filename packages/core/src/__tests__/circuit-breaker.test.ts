import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CircuitBreaker } from '../llm/circuit-breaker.js'

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker

  beforeEach(() => {
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 1000,
      halfOpenMaxAttempts: 1,
    })
  })

  it('starts in closed state', () => {
    expect(breaker.getState()).toBe('closed')
    expect(breaker.canExecute()).toBe(true)
  })

  it('stays closed when failures < threshold', () => {
    breaker.recordFailure()
    breaker.recordFailure()
    expect(breaker.getState()).toBe('closed')
    expect(breaker.canExecute()).toBe(true)
  })

  it('opens after reaching failure threshold', () => {
    breaker.recordFailure()
    breaker.recordFailure()
    breaker.recordFailure()
    expect(breaker.getState()).toBe('open')
    expect(breaker.canExecute()).toBe(false)
  })

  it('resets failure count on success', () => {
    breaker.recordFailure()
    breaker.recordFailure()
    breaker.recordSuccess()
    expect(breaker.getState()).toBe('closed')
    // Now needs 3 more failures to open
    breaker.recordFailure()
    breaker.recordFailure()
    expect(breaker.getState()).toBe('closed')
  })

  it('transitions to half-open after reset timeout', () => {
    vi.useFakeTimers()
    try {
      breaker.recordFailure()
      breaker.recordFailure()
      breaker.recordFailure()
      expect(breaker.getState()).toBe('open')

      vi.advanceTimersByTime(1000)
      expect(breaker.getState()).toBe('half-open')
      expect(breaker.canExecute()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes on success in half-open state', () => {
    vi.useFakeTimers()
    try {
      // Trip the breaker
      breaker.recordFailure()
      breaker.recordFailure()
      breaker.recordFailure()

      // Wait for half-open
      vi.advanceTimersByTime(1000)
      expect(breaker.getState()).toBe('half-open')

      // Success closes it
      breaker.recordSuccess()
      expect(breaker.getState()).toBe('closed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-opens on failure in half-open state', () => {
    vi.useFakeTimers()
    try {
      breaker.recordFailure()
      breaker.recordFailure()
      breaker.recordFailure()
      vi.advanceTimersByTime(1000)
      expect(breaker.getState()).toBe('half-open')

      breaker.recordFailure()
      expect(breaker.getState()).toBe('open')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reset() returns to initial state', () => {
    breaker.recordFailure()
    breaker.recordFailure()
    breaker.recordFailure()
    expect(breaker.getState()).toBe('open')

    breaker.reset()
    expect(breaker.getState()).toBe('closed')
    expect(breaker.canExecute()).toBe(true)
  })

  it('uses default config when none provided', () => {
    const defaultBreaker = new CircuitBreaker()
    // Default threshold is 3
    defaultBreaker.recordFailure()
    defaultBreaker.recordFailure()
    expect(defaultBreaker.getState()).toBe('closed')
    defaultBreaker.recordFailure()
    expect(defaultBreaker.getState()).toBe('open')
  })
})
