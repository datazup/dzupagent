import { describe, it, expect, vi, afterEach } from 'vitest'
import { WebScraper } from '../scraper.js'
import { normalizeScraperTool } from '../connector-contract.js'
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

function mockScraper(overrides?: {
  httpFetch?: ReturnType<typeof vi.fn>
  browserFetch?: ReturnType<typeof vi.fn>
  browserDestroy?: ReturnType<typeof vi.fn>
}) {
  return {
    httpFetch: overrides?.httpFetch ?? vi.fn().mockResolvedValue(baseResult),
    browserFetch: overrides?.browserFetch ?? vi.fn().mockResolvedValue({ ...baseResult, method: 'browser' }),
    browserDestroy: overrides?.browserDestroy ?? vi.fn().mockResolvedValue(undefined),
  }
}

function wireUpMocks(
  scraper: WebScraper,
  mocks: ReturnType<typeof mockScraper>,
) {
  const s = scraper as unknown as {
    httpFetcher: { fetch: ReturnType<typeof vi.fn> }
    browserPool: { fetch: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> } | null
  }
  s.httpFetcher = { fetch: mocks.httpFetch }
  s.browserPool = { fetch: mocks.browserFetch, destroy: mocks.browserDestroy }
}

describe('WebScraper - mode selection', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses HTTP fetcher in "http" mode', async () => {
    const scraper = new WebScraper({ mode: 'http' })
    const mocks = mockScraper()
    wireUpMocks(scraper, mocks)

    const result = await scraper.scrape('https://example.com')
    expect(result.method).toBe('http')
    expect(mocks.httpFetch).toHaveBeenCalled()
    expect(mocks.browserFetch).not.toHaveBeenCalled()
  })

  it('uses browser pool in "browser" mode', async () => {
    const scraper = new WebScraper({ mode: 'browser' })
    const mocks = mockScraper()
    wireUpMocks(scraper, mocks)

    const result = await scraper.scrape('https://example.com')
    expect(result.method).toBe('browser')
    expect(mocks.browserFetch).toHaveBeenCalled()
    expect(mocks.httpFetch).not.toHaveBeenCalled()
  })

  it('tries HTTP first in "auto" mode, returns HTTP result if sufficient content', async () => {
    const scraper = new WebScraper({ mode: 'auto' })
    const mocks = mockScraper()
    wireUpMocks(scraper, mocks)

    const result = await scraper.scrape('https://example.com')
    expect(result.method).toBe('http')
    expect(mocks.httpFetch).toHaveBeenCalled()
    expect(mocks.browserFetch).not.toHaveBeenCalled()
  })

  it('falls back to browser in "auto" mode when HTTP returns insufficient content', async () => {
    const scraper = new WebScraper({ mode: 'auto' })
    const mocks = mockScraper({
      httpFetch: vi.fn().mockResolvedValue({
        ...baseResult,
        text: 'too short', // less than 100 chars
      }),
    })
    wireUpMocks(scraper, mocks)

    const result = await scraper.scrape('https://example.com')
    expect(result.method).toBe('browser')
    expect(mocks.httpFetch).toHaveBeenCalled()
    expect(mocks.browserFetch).toHaveBeenCalled()
  })

  it('falls back to browser in "auto" mode when HTTP returns 4xx/5xx', async () => {
    const scraper = new WebScraper({ mode: 'auto' })
    const mocks = mockScraper({
      httpFetch: vi.fn().mockResolvedValue({
        ...baseResult,
        status: 500,
      }),
    })
    wireUpMocks(scraper, mocks)

    const result = await scraper.scrape('https://example.com')
    expect(result.method).toBe('browser')
  })

  it('uses default "auto" mode when no mode specified', async () => {
    const scraper = new WebScraper()
    const mocks = mockScraper()
    wireUpMocks(scraper, mocks)

    const result = await scraper.scrape('https://example.com')
    expect(result.method).toBe('http')
  })
})

