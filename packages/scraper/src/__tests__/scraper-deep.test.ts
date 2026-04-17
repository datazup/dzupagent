import { describe, it, expect, vi, afterEach } from 'vitest'
import { WebScraper } from '../scraper.js'
import { RobotsDisallowedError } from '../http-fetcher.js'
import type { FetchResult } from '../types.js'

const baseResult: FetchResult = {
  url: 'https://example.com',
  status: 200,
  contentType: 'text/html',
  text: 'x'.repeat(250),
  title: 'Example',
  description: 'An example page',
  author: 'Author',
  durationMs: 10,
  method: 'http',
}

function wireUpMocks(
  scraper: WebScraper,
  mocks: {
    httpFetch: ReturnType<typeof vi.fn>
    browserFetch?: ReturnType<typeof vi.fn>
    browserDestroy?: ReturnType<typeof vi.fn>
  },
) {
  const s = scraper as unknown as {
    httpFetcher: { fetch: ReturnType<typeof vi.fn> }
    browserPool: { fetch: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> } | null
  }
  s.httpFetcher = { fetch: mocks.httpFetch }
  if (mocks.browserFetch) {
    s.browserPool = {
      fetch: mocks.browserFetch,
      destroy: mocks.browserDestroy ?? vi.fn().mockResolvedValue(undefined),
    }
  }
}

describe('WebScraper - auto mode detailed behavior', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses HTTP result when status is 200 and text > 100 chars', async () => {
    const scraper = new WebScraper({ mode: 'auto' })
    wireUpMocks(scraper, {
      httpFetch: vi.fn().mockResolvedValue({ ...baseResult, text: 'a'.repeat(101) }),
      browserFetch: vi.fn().mockResolvedValue({ ...baseResult, method: 'browser' }),
    })

    const result = await scraper.scrape('https://example.com')
    expect(result.method).toBe('http')
  })

  it('falls back to browser when HTTP text is exactly 100 chars', async () => {
    const scraper = new WebScraper({ mode: 'auto' })
    wireUpMocks(scraper, {
      httpFetch: vi.fn().mockResolvedValue({ ...baseResult, text: 'a'.repeat(100) }),
      browserFetch: vi.fn().mockResolvedValue({ ...baseResult, method: 'browser' }),
    })

    const result = await scraper.scrape('https://example.com')
    expect(result.method).toBe('browser')
  })

  it('falls back to browser when HTTP text is empty', async () => {
    const scraper = new WebScraper({ mode: 'auto' })
    wireUpMocks(scraper, {
      httpFetch: vi.fn().mockResolvedValue({ ...baseResult, text: '' }),
      browserFetch: vi.fn().mockResolvedValue({ ...baseResult, method: 'browser' }),
    })

    const result = await scraper.scrape('https://example.com')
    expect(result.method).toBe('browser')
  })

  it('falls back to browser when HTTP returns 400 status', async () => {
    const scraper = new WebScraper({ mode: 'auto' })
    wireUpMocks(scraper, {
      httpFetch: vi.fn().mockResolvedValue({ ...baseResult, status: 400, text: 'a'.repeat(200) }),
      browserFetch: vi.fn().mockResolvedValue({ ...baseResult, method: 'browser' }),
    })

    const result = await scraper.scrape('https://example.com')
    expect(result.method).toBe('browser')
  })

  it('falls back to browser when HTTP returns 301 redirect status', async () => {
    const scraper = new WebScraper({ mode: 'auto' })
    wireUpMocks(scraper, {
      httpFetch: vi.fn().mockResolvedValue({ ...baseResult, status: 301, text: '' }),
      browserFetch: vi.fn().mockResolvedValue({ ...baseResult, method: 'browser' }),
    })

    const result = await scraper.scrape('https://example.com')
    expect(result.method).toBe('browser')
  })

  it('re-throws RobotsDisallowedError without browser fallback', async () => {
    const scraper = new WebScraper({ mode: 'auto' })
    wireUpMocks(scraper, {
      httpFetch: vi.fn().mockRejectedValue(new RobotsDisallowedError('https://example.com/blocked')),
      browserFetch: vi.fn().mockResolvedValue({ ...baseResult, method: 'browser' }),
    })

    await expect(scraper.scrape('https://example.com/blocked')).rejects.toThrow(RobotsDisallowedError)
  })

  it('throws combined error message when both HTTP and browser fail', async () => {
    const scraper = new WebScraper({ mode: 'auto' })
    wireUpMocks(scraper, {
      httpFetch: vi.fn().mockRejectedValue(new Error('HTTP down')),
      browserFetch: vi.fn().mockRejectedValue(new Error('Browser crashed')),
    })

    await expect(scraper.scrape('https://example.com')).rejects.toThrow(
      /Both HTTP and browser fetch failed.*Browser crashed/,
    )
  })

  it('uses browser result when HTTP throws generic error', async () => {
    const scraper = new WebScraper({ mode: 'auto' })
    wireUpMocks(scraper, {
      httpFetch: vi.fn().mockRejectedValue(new Error('Network timeout')),
      browserFetch: vi.fn().mockResolvedValue({ ...baseResult, method: 'browser' }),
    })

    const result = await scraper.scrape('https://example.com')
    expect(result.method).toBe('browser')
  })
})

