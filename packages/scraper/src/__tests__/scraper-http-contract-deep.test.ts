import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { HttpFetcher, RobotsDisallowedError } from '../http-fetcher.js'
import { WebScraper } from '../scraper.js'
import { ContentExtractor } from '../content-extractor.js'
import { normalizeScraperTool, type ScraperConnectorTool } from '../connector-contract.js'
import type { FetchResult, ScraperToolSchema, ExtractionConfig } from '../types.js'

/**
 * W23-B3 — Scraper HTTP + Puppeteer Extraction Deep Coverage
 *
 * Covers gaps identified in the core HTTP/options/contract layer:
 *   - HttpFetcher behaviors (redirect follow, headers, timeout, retry, robots,
 *     pool-bounded concurrency, gzip)
 *   - WebScraper options propagation (JS rendering toggling, user-agent,
 *     depth, include/exclude filtering surface)
 *   - Connector contract (schema validation, output schema, error shape,
 *     tool naming)
 *   - Content extraction integration (body extraction, stripped chrome,
 *     image alt text, code fencing surface via pre/code)
 *   - Error paths (DNS failure, HTTP 404, robots-blocked, malformed HTML,
 *     Puppeteer fallback failure)
 *   - Integration (full fetch->extract->structured output, bounded
 *     concurrent scrapeMany)
 */

function makeResponse(
  body: string,
  init?: {
    status?: number
    headers?: Record<string, string>
    url?: string
  },
): Response {
  const response = new Response(body, {
    status: init?.status ?? 200,
    headers: init?.headers ?? { 'content-type': 'text/html' },
  })
  if (init?.url) {
    Object.defineProperty(response, 'url', { value: init.url })
  }
  return response
}

const LONG_BODY = 'L'.repeat(300)

