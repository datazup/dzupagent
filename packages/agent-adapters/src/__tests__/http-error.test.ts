import { describe, it, expect } from 'vitest'
import { httpErrorToForgeError } from '../utils/http-error.js'
import { ForgeError } from '@dzupagent/core/events'

describe('httpErrorToForgeError', () => {
  it('maps 429 to a recoverable rate-limited error', () => {
    const err = httpErrorToForgeError(429, 'slow down', 'openai')
    expect(err).toBeInstanceOf(ForgeError)
    expect(err.code).toBe('PROVIDER_RATE_LIMITED')
    expect(err.recoverable).toBe(true)
  })

  it('maps 401 and 403 to non-recoverable auth failures', () => {
    for (const status of [401, 403]) {
      const err = httpErrorToForgeError(status, 'nope', 'openrouter')
      expect(err.code).toBe('PROVIDER_AUTH_FAILED')
      expect(err.recoverable).toBe(false)
    }
  })

  it('maps 5xx to a recoverable unavailable error', () => {
    for (const status of [500, 502, 503]) {
      const err = httpErrorToForgeError(status, 'boom', 'openai')
      expect(err.code).toBe('PROVIDER_UNAVAILABLE')
      expect(err.recoverable).toBe(true)
    }
  })

  it('maps other 4xx to a non-recoverable rejected request', () => {
    const err = httpErrorToForgeError(422, 'bad input', 'openai')
    expect(err.code).toBe('PROVIDER_REJECTED_REQUEST')
    expect(err.recoverable).toBe(false)
  })

  it('never interpolates the raw body into the message', () => {
    const secret = 'sk-SECRET_KEY_98765'
    const err = httpErrorToForgeError(403, secret, 'openai')
    expect(err.message).not.toContain(secret)
    expect(err.context?.['body']).toBe(secret)
  })

  it('records providerId and status in the context', () => {
    const err = httpErrorToForgeError(429, { error: 'rate' }, 'openrouter')
    expect(err.context?.['providerId']).toBe('openrouter')
    expect(err.context?.['status']).toBe(429)
  })
})
