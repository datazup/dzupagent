import { describe, it, expect } from 'vitest'
import {
  classifyProviderError,
  isRecoverableProviderError,
  isContextLengthProviderError,
} from '../errors/classify-provider-error.js'
import { ForgeError } from '../errors/forge-error.js'
import { isTransientError, isContextLengthError } from '../llm/retry.js'

describe('classifyProviderError — typed provider-error classification', () => {
  it('maps a 429-shaped error to PROVIDER_RATE_LIMITED and marks it recoverable', () => {
    const err = classifyProviderError(new Error('HTTP 429 too many requests'))
    expect(err).toBeInstanceOf(ForgeError)
    expect(err.code).toBe('PROVIDER_RATE_LIMITED')
    expect(err.recoverable).toBe(true)
  })

  it('maps 503/529/overloaded to PROVIDER_UNAVAILABLE (recoverable)', () => {
    for (const msg of ['HTTP 503', 'HTTP 529', 'Model is overloaded', 'No capacity']) {
      const err = classifyProviderError(new Error(msg))
      expect(err.code).toBe('PROVIDER_UNAVAILABLE')
      expect(err.recoverable).toBe(true)
    }
  })

  it('maps network resets/timeouts to PROVIDER_TIMEOUT (recoverable)', () => {
    for (const msg of ['read ECONNRESET', 'socket hang up', 'fetch failed', 'Request timeout']) {
      const err = classifyProviderError(new Error(msg))
      expect(err.code).toBe('PROVIDER_TIMEOUT')
      expect(err.recoverable).toBe(true)
    }
  })

  it('maps auth failures to PROVIDER_AUTH_FAILED and marks non-recoverable', () => {
    const err = classifyProviderError(new Error('HTTP 401 Invalid API key'))
    expect(err.code).toBe('PROVIDER_AUTH_FAILED')
    expect(err.recoverable).toBe(false)
  })

  it('maps context-length overflow to CONTEXT_LENGTH_EXCEEDED (non-recoverable)', () => {
    const err = classifyProviderError(new Error('context_length_exceeded: prompt too big'))
    expect(err.code).toBe('CONTEXT_LENGTH_EXCEEDED')
    expect(err.recoverable).toBe(false)
  })

  it('prioritises context-length over rate-limit when both keywords present', () => {
    const err = classifyProviderError(
      new Error('maximum context exceeded (also 429 seen earlier)'),
    )
    expect(err.code).toBe('CONTEXT_LENGTH_EXCEEDED')
  })

  it('maps unknown errors to INTERNAL_ERROR (non-recoverable)', () => {
    const err = classifyProviderError(new Error('something unexpected'))
    expect(err.code).toBe('INTERNAL_ERROR')
    expect(err.recoverable).toBe(false)
  })

  it('returns an existing ForgeError unchanged (its code is authoritative)', () => {
    const original = new ForgeError({
      code: 'PROVIDER_RATE_LIMITED',
      message: 'rl',
      recoverable: true,
    })
    expect(classifyProviderError(original)).toBe(original)
  })

  it('handles non-Error thrown values', () => {
    expect(classifyProviderError('429 rate limit').code).toBe('PROVIDER_RATE_LIMITED')
    expect(classifyProviderError(null).code).toBe('INTERNAL_ERROR')
  })
})

describe('isRecoverableProviderError — typed retry gate', () => {
  it('is true for a 429-shaped error (retry via the typed path)', () => {
    expect(isRecoverableProviderError(new Error('429 rate_limit'))).toBe(true)
  })

  it('is false for a non-recoverable auth error', () => {
    expect(isRecoverableProviderError(new Error('401 unauthorized'))).toBe(false)
  })

  it('is false for a context-length error', () => {
    expect(isRecoverableProviderError(new Error('context_length_exceeded'))).toBe(false)
  })
})

describe('isContextLengthProviderError — typed context gate', () => {
  it('is true only for context-length overflow', () => {
    expect(isContextLengthProviderError(new Error('prompt is too long'))).toBe(true)
    expect(isContextLengthProviderError(new Error('429 rate limit'))).toBe(false)
  })
})

describe('retry.ts delegates to the typed classifier (backward-compatible)', () => {
  it('isTransientError still triggers retry for a 429-shaped error', () => {
    expect(isTransientError(new Error('HTTP 429 too many requests'))).toBe(true)
  })

  it('isTransientError does NOT retry a non-recoverable auth error', () => {
    expect(isTransientError(new Error('401 Invalid API key'))).toBe(false)
  })

  it('isTransientError does NOT retry a context-length error', () => {
    expect(isTransientError(new Error('context_length_exceeded'))).toBe(false)
  })

  it('isContextLengthError matches the typed CONTEXT_LENGTH_EXCEEDED code', () => {
    expect(isContextLengthError(new Error('maximum context length'))).toBe(true)
    expect(isContextLengthError(new Error('429'))).toBe(false)
  })
})