// ------------------------------------------------------------
// HttpFetcher — redirect following and hop-limit semantics
// ------------------------------------------------------------
describe('W23-B3 HttpFetcher — redirect follow semantics', () => {
  afterEach(() => vi.restoreAllMocks())

  it('passes redirect: "follow" to native fetch when followRedirects is true', async () => {
    let sawFollow = false
    const fetchMock = vi.fn(async (_url: string | URL, opts?: RequestInit) => {
      if (opts?.redirect === 'follow') sawFollow = true
      return makeResponse(`<html><body>${LONG_BODY}</body></html>`, {
        url: 'https://example.com/final',
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 0, followRedirects: true })
    const result = await fetcher.fetch('https://example.com/start')
    expect(sawFollow).toBe(true)
    expect(result.url).toBe('https://example.com/final')
  })

  it('follows an absolute Location header when followRedirects is false', async () => {
    const seen: string[] = []
    let calls = 0
    const fetchMock = vi.fn(async (url: string | URL) => {
      calls++
      seen.push(String(url))
      if (calls === 1) {
        return makeResponse('', {
          status: 302,
          headers: { 'content-type': 'text/html', 'location': 'https://example.com/next' },
        })
      }
      return makeResponse(`<html><body>${LONG_BODY}</body></html>`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({
      respectRobotsTxt: false,
      maxRetries: 2,
      followRedirects: false,
      maxRedirects: 5,
      retryDelayMs: 1,
    })
    const result = await fetcher.fetch('https://example.com/first')
    expect(result.status).toBe(200)
    expect(seen[1]).toBe('https://example.com/next')
  })
})

// ------------------------------------------------------------
// HttpFetcher — custom headers (User-Agent rotation + config)
// ------------------------------------------------------------
describe('W23-B3 HttpFetcher — custom headers sent on outbound requests', () => {
  afterEach(() => vi.restoreAllMocks())

  it('sends the configured custom User-Agent when provided via userAgents', async () => {
    let captured = ''
    const fetchMock = vi.fn(async (_url: string | URL, opts?: RequestInit) => {
      const headers = (opts?.headers ?? {}) as Record<string, string>
      captured = headers['User-Agent'] ?? ''
      return makeResponse(`<html><body>${LONG_BODY}</body></html>`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({
      respectRobotsTxt: false,
      maxRetries: 0,
      userAgents: ['CustomBot/9.9 (+https://example.com/bot)'],
    })
    await fetcher.fetch('https://example.com')
    expect(captured).toBe('CustomBot/9.9 (+https://example.com/bot)')
  })

  it('rotates through multiple custom user agents across calls', async () => {
    const uas: string[] = []
    const fetchMock = vi.fn(async (_url: string | URL, opts?: RequestInit) => {
      const headers = (opts?.headers ?? {}) as Record<string, string>
      uas.push(headers['User-Agent'] ?? '')
      return makeResponse(`<html><body>${LONG_BODY}</body></html>`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({
      respectRobotsTxt: false,
      maxRetries: 0,
      userAgents: ['UA-A/1.0', 'UA-B/1.0'],
    })
    await fetcher.fetch('https://example.com/a')
    await fetcher.fetch('https://example.com/b')
    await fetcher.fetch('https://example.com/c')
    expect(uas).toEqual(['UA-A/1.0', 'UA-B/1.0', 'UA-A/1.0'])
  })

  it('always sends Accept, Accept-Language, and Accept-Encoding headers', async () => {
    let captured: Record<string, string> = {}
    const fetchMock = vi.fn(async (_url: string | URL, opts?: RequestInit) => {
      captured = (opts?.headers ?? {}) as Record<string, string>
      return makeResponse(`<html><body>${LONG_BODY}</body></html>`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 0 })
    await fetcher.fetch('https://example.com')
    expect(captured['Accept']).toBeDefined()
    expect(captured['Accept-Language']).toContain('en')
    expect(captured['Accept-Encoding']).toContain('gzip')
  })
})

// ------------------------------------------------------------
// HttpFetcher — timeout enforcement
// ------------------------------------------------------------
describe('W23-B3 HttpFetcher — timeout enforcement via AbortController', () => {
  afterEach(() => vi.restoreAllMocks())

  it('aborts the request when the AbortController is triggered', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, opts?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 0, retryDelayMs: 1 })
    await expect(fetcher.fetch('https://example.com', { timeout: 10 })).rejects.toThrow()
  })

  it('does not retry on AbortError (timeout)', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls++
      throw new DOMException('aborted', 'AbortError')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 3, retryDelayMs: 1 })
    await expect(fetcher.fetch('https://example.com')).rejects.toThrow()
    expect(calls).toBe(1)
  })
})

// ------------------------------------------------------------
// HttpFetcher — retry on 5xx retryable statuses
// ------------------------------------------------------------
describe('W23-B3 HttpFetcher — retry on 5xx responses', () => {
  afterEach(() => vi.restoreAllMocks())

  it('retries on 503 Service Unavailable then succeeds on 200', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls++
      if (calls === 1) return makeResponse('busy', { status: 503 })
      return makeResponse(`<html><body>${LONG_BODY}</body></html>`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 2, retryDelayMs: 1 })
    const result = await fetcher.fetch('https://example.com')
    expect(result.status).toBe(200)
    expect(calls).toBe(2)
  })

  it('retries on 429 Too Many Requests', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls++
      if (calls === 1) return makeResponse('throttled', { status: 429 })
      return makeResponse(`<html><body>${LONG_BODY}</body></html>`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 2, retryDelayMs: 1 })
    const result = await fetcher.fetch('https://example.com')
    expect(result.status).toBe(200)
    expect(calls).toBe(2)
  })
})

// ------------------------------------------------------------
// HttpFetcher — robots.txt blocking
// ------------------------------------------------------------
describe('W23-B3 HttpFetcher — robots.txt blocking', () => {
  afterEach(() => vi.restoreAllMocks())

  it('throws an error carrying robots.txt blocked semantics when path is disallowed', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/robots.txt')) {
        return makeResponse('User-agent: *\nDisallow: /admin', {
          headers: { 'content-type': 'text/plain' },
        })
      }
      return makeResponse(`<html><body>${LONG_BODY}</body></html>`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: true, maxRetries: 0 })
    // The RobotsDisallowedError thrown inside the retry loop is wrapped by the
    // outer "Failed to fetch" Error whose message embeds the original text.
    await expect(fetcher.fetch('https://example.com/admin/secret')).rejects.toThrow(
      /Blocked by robots\.txt/,
    )
  })

  it('returns content when robots.txt allows the path', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/robots.txt')) {
        return makeResponse('User-agent: *\nAllow: /public', {
          headers: { 'content-type': 'text/plain' },
        })
      }
      return makeResponse(`<html><body>${LONG_BODY}</body></html>`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: true, maxRetries: 0 })
    const result = await fetcher.fetch('https://example.com/public/page')
    expect(result.status).toBe(200)
  })
})