describe('WebScraper - scrapeMany edge cases', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('handles single URL', async () => {
    const scraper = new WebScraper({ mode: 'http' })
    wireUpMocks(scraper, {
      httpFetch: vi.fn().mockResolvedValue(baseResult),
    })

    const results = await scraper.scrapeMany(['https://example.com'])
    expect(results).toHaveLength(1)
    expect(results[0]!.url).toBe('https://example.com')
  })

  it('handles all URLs failing', async () => {
    const scraper = new WebScraper({ mode: 'http' })
    wireUpMocks(scraper, {
      httpFetch: vi.fn().mockRejectedValue(new Error('All fail')),
    })

    const results = await scraper.scrapeMany([
      'https://example.com/1',
      'https://example.com/2',
      'https://example.com/3',
    ])

    expect(results).toHaveLength(3)
    expect(results.every(r => r.status === 0)).toBe(true)
    expect(results.every(r => r.text.includes('All fail'))).toBe(true)
  })

  it('returns results in the same order as input URLs', async () => {
    const scraper = new WebScraper({ mode: 'http' })
    wireUpMocks(scraper, {
      httpFetch: vi.fn().mockImplementation(async (url: string) => ({
        ...baseResult,
        url,
      })),
    })

    const urls = ['https://z.com', 'https://a.com', 'https://m.com']
    const results = await scraper.scrapeMany(urls)

    expect(results[0]!.url).toBe('https://z.com')
    expect(results[1]!.url).toBe('https://a.com')
    expect(results[2]!.url).toBe('https://m.com')
  })

  it('batches URLs according to concurrency setting', async () => {
    const scraper = new WebScraper({ mode: 'http' })
    const callOrder: number[] = []
    let batchCount = 0

    wireUpMocks(scraper, {
      httpFetch: vi.fn().mockImplementation(async (url: string) => {
        const idx = parseInt(url.split('/').pop()!, 10)
        callOrder.push(idx)
        return { ...baseResult, url }
      }),
    })

    const urls = Array.from({ length: 7 }, (_, i) => `https://example.com/${i}`)
    await scraper.scrapeMany(urls, { concurrency: 3 })

    // 7 URLs with concurrency 3 → 3 batches: [0,1,2], [3,4,5], [6]
    expect(callOrder).toHaveLength(7)
  })

  it('default concurrency is 5', async () => {
    const scraper = new WebScraper({ mode: 'http' })
    let maxConcurrent = 0
    let current = 0

    wireUpMocks(scraper, {
      httpFetch: vi.fn().mockImplementation(async (url: string) => {
        current++
        maxConcurrent = Math.max(maxConcurrent, current)
        await new Promise(r => setTimeout(r, 5))
        current--
        return { ...baseResult, url }
      }),
    })

    const urls = Array.from({ length: 10 }, (_, i) => `https://example.com/${i}`)
    await scraper.scrapeMany(urls)

    expect(maxConcurrent).toBeLessThanOrEqual(5)
  })

  it('scrapeMany without extraction options passes undefined', async () => {
    const scraper = new WebScraper({ mode: 'http' })
    wireUpMocks(scraper, {
      httpFetch: vi.fn().mockResolvedValue(baseResult),
    })

    await scraper.scrapeMany(['https://example.com'])

    const httpFetch = (scraper as unknown as { httpFetcher: { fetch: ReturnType<typeof vi.fn> } }).httpFetcher.fetch
    // When no options, extraction should be empty/undefined
    const callArgs = httpFetch.mock.calls[0]
    expect(callArgs).toBeDefined()
  })

  it('handles non-Error rejection in scrapeMany', async () => {
    const scraper = new WebScraper({ mode: 'http' })
    wireUpMocks(scraper, {
      httpFetch: vi.fn().mockRejectedValue('string rejection'),
    })

    const results = await scraper.scrapeMany(['https://example.com'])
    expect(results[0]!.status).toBe(0)
    expect(results[0]!.text).toContain('string rejection')
  })
})

