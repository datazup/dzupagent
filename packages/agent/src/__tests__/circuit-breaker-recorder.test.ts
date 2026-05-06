import { describe, it, expect, vi } from 'vitest'
import {
  CIRCUIT_BREAKER_RECORDED,
  hasCircuitBreakerRecorded,
  isTimeoutError,
  markCircuitBreakerRecorded,
  recordCircuitBreakerFailure,
} from '../orchestration/circuit-breaker-recorder.js'
import type { AgentCircuitBreaker } from '../orchestration/circuit-breaker.js'

function createBreakerSpy(): AgentCircuitBreaker & {
  recordSuccess: ReturnType<typeof vi.fn>
  recordFailure: ReturnType<typeof vi.fn>
  recordTimeout: ReturnType<typeof vi.fn>
} {
  return {
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    recordTimeout: vi.fn(),
    filterAvailable: vi.fn((agents) => agents),
    getState: vi.fn(() => 'closed'),
  } as unknown as AgentCircuitBreaker & {
    recordSuccess: ReturnType<typeof vi.fn>
    recordFailure: ReturnType<typeof vi.fn>
    recordTimeout: ReturnType<typeof vi.fn>
  }
}

describe('isTimeoutError', () => {
  it('returns true for messages mentioning timeout (case-insensitive)', () => {
    expect(isTimeoutError('Request TIMEOUT after 30s')).toBe(true)
    expect(isTimeoutError('operation timeout')).toBe(true)
  })

  it('returns false for non-timeout messages and undefined', () => {
    expect(isTimeoutError(undefined)).toBe(false)
    expect(isTimeoutError('connection refused')).toBe(false)
    expect(isTimeoutError('')).toBe(false)
  })
})

describe('markCircuitBreakerRecorded / hasCircuitBreakerRecorded', () => {
  it('tags an Error object with the recorded marker', () => {
    const err = new Error('boom')
    expect(hasCircuitBreakerRecorded(err)).toBe(false)
    markCircuitBreakerRecorded(err)
    expect(hasCircuitBreakerRecorded(err)).toBe(true)
    expect((err as { [CIRCUIT_BREAKER_RECORDED]?: boolean })[CIRCUIT_BREAKER_RECORDED]).toBe(true)
  })

  it('is a no-op for primitive throw values without crashing', () => {
    // Strings cannot carry a marker; helper must not throw and must report false
    expect(() => markCircuitBreakerRecorded('string-error')).not.toThrow()
    expect(hasCircuitBreakerRecorded('string-error')).toBe(false)
    expect(hasCircuitBreakerRecorded(undefined)).toBe(false)
    expect(hasCircuitBreakerRecorded(null)).toBe(false)
  })

  it('silently handles non-extensible objects', () => {
    const frozen = Object.freeze({ kind: 'frozen' })
    expect(() => markCircuitBreakerRecorded(frozen)).not.toThrow()
    // Non-extensible objects can't be tagged, so the marker stays false
    expect(hasCircuitBreakerRecorded(frozen)).toBe(false)
  })
})

describe('recordCircuitBreakerFailure', () => {
  it('returns false and is a no-op when no breaker is supplied', () => {
    expect(recordCircuitBreakerFailure(undefined, 'specialist-a', new Error('boom'))).toBe(false)
  })

  it('routes timeout-shaped errors to recordTimeout', () => {
    const breaker = createBreakerSpy()
    const result = recordCircuitBreakerFailure(breaker, 'spec-1', new Error('Timeout exceeded'))
    expect(result).toBe(true)
    expect(breaker.recordTimeout).toHaveBeenCalledWith('spec-1')
    expect(breaker.recordFailure).not.toHaveBeenCalled()
  })

  it('routes non-timeout errors to recordFailure', () => {
    const breaker = createBreakerSpy()
    recordCircuitBreakerFailure(breaker, 'spec-2', new Error('connection refused'))
    expect(breaker.recordFailure).toHaveBeenCalledWith('spec-2')
    expect(breaker.recordTimeout).not.toHaveBeenCalled()
  })

  it('coerces non-Error throw values to strings before classifying', () => {
    const breaker = createBreakerSpy()
    recordCircuitBreakerFailure(breaker, 'spec-3', 'agent timeout reached')
    expect(breaker.recordTimeout).toHaveBeenCalledWith('spec-3')
  })
})
