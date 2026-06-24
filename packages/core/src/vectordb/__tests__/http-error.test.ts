import { describe, it, expect } from 'vitest'
import { vectorHttpErrorToForgeError } from '../http-error.js'
import { ForgeError } from '../../errors/forge-error.js'

describe('vectorHttpErrorToForgeError', () => {
  it('maps 429 to a recoverable rate-limited error', () => {
    const err = vectorHttpErrorToForgeError(429, 'slow down', 'pinecone')
    expect(err).toBeInstanceOf(ForgeError)
    expect(err.code).toBe('VECTOR_STORE_RATE_LIMITED')
    expect(err.recoverable).toBe(true)
  })

  it('maps 401 and 403 to non-recoverable auth failures', () => {
    for (const status of [401, 403]) {
      const err = vectorHttpErrorToForgeError(status, 'nope', 'qdrant')
      expect(err.code).toBe('VECTOR_STORE_AUTH_FAILED')
      expect(err.recoverable).toBe(false)
    }
  })

  it('maps 5xx to a recoverable unavailable error', () => {
    for (const status of [500, 502, 503]) {
      const err = vectorHttpErrorToForgeError(status, 'boom', 'chroma')
      expect(err.code).toBe('VECTOR_STORE_UNAVAILABLE')
      expect(err.recoverable).toBe(true)
    }
  })

  it('maps other 4xx to a non-recoverable rejected request', () => {
    const err = vectorHttpErrorToForgeError(400, 'bad input', 'turbopuffer')
    expect(err.code).toBe('VECTOR_STORE_REJECTED_REQUEST')
    expect(err.recoverable).toBe(false)
  })

  it('never interpolates the raw body into the message', () => {
    const secret = 'SECRET_API_TOKEN_12345'
    const err = vectorHttpErrorToForgeError(403, secret, 'pinecone')
    expect(err.message).not.toContain(secret)
    expect(err.context?.['body']).toBe(secret)
  })

  it('records providerId and status in the context', () => {
    const err = vectorHttpErrorToForgeError(429, { error: 'rate' }, 'qdrant')
    expect(err.context?.['providerId']).toBe('qdrant')
    expect(err.context?.['status']).toBe(429)
  })

  it('truncates very large string bodies in the context', () => {
    const big = 'x'.repeat(5000)
    const err = vectorHttpErrorToForgeError(500, big, 'chroma')
    const body = err.context?.['body'] as string
    expect(body.length).toBeLessThan(big.length)
    expect(body).toContain('[truncated]')
  })
})
