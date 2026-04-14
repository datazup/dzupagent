import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { HttpFetcher, RobotsDisallowedError } from '../http-fetcher.js'

function makeResponse(body: string, init?: { status?: number; headers?: Record<string, string>; url?: string }): Response {
  const response = new Response(body, {
    status: init?.status ?? 200,
    headers: init?.headers ?? { 'content-type': 'text/html' },
  })
  if (init?.url) {
    Object.defineProperty(response, 'url', { value: init.url })
  }
  return response
}

describe('RobotsDisallowedError', () => {
  it('has the correct name and message', () => {
    const err = new RobotsDisallowedError('https://example.com/private')
    expect(err.name).toBe('RobotsDisallowedError')
    expect(err.message).toBe('Blocked by robots.txt: https://example.com/private')
    expect(err).toBeInstanceOf(Error)
  })
})

describe('HttpFetcher - robots.txt parsing', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('allows all paths when robots.txt returns 404', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.endsWith('/robots.txt')) {
        return makeResponse('Not Found', { status: 404 })
      }
      return makeResponse('<html><body>' + 'A'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: true, maxRetries: 0 })
    const result = await fetcher.fetch('https://example.com/any-path')
    expect(result.status).toBe(200)
  })

  it('allows all paths when robots.txt fetch throws a network error', async () => {
    let callCount = 0
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.endsWith('/robots.txt')) {
        throw new Error('Network error fetching robots.txt')
      }
      callCount++
      return makeResponse('<html><body>' + 'B'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: true, maxRetries: 0 })
    const result = await fetcher.fetch('https://example.com/page')
    expect(result.status).toBe(200)
    expect(callCount).toBe(1)
  })

  it('handles robots.txt with multiple user-agent groups', async () => {
    const robotsTxt = [
      'User-agent: Googlebot',
      'Allow: /public',
      'Disallow: /',
      '',
      'User-agent: *',
      'Disallow: /admin',
    ].join('\n')

    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.endsWith('/robots.txt')) {
        return makeResponse(robotsTxt, { status: 200, headers: { 'content-type': 'text/plain' } })
      }
      return makeResponse('<html><body>' + 'C'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    // Default user-agent should match * group, which only disallows /admin
    const fetcher = new HttpFetcher({ respectRobotsTxt: true, maxRetries: 0 })
    const result = await fetcher.fetch('https://example.com/public')
    expect(result.status).toBe(200)
  })

  it('blocks disallowed paths under wildcard user-agent', async () => {
    const robotsTxt = 'User-agent: *\nDisallow: /secret'
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.endsWith('/robots.txt')) {
        return makeResponse(robotsTxt, { status: 200, headers: { 'content-type': 'text/plain' } })
      }
      return makeResponse('<html><body>secret</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: true, maxRetries: 0 })
    await expect(fetcher.fetch('https://example.com/secret/page')).rejects.toThrow('robots.txt')
  })

  it('allow rule overrides disallow when allow is more specific', async () => {
    const robotsTxt = 'User-agent: *\nDisallow: /docs\nAllow: /docs/public'
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.endsWith('/robots.txt')) {
        return makeResponse(robotsTxt, { status: 200, headers: { 'content-type': 'text/plain' } })
      }
      return makeResponse('<html><body>' + 'D'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: true, maxRetries: 0 })
    const result = await fetcher.fetch('https://example.com/docs/public/readme')
    expect(result.status).toBe(200)
  })

  it('caches robots.txt rules per origin', async () => {
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
    await fetcher.fetch('https://example.com/page1')
    await fetcher.fetch('https://example.com/page2')

    // robots.txt should only be fetched once for the same origin
    expect(robotsFetchCount).toBe(1)
  })

  it('handles robots.txt with comments and blank lines', async () => {
    const robotsTxt = [
      '# This is a comment',
      'User-agent: *',
      '',
      '# Block admin',
      'Disallow: /admin  # inline comment',
      'Allow: /',
    ].join('\n')

    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.endsWith('/robots.txt')) {
        return makeResponse(robotsTxt, { status: 200, headers: { 'content-type': 'text/plain' } })
      }
      return makeResponse('<html><body>' + 'F'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: true, maxRetries: 0 })
    const result = await fetcher.fetch('https://example.com/public-page')
    expect(result.status).toBe(200)
  })

  it('handles empty disallow (allows all)', async () => {
    const robotsTxt = 'User-agent: *\nDisallow:'
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.endsWith('/robots.txt')) {
        return makeResponse(robotsTxt, { status: 200, headers: { 'content-type': 'text/plain' } })
      }
      return makeResponse('<html><body>' + 'G'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: true, maxRetries: 0 })
    const result = await fetcher.fetch('https://example.com/anything')
    expect(result.status).toBe(200)
  })
})

