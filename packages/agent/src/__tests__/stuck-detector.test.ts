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

// ===========================================================================
// Progress-hash detection
// ===========================================================================

describe('StuckDetector — progress-hash detection', () => {
  // Helper: produce one full window of 5 distinct tool calls.
  // Tool sequence: a, b, c, d, e
  function oneSequence(detector: StuckDetector): void {
    detector.recordToolCall('tool_a', {})
    detector.recordToolCall('tool_b', {})
    detector.recordToolCall('tool_c', {})
    detector.recordToolCall('tool_d', {})
    detector.recordToolCall('tool_e', {})
  }

  it('is not stuck after fewer than 3 identical sequences', () => {
    const det = new StuckDetector()
    // Two full repetitions of [a,b,c,d,e] should NOT trigger stuck
    oneSequence(det)
    const lastOfSecond: ReturnType<typeof det.recordToolCall>[] = []
    det.recordToolCall('tool_a', {})
    det.recordToolCall('tool_b', {})
    det.recordToolCall('tool_c', {})
    det.recordToolCall('tool_d', {})
    lastOfSecond.push(det.recordToolCall('tool_e', {}))
    // Only 2 full identical windows recorded — not stuck yet
    expect(lastOfSecond[0]!.stuck).toBe(false)
  })

  it('detects stuck after exactly 3 identical sequences of 5 tools', () => {
    const det = new StuckDetector()
    oneSequence(det)
    oneSequence(det)
    // Third repetition — the last call of the third window should trigger
    det.recordToolCall('tool_a', {})
    det.recordToolCall('tool_b', {})
    det.recordToolCall('tool_c', {})
    det.recordToolCall('tool_d', {})
    const result = det.recordToolCall('tool_e', {})
    expect(result.stuck).toBe(true)
    expect(result.reason).toContain('tool_a')
  })

  it('resets detection when a different tool breaks the sequence', () => {
    const det = new StuckDetector()
    oneSequence(det)
    oneSequence(det)
    // Inject a different tool before completing the third window
    det.recordToolCall('tool_a', {})
    det.recordToolCall('tool_b', {})
    det.recordToolCall('DIFFERENT', {}) // breaks the pattern
    det.recordToolCall('tool_d', {})
    const result = det.recordToolCall('tool_e', {})
    // Window is now [b, DIFFERENT, d, e, ...] — not stuck
    expect(result.stuck).toBe(false)
  })

  it('changing any one tool in the window breaks the hash match', () => {
    const det = new StuckDetector()
    // Two windows of [a,b,c,d,e]
    oneSequence(det)
    oneSequence(det)
    // Start the third but swap tool_c for tool_X
    det.recordToolCall('tool_a', {})
    det.recordToolCall('tool_b', {})
    det.recordToolCall('tool_X', {}) // changed
    det.recordToolCall('tool_d', {})
    const result = det.recordToolCall('tool_e', {})
    expect(result.stuck).toBe(false)
  })
})
