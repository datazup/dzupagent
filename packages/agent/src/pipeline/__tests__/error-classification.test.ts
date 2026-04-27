/**
 * Focused tests for the extracted error-classification helpers.
 *
 * These mirror the original in-class invariants of `extractErrorCode`
 * and `classifyError` so the pipeline runtime continues to surface
 * exactly the same error codes to `errorEdges` and the same
 * `FailureType` values to the recovery copilot.
 */

import { describe, it, expect } from 'vitest'
import {
  extractErrorCode,
  extractErrorCodeFromMessage,
  classifyFailureType,
} from '../pipeline-runtime/error-classification.js'

describe('extractErrorCode', () => {
  it('returns string `code` field when present on object', () => {
    expect(extractErrorCode({ code: 'BUDGET_EXCEEDED' })).toBe('BUDGET_EXCEEDED')
  })

  it('ignores non-string `code` field and falls through', () => {
    expect(extractErrorCode({ code: 123 })).toBeUndefined()
  })

  it('ignores empty string `code` field and falls through', () => {
    expect(extractErrorCode({ code: '' })).toBeUndefined()
  })

  it('parses Error.message for a bracketed code', () => {
    expect(extractErrorCode(new Error('[TIMEOUT] step took too long'))).toBe('TIMEOUT')
  })

  it('parses bare strings for a colon-prefixed code', () => {
    expect(extractErrorCode('OOM_KILL: memory exhausted')).toBe('OOM_KILL')
  })

  it('returns undefined for null and undefined', () => {
    expect(extractErrorCode(null)).toBeUndefined()
    expect(extractErrorCode(undefined)).toBeUndefined()
  })

  it('coerces non-string non-Error values to string and parses', () => {
    expect(extractErrorCode({ toString: () => 'RATE_LIMIT: slow down' })).toBe('RATE_LIMIT')
  })
})

describe('extractErrorCodeFromMessage', () => {
  it('prefers bracketed code over plain text', () => {
    expect(extractErrorCodeFromMessage('[E_NET] connection refused')).toBe('E_NET')
  })

  it('prefers prefixed code form `CODE:`', () => {
    expect(extractErrorCodeFromMessage('AUTH_FAIL: invalid token')).toBe('AUTH_FAIL')
  })

  it('returns the entire message when it is a bare code', () => {
    expect(extractErrorCodeFromMessage('TIMEOUT')).toBe('TIMEOUT')
  })

  it('rejects codes shorter than 3 characters', () => {
    expect(extractErrorCodeFromMessage('AB')).toBeUndefined()
    expect(extractErrorCodeFromMessage('[AB] short')).toBeUndefined()
  })

  it('rejects lowercase or mixed-case codes', () => {
    expect(extractErrorCodeFromMessage('timeout occurred')).toBeUndefined()
    expect(extractErrorCodeFromMessage('[Timeout] mixed case')).toBeUndefined()
  })

  it('returns undefined for unstructured messages', () => {
    expect(extractErrorCodeFromMessage('something went wrong')).toBeUndefined()
  })
})

describe('classifyFailureType', () => {
  it('classifies timeout-flavoured messages', () => {
    expect(classifyFailureType('Request timeout after 30s')).toBe('timeout')
    expect(classifyFailureType('operation timed out')).toBe('timeout')
    expect(classifyFailureType('deadline exceeded')).toBe('timeout')
  })

  it('classifies resource-exhaustion-flavoured messages', () => {
    expect(classifyFailureType('out of memory')).toBe('resource_exhaustion')
    expect(classifyFailureType('OOM killer triggered')).toBe('resource_exhaustion')
    expect(classifyFailureType('quota exceeded for project')).toBe('resource_exhaustion')
    expect(classifyFailureType('rate limit hit on endpoint')).toBe('resource_exhaustion')
    expect(classifyFailureType('insufficient resource')).toBe('resource_exhaustion')
  })

  it('classifies build-flavoured messages', () => {
    expect(classifyFailureType('build failed')).toBe('build_failure')
    expect(classifyFailureType('compile error in module foo')).toBe('build_failure')
    expect(classifyFailureType('syntax error at line 12')).toBe('build_failure')
  })

  it('classifies test-flavoured messages', () => {
    expect(classifyFailureType('test failed: foo')).toBe('test_failure')
    expect(classifyFailureType('assertion error: x !== y')).toBe('test_failure')
    expect(classifyFailureType('expect(x).toBe(y) failed')).toBe('test_failure')
  })

  it('falls back to generation_failure for everything else', () => {
    expect(classifyFailureType('some unrelated problem')).toBe('generation_failure')
    expect(classifyFailureType('')).toBe('generation_failure')
  })

  it('respects keyword precedence: timeout beats resource', () => {
    // Both keywords present — timeout wins because it is checked first.
    expect(classifyFailureType('timeout while reading memory')).toBe('timeout')
  })

  it('respects keyword precedence: resource beats build', () => {
    expect(classifyFailureType('memory pressure during compile')).toBe('resource_exhaustion')
  })

  it('matches case-insensitively', () => {
    expect(classifyFailureType('TIMEOUT')).toBe('timeout')
    expect(classifyFailureType('Build Failed')).toBe('build_failure')
  })

  it('ignores the optional nodeType argument', () => {
    expect(classifyFailureType('timeout', 'gate')).toBe('timeout')
    expect(classifyFailureType('timeout', 'task')).toBe('timeout')
  })
})