describe('HttpFetcher - user-agent rotation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rotates through provided user-agents', async () => {
    const capturedUAs: string[] = []
    const fetchMock = vi.fn(async (_url: string | URL, opts?: RequestInit) => {
      const ua = (opts?.headers as Record<string, string>)?.['User-Agent']
      if (ua) capturedUAs.push(ua)
      return makeResponse('<html><body>' + 'H'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const customUAs = ['UA-One', 'UA-Two', 'UA-Three']
    const fetcher = new HttpFetcher({
      respectRobotsTxt: false,
      maxRetries: 0,
      userAgents: customUAs,
    })

    await fetcher.fetch('https://example.com/page1')
    await fetcher.fetch('https://example.com/page2')
    await fetcher.fetch('https://example.com/page3')
    await fetcher.fetch('https://example.com/page4')

    expect(capturedUAs[0]).toBe('UA-One')
    expect(capturedUAs[1]).toBe('UA-Two')
    expect(capturedUAs[2]).toBe('UA-Three')
    // Should wrap around
    expect(capturedUAs[3]).toBe('UA-One')
  })
})

describe('HttpFetcher - retry behavior', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('retries on 429 status and eventually succeeds', async () => {
    let callCount = 0
    const fetchMock = vi.fn(async () => {
      callCount++
      if (callCount <= 2) {
        return makeResponse('Too Many Requests', { status: 429 })
      }
      return makeResponse('<html><body>' + 'I'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({
      respectRobotsTxt: false,
      maxRetries: 3,
      retryDelayMs: 1, // minimal delay for tests
    })
    const result = await fetcher.fetch('https://example.com/rate-limited')
    expect(result.status).toBe(200)
    expect(callCount).toBe(3)
  })

  it('retries on 502, 503, 504 status codes', async () => {
    const statusCodes = [502, 503, 504]
    for (const statusCode of statusCodes) {
      let callCount = 0
      const fetchMock = vi.fn(async () => {
        callCount++
        if (callCount === 1) {
          return makeResponse('Error', { status: statusCode })
        }
        return makeResponse('<html><body>' + 'J'.repeat(120) + '</body></html>')
      })
      vi.stubGlobal('fetch', fetchMock)

      const fetcher = new HttpFetcher({
        respectRobotsTxt: false,
        maxRetries: 2,
        retryDelayMs: 1,
      })
      const result = await fetcher.fetch('https://example.com/retry')
      expect(result.status).toBe(200)
      expect(callCount).toBe(2)
    }
  })

  it('returns last response after exhausting all retries on retryable status', async () => {
    const fetchMock = vi.fn(async () => {
      return makeResponse('Service Unavailable', { status: 503 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({
      respectRobotsTxt: false,
      maxRetries: 2,
      retryDelayMs: 1,
    })
    // When all retries return retryable status, the last response is returned (not thrown)
    const result = await fetcher.fetch('https://example.com/always-fails')
    expect(result.status).toBe(503)
    // Total calls = initial + 2 retries = 3
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('throws after exhausting all retries on network errors', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({
      respectRobotsTxt: false,
      maxRetries: 2,
      retryDelayMs: 1,
    })
    await expect(fetcher.fetch('https://example.com/always-fails')).rejects.toThrow(
      /Failed to fetch.*after 3 attempts/,
    )
  })

  it('does not retry on non-retryable status codes like 400 or 404', async () => {
    let callCount = 0
    const fetchMock = vi.fn(async () => {
      callCount++
      return makeResponse('Not Found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({
      respectRobotsTxt: false,
      maxRetries: 3,
      retryDelayMs: 1,
    })
    const result = await fetcher.fetch('https://example.com/not-found')
    expect(result.status).toBe(404)
    expect(callCount).toBe(1) // No retry
  })

  it('does not retry on network errors that are AbortError (timeout)', async () => {
    const fetchMock = vi.fn(async () => {
      const err = new DOMException('The operation was aborted.', 'AbortError')
      throw err
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({
      respectRobotsTxt: false,
      maxRetries: 3,
      retryDelayMs: 1,
    })
    await expect(fetcher.fetch('https://example.com/timeout')).rejects.toThrow(
      /Failed to fetch/,
    )
    // Should only call once since AbortError breaks the loop
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('HttpFetcher - configuration defaults', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses default config values when no config is provided', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.endsWith('/robots.txt')) {
        return makeResponse('User-agent: *\nAllow: /', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        })
      }
      return makeResponse('<html><body>' + 'K'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher()
    const result = await fetcher.fetch('https://example.com/')
    expect(result.status).toBe(200)
    expect(result.method).toBe('http')
    expect(result.url).toBeDefined()
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('skips robots.txt check when respectRobotsTxt is false', async () => {
    let robotsFetched = false
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.endsWith('/robots.txt')) {
        robotsFetched = true
        return makeResponse('User-agent: *\nDisallow: /', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        })
      }
      return makeResponse('<html><body>' + 'L'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 0 })
    const result = await fetcher.fetch('https://example.com/blocked-path')
    expect(result.status).toBe(200)
    expect(robotsFetched).toBe(false)
  })
})

describe('HttpFetcher - response handling', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns content-type from response headers', async () => {
    const fetchMock = vi.fn(async () =>
      makeResponse('<html><body>' + 'M'.repeat(120) + '</body></html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 0 })
    const result = await fetcher.fetch('https://example.com/')
    expect(result.contentType).toBe('text/html; charset=utf-8')
  })

  it('defaults content-type to text/html when header is missing', async () => {
    const response = new Response('<html><body>' + 'N'.repeat(120) + '</body></html>', {
      status: 200,
    })
    // Remove content-type header
    response.headers.delete('content-type')
    const fetchMock = vi.fn(async () => response)
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 0 })
    const result = await fetcher.fetch('https://example.com/')
    expect(result.contentType).toBe('text/html')
  })

  it('includes html in result', async () => {
    const html = '<html><body><p>Full HTML content</p></body></html>'
    const fetchMock = vi.fn(async () => makeResponse(html))
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 0 })
    const result = await fetcher.fetch('https://example.com/')
    expect(result.html).toBe(html)
  })

  it('extracts metadata in "all" extraction mode by default', async () => {
    const html = `<html>
      <head>
        <title>Test Page</title>
        <meta name="description" content="Test description">
        <meta name="author" content="Test Author">
      </head>
      <body><p>Body content</p></body>
    </html>`
    const fetchMock = vi.fn(async () => makeResponse(html))
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 0 })
    const result = await fetcher.fetch('https://example.com/')
    expect(result.title).toBe('Test Page')
    expect(result.description).toBe('Test description')
    expect(result.author).toBe('Test Author')
  })
})
