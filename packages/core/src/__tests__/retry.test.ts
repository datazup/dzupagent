import { describe, it, expect } from 'vitest'
import { isTransientError, DEFAULT_RETRY_CONFIG } from '../llm/retry.js'

describe('isTransientError', () => {
  it('detects 503 service unavailable', () => {
    expect(isTransientError(new Error('HTTP 503 Service Unavailable'))).toBe(true)
  })

  it('detects 529 overloaded', () => {
    expect(isTransientError(new Error('HTTP 529'))).toBe(true)
  })

  it('detects rate_limit (underscore variant)', () => {
    expect(isTransientError(new Error('rate_limit_exceeded'))).toBe(true)
  })

  it('detects rate limit (space variant)', () => {
    expect(isTransientError(new Error('Rate limit reached for model'))).toBe(true)
  })

  it('detects overloaded', () => {
    expect(isTransientError(new Error('Model is overloaded'))).toBe(true)
  })

  it('detects capacity errors', () => {
    expect(isTransientError(new Error('No capacity available'))).toBe(true)
  })

  it('detects timeout', () => {
    expect(isTransientError(new Error('Request timeout after 30s'))).toBe(true)
  })

  it('detects ECONNRESET', () => {
    expect(isTransientError(new Error('read ECONNRESET'))).toBe(true)
  })

  it('detects ECONNREFUSED', () => {
    expect(isTransientError(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe(true)
  })

  it('detects socket hang up', () => {
    expect(isTransientError(new Error('socket hang up'))).toBe(true)
  })

  it('detects fetch failed', () => {
    expect(isTransientError(new Error('fetch failed'))).toBe(true)
  })

  it('returns false for non-transient errors', () => {
    expect(isTransientError(new Error('Invalid API key'))).toBe(false)
  })

  it('returns false for 400 bad request', () => {
    expect(isTransientError(new Error('HTTP 400 Bad Request'))).toBe(false)
  })

  it('returns false for 401 unauthorized', () => {
    expect(isTransientError(new Error('HTTP 401 Unauthorized'))).toBe(false)
  })

  it('returns false for generic errors', () => {
    expect(isTransientError(new Error('Something went wrong'))).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(isTransientError(new Error('RATE_LIMIT exceeded'))).toBe(true)
    expect(isTransientError(new Error('TIMEOUT occurred'))).toBe(true)
  })
})

describe('DEFAULT_RETRY_CONFIG', () => {
  it('has sensible defaults', () => {
    expect(DEFAULT_RETRY_CONFIG.maxAttempts).toBe(3)
    expect(DEFAULT_RETRY_CONFIG.backoffMs).toBe(1000)
    expect(DEFAULT_RETRY_CONFIG.maxBackoffMs).toBe(8000)
  })
})
