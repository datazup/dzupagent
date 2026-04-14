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
  it('extracts bearer token from Authorization header', () => {
    const key = extractDefaultRateLimitKey(makeContext({
      Authorization: 'Bearer my-token',
      'X-Forwarded-For': '1.2.3.4',
    }))
    expect(key).toBe('my-token')
  })

  it('supports case-insensitive bearer scheme and trims token', () => {
    const key = extractDefaultRateLimitKey(makeContext({
      Authorization: '  bearer   token-123  ',
    }))
    expect(key).toBe('token-123')
  })

  it('does not trust X-Forwarded-For by default', () => {
    const key = extractDefaultRateLimitKey(makeContext({
      'X-Forwarded-For': '10.0.0.1, 10.0.0.2',
    }))
    expect(key).toBe('anonymous')
  })

  it('uses X-Forwarded-For when explicitly trusted', () => {
    const key = extractDefaultRateLimitKey(
      makeContext({
        'X-Forwarded-For': '10.0.0.1, 10.0.0.2',
      }),
      { trustForwardedFor: true },
    )
    expect(key).toBe('10.0.0.1')
  })

  it('falls back to anonymous when no key headers are present', () => {
    const key = extractDefaultRateLimitKey(makeContext({}))
    expect(key).toBe('anonymous')
  })
})