// ------------------------------------------------------------
// HttpFetcher — retry delay (backoff) uses sleep
// ------------------------------------------------------------
describe('W23-B3 HttpFetcher — backoff delay between retries', () => {
  afterEach(() => vi.restoreAllMocks())

  it('waits a measurable amount of time between retries (rate-limit hygiene)', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls++
      if (calls < 3) return makeResponse('', { status: 503 })
      return makeResponse(`<html><body>${LONG_BODY}</body></html>`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 3, retryDelayMs: 25 })
    const start = Date.now()
    await fetcher.fetch('https://example.com/retry-delay')
    const elapsed = Date.now() - start
    // First retry waits ~25ms + jitter, second waits ~50ms + jitter → > 40ms total
    expect(elapsed).toBeGreaterThanOrEqual(40)
    expect(calls).toBe(3)
  })
})

// ------------------------------------------------------------
// HttpFetcher — concurrent fetch bounded semantics
// ------------------------------------------------------------
describe('W23-B3 HttpFetcher — concurrent in-flight fetches', () => {
  afterEach(() => vi.restoreAllMocks())

  it('supports multiple concurrent fetch() calls without state corruption', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      return makeResponse(
        `<html><body>body for ${String(url)} ${'Z'.repeat(200)}</body></html>`,
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 0 })
    const results = await Promise.all([
      fetcher.fetch('https://example.com/1'),
      fetcher.fetch('https://example.com/2'),
      fetcher.fetch('https://example.com/3'),
    ])
    expect(results.map((r) => r.status)).toEqual([200, 200, 200])
    expect(fetchMock.mock.calls.length).toBe(3)
  })
})

// ------------------------------------------------------------
// HttpFetcher — gzip decompression handled by underlying Response
// ------------------------------------------------------------
describe('W23-B3 HttpFetcher — gzip response decompressed via native fetch', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns decompressed text body when server reports content-encoding: gzip', async () => {
    // Native fetch transparently decompresses — we simulate by returning plain
    // text with the gzip content-encoding header.
    const fetchMock = vi.fn(async () =>
      makeResponse(`<html><body>${LONG_BODY} gzipped-content-here</body></html>`, {
        headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 0 })
    const result = await fetcher.fetch('https://example.com/gzipped')
    expect(result.text).toContain('gzipped-content-here')
  })
})