describe('WebScraper - scrapeMany', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('scrapes multiple URLs concurrently', async () => {
    const scraper = new WebScraper({ mode: 'http' })
    const mocks = mockScraper({
      httpFetch: vi.fn().mockImplementation(async (url: string) => ({
        ...baseResult,
        url,
      })),
    })
    wireUpMocks(scraper, mocks)

    const urls = [
      'https://example.com/page1',
      'https://example.com/page2',
      'https://example.com/page3',
    ]
    const results = await scraper.scrapeMany(urls)

    expect(results).toHaveLength(3)
    expect(results[0]!.url).toBe('https://example.com/page1')
    expect(results[1]!.url).toBe('https://example.com/page2')
    expect(results[2]!.url).toBe('https://example.com/page3')
  })

  it('returns error results for failed URLs instead of throwing', async () => {
    const scraper = new WebScraper({ mode: 'http' })
    const mocks = mockScraper({
      httpFetch: vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('fail')) {
          throw new Error('Connection refused')
        }
        return { ...baseResult, url }
      }),
    })
    wireUpMocks(scraper, mocks)

    const results = await scraper.scrapeMany([
      'https://example.com/good',
      'https://example.com/fail',
    ])

    expect(results).toHaveLength(2)
    expect(results[0]!.status).toBe(200)
    expect(results[1]!.status).toBe(0)
    expect(results[1]!.text).toContain('Connection refused')
  })

  it('respects concurrency limit by batching', async () => {
    const scraper = new WebScraper({ mode: 'http' })
    let maxConcurrent = 0
    let currentConcurrent = 0

    const mocks = mockScraper({
      httpFetch: vi.fn().mockImplementation(async (url: string) => {
        currentConcurrent++
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent)
        await new Promise((r) => setTimeout(r, 10))
        currentConcurrent--
        return { ...baseResult, url }
      }),
    })
    wireUpMocks(scraper, mocks)

    const urls = Array.from({ length: 6 }, (_, i) => `https://example.com/page${i}`)
    await scraper.scrapeMany(urls, { concurrency: 2 })

    expect(maxConcurrent).toBeLessThanOrEqual(2)
  })

  it('returns empty array for empty URL list', async () => {
    const scraper = new WebScraper({ mode: 'http' })
    const results = await scraper.scrapeMany([])
    expect(results).toEqual([])
  })

  it('passes extraction options to individual scrape calls', async () => {
    const scraper = new WebScraper({ mode: 'http' })
    const mocks = mockScraper()
    wireUpMocks(scraper, mocks)

    await scraper.scrapeMany(['https://example.com'], {
      mode: 'metadata',
      cleanHtml: false,
      maxLength: 100,
    })

    expect(mocks.httpFetch).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({
        extraction: expect.objectContaining({
          mode: 'metadata',
          cleanHtml: false,
          maxLength: 100,
        }),
      }),
    )
  })
})

describe('WebScraper - timeout configuration', () => {
  it('uses custom timeout from config', async () => {
    const scraper = new WebScraper({ mode: 'http', timeout: 5000 })
    const mocks = mockScraper()
    wireUpMocks(scraper, mocks)

    await scraper.scrape('https://example.com')

    expect(mocks.httpFetch).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ timeout: 5000 }),
    )
  })

  it('defaults to 30000ms timeout', async () => {
    const scraper = new WebScraper({ mode: 'http' })
    const mocks = mockScraper()
    wireUpMocks(scraper, mocks)

    await scraper.scrape('https://example.com')

    expect(mocks.httpFetch).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ timeout: 30_000 }),
    )
  })
})

describe('WebScraper - destroy', () => {
  it('destroys browser pool when present', async () => {
    const scraper = new WebScraper({ mode: 'browser' })
    const mocks = mockScraper()
    wireUpMocks(scraper, mocks)

    await scraper.destroy()
    expect(mocks.browserDestroy).toHaveBeenCalled()
  })

  it('does not throw when no browser pool exists', async () => {
    const scraper = new WebScraper({ mode: 'http' })
    await expect(scraper.destroy()).resolves.toBeUndefined()
  })
})

