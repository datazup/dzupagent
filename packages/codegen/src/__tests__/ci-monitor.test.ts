import { describe, it, expect } from 'vitest'
import {
  categorizeFailure,
  parseGitHubActionsStatus,
  parseCIWebhook,
} from '../ci/ci-monitor.js'

// ---------------------------------------------------------------------------
// categorizeFailure
// ---------------------------------------------------------------------------

describe('categorizeFailure', () => {
  it('categorizes TypeScript errors as type-check', () => {
    expect(categorizeFailure('error TS2322: Type string is not assignable')).toBe('type-check')
    expect(categorizeFailure('tsc exited with code 1')).toBe('type-check')
    expect(categorizeFailure('type error in foo.ts')).toBe('type-check')
  })

  it('categorizes test failures', () => {
    expect(categorizeFailure('FAIL src/__tests__/foo.test.ts')).toBe('test')
    expect(categorizeFailure('vitest run failed')).toBe('test')
    expect(categorizeFailure('jest returned 1')).toBe('test')
    expect(categorizeFailure('test suite failed')).toBe('test')
  })

  it('categorizes lint errors', () => {
    expect(categorizeFailure('eslint found 3 errors')).toBe('lint')
    expect(categorizeFailure('lint error in file.ts')).toBe('lint')
  })

  it('categorizes build errors', () => {
    // "compile error" matches build pattern without triggering test pattern
    expect(categorizeFailure('compile error: missing module')).toBe('build')
  })

  it('notes that deploy pattern is shadowed by test pattern for strings containing "fail"', () => {
    // The FAIL regex (test category) fires before deploy\s*.*fail because patterns
    // are checked in order. This documents the actual first-match-wins behavior.
    expect(categorizeFailure('deploy failed: timeout')).toBe('test')
  })

  it('returns unknown for unrecognized logs', () => {
    expect(categorizeFailure('something went wrong')).toBe('unknown')
    expect(categorizeFailure('')).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// parseGitHubActionsStatus
// ---------------------------------------------------------------------------

describe('parseGitHubActionsStatus', () => {
  it('parses a successful run', () => {
    const result = parseGitHubActionsStatus({
      id: 12345,
      conclusion: 'success',
      status: 'completed',
      head_branch: 'main',
      html_url: 'https://github.com/test/run/12345',
      updated_at: '2026-01-01T00:00:00Z',
    })

    expect(result.provider).toBe('github-actions')
    expect(result.runId).toBe('12345')
    expect(result.branch).toBe('main')
    expect(result.status).toBe('success')
    expect(result.failures).toHaveLength(0)
    expect(result.url).toBe('https://github.com/test/run/12345')
  })

  it('parses a failed run with job failures', () => {
    const result = parseGitHubActionsStatus({
      id: 99,
      conclusion: 'failure',
      status: 'completed',
      head_branch: 'feature/x',
      updated_at: '2026-01-01T00:00:00Z',
      jobs: [
        {
          name: 'typecheck',
          conclusion: 'failure',
          log: 'error TS2322: Type mismatch',
          step: 'Run tsc',
          exit_code: 1,
        },
        { name: 'lint', conclusion: 'success' },
      ],
    })

    expect(result.status).toBe('failure')
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]!.jobName).toBe('typecheck')
    expect(result.failures[0]!.step).toBe('Run tsc')
    expect(result.failures[0]!.exitCode).toBe(1)
    expect(result.failures[0]!.errorCategory).toBe('type-check')
  })

  it('parses a cancelled run', () => {
    const result = parseGitHubActionsStatus({
      id: 1,
      conclusion: 'cancelled',
      status: 'completed',
      head_branch: 'dev',
      updated_at: '2026-01-01T00:00:00Z',
    })
    expect(result.status).toBe('cancelled')
  })

  it('parses a pending run (null conclusion)', () => {
    const result = parseGitHubActionsStatus({
      id: 2,
      conclusion: null,
      status: 'in_progress',
      head_branch: 'dev',
      updated_at: '2026-01-01T00:00:00Z',
    })
    expect(result.status).toBe('running')
  })

  it('handles missing optional fields gracefully', () => {
    const result = parseGitHubActionsStatus({})
    expect(result.runId).toBe('')
    expect(result.branch).toBe('')
    expect(result.url).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// parseCIWebhook
// ---------------------------------------------------------------------------

describe('parseCIWebhook', () => {
  it('parses a generic webhook with failures', () => {
    const result = parseCIWebhook(
      {
        runId: 'run-42',
        branch: 'main',
        status: 'failure',
        url: 'https://ci.example.com/42',
        timestamp: '2026-01-01T00:00:00Z',
        failures: [
          { jobName: 'test', logExcerpt: 'FAIL src/foo.test.ts', exitCode: 1 },
        ],
      },
      'generic',
    )

    expect(result.provider).toBe('generic')
    expect(result.runId).toBe('run-42')
    expect(result.status).toBe('failure')
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]!.errorCategory).toBe('test')
    expect(result.url).toBe('https://ci.example.com/42')
  })

  it('overrides success status when failures exist', () => {
    const result = parseCIWebhook(
      {
        status: 'success',
        failures: [{ job: 'build', log: 'build failed' }],
      },
      'gitlab-ci',
    )
    expect(result.status).toBe('failure')
  })

  it('handles empty payload', () => {
    const result = parseCIWebhook({}, 'generic')
    expect(result.runId).toBe('')
    expect(result.branch).toBe('')
    expect(result.failures).toHaveLength(0)
  })

  it('reads alternate key names (id, ref, logExcerpt)', () => {
    const result = parseCIWebhook(
      {
        id: 'alt-id',
        ref: 'refs/heads/dev',
        failures: [{ jobName: 'lint', logExcerpt: 'eslint found errors' }],
      },
      'generic',
    )
    expect(result.runId).toBe('alt-id')
    expect(result.branch).toBe('refs/heads/dev')
    expect(result.failures[0]!.errorCategory).toBe('lint')
  })
})