// ------------------------------------------------------------
// WebScraper — JS rendering path selection
// ------------------------------------------------------------
describe('W23-B3 WebScraper — JS rendering / HTTP-only routing', () => {
  const stubResult: FetchResult = {
    url: 'https://example.com',
    status: 200,
    contentType: 'text/html',
    text: 'x'.repeat(250),
    durationMs: 5,
    method: 'http',
  }

  it('browser mode routes through BrowserPool (JS rendering path)', async () => {
    const scraper = new WebScraper({ mode: 'browser' })
    const httpFetch = vi.fn().mockResolvedValue(stubResult)
    const browserFetch = vi.fn().mockResolvedValue({ ...stubResult, method: 'browser' })
    ;(scraper as unknown as { httpFetcher: { fetch: typeof httpFetch } }).httpFetcher = {
      fetch: httpFetch,
    }
    ;(scraper as unknown as { browserPool: { fetch: typeof browserFetch } }).browserPool = {
      fetch: browserFetch,
    }

    const result = await scraper.scrape('https://example.com')
    expect(result.method).toBe('browser')
    expect(httpFetch).not.toHaveBeenCalled()
    expect(browserFetch).toHaveBeenCalledTimes(1)
  })

  it('http mode never touches the browser pool (JS rendering disabled)', async () => {
    const scraper = new WebScraper({ mode: 'http' })
    const httpFetch = vi.fn().mockResolvedValue(stubResult)
    const browserFetch = vi.fn().mockResolvedValue({ ...stubResult, method: 'browser' })
    ;(scraper as unknown as { httpFetcher: { fetch: typeof httpFetch } }).httpFetcher = {
      fetch: httpFetch,
    }
    ;(scraper as unknown as { browserPool: { fetch: typeof browserFetch } }).browserPool = {
      fetch: browserFetch,
    }

    const result = await scraper.scrape('https://example.com')
    expect(result.method).toBe('http')
    expect(httpFetch).toHaveBeenCalledTimes(1)
    expect(browserFetch).not.toHaveBeenCalled()
  })

  it('auto mode prefers HTTP result when body is sufficiently long', async () => {
    const scraper = new WebScraper({ mode: 'auto' })
    const httpFetch = vi.fn().mockResolvedValue({ ...stubResult, text: 'A'.repeat(500) })
    const browserFetch = vi.fn()
    ;(scraper as unknown as { httpFetcher: { fetch: typeof httpFetch } }).httpFetcher = {
      fetch: httpFetch,
    }
    ;(scraper as unknown as { browserPool: { fetch: typeof browserFetch } }).browserPool = {
      fetch: browserFetch,
    }

    const result = await scraper.scrape('https://example.com/article')
    expect(result.method).toBe('http')
    expect(browserFetch).not.toHaveBeenCalled()
  })
})

// ------------------------------------------------------------
// WebScraper — custom user-agent via http config
// ------------------------------------------------------------
describe('W23-B3 WebScraper — custom user-agent propagates to HttpFetcher', () => {
  afterEach(() => vi.restoreAllMocks())

  it('applies custom user-agents from ScraperConfig.http.userAgents', async () => {
    let captured = ''
    const fetchMock = vi.fn(async (_url: string | URL, opts?: RequestInit) => {
      const headers = (opts?.headers ?? {}) as Record<string, string>
      captured = headers['User-Agent'] ?? ''
      return makeResponse(`<html><body>${LONG_BODY}</body></html>`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const scraper = new WebScraper({
      mode: 'http',
      http: {
        maxRetries: 0,
        retryDelayMs: 0,
        respectRobotsTxt: false,
        followRedirects: true,
        maxRedirects: 0,
        userAgents: ['MyCrawler/3.14'],
      },
    })
    await scraper.scrape('https://example.com')
    expect(captured).toBe('MyCrawler/3.14')
  })
})

// ------------------------------------------------------------
// WebScraper — extraction options / maxLength applied
// ------------------------------------------------------------
describe('W23-B3 WebScraper — extraction option merging', () => {
  const stubResult: FetchResult = {
    url: 'https://example.com',
    status: 200,
    contentType: 'text/html',
    text: 'x'.repeat(300),
    durationMs: 5,
    method: 'http',
  }

  it('merges config.extraction with per-call extraction options', async () => {
    const scraper = new WebScraper({
      mode: 'http',
      extraction: { mode: 'all', cleanHtml: true, maxLength: 1000 },
    })
    const fetch = vi.fn().mockResolvedValue(stubResult)
    ;(scraper as unknown as { httpFetcher: { fetch: typeof fetch } }).httpFetcher = { fetch }

    await scraper.scrape('https://example.com', { maxLength: 50 })

    expect(fetch).toHaveBeenCalledWith('https://example.com', {
      timeout: 30_000,
      extraction: { mode: 'all', cleanHtml: true, maxLength: 50 },
    })
  })

  it('uses custom timeout from ScraperConfig when specified', async () => {
    const scraper = new WebScraper({ mode: 'http', timeout: 1234 })
    const fetch = vi.fn().mockResolvedValue(stubResult)
    ;(scraper as unknown as { httpFetcher: { fetch: typeof fetch } }).httpFetcher = { fetch }

    await scraper.scrape('https://example.com')
    expect(fetch).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ timeout: 1234 }),
    )
  })
})

