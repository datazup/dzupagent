import { describe, it, expect } from 'vitest'
import { extractDefaultRateLimitKey } from '../rate-limiter.js'

function makeContext(headers: Record<string, string | undefined>) {
  return {
    req: {
      header: (name: string) => headers[name],
    },
  }
}

describe('extractDefaultRateLimitKey', () => {
  it('does not use bearer token material', () => {
    const first = extractDefaultRateLimitKey(makeContext({
      Authorization: 'Bearer my-token',
    }))
    const rotated = extractDefaultRateLimitKey(makeContext({
      Authorization: 'bearer token-123',
    }))
    expect(first).toBe(rotated)
    expect(first).toMatch(/^ip:[a-f0-9]{64}$/)
    expect(first).not.toContain('my-token')
  })

  it('does not trust X-Forwarded-For by default', () => {
    const key = extractDefaultRateLimitKey(makeContext({
      'X-Forwarded-For': '10.0.0.1, 10.0.0.2',
    }))
    expect(key).toMatch(/^ip:[a-f0-9]{64}$/)
  })

  it('uses X-Forwarded-For when explicitly trusted', () => {
    const key = extractDefaultRateLimitKey(
      makeContext({
        'X-Forwarded-For': '10.0.0.1, 10.0.0.2',
      }),
      { trustForwardedFor: true },
    )
    expect(key).toMatch(/^ip:[a-f0-9]{64}$/)
    expect(key).not.toContain('10.0.0.1')
  })

  it('falls back to a hashed anonymous bucket when no key headers are present', () => {
    const key = extractDefaultRateLimitKey(makeContext({}))
    expect(key).toMatch(/^ip:[a-f0-9]{64}$/)
  })

  it('uses a resolved principal when available', () => {
    const key = extractDefaultRateLimitKey({
      ...makeContext({ Authorization: 'Bearer raw-token' }),
      get: () => ({ id: 'api-key-record' }),
    })
    expect(key).toBe('principal:api-key-record')
  })
})