describe('WebScraper - auto mode error handling', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('throws combined error when both HTTP and browser fail', async () => {
    const scraper = new WebScraper({ mode: 'auto' })
    const mocks = mockScraper({
      httpFetch: vi.fn().mockRejectedValue(new Error('HTTP fail')),
      browserFetch: vi.fn().mockRejectedValue(new Error('Browser fail')),
    })
    wireUpMocks(scraper, mocks)

    await expect(scraper.scrape('https://example.com')).rejects.toThrow(
      /Both HTTP and browser fetch failed/,
    )
  })
})

describe('normalizeScraperTool', () => {
  it('uses name as id when id is not provided', () => {
    const tool = normalizeScraperTool({
      name: 'my_scraper',
      description: 'A scraper tool',
      schema: { type: 'object', properties: {}, required: [] },
      invoke: async () => 'result',
    })
    expect(tool.id).toBe('my_scraper')
    expect(tool.name).toBe('my_scraper')
  })

  it('preserves explicit id when provided', () => {
    const tool = normalizeScraperTool({
      id: 'custom_id',
      name: 'my_scraper',
      description: 'A scraper tool',
      schema: { type: 'object', properties: {}, required: [] },
      invoke: async () => 'result',
    })
    expect(tool.id).toBe('custom_id')
    expect(tool.name).toBe('my_scraper')
  })

  it('preserves schema and description', () => {
    const tool = normalizeScraperTool({
      name: 'test',
      description: 'Test description',
      schema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
      invoke: async () => 'ok',
    })
    expect(tool.description).toBe('Test description')
    expect(tool.schema.required).toEqual(['url'])
  })

  it('preserves the invoke function', async () => {
    const invoke = vi.fn().mockResolvedValue('invoked')
    const tool = normalizeScraperTool({
      name: 'test',
      description: 'Test',
      schema: { type: 'object', properties: {}, required: [] },
      invoke,
    })

    const result = await tool.invoke({ url: 'https://example.com' })
    expect(result).toBe('invoked')
    expect(invoke).toHaveBeenCalledWith({ url: 'https://example.com' })
  })
})

describe('WebScraper.asTool', () => {
  it('returns tool with correct id and schema shape', () => {
    const tool = new WebScraper().asTool()
    expect(tool.id).toBe('web_scraper')
    expect(tool.name).toBe('web_scraper')
    expect(tool.schema.type).toBe('object')
    expect(tool.schema.required).toContain('url')
    expect(tool.schema.properties).toHaveProperty('url')
    expect(tool.schema.properties).toHaveProperty('extractMode')
    expect(tool.schema.properties).toHaveProperty('cleanHtml')
    expect(tool.schema.properties).toHaveProperty('maxLength')
  })

  it('invoke returns JSON string with expected fields', async () => {
    const scraper = new WebScraper()
    const scrapeMock = vi.fn().mockResolvedValue(baseResult)
    ;(scraper as unknown as { scrape: typeof scrapeMock }).scrape = scrapeMock

    const tool = scraper.asTool()
    const raw = await tool.invoke({ url: 'https://example.com' })
    const parsed = JSON.parse(raw)

    expect(parsed).toHaveProperty('url')
    expect(parsed).toHaveProperty('title')
    expect(parsed).toHaveProperty('text')
    expect(parsed).toHaveProperty('status')
    expect(parsed).toHaveProperty('method')
    expect(parsed).toHaveProperty('durationMs')
  })

  it('omits html from tool output', async () => {
    const scraper = new WebScraper()
    const scrapeMock = vi.fn().mockResolvedValue({
      ...baseResult,
      html: '<html><body>raw</body></html>',
    })
    ;(scraper as unknown as { scrape: typeof scrapeMock }).scrape = scrapeMock

    const tool = scraper.asTool()
    const raw = await tool.invoke({ url: 'https://example.com' })
    const parsed = JSON.parse(raw)

    expect(parsed).not.toHaveProperty('html')
    expect(parsed).not.toHaveProperty('contentType')
  })
})