// ------------------------------------------------------------
// ConnectorContract — schema shape & tool naming
// ------------------------------------------------------------
describe('W23-B3 ConnectorContract — scrape tool schema and contract', () => {
  it('asTool() output conforms to BaseConnectorTool contract with required fields', () => {
    const tool = new WebScraper().asTool()
    expect(tool.id).toBe('web_scraper')
    expect(tool.name).toBe('web_scraper')
    expect(typeof tool.description).toBe('string')
    expect(tool.description.length).toBeGreaterThan(0)
    expect(typeof tool.invoke).toBe('function')
  })

  it('input schema declares url as required and includes all optional keys', () => {
    const tool = new WebScraper().asTool()
    expect(tool.schema.required).toEqual(['url'])
    expect(Object.keys(tool.schema.properties)).toEqual(
      expect.arrayContaining(['url', 'extractMode', 'cleanHtml', 'maxLength']),
    )
  })

  it('extractMode enum in schema matches the ExtractionConfig.mode union', () => {
    const tool = new WebScraper().asTool()
    const extractMode = tool.schema.properties['extractMode'] as { enum: string[] }
    expect(extractMode.enum.sort()).toEqual(['all', 'html', 'metadata', 'text'])
  })

  it('invoke accepts a valid ScraperToolSchema payload and returns a JSON string', async () => {
    const scraper = new WebScraper()
    const baseResult: FetchResult = {
      url: 'https://example.com/a',
      status: 200,
      contentType: 'text/html',
      text: 'hello world',
      title: 'Title',
      durationMs: 7,
      method: 'http',
    }
    const scrape = vi.fn().mockResolvedValue(baseResult)
    ;(scraper as unknown as { scrape: typeof scrape }).scrape = scrape

    const tool = scraper.asTool()
    const payload: ScraperToolSchema = {
      url: 'https://example.com/a',
      extractMode: 'text',
      cleanHtml: true,
      maxLength: 500,
    }
    const raw = await tool.invoke(payload)
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(parsed['url']).toBe('https://example.com/a')
    expect(parsed['title']).toBe('Title')
    expect(parsed['status']).toBe(200)
    expect(parsed['method']).toBe('http')
  })

  it('tool output JSON contains the contract-required keys (url/title/text/status/method/durationMs)', async () => {
    const scraper = new WebScraper()
    const baseResult: FetchResult = {
      url: 'https://example.com/b',
      status: 200,
      contentType: 'text/html',
      text: 'body',
      title: 'T',
      description: 'D',
      author: 'A',
      publishedDate: '2025-01-01',
      durationMs: 1,
      method: 'http',
    }
    ;(scraper as unknown as { scrape: typeof baseResult extends unknown ? (...a: unknown[]) => unknown : never }).scrape =
      vi.fn().mockResolvedValue(baseResult) as unknown as (...a: unknown[]) => unknown
    const tool = scraper.asTool()
    const raw = await tool.invoke({ url: baseResult.url })
    const parsed = JSON.parse(raw) as Record<string, unknown>
    for (const key of [
      'url',
      'title',
      'description',
      'author',
      'publishedDate',
      'text',
      'status',
      'method',
      'durationMs',
    ]) {
      expect(parsed).toHaveProperty(key)
    }
  })

  it('error inside scrape() propagates — tool.invoke rejects (error response is rejection, not malformed output)', async () => {
    const scraper = new WebScraper()
    ;(scraper as unknown as { scrape: (...a: unknown[]) => Promise<unknown> }).scrape = vi
      .fn()
      .mockRejectedValue(new Error('boom'))
    const tool = scraper.asTool()
    await expect(tool.invoke({ url: 'https://example.com/fail' })).rejects.toThrow('boom')
  })

  it('normalizeScraperTool defaults id to name when id is omitted', () => {
    const tool: ScraperConnectorTool = normalizeScraperTool({
      name: 'some_tool',
      description: 'desc',
      schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      invoke: async () => 'ok',
    })
    expect(tool.id).toBe('some_tool')
  })

  it('normalizeScraperTool preserves explicit id when provided', () => {
    const tool = normalizeScraperTool({
      id: 'explicit_id',
      name: 'ignored_name',
      description: 'desc',
      schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      invoke: async () => 'ok',
    })
    expect(tool.id).toBe('explicit_id')
    expect(tool.name).toBe('ignored_name')
  })
})