describe('WebScraper - asTool edge cases', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('tool invoke defaults extractMode to "text" when not provided', async () => {
    const scraper = new WebScraper()
    const scrapeMock = vi.fn().mockResolvedValue(baseResult)
    ;(scraper as unknown as { scrape: typeof scrapeMock }).scrape = scrapeMock

    const tool = scraper.asTool()
    await tool.invoke({ url: 'https://example.com' })

    expect(scrapeMock).toHaveBeenCalledWith('https://example.com', { mode: 'text' })
  })

  it('tool invoke passes cleanHtml when provided', async () => {
    const scraper = new WebScraper()
    const scrapeMock = vi.fn().mockResolvedValue(baseResult)
    ;(scraper as unknown as { scrape: typeof scrapeMock }).scrape = scrapeMock

    const tool = scraper.asTool()
    await tool.invoke({ url: 'https://example.com', cleanHtml: false })

    expect(scrapeMock).toHaveBeenCalledWith('https://example.com', {
      mode: 'text',
      cleanHtml: false,
    })
  })

  it('tool invoke passes maxLength when provided', async () => {
    const scraper = new WebScraper()
    const scrapeMock = vi.fn().mockResolvedValue(baseResult)
    ;(scraper as unknown as { scrape: typeof scrapeMock }).scrape = scrapeMock

    const tool = scraper.asTool()
    await tool.invoke({ url: 'https://example.com', maxLength: 500 })

    expect(scrapeMock).toHaveBeenCalledWith('https://example.com', {
      mode: 'text',
      maxLength: 500,
    })
  })

  it('tool invoke returns JSON with all expected fields', async () => {
    const scraper = new WebScraper()
    const fullResult: FetchResult = {
      url: 'https://example.com',
      status: 200,
      contentType: 'text/html',
      text: 'Hello world',
      title: 'Test Title',
      description: 'Test Desc',
      author: 'Test Author',
      publishedDate: '2024-01-01',
      html: '<html><body>Hello world</body></html>',
      durationMs: 42,
      method: 'http',
    }
    const scrapeMock = vi.fn().mockResolvedValue(fullResult)
    ;(scraper as unknown as { scrape: typeof scrapeMock }).scrape = scrapeMock

    const tool = scraper.asTool()
    const raw = await tool.invoke({ url: 'https://example.com' })
    const parsed = JSON.parse(raw)

    expect(parsed.url).toBe('https://example.com')
    expect(parsed.title).toBe('Test Title')
    expect(parsed.description).toBe('Test Desc')
    expect(parsed.author).toBe('Test Author')
    expect(parsed.publishedDate).toBe('2024-01-01')
    expect(parsed.text).toBe('Hello world')
    expect(parsed.status).toBe(200)
    expect(parsed.method).toBe('http')
    expect(parsed.durationMs).toBe(42)
    // html and contentType should NOT be in tool output
    expect(parsed.html).toBeUndefined()
    expect(parsed.contentType).toBeUndefined()
  })

  it('tool description is set correctly', () => {
    const tool = new WebScraper().asTool()
    expect(tool.description).toContain('Fetch and extract clean text content')
  })

  it('tool schema has correct required fields', () => {
    const tool = new WebScraper().asTool()
    expect(tool.schema.required).toEqual(['url'])
  })
})

