import { describe, it, expect, beforeEach } from 'vitest'
import { FailureAnalyzer } from '../recovery/failure-analyzer.js'
import type { FailureContext } from '../recovery/recovery-types.js'

function makeContext(overrides: Partial<FailureContext> = {}): FailureContext {
  return {
    type: 'generation_failure',
    error: 'Something went wrong',
    runId: 'run-1',
    timestamp: new Date(),
    previousAttempts: 0,
    ...overrides,
  }
}

describe('FailureAnalyzer', () => {
  let analyzer: FailureAnalyzer

  beforeEach(() => {
    analyzer = new FailureAnalyzer()
  })

  // -------------------------------------------------------------------------
  // classifyError
  // -------------------------------------------------------------------------

  describe('classifyError', () => {
    it('classifies build failures', () => {
      expect(analyzer.classifyError('compilation error in module X')).toBe('build_failure')
      expect(analyzer.classifyError('Build failed with 3 errors')).toBe('build_failure')
      expect(analyzer.classifyError('TypeScript error TS2345')).toBe('build_failure')
      expect(analyzer.classifyError('Cannot find module "foo"')).toBe('build_failure')
    })

    it('classifies test failures', () => {
      expect(analyzer.classifyError('Test failed: expect(x).toBe(y)')).toBe('test_failure')
      expect(analyzer.classifyError('3 tests failed')).toBe('test_failure')
      expect(analyzer.classifyError('Assertion error: expected 5 to equal 3')).toBe('test_failure')
    })

    it('classifies timeouts', () => {
      expect(analyzer.classifyError('Request timeout after 30000ms')).toBe('timeout')
      expect(analyzer.classifyError('ETIMEDOUT')).toBe('timeout')
      expect(analyzer.classifyError('Deadline exceeded')).toBe('timeout')
    })

    it('classifies resource exhaustion', () => {
      expect(analyzer.classifyError('Out of memory')).toBe('resource_exhaustion')
      expect(analyzer.classifyError('Rate limit exceeded')).toBe('resource_exhaustion')
      expect(analyzer.classifyError('HTTP 429 Too Many Requests')).toBe('resource_exhaustion')
      expect(analyzer.classifyError('Budget exceeded')).toBe('resource_exhaustion')
    })

    it('classifies generation failures', () => {
      expect(analyzer.classifyError('LLM error: invalid response')).toBe('generation_failure')
      expect(analyzer.classifyError('Model unavailable')).toBe('generation_failure')
      expect(analyzer.classifyError('Generation failed')).toBe('generation_failure')
    })

    it('defaults to generation_failure for unknown errors', () => {
      expect(analyzer.classifyError('something completely unknown happened')).toBe('generation_failure')
    })
  })

  // -------------------------------------------------------------------------
  // fingerprint
  // -------------------------------------------------------------------------

  describe('fingerprint', () => {
    it('produces consistent fingerprints for identical errors', () => {
      const fp1 = analyzer.fingerprint('Error at line 42 in /src/foo.ts')
      const fp2 = analyzer.fingerprint('Error at line 42 in /src/foo.ts')
      expect(fp1).toBe(fp2)
    })

    it('produces the same fingerprint when only numbers differ', () => {
      const fp1 = analyzer.fingerprint('Error at line 42 in /src/foo.ts')
      const fp2 = analyzer.fingerprint('Error at line 99 in /src/foo.ts')
      expect(fp1).toBe(fp2)
    })

    it('produces the same fingerprint when only paths differ', () => {
      const fp1 = analyzer.fingerprint('Cannot find module "/src/foo.ts"')
      const fp2 = analyzer.fingerprint('Cannot find module "/src/bar/baz.ts"')
      expect(fp1).toBe(fp2)
    })

    it('produces different fingerprints for structurally different errors', () => {
      const fp1 = analyzer.fingerprint('Build failed')
      const fp2 = analyzer.fingerprint('Test failed')
      expect(fp1).not.toBe(fp2)
    })

    it('starts with fp_ prefix', () => {
      const fp = analyzer.fingerprint('any error')
      expect(fp).toMatch(/^fp_[0-9a-f]{8}$/)
    })
  })

  // -------------------------------------------------------------------------
  // analyze
  // -------------------------------------------------------------------------

  describe('analyze', () => {
    it('returns full analysis for a fresh failure', () => {
      const ctx = makeContext({ error: 'Build failed with syntax error' })
      const result = analyzer.analyze(ctx)

      expect(result.type).toBe('build_failure')
      expect(result.fingerprint).toMatch(/^fp_/)
      expect(result.isRecurring).toBe(false)
      expect(result.occurrenceCount).toBe(1)
      expect(result.previousResolutions).toEqual([])
    })

    it('detects recurring failures', () => {
      const ctx = makeContext({ error: 'Build failed with syntax error' })

      // Record the first occurrence
      analyzer.recordFailure(ctx, 'Fixed manually')

      // Analyze the same error again
      const result = analyzer.analyze(ctx)
      expect(result.isRecurring).toBe(true)
      expect(result.occurrenceCount).toBe(2)
      expect(result.previousResolutions).toEqual(['Fixed manually'])
    })

    it('extracts file paths from error messages', () => {
      const ctx = makeContext({ error: 'Error in /src/components/Button.tsx at line 42' })
      const result = analyzer.analyze(ctx)
      expect(result.extractedInfo['file']).toBe('/src/components/Button.tsx')
    })

    it('extracts line numbers from error messages', () => {
      const ctx = makeContext({ error: 'Error at line 42' })
      const result = analyzer.analyze(ctx)
      expect(result.extractedInfo['line']).toBe('42')
    })

    it('extracts HTTP status codes from error messages', () => {
      const ctx = makeContext({ error: 'Server returned 503 Service Unavailable' })
      const result = analyzer.analyze(ctx)
      expect(result.extractedInfo['httpStatus']).toBe('503')
    })
  })

  // -------------------------------------------------------------------------
  // recordFailure / history
  // -------------------------------------------------------------------------

  describe('recordFailure', () => {
    it('adds entries to history', () => {
      const ctx = makeContext({ error: 'Error A' })
      analyzer.recordFailure(ctx)
      expect(analyzer.getHistory()).toHaveLength(1)
      expect(analyzer.getHistory()[0]!.error).toBe('Error A')
    })

    it('tracks resolutions', () => {
      const ctx = makeContext({ error: 'Error A' })
      analyzer.recordFailure(ctx, 'Fixed by retry')

      const analysis = analyzer.analyze(ctx)
      expect(analysis.previousResolutions).toContain('Fixed by retry')
    })

    it('accumulates multiple occurrences', () => {
      const ctx = makeContext({ error: 'Repeated error' })
      analyzer.recordFailure(ctx)
      analyzer.recordFailure(ctx)
      analyzer.recordFailure(ctx)

      const analysis = analyzer.analyze(ctx)
      expect(analysis.occurrenceCount).toBe(4) // 3 recorded + 1 current
    })
  })

  // -------------------------------------------------------------------------
  // reset
  // -------------------------------------------------------------------------

  describe('reset', () => {
    it('clears all history and fingerprints', () => {
      const ctx = makeContext({ error: 'Error A' })
      analyzer.recordFailure(ctx)
      expect(analyzer.getHistory()).toHaveLength(1)

      analyzer.reset()
      expect(analyzer.getHistory()).toHaveLength(0)

      const analysis = analyzer.analyze(ctx)
      expect(analysis.isRecurring).toBe(false)
    })
  })
})