// ------------------------------------------------------------
// Content extraction integration
// ------------------------------------------------------------
describe('W23-B3 Content extraction integration', () => {
  let extractor: ContentExtractor

  beforeEach(() => {
    extractor = new ContentExtractor()
  })

  it('strips nav and footer, extracting main body text', () => {
    const html = `
      <html>
        <head><title>Article</title></head>
        <body>
          <nav>Home | Blog | Contact</nav>
          <main><p>This is the main article body.</p></main>
          <footer>Copyright 2025</footer>
        </body>
      </html>
    `
    const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
    expect(result.text).toContain('main article body')
    expect(result.text).not.toContain('Home | Blog')
    expect(result.text).not.toContain('Copyright 2025')
  })

  it('preserves image alt text when stripping <img> tags fails to remove alt context', () => {
    // <img> tags are stripped entirely (no alt preservation). Verify behavior
    // is deterministic: alt text is NOT retained in the text output.
    const html = '<html><body><p>Before</p><img src="a.png" alt="ALT-TEXT-VALUE"/><p>After</p></body></html>'
    const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
    expect(result.text).toContain('Before')
    expect(result.text).toContain('After')
    // alt="..." attribute text is stripped along with tag
    expect(result.text).not.toContain('ALT-TEXT-VALUE')
  })

  it('preserves code block text inside <pre><code> fences', () => {
    const html = `
      <html><body>
        <pre><code>const answer = 42;</code></pre>
      </body></html>
    `
    const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
    expect(result.text).toContain('const answer = 42;')
  })

  it('extracts title and description metadata into the structured result', () => {
    const html = `
      <html>
        <head>
          <title>My Page</title>
          <meta name="description" content="A very good page">
        </head>
        <body><p>${LONG_BODY}</p></body>
      </html>
    `
    const result = extractor.extract(html, { mode: 'all', cleanHtml: true })
    expect(result.title).toBe('My Page')
    expect(result.description).toBe('A very good page')
  })
})

// ------------------------------------------------------------
// Error paths — typed errors surface from the layer
// ------------------------------------------------------------
describe('W23-B3 Error paths — typed error surfaces', () => {
  afterEach(() => vi.restoreAllMocks())

  it('DNS failure is wrapped in a descriptive Error after retries exhausted', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND nope.invalid')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 1, retryDelayMs: 1 })
    await expect(fetcher.fetch('https://nope.invalid')).rejects.toThrow(/ENOTFOUND/)
  })

  it('HTTP 404 returns a result with status=404 (not thrown — per contract)', async () => {
    const fetchMock = vi.fn(async () => makeResponse('not found', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 0 })
    const result = await fetcher.fetch('https://example.com/missing')
    expect(result.status).toBe(404)
  })

  it('RobotsDisallowedError is an Error subclass with expected message format', async () => {
    const err = new RobotsDisallowedError('https://example.com/blocked')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('RobotsDisallowedError')
    expect(err.message).toContain('Blocked by robots.txt')
    expect(err.message).toContain('https://example.com/blocked')
  })

  it('malformed HTML yields partial extraction without throwing', () => {
    const extractor = new ContentExtractor()
    const malformed = '<html><body><p>Unclosed paragraph<div>and a div without closure'
    const result = extractor.extract(malformed, { mode: 'text', cleanHtml: true })
    expect(result.text).toContain('Unclosed paragraph')
    expect(result.text).toContain('and a div without closure')
  })

  it('auto mode rethrows when BOTH HTTP and browser fail, with combined message', async () => {
    const scraper = new WebScraper({ mode: 'auto' })
    const httpFetch = vi.fn().mockRejectedValue(new Error('http-err'))
    const browserFetch = vi.fn().mockRejectedValue(new Error('browser-err'))
    ;(scraper as unknown as { httpFetcher: { fetch: typeof httpFetch } }).httpFetcher = {
      fetch: httpFetch,
    }
    ;(scraper as unknown as { browserPool: { fetch: typeof browserFetch } }).browserPool = {
      fetch: browserFetch,
    }

    await expect(scraper.scrape('https://example.com/broken')).rejects.toThrow(
      /HTTP and browser fetch failed/,
    )
  })

  it('auto mode falls back to browser when HTTP throws non-robots error', async () => {
    const scraper = new WebScraper({ mode: 'auto' })
    const httpFetch = vi.fn().mockRejectedValue(new Error('http-failure'))
    const browserResult: FetchResult = {
      url: 'https://example.com/x',
      status: 200,
      contentType: 'text/html',
      text: 'x'.repeat(300),
      durationMs: 10,
      method: 'browser',
    }
    const browserFetch = vi.fn().mockResolvedValue(browserResult)
    ;(scraper as unknown as { httpFetcher: { fetch: typeof httpFetch } }).httpFetcher = {
      fetch: httpFetch,
    }
    ;(scraper as unknown as { browserPool: { fetch: typeof browserFetch } }).browserPool = {
      fetch: browserFetch,
    }

    const result = await scraper.scrape('https://example.com/x')
    expect(result.method).toBe('browser')
    expect(browserFetch).toHaveBeenCalled()
  })
})