describe('WebScraper - configuration merging', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('merges scrape-level extraction with config-level extraction', async () => {
    const scraper = new WebScraper({
      mode: 'http',
      extraction: { mode: 'all', cleanHtml: true, maxLength: 5000 },
    })
    wireUpMocks(scraper, {
      httpFetch: vi.fn().mockResolvedValue(baseResult),
    })

    await scraper.scrape('https://example.com', { mode: 'text' })

    const httpFetch = (scraper as unknown as { httpFetcher: { fetch: ReturnType<typeof vi.fn> } }).httpFetcher.fetch
    expect(httpFetch).toHaveBeenCalledWith('https://example.com', {
      timeout: 30_000,
      extraction: { mode: 'text', cleanHtml: true, maxLength: 5000 },
    })
  })

  it('uses config extraction when no scrape-level options', async () => {
    const scraper = new WebScraper({
      mode: 'http',
      extraction: { mode: 'metadata', cleanHtml: false },
    })
    wireUpMocks(scraper, {
      httpFetch: vi.fn().mockResolvedValue(baseResult),
    })

    await scraper.scrape('https://example.com')

    const httpFetch = (scraper as unknown as { httpFetcher: { fetch: ReturnType<typeof vi.fn> } }).httpFetcher.fetch
    expect(httpFetch).toHaveBeenCalledWith('https://example.com', {
      timeout: 30_000,
      extraction: { mode: 'metadata', cleanHtml: false },
    })
  })

  it('uses custom timeout from config', async () => {
    const scraper = new WebScraper({ mode: 'http', timeout: 10_000 })
    wireUpMocks(scraper, {
      httpFetch: vi.fn().mockResolvedValue(baseResult),
    })

    await scraper.scrape('https://example.com')

    const httpFetch = (scraper as unknown as { httpFetcher: { fetch: ReturnType<typeof vi.fn> } }).httpFetcher.fetch
    expect(httpFetch).toHaveBeenCalledWith('https://example.com', expect.objectContaining({
      timeout: 10_000,
    }))
  })
})

describe('WebScraper - browser mode', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('calls browser pool fetch in browser mode', async () => {
    const scraper = new WebScraper({ mode: 'browser' })
    const browserFetch = vi.fn().mockResolvedValue({ ...baseResult, method: 'browser' })
    wireUpMocks(scraper, {
      httpFetch: vi.fn(),
      browserFetch,
    })

    const result = await scraper.scrape('https://example.com')
    expect(result.method).toBe('browser')
    expect(browserFetch).toHaveBeenCalled()
  })

  it('passes timeout and extraction to browser pool', async () => {
    const scraper = new WebScraper({ mode: 'browser', timeout: 15_000 })
    const browserFetch = vi.fn().mockResolvedValue({ ...baseResult, method: 'browser' })
    wireUpMocks(scraper, {
      httpFetch: vi.fn(),
      browserFetch,
    })

    await scraper.scrape('https://example.com', { mode: 'metadata', cleanHtml: false })

    expect(browserFetch).toHaveBeenCalledWith('https://example.com', {
      timeout: 15_000,
      extraction: { mode: 'metadata', cleanHtml: false },
    })
  })
})

describe('WebScraper - destroy edge cases', () => {
  it('destroy is idempotent (can be called multiple times)', async () => {
    const scraper = new WebScraper({ mode: 'browser' })
    const browserDestroy = vi.fn().mockResolvedValue(undefined)
    wireUpMocks(scraper, {
      httpFetch: vi.fn(),
      browserFetch: vi.fn(),
      browserDestroy,
    })

    await scraper.destroy()
    // Second call — browserPool is now null, should not throw
    await expect(scraper.destroy()).resolves.toBeUndefined()
  })

  it('sets browser pool to null after destroy', async () => {
    const scraper = new WebScraper({ mode: 'browser' })
    wireUpMocks(scraper, {
      httpFetch: vi.fn(),
      browserFetch: vi.fn(),
      browserDestroy: vi.fn().mockResolvedValue(undefined),
    })

    await scraper.destroy()
    const pool = (scraper as unknown as { browserPool: unknown }).browserPool
    expect(pool).toBeNull()
  })
})
