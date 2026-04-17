import { describe, it, expect } from 'vitest'
import { routeFailure, DEFAULT_FIX_STRATEGIES } from '../ci/failure-router.js'
import type { CIFailure } from '../ci/ci-monitor.js'

describe('routeFailure', () => {
  it('routes a type-check failure to the type-check strategy', () => {
    const failure: CIFailure = {
      jobName: 'typecheck',
      logExcerpt: 'TS2322',
      errorCategory: 'type-check',
    }
    const strategy = routeFailure(failure)
    expect(strategy.category).toBe('type-check')
    expect(strategy.suggestedTools).toContain('edit_file')
    expect(strategy.maxAttempts).toBe(3)
  })

  it('routes a test failure', () => {
    const failure: CIFailure = {
      jobName: 'test',
      logExcerpt: 'FAIL',
      errorCategory: 'test',
    }
    const strategy = routeFailure(failure)
    expect(strategy.category).toBe('test')
    expect(strategy.suggestedTools).toContain('run_tests')
  })

  it('routes a lint failure', () => {
    const failure: CIFailure = {
      jobName: 'lint',
      logExcerpt: 'eslint error',
      errorCategory: 'lint',
    }
    const strategy = routeFailure(failure)
    expect(strategy.category).toBe('lint')
    expect(strategy.maxAttempts).toBe(2)
  })

  it('routes a build failure', () => {
    const failure: CIFailure = {
      jobName: 'build',
      logExcerpt: 'compile error',
      errorCategory: 'build',
    }
    expect(routeFailure(failure).category).toBe('build')
  })

  it('routes a deploy failure', () => {
    const failure: CIFailure = {
      jobName: 'deploy',
      logExcerpt: 'deploy failed',
      errorCategory: 'deploy',
    }
    expect(routeFailure(failure).category).toBe('deploy')
    expect(routeFailure(failure).maxAttempts).toBe(2)
  })

  it('falls back to unknown for undefined category', () => {
    const failure: CIFailure = {
      jobName: 'mystery',
      logExcerpt: 'something happened',
    }
    const strategy = routeFailure(failure)
    expect(strategy.category).toBe('unknown')
  })

  it('uses custom strategies when provided', () => {
    const failure: CIFailure = {
      jobName: 'test',
      logExcerpt: 'FAIL',
      errorCategory: 'test',
    }
    const custom = {
      test: {
        category: 'test' as const,
        promptHint: 'Custom hint',
        suggestedTools: ['custom_tool'],
        maxAttempts: 10,
      },
    }
    const strategy = routeFailure(failure, custom)
    expect(strategy.promptHint).toBe('Custom hint')
    expect(strategy.maxAttempts).toBe(10)
  })

  it('DEFAULT_FIX_STRATEGIES covers all standard categories', () => {
    expect(DEFAULT_FIX_STRATEGIES['type-check']).toBeDefined()
    expect(DEFAULT_FIX_STRATEGIES['test']).toBeDefined()
    expect(DEFAULT_FIX_STRATEGIES['lint']).toBeDefined()
    expect(DEFAULT_FIX_STRATEGIES['build']).toBeDefined()
    expect(DEFAULT_FIX_STRATEGIES['deploy']).toBeDefined()
    expect(DEFAULT_FIX_STRATEGIES['unknown']).toBeDefined()
  })
})
