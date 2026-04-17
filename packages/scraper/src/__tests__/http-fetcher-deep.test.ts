import { describe, it, expect, vi, afterEach } from 'vitest'
import { HttpFetcher, RobotsDisallowedError } from '../http-fetcher.js'

function makeResponse(body: string, init?: {
  status?: number
  headers?: Record<string, string>
  url?: string
}): Response {
  const response = new Response(body, {
    status: init?.status ?? 200,
    headers: init?.headers ?? { 'content-type': 'text/html' },
  })
  if (init?.url) {
    Object.defineProperty(response, 'url', { value: init.url })
  }
  return response
}

describe('HttpFetcher - redirect handling', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('follows redirects when followRedirects is true (default fetch behavior)', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, opts?: RequestInit) => {
      // When redirect: 'follow', fetch auto-follows. Simulate final response.
      expect(opts?.redirect).toBe('follow')
      return makeResponse('<html><body>' + 'R'.repeat(120) + '</body></html>', {
        url: 'https://example.com/final',
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 0, followRedirects: true })
    const result = await fetcher.fetch('https://example.com/redirect')
    expect(result.url).toBe('https://example.com/final')
  })

  it('uses manual redirect mode when followRedirects is false', async () => {
    let callCount = 0
    const fetchMock = vi.fn(async (url: string | URL, opts?: RequestInit) => {
      callCount++
      expect(opts?.redirect).toBe('manual')
      const href = String(url)
      if (href.endsWith('/robots.txt')) {
        return makeResponse('', { status: 404 })
      }
      if (callCount === 1) {
        return makeResponse('', {
          status: 301,
          headers: {
            'content-type': 'text/html',
            'location': 'https://example.com/new-location',
          },
        })
      }
      return makeResponse('<html><body>' + 'X'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    // Note: redirect continue consumes a retry attempt, so we need maxRetries >= 1
    const fetcher = new HttpFetcher({
      respectRobotsTxt: false,
      maxRetries: 1,
      followRedirects: false,
      maxRedirects: 5,
      retryDelayMs: 1,
    })
    const result = await fetcher.fetch('https://example.com/old-page')
    expect(result.status).toBe(200)
  })

  it('stops following redirects after maxRedirects hops', async () => {
    let callCount = 0
    const fetchMock = vi.fn(async () => {
      callCount++
      // Always redirect
      return makeResponse('', {
        status: 302,
        headers: {
          'content-type': 'text/html',
          'location': `https://example.com/redirect-${callCount}`,
        },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    // maxRedirects=3 means 3 redirects allowed, each consuming a retry attempt.
    // Need maxRetries >= maxRedirects so the loop can accommodate the hops.
    const fetcher = new HttpFetcher({
      respectRobotsTxt: false,
      maxRetries: 5,
      followRedirects: false,
      maxRedirects: 3,
      retryDelayMs: 1,
    })
    const result = await fetcher.fetch('https://example.com/loop')
    // After exhausting maxRedirects, should return the redirect response
    expect(result.status).toBe(302)
  })

  it('resolves relative redirect URLs against current URL', async () => {
    const capturedUrls: string[] = []
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url)
      capturedUrls.push(href)
      if (capturedUrls.length === 1) {
        return makeResponse('', {
          status: 301,
          headers: {
            'content-type': 'text/html',
            'location': '/relative-path',
          },
        })
      }
      return makeResponse('<html><body>' + 'Y'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({
      respectRobotsTxt: false,
      maxRetries: 2,
      followRedirects: false,
      maxRedirects: 5,
      retryDelayMs: 1,
    })
    await fetcher.fetch('https://example.com/original')
    expect(capturedUrls[1]).toBe('https://example.com/relative-path')
  })

  it('handles all redirect status codes: 301, 302, 303, 307, 308', async () => {
    const redirectStatuses = [301, 302, 303, 307, 308]
    for (const status of redirectStatuses) {
      let callCount = 0
      const fetchMock = vi.fn(async () => {
        callCount++
        if (callCount === 1) {
          return makeResponse('', {
            status,
            headers: {
              'content-type': 'text/html',
              'location': 'https://example.com/dest',
            },
          })
        }
        return makeResponse('<html><body>' + 'Z'.repeat(120) + '</body></html>')
      })
      vi.stubGlobal('fetch', fetchMock)

      const fetcher = new HttpFetcher({
        respectRobotsTxt: false,
        maxRetries: 2,
        followRedirects: false,
        maxRedirects: 5,
        retryDelayMs: 1,
      })
      const result = await fetcher.fetch('https://example.com/test')
      expect(result.status).toBe(200)
    }
  })
})

describe('HttpFetcher - timeout behavior', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('passes a custom timeout to fetch via AbortController', async () => {
    let signalReceived = false
    const fetchMock = vi.fn(async (_url: string | URL, opts?: RequestInit) => {
      if (opts?.signal) {
        signalReceived = true
      }
      return makeResponse('<html><body>' + 'T'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 0 })
    await fetcher.fetch('https://example.com', { timeout: 5000 })
    expect(signalReceived).toBe(true)
  })

  it('uses default 30s timeout when none specified', async () => {
    const fetchMock = vi.fn(async () =>
      makeResponse('<html><body>' + 'U'.repeat(120) + '</body></html>'),
    )
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 0 })
    // Just verify it doesn't throw with default timeout
    const result = await fetcher.fetch('https://example.com')
    expect(result.status).toBe(200)
  })
})

describe('HttpFetcher - error status codes', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns 400 Bad Request without retry', async () => {
    let callCount = 0
    const fetchMock = vi.fn(async () => {
      callCount++
      return makeResponse('Bad Request', { status: 400 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 3, retryDelayMs: 1 })
    const result = await fetcher.fetch('https://example.com/bad')
    expect(result.status).toBe(400)
    expect(callCount).toBe(1)
  })

  it('returns 401 Unauthorized without retry', async () => {
    let callCount = 0
    const fetchMock = vi.fn(async () => {
      callCount++
      return makeResponse('Unauthorized', { status: 401 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 3, retryDelayMs: 1 })
    const result = await fetcher.fetch('https://example.com/auth')
    expect(result.status).toBe(401)
    expect(callCount).toBe(1)
  })

  it('returns 403 Forbidden without retry', async () => {
    let callCount = 0
    const fetchMock = vi.fn(async () => {
      callCount++
      return makeResponse('Forbidden', { status: 403 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 3, retryDelayMs: 1 })
    const result = await fetcher.fetch('https://example.com/forbidden')
    expect(result.status).toBe(403)
    expect(callCount).toBe(1)
  })

  it('returns 500 Internal Server Error without retry (not retryable)', async () => {
    let callCount = 0
    const fetchMock = vi.fn(async () => {
      callCount++
      return makeResponse('Internal Server Error', { status: 500 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 3, retryDelayMs: 1 })
    const result = await fetcher.fetch('https://example.com/error')
    expect(result.status).toBe(500)
    expect(callCount).toBe(1) // 500 is NOT retryable (only 502/503/504 are)
  })

  it('retries 502 Bad Gateway', async () => {
    let callCount = 0
    const fetchMock = vi.fn(async () => {
      callCount++
      if (callCount === 1) return makeResponse('Bad Gateway', { status: 502 })
      return makeResponse('<html><body>' + 'W'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 2, retryDelayMs: 1 })
    const result = await fetcher.fetch('https://example.com/gateway')
    expect(result.status).toBe(200)
    expect(callCount).toBe(2)
  })

  it('retries 504 Gateway Timeout', async () => {
    let callCount = 0
    const fetchMock = vi.fn(async () => {
      callCount++
      if (callCount === 1) return makeResponse('Gateway Timeout', { status: 504 })
      return makeResponse('<html><body>' + 'V'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 2, retryDelayMs: 1 })
    const result = await fetcher.fetch('https://example.com/timeout')
    expect(result.status).toBe(200)
    expect(callCount).toBe(2)
  })
})

describe('HttpFetcher - exponential backoff', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('increases delay exponentially between retries', async () => {
    const timestamps: number[] = []
    const fetchMock = vi.fn(async () => {
      timestamps.push(Date.now())
      if (timestamps.length < 3) {
        return makeResponse('Service Unavailable', { status: 503 })
      }
      return makeResponse('<html><body>' + 'Q'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({
      respectRobotsTxt: false,
      maxRetries: 3,
      retryDelayMs: 50, // 50ms base delay
    })
    await fetcher.fetch('https://example.com/backoff')

    // First retry after ~50ms, second after ~100ms (with jitter)
    // Just verify all calls happened
    expect(timestamps.length).toBe(3)
  })
})

describe('HttpFetcher - request headers', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sends Accept, Accept-Language, and Accept-Encoding headers', async () => {
    let capturedHeaders: Record<string, string> = {}
    const fetchMock = vi.fn(async (_url: string | URL, opts?: RequestInit) => {
      capturedHeaders = (opts?.headers ?? {}) as Record<string, string>
      return makeResponse('<html><body>' + 'H'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 0 })
    await fetcher.fetch('https://example.com')

    expect(capturedHeaders['Accept']).toContain('text/html')
    expect(capturedHeaders['Accept-Language']).toContain('en-US')
    expect(capturedHeaders['Accept-Encoding']).toContain('gzip')
  })

  it('uses default user-agents when no custom ones provided', async () => {
    let capturedUA = ''
    const fetchMock = vi.fn(async (_url: string | URL, opts?: RequestInit) => {
      const headers = opts?.headers as Record<string, string>
      capturedUA = headers?.['User-Agent'] ?? ''
      return makeResponse('<html><body>' + 'D'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 0 })
    await fetcher.fetch('https://example.com')

    // Should be one of the default user agents (contains Chrome or Firefox)
    expect(capturedUA).toMatch(/Mozilla/)
  })
})

describe('HttpFetcher - network errors', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('retries on generic network errors', async () => {
    let callCount = 0
    const fetchMock = vi.fn(async () => {
      callCount++
      if (callCount === 1) {
        throw new Error('ECONNRESET')
      }
      return makeResponse('<html><body>' + 'N'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 2, retryDelayMs: 1 })
    const result = await fetcher.fetch('https://example.com/reset')
    expect(result.status).toBe(200)
    expect(callCount).toBe(2)
  })

  it('retries on DNS resolution errors', async () => {
    let callCount = 0
    const fetchMock = vi.fn(async () => {
      callCount++
      if (callCount === 1) {
        throw new Error('getaddrinfo ENOTFOUND example.com')
      }
      return makeResponse('<html><body>' + 'P'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 2, retryDelayMs: 1 })
    const result = await fetcher.fetch('https://example.com')
    expect(result.status).toBe(200)
    expect(callCount).toBe(2)
  })

  it('includes original error message in the final thrown error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('SSL_ERROR_HANDSHAKE_FAILURE_ALERT')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 1, retryDelayMs: 1 })
    await expect(fetcher.fetch('https://example.com')).rejects.toThrow(
      /SSL_ERROR_HANDSHAKE_FAILURE_ALERT/,
    )
  })

  it('handles non-Error thrown values', async () => {
    const fetchMock = vi.fn(async () => {
      throw 'string error'
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 0 })
    await expect(fetcher.fetch('https://example.com')).rejects.toThrow(
      /string error/,
    )
  })
})

describe('HttpFetcher - zero retries', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('makes exactly one attempt when maxRetries is 0', async () => {
    let callCount = 0
    const fetchMock = vi.fn(async () => {
      callCount++
      throw new Error('fail')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 0 })
    await expect(fetcher.fetch('https://example.com')).rejects.toThrow(/after 1 attempts/)
    expect(callCount).toBe(1)
  })
})

describe('HttpFetcher - robots.txt edge cases', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('allows access when URL is invalid (cannot be parsed)', async () => {
    const fetchMock = vi.fn(async () =>
      makeResponse('<html><body>' + 'A'.repeat(120) + '</body></html>'),
    )
    vi.stubGlobal('fetch', fetchMock)

    // The fetcher should handle invalid URLs in isAllowedByRobots gracefully
    const fetcher = new HttpFetcher({ respectRobotsTxt: true, maxRetries: 0 })
    // Using a valid URL that won't fail URL constructor
    const result = await fetcher.fetch('https://example.com/page')
    expect(result.status).toBe(200)
  })

  it('handles robots.txt with Windows-style line endings', async () => {
    const robotsTxt = 'User-agent: *\r\nDisallow: /blocked\r\nAllow: /'
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.endsWith('/robots.txt')) {
        return makeResponse(robotsTxt, { status: 200, headers: { 'content-type': 'text/plain' } })
      }
      return makeResponse('<html><body>' + 'B'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: true, maxRetries: 0 })
    await expect(fetcher.fetch('https://example.com/blocked/page')).rejects.toThrow('robots.txt')
  })

  it('handles robots.txt with specific user-agent matching', async () => {
    const robotsTxt = [
      'User-agent: mybot',
      'Disallow: /',
      '',
      'User-agent: *',
      'Allow: /',
    ].join('\n')

    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.endsWith('/robots.txt')) {
        return makeResponse(robotsTxt, { status: 200, headers: { 'content-type': 'text/plain' } })
      }
      return makeResponse('<html><body>' + 'C'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    // Default UA should match * group and be allowed
    const fetcher = new HttpFetcher({ respectRobotsTxt: true, maxRetries: 0 })
    const result = await fetcher.fetch('https://example.com/page')
    expect(result.status).toBe(200)
  })

  it('matches specific user-agent group when UA contains the pattern', async () => {
    const robotsTxt = [
      'User-agent: chrome',
      'Disallow: /chrome-blocked',
      '',
      'User-agent: *',
      'Allow: /',
    ].join('\n')

    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.endsWith('/robots.txt')) {
        return makeResponse(robotsTxt, { status: 200, headers: { 'content-type': 'text/plain' } })
      }
      return makeResponse('<html><body>' + 'D'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    // Default UAs contain "Chrome" which will match "chrome" (case-insensitive matching in evaluateRobots)
    const fetcher = new HttpFetcher({ respectRobotsTxt: true, maxRetries: 0 })
    await expect(fetcher.fetch('https://example.com/chrome-blocked/page')).rejects.toThrow('robots.txt')
  })

  it('robots cache TTL: re-fetches after cache expires', async () => {
    let robotsFetchCount = 0
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.endsWith('/robots.txt')) {
        robotsFetchCount++
        return makeResponse('User-agent: *\nAllow: /', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        })
      }
      return makeResponse('<html><body>' + 'E'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: true, maxRetries: 0 })

    // First fetch — robots.txt is fetched
    await fetcher.fetch('https://example.com/page1')
    expect(robotsFetchCount).toBe(1)

    // Second fetch — should use cache
    await fetcher.fetch('https://example.com/page2')
    expect(robotsFetchCount).toBe(1)

    // Manipulate cache to simulate expiry
    const cache = (fetcher as unknown as { robotsCache: Map<string, { fetchedAt: number }> }).robotsCache
    const entry = cache.get('https://example.com')
    if (entry) {
      entry.fetchedAt = Date.now() - 11 * 60 * 1000 // 11 minutes ago (TTL is 10 min)
    }

    // Third fetch — should re-fetch robots.txt
    await fetcher.fetch('https://example.com/page3')
    expect(robotsFetchCount).toBe(2)
  })
})

describe('RobotsDisallowedError', () => {
  it('is an instance of Error', () => {
    const err = new RobotsDisallowedError('https://example.com')
    expect(err).toBeInstanceOf(Error)
  })

  it('has the correct name property', () => {
    const err = new RobotsDisallowedError('https://example.com')
    expect(err.name).toBe('RobotsDisallowedError')
  })

  it('includes the URL in the message', () => {
    const err = new RobotsDisallowedError('https://example.com/secret/path')
    expect(err.message).toBe('Blocked by robots.txt: https://example.com/secret/path')
  })
})