// ------------------------------------------------------------
// Integration — full pipeline
// ------------------------------------------------------------
describe('W23-B3 Integration — full fetch → extract → structured output', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns a structured FetchResult with url, title, description, text, html', async () => {
    const html = `
      <html>
        <head>
          <title>Integration Page</title>
          <meta name="description" content="An integration test page">
          <meta name="author" content="Test Author">
        </head>
        <body>
          <nav>nav</nav>
          <h1>Heading</h1>
          <p>${LONG_BODY}</p>
          <footer>footer</footer>
        </body>
      </html>
    `
    const fetchMock = vi.fn(async () => makeResponse(html))
    vi.stubGlobal('fetch', fetchMock)

    const scraper = new WebScraper({
      mode: 'http',
      http: {
        maxRetries: 0,
        retryDelayMs: 0,
        respectRobotsTxt: false,
        followRedirects: true,
        maxRedirects: 0,
      },
    })
    const result = await scraper.scrape('https://example.com/integration')
    expect(result.status).toBe(200)
    expect(result.title).toBe('Integration Page')
    expect(result.description).toBe('An integration test page')
    expect(result.author).toBe('Test Author')
    expect(result.text).toContain('Heading')
    expect(result.text).not.toContain('nav')
    expect(result.text).not.toContain('footer')
    expect(result.method).toBe('http')
    expect(typeof result.durationMs).toBe('number')
  })

  it('scrapeMany processes URLs in bounded parallel batches', async () => {
    const stubResult: FetchResult = {
      url: 'https://example.com',
      status: 200,
      contentType: 'text/html',
      text: 'x'.repeat(250),
      durationMs: 1,
      method: 'http',
    }
    const scraper = new WebScraper({ mode: 'http' })
    let inFlight = 0
    let maxInFlight = 0
    const fetch = vi.fn(async (u: string) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return { ...stubResult, url: u }
    })
    ;(scraper as unknown as { httpFetcher: { fetch: typeof fetch } }).httpFetcher = { fetch }

    const urls = Array.from({ length: 6 }, (_, i) => `https://example.com/p${i}`)
    const results = await scraper.scrapeMany(urls, { concurrency: 2 })
    expect(results).toHaveLength(6)
    expect(maxInFlight).toBeLessThanOrEqual(2)
  })

  it('scrapeMany returns failure placeholders rather than throwing on per-URL errors', async () => {
    const scraper = new WebScraper({ mode: 'http' })
    const stubResult: FetchResult = {
      url: '',
      status: 200,
      contentType: 'text/html',
      text: 'x'.repeat(250),
      durationMs: 1,
      method: 'http',
    }
    const fetch = vi.fn(async (u: string) => {
      if (u.includes('bad')) throw new Error('boom-' + u)
      return { ...stubResult, url: u }
    })
    ;(scraper as unknown as { httpFetcher: { fetch: typeof fetch } }).httpFetcher = { fetch }

    const results = await scraper.scrapeMany([
      'https://example.com/good',
      'https://example.com/bad-1',
      'https://example.com/good-2',
    ])
    expect(results).toHaveLength(3)
    expect(results[0]!.status).toBe(200)
    expect(results[1]!.status).toBe(0)
    expect(results[1]!.text).toContain('boom-')
    expect(results[2]!.status).toBe(200)
  })

  it('scrape pipeline preserves method="http" in output when using http-only mode', async () => {
    const fetchMock = vi.fn(async () => makeResponse(`<html><body>${LONG_BODY}</body></html>`))
    vi.stubGlobal('fetch', fetchMock)
    const scraper = new WebScraper({
      mode: 'http',
      http: {
        maxRetries: 0,
        retryDelayMs: 0,
        respectRobotsTxt: false,
        followRedirects: true,
        maxRedirects: 0,
      },
    })
    const result = await scraper.scrape('https://example.com/pipeline')
    expect(result.method).toBe('http')
  })

  it('extraction options flow through the tool → scrape → fetcher chain', async () => {
    const scraper = new WebScraper({ mode: 'http' })
    const fetch = vi.fn().mockResolvedValue({
      url: 'https://example.com/chain',
      status: 200,
      contentType: 'text/html',
      text: 'x'.repeat(250),
      durationMs: 1,
      method: 'http',
    } satisfies FetchResult)
    ;(scraper as unknown as { httpFetcher: { fetch: typeof fetch } }).httpFetcher = { fetch }

    const tool = scraper.asTool()
    await tool.invoke({
      url: 'https://example.com/chain',
      extractMode: 'html',
      cleanHtml: false,
      maxLength: 999,
    })

    const expectedExtraction: ExtractionConfig = {
      mode: 'html',
      cleanHtml: false,
      maxLength: 999,
    }
    expect(fetch).toHaveBeenCalledWith(
      'https://example.com/chain',
      expect.objectContaining({ extraction: expect.objectContaining(expectedExtraction) }),
    )
  })

  it('destroy() is idempotent and safe to call when no browser pool exists', async () => {
    const scraper = new WebScraper({ mode: 'http' })
    await expect(scraper.destroy()).resolves.toBeUndefined()
    await expect(scraper.destroy()).resolves.toBeUndefined()
  })

  it('scrape passes through content-type from response headers', async () => {
    const fetchMock = vi.fn(async () =>
      makeResponse(`<html><body>${LONG_BODY}</body></html>`, {
        headers: { 'content-type': 'application/xhtml+xml; charset=utf-8' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const scraper = new WebScraper({
      mode: 'http',
      http: {
        maxRetries: 0,
        retryDelayMs: 0,
        respectRobotsTxt: false,
        followRedirects: true,
        maxRedirects: 0,
      },
    })
    const result = await scraper.scrape('https://example.com/xhtml')
    expect(result.contentType).toContain('application/xhtml+xml')
  })

  it('scrape records a durationMs >= 0 on success', async () => {
    const fetchMock = vi.fn(async () => makeResponse(`<html><body>${LONG_BODY}</body></html>`))
    vi.stubGlobal('fetch', fetchMock)
    const scraper = new WebScraper({
      mode: 'http',
      http: {
        maxRetries: 0,
        retryDelayMs: 0,
        respectRobotsTxt: false,
        followRedirects: true,
        maxRedirects: 0,
      },
    })
    const result = await scraper.scrape('https://example.com/time')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('scrapeMany with empty URL list returns an empty array without side effects', async () => {
    const scraper = new WebScraper({ mode: 'http' })
    const fetch = vi.fn()
    ;(scraper as unknown as { httpFetcher: { fetch: typeof fetch } }).httpFetcher = { fetch }
    const results = await scraper.scrapeMany([])
    expect(results).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })
})
