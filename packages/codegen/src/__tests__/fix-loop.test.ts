import { describe, it, expect } from 'vitest'
import { buildFixPrompt, generateFixAttempts } from '../ci/fix-loop.js'
import type { CIFailure } from '../ci/ci-monitor.js'

// ---------------------------------------------------------------------------
// buildFixPrompt
// ---------------------------------------------------------------------------

describe('buildFixPrompt', () => {
  const baseFailure: CIFailure = {
    jobName: 'test',
    logExcerpt: 'FAIL src/foo.test.ts\nExpected true, got false',
    errorCategory: 'test',
    step: 'Run tests',
    exitCode: 1,
  }

  const strategy = {
    category: 'test' as const,
    promptHint: 'Fix the failing tests.',
    suggestedTools: ['edit_file', 'run_tests'],
    maxAttempts: 3,
  }

  it('includes the job name', () => {
    const prompt = buildFixPrompt(baseFailure, strategy, 1)
    expect(prompt).toContain('**Job:** test')
  })

  it('includes the step if present', () => {
    const prompt = buildFixPrompt(baseFailure, strategy, 1)
    expect(prompt).toContain('**Step:** Run tests')
  })

  it('includes exit code', () => {
    const prompt = buildFixPrompt(baseFailure, strategy, 1)
    expect(prompt).toContain('**Exit code:** 1')
  })

  it('includes the log excerpt in a code block', () => {
    const prompt = buildFixPrompt(baseFailure, strategy, 1)
    expect(prompt).toContain('```\nFAIL src/foo.test.ts')
  })

  it('includes prompt hint', () => {
    const prompt = buildFixPrompt(baseFailure, strategy, 1)
    expect(prompt).toContain('Fix the failing tests.')
  })

  it('includes retry hint on attempt > 1', () => {
    const prompt = buildFixPrompt(baseFailure, strategy, 2)
    expect(prompt).toContain('This is attempt 2')
    expect(prompt).toContain('different approach')
  })

  it('does not include retry hint on attempt 1', () => {
    const prompt = buildFixPrompt(baseFailure, strategy, 1)
    expect(prompt).not.toContain('This is attempt 1. Previous')
  })

  it('omits step when not present', () => {
    const noStep: CIFailure = { jobName: 'build', logExcerpt: 'error' }
    const prompt = buildFixPrompt(noStep, strategy, 1)
    expect(prompt).not.toContain('**Step:**')
  })

  it('omits exit code when not present', () => {
    const noExit: CIFailure = { jobName: 'build', logExcerpt: 'error' }
    const prompt = buildFixPrompt(noExit, strategy, 1)
    expect(prompt).not.toContain('**Exit code:**')
  })
})

// ---------------------------------------------------------------------------
// generateFixAttempts
// ---------------------------------------------------------------------------

describe('generateFixAttempts', () => {
  it('generates attempts for a single failure', () => {
    const failures: CIFailure[] = [
      { jobName: 'test', logExcerpt: 'FAIL', errorCategory: 'test' },
    ]
    const attempts = generateFixAttempts(failures)
    expect(attempts.length).toBeGreaterThanOrEqual(1)
    expect(attempts[0]!.failure.jobName).toBe('test')
    expect(attempts[0]!.attempt).toBe(1)
    expect(attempts[0]!.prompt).toContain('test')
  })

  it('respects maxTotalAttempts', () => {
    const failures: CIFailure[] = [
      { jobName: 'a', logExcerpt: 'fail', errorCategory: 'test' },
      { jobName: 'b', logExcerpt: 'fail', errorCategory: 'lint' },
      { jobName: 'c', logExcerpt: 'fail', errorCategory: 'build' },
    ]
    const attempts = generateFixAttempts(failures, { maxTotalAttempts: 2 })
    expect(attempts.length).toBeLessThanOrEqual(2)
  })

  it('generates multiple attempts per failure up to strategy max', () => {
    const failures: CIFailure[] = [
      { jobName: 'test', logExcerpt: 'FAIL', errorCategory: 'test' },
    ]
    const attempts = generateFixAttempts(failures, { maxTotalAttempts: 10 })
    // The test strategy allows 3 attempts
    expect(attempts.length).toBe(3)
    expect(attempts[2]!.attempt).toBe(3)
  })

  it('returns empty for no failures', () => {
    expect(generateFixAttempts([])).toHaveLength(0)
  })
})
