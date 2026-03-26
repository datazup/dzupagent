import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ErrorDetectionOrchestrator } from '../self-correction/error-detector.js'
import type { ErrorSource, ErrorSeverity } from '../self-correction/error-detector.js'

describe('ErrorDetectionOrchestrator', () => {
  let detector: ErrorDetectionOrchestrator

  beforeEach(() => {
    detector = new ErrorDetectionOrchestrator({
      qualityRegressionThreshold: 0.6,
      correlationWindowMs: 60_000,
      maxHistorySize: 100,
    })
  })

  describe('recordError', () => {
    it('records an error and returns a DetectedError with generated ID', () => {
      const err = detector.recordError({
        source: 'build_failure',
        message: 'tsc failed',
      })
      expect(err.id).toMatch(/^err_\d+_\d+$/)
      expect(err.source).toBe('build_failure')
      expect(err.message).toBe('tsc failed')
      expect(err.timestamp).toBeInstanceOf(Date)
    })

    it('assigns default context as empty object when not provided', () => {
      const err = detector.recordError({
        source: 'timeout',
        message: 'took too long',
      })
      expect(err.context).toEqual({})
    })

    it('preserves custom context', () => {
      const err = detector.recordError({
        source: 'timeout',
        message: 'took too long',
        context: { durationMs: 30_000 },
      })
      expect(err.context).toEqual({ durationMs: 30_000 })
    })

    it('stores optional nodeId', () => {
      const err = detector.recordError({
        source: 'build_failure',
        message: 'fail',
        nodeId: 'gen_backend',
      })
      expect(err.nodeId).toBe('gen_backend')
    })

    it('generates unique IDs for each error', () => {
      const err1 = detector.recordError({ source: 'timeout', message: 'a' })
      const err2 = detector.recordError({ source: 'timeout', message: 'b' })
      expect(err1.id).not.toBe(err2.id)
    })
  })

  describe('severity classification', () => {
    const severityCases: Array<[ErrorSource, ErrorSeverity]> = [
      ['safety_monitor', 'critical'],
      ['resource_exhaustion', 'critical'],
      ['stuck_detector', 'degraded'],
      ['pipeline_stuck', 'degraded'],
      ['timeout', 'degraded'],
      ['build_failure', 'warning'],
      ['test_failure', 'warning'],
      ['quality_regression', 'warning'],
    ]

    it.each(severityCases)(
      'classifies %s as %s',
      (source, expectedSeverity) => {
        const err = detector.recordError({ source, message: 'test' })
        expect(err.severity).toBe(expectedSeverity)
      },
    )
  })

  describe('suggested recovery', () => {
    it('suggests recovery for each error source', () => {
      const sources: ErrorSource[] = [
        'safety_monitor', 'resource_exhaustion', 'stuck_detector',
        'pipeline_stuck', 'timeout', 'build_failure', 'test_failure',
        'quality_regression',
      ]
      for (const source of sources) {
        const err = detector.recordError({ source, message: 'test' })
        expect(err.suggestedRecovery).toBeDefined()
        expect(typeof err.suggestedRecovery).toBe('string')
        expect(err.suggestedRecovery!.length).toBeGreaterThan(0)
      }
    })
  })

  describe('error correlation', () => {
    it('correlates errors with the same nodeId within the time window', () => {
      const err1 = detector.recordError({
        source: 'build_failure',
        message: 'first',
        nodeId: 'gen_backend',
      })
      const err2 = detector.recordError({
        source: 'test_failure',
        message: 'second',
        nodeId: 'gen_backend',
      })

      expect(err2.correlatedErrors).toContain(err1.id)
      // Back-link: err1 should now also reference err2
      const correlated = detector.getCorrelatedErrors(err1.id)
      expect(correlated.some((e) => e.id === err2.id)).toBe(true)
    })

    it('does not correlate errors from different nodes', () => {
      detector.recordError({
        source: 'build_failure',
        message: 'first',
        nodeId: 'gen_backend',
      })
      const err2 = detector.recordError({
        source: 'test_failure',
        message: 'second',
        nodeId: 'gen_frontend',
      })

      expect(err2.correlatedErrors).toEqual([])
    })

    it('does not correlate errors without nodeId', () => {
      detector.recordError({ source: 'timeout', message: 'a' })
      const err2 = detector.recordError({ source: 'timeout', message: 'b' })
      expect(err2.correlatedErrors).toEqual([])
    })

    it('returns empty array for getCorrelatedErrors on unknown ID', () => {
      expect(detector.getCorrelatedErrors('nonexistent')).toEqual([])
    })

    it('returns empty array for error with no correlations', () => {
      const err = detector.recordError({ source: 'timeout', message: 'solo' })
      expect(detector.getCorrelatedErrors(err.id)).toEqual([])
    })
  })

  describe('recordQualityScore', () => {
    it('returns null when score is above threshold', () => {
      const result = detector.recordQualityScore('gen', 0.8, 1.0)
      expect(result).toBeNull()
    })

    it('returns null when score equals threshold exactly', () => {
      // threshold = 1.0 * 0.6 = 0.6
      const result = detector.recordQualityScore('gen', 0.6, 1.0)
      expect(result).toBeNull()
    })

    it('returns DetectedError when score is below threshold', () => {
      const result = detector.recordQualityScore('gen', 0.5, 1.0)
      expect(result).not.toBeNull()
      expect(result!.source).toBe('quality_regression')
      expect(result!.nodeId).toBe('gen')
      expect(result!.context).toMatchObject({ score: 0.5, baseline: 1.0 })
    })

    it('uses baseline of 1.0 when not provided', () => {
      // threshold = 1.0 * 0.6 = 0.6
      const result = detector.recordQualityScore('gen', 0.59)
      expect(result).not.toBeNull()
      expect(result!.context).toMatchObject({ baseline: 1.0 })
    })

    it('calculates threshold relative to the provided baseline', () => {
      // baseline=0.8, threshold = 0.8 * 0.6 = 0.48
      expect(detector.recordQualityScore('gen', 0.5, 0.8)).toBeNull()
      expect(detector.recordQualityScore('gen', 0.47, 0.8)).not.toBeNull()
    })

    it('adds the error to history when regression is detected', () => {
      detector.recordQualityScore('gen', 0.3, 1.0)
      const recent = detector.getRecentErrors()
      expect(recent.length).toBe(1)
      expect(recent[0]!.source).toBe('quality_regression')
    })
  })

  describe('getRecentErrors', () => {
    it('returns empty array when no errors recorded', () => {
      expect(detector.getRecentErrors()).toEqual([])
    })

    it('returns all errors within the default window', () => {
      detector.recordError({ source: 'timeout', message: 'a' })
      detector.recordError({ source: 'timeout', message: 'b' })
      expect(detector.getRecentErrors().length).toBe(2)
    })

    it('respects custom window parameter', () => {
      // Use the real date, both errors are "now" so a 1ms window should include them
      detector.recordError({ source: 'timeout', message: 'a' })
      detector.recordError({ source: 'timeout', message: 'b' })
      const recent = detector.getRecentErrors(1_000)
      expect(recent.length).toBe(2)
    })
  })

  describe('getErrorFrequency', () => {
    it('returns empty map when no errors', () => {
      expect(detector.getErrorFrequency().size).toBe(0)
    })

    it('counts errors by source correctly', () => {
      detector.recordError({ source: 'timeout', message: 'a' })
      detector.recordError({ source: 'timeout', message: 'b' })
      detector.recordError({ source: 'build_failure', message: 'c' })

      const freq = detector.getErrorFrequency()
      expect(freq.get('timeout')).toBe(2)
      expect(freq.get('build_failure')).toBe(1)
      expect(freq.has('safety_monitor')).toBe(false)
    })
  })

  describe('getMostSevere', () => {
    it('returns null when no errors recorded', () => {
      expect(detector.getMostSevere()).toBeNull()
    })

    it('returns the most severe error', () => {
      detector.recordError({ source: 'test_failure', message: 'warning level' })
      detector.recordError({ source: 'safety_monitor', message: 'critical level' })
      detector.recordError({ source: 'timeout', message: 'degraded level' })

      const most = detector.getMostSevere()
      expect(most).not.toBeNull()
      expect(most!.severity).toBe('critical')
      expect(most!.source).toBe('safety_monitor')
    })

    it('returns first critical if multiple criticals exist', () => {
      detector.recordError({ source: 'safety_monitor', message: 'first critical' })
      detector.recordError({ source: 'resource_exhaustion', message: 'second critical' })

      const most = detector.getMostSevere()
      expect(most).not.toBeNull()
      expect(most!.severity).toBe('critical')
    })
  })

  describe('history management', () => {
    it('enforces maxHistorySize', () => {
      const small = new ErrorDetectionOrchestrator({ maxHistorySize: 5 })
      for (let i = 0; i < 10; i++) {
        small.recordError({ source: 'timeout', message: `err ${i}` })
      }
      // Only 5 most recent should remain
      const recent = small.getRecentErrors(999_999_999)
      expect(recent.length).toBe(5)
      // The oldest should be err 5 (0-4 were evicted)
      expect(recent[0]!.message).toBe('err 5')
    })
  })

  describe('reset', () => {
    it('clears all error history', () => {
      detector.recordError({ source: 'timeout', message: 'a' })
      detector.recordError({ source: 'build_failure', message: 'b' })

      detector.reset()

      expect(detector.getRecentErrors().length).toBe(0)
      expect(detector.getErrorFrequency().size).toBe(0)
      expect(detector.getMostSevere()).toBeNull()
    })

    it('resets ID counter so new errors get fresh IDs', () => {
      detector.recordError({ source: 'timeout', message: 'before' })
      detector.reset()
      const err = detector.recordError({ source: 'timeout', message: 'after' })
      // Counter resets to 0, so the suffix should be _1
      expect(err.id).toMatch(/_1$/)
    })

    it('allows re-accumulation after reset', () => {
      detector.recordError({ source: 'timeout', message: 'a' })
      detector.reset()
      detector.recordError({ source: 'build_failure', message: 'b' })

      const freq = detector.getErrorFrequency()
      expect(freq.size).toBe(1)
      expect(freq.get('build_failure')).toBe(1)
      expect(freq.has('timeout')).toBe(false)
    })
  })

  describe('default config', () => {
    it('uses sensible defaults', () => {
      const d = new ErrorDetectionOrchestrator()
      // Default threshold is 0.6, so score 0.5 < 1.0 * 0.6 should flag
      const result = d.recordQualityScore('gen', 0.5)
      expect(result).not.toBeNull()
      expect(result!.source).toBe('quality_regression')
    })

    it('defaults maxHistorySize to 100', () => {
      const d = new ErrorDetectionOrchestrator()
      for (let i = 0; i < 110; i++) {
        d.recordError({ source: 'timeout', message: `err ${i}` })
      }
      const all = d.getRecentErrors(999_999_999)
      expect(all.length).toBe(100)
    })
  })
})
