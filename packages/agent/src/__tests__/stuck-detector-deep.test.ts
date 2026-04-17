import { describe, it, expect, beforeEach } from 'vitest'
import { StuckDetector } from '../guardrails/stuck-detector.js'

describe('StuckDetector - extended', () => {
  describe('constructor defaults', () => {
    it('uses default config values', () => {
      const detector = new StuckDetector()
      // Default maxRepeatCalls is 3
      expect(detector.recordToolCall('a', { x: 1 }).stuck).toBe(false)
      expect(detector.recordToolCall('a', { x: 1 }).stuck).toBe(false)
      expect(detector.recordToolCall('a', { x: 1 }).stuck).toBe(true)
    })
  })

  describe('recordToolCall edge cases', () => {
    it('handles string input for hashing', () => {
      const detector = new StuckDetector({ maxRepeatCalls: 2 })
      expect(detector.recordToolCall('test', 'string input').stuck).toBe(false)
      expect(detector.recordToolCall('test', 'string input').stuck).toBe(true)
    })

    it('handles null input', () => {
      const detector = new StuckDetector({ maxRepeatCalls: 2 })
      expect(detector.recordToolCall('test', null).stuck).toBe(false)
      expect(detector.recordToolCall('test', null).stuck).toBe(true)
    })

    it('handles empty object input', () => {
      const detector = new StuckDetector({ maxRepeatCalls: 2 })
      expect(detector.recordToolCall('test', {}).stuck).toBe(false)
      expect(detector.recordToolCall('test', {}).stuck).toBe(true)
    })

    it('handles deeply nested objects', () => {
      const detector = new StuckDetector({ maxRepeatCalls: 2 })
      const input = { a: { b: { c: [1, 2, 3] } } }
      expect(detector.recordToolCall('deep', input).stuck).toBe(false)
      expect(detector.recordToolCall('deep', input).stuck).toBe(true)
    })

    it('different names with same input are not stuck', () => {
      const detector = new StuckDetector({ maxRepeatCalls: 2 })
      expect(detector.recordToolCall('tool_a', { x: 1 }).stuck).toBe(false)
      expect(detector.recordToolCall('tool_b', { x: 1 }).stuck).toBe(false)
    })

    it('resets idle count on tool call', () => {
      const detector = new StuckDetector({ maxRepeatCalls: 5, maxIdleIterations: 2 })
      detector.recordIteration(0) // idle
      detector.recordToolCall('test', {}) // resets idle
      expect(detector.recordIteration(0).stuck).toBe(false)
      expect(detector.recordIteration(0).stuck).toBe(true) // 2 consecutive idle
    })
  })

  describe('recordError edge cases', () => {
    it('errors outside the window do not count', () => {
      const detector = new StuckDetector({
        maxErrorsInWindow: 2,
        errorWindowMs: 100,
      })

      detector.recordError(new Error('e1'))

      // The error happened within 100ms, but we only have 1 error.
      expect(detector.recordError(new Error('e2')).stuck).toBe(true)
    })

    it('single error does not trigger stuck', () => {
      const detector = new StuckDetector({ maxErrorsInWindow: 5, errorWindowMs: 60_000 })
      expect(detector.recordError(new Error('one')).stuck).toBe(false)
    })
  })

  describe('recordIteration', () => {
    it('non-zero tool calls reset idle count', () => {
      const detector = new StuckDetector({ maxIdleIterations: 2 })
      detector.recordIteration(0) // idle
      detector.recordIteration(5) // not idle -- resets
      expect(detector.recordIteration(0).stuck).toBe(false) // first idle again
      expect(detector.recordIteration(0).stuck).toBe(true) // second idle
    })

    it('tracks lastToolCallCount', () => {
      const detector = new StuckDetector()
      detector.recordIteration(3)
      expect(detector.lastToolCalls).toBe(3)
      detector.recordIteration(0)
      expect(detector.lastToolCalls).toBe(0)
    })
  })

  describe('reset', () => {
    it('clears tool call history', () => {
      const detector = new StuckDetector({ maxRepeatCalls: 2 })
      detector.recordToolCall('test', { x: 1 })
      detector.reset()
      // After reset, need 2 more calls to trigger
      expect(detector.recordToolCall('test', { x: 1 }).stuck).toBe(false)
      expect(detector.recordToolCall('test', { x: 1 }).stuck).toBe(true)
    })

    it('clears error history', () => {
      const detector = new StuckDetector({ maxErrorsInWindow: 2, errorWindowMs: 60_000 })
      detector.recordError(new Error('e1'))
      detector.reset()
      // After reset, need 2 more errors
      expect(detector.recordError(new Error('e2')).stuck).toBe(false)
      expect(detector.recordError(new Error('e3')).stuck).toBe(true)
    })

    it('clears idle count', () => {
      const detector = new StuckDetector({ maxIdleIterations: 2 })
      detector.recordIteration(0) // idle
      detector.reset()
      expect(detector.recordIteration(0).stuck).toBe(false) // restarted
    })

    it('clears lastToolCallCount', () => {
      const detector = new StuckDetector()
      detector.recordIteration(5)
      expect(detector.lastToolCalls).toBe(5)
      detector.reset()
      expect(detector.lastToolCalls).toBe(0)
    })
  })

  describe('combined scenarios', () => {
    it('error and tool call stuck do not interfere', () => {
      const detector = new StuckDetector({
        maxRepeatCalls: 3,
        maxErrorsInWindow: 3,
        errorWindowMs: 60_000,
      })

      detector.recordError(new Error('e1'))
      detector.recordToolCall('test', { x: 1 })
      detector.recordError(new Error('e2'))
      detector.recordToolCall('test', { x: 1 })

      // Not stuck yet from either path
      expect(detector.recordToolCall('test', { x: 1 }).stuck).toBe(true) // 3 identical calls
    })
  })
})
