import { describe, it, expect, beforeEach } from 'vitest'
import { StuckDetector } from '../guardrails/stuck-detector.js'

describe('StuckDetector', () => {
  let detector: StuckDetector

  beforeEach(() => {
    detector = new StuckDetector({
      maxRepeatCalls: 3,
      maxErrorsInWindow: 3,
      errorWindowMs: 5000,
      maxIdleIterations: 2,
    })
  })

  it('does not flag normal varied tool calls', () => {
    expect(detector.recordToolCall('read_file', { path: 'a.ts' }).stuck).toBe(false)
    expect(detector.recordToolCall('write_file', { path: 'b.ts' }).stuck).toBe(false)
    expect(detector.recordToolCall('read_file', { path: 'c.ts' }).stuck).toBe(false)
  })

  it('flags repeated identical tool calls', () => {
    const input = { path: 'same.ts' }
    expect(detector.recordToolCall('read_file', input).stuck).toBe(false)
    expect(detector.recordToolCall('read_file', input).stuck).toBe(false)
    const result = detector.recordToolCall('read_file', input)
    expect(result.stuck).toBe(true)
    expect(result.reason).toContain('read_file')
    expect(result.reason).toContain('3 times')
  })

  it('does not flag repeated calls with different inputs', () => {
    expect(detector.recordToolCall('read_file', { path: 'a.ts' }).stuck).toBe(false)
    expect(detector.recordToolCall('read_file', { path: 'b.ts' }).stuck).toBe(false)
    expect(detector.recordToolCall('read_file', { path: 'c.ts' }).stuck).toBe(false)
  })

  it('flags high error rate', () => {
    expect(detector.recordError(new Error('err 1')).stuck).toBe(false)
    expect(detector.recordError(new Error('err 2')).stuck).toBe(false)
    const result = detector.recordError(new Error('err 3'))
    expect(result.stuck).toBe(true)
    expect(result.reason).toContain('3 errors')
  })

  it('flags idle iterations (no tool calls)', () => {
    expect(detector.recordIteration(0).stuck).toBe(false)
    const result = detector.recordIteration(0)
    expect(result.stuck).toBe(true)
    expect(result.reason).toContain('no tool calls')
  })

  it('resets idle count when tool calls happen', () => {
    detector.recordIteration(0) // idle
    detector.recordToolCall('test', {}) // progress
    expect(detector.recordIteration(1).stuck).toBe(false) // not idle
  })

  it('reset() clears all state', () => {
    detector.recordToolCall('read_file', { x: 1 })
    detector.recordToolCall('read_file', { x: 1 })
    detector.reset()
    // After reset, need 3 more to trigger
    expect(detector.recordToolCall('read_file', { x: 1 }).stuck).toBe(false)
  })
})
