import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { ContentExtractor } from '../content-extractor.js'
import { HttpFetcher } from '../http-fetcher.js'
import { WebScraper } from '../scraper.js'
import { BrowserPool } from '../browser-pool.js'

vi.mock('puppeteer', () => {
  return {
    default: {
      launch: vi.fn(),
    },
  }
})

vi.mock('puppeteer-extra', () => {
  return {
    default: {
      use: vi.fn(),
      launch: vi.fn(),
    },
  }
})

vi.mock('puppeteer-extra-plugin-stealth', () => {
  return {
    default: vi.fn(() => ({})),
  }
})

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

describe('ContentExtractor - self-closing noise elements', () => {
  const extractor = new ContentExtractor()

  it('removes self-closing iframe tags', () => {
    const html = '<html><body><p>Before</p><iframe src="https://tracker.example.com"/><p>After</p></body></html>'
    const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
    expect(result.text).toContain('Before')
    expect(result.text).toContain('After')
    expect(result.text).not.toContain('tracker.example.com')
  })

  it('removes self-closing svg tags with no children', () => {
    const html = '<html><body><p>Start</p><svg xmlns="http://www.w3.org/2000/svg"/><p>End</p></body></html>'
    const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
    expect(result.text).toContain('Start')
    expect(result.text).toContain('End')
    expect(result.text).not.toContain('xmlns')
  })

  it('removes multiple self-closing noise elements in one document', () => {
    const html = [
      '<html><body>',
      '<iframe src="a.html"/>',
      '<iframe src="b.html"/>',
      '<svg/>',
      '<p>Real body content that should remain visible to readers.</p>',
      '</body></html>',
    ].join('')
    const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
    expect(result.text).toContain('Real body content')
    expect(result.text).not.toContain('a.html')
    expect(result.text).not.toContain('b.html')
  })

  it('handles mixed self-closing and paired noise elements', () => {
    const html = [
      '<html><body>',
      '<script>var a = 1;</script>',
      '<iframe src="mixed.html"/>',
      '<p>Article text is present here.</p>',
      '</body></html>',
    ].join('')
    const result = extractor.extract(html, { mode: 'text', cleanHtml: true })
    expect(result.text).toContain('Article text')
    expect(result.text).not.toContain('var a = 1')
    expect(result.text).not.toContain('mixed.html')
  })
})

describe('ContentExtractor - empty and malformed HTML', () => {
  const extractor = new ContentExtractor()

  it('returns empty text for empty string input', () => {
    const result = extractor.extract('')
    expect(result.text).toBe('')
    expect(result.title).toBeUndefined()
    expect(result.description).toBeUndefined()
  })

  it('returns empty text for whitespace-only input', () => {
    const result = extractor.extract('   \n\t   ')
    expect(result.text).toBe('')
    expect(result.title).toBeUndefined()
  })

  it('handles HTML with only a title and no body', () => {
    const html = '<html><head><title>Lonely Title</title></head></html>'
    const result = extractor.extract(html)
    expect(result.title).toBe('Lonely Title')
    expect(result.text.length).toBeLessThanOrEqual(20)
  })

  it('handles body with only whitespace', () => {
    const html = '<html><body>   \n\t   </body></html>'
    const result = extractor.extract(html)
    expect(result.text).toBe('')
  })

  it('handles completely malformed HTML without closing tags', () => {
    const html = '<html><body><p>Orphan paragraph<div>unclosed div<span>end'
    const result = extractor.extract(html)
    expect(result.text).toContain('Orphan paragraph')
    expect(result.text).toContain('unclosed div')
  })

  it('handles HTML with only text and no tags', () => {
    const html = 'Just plain text without any tags whatsoever.'
    const result = extractor.extract(html)
    expect(result.text).toBe('Just plain text without any tags whatsoever.')
    expect(result.title).toBeUndefined()
  })

  it('treats empty title tag as missing', () => {
    const html = '<html><head><title></title></head><body><p>Content</p></body></html>'
    const result = extractor.extract(html)
    expect(result.title).toBeUndefined()
  })

  it('treats whitespace-only title as missing', () => {
    const html = '<html><head><title>   </title></head><body><h1>Real Heading</h1></body></html>'
    const result = extractor.extract(html)
    expect(result.title).toBe('Real Heading')
  })

  it('handles HTML with title containing only a stripped entity', () => {
    const html = '<html><head><title>&nbsp;</title></head><body><h1>Fallback Heading</h1></body></html>'
    const result = extractor.extract(html)
    expect(result.title).toBeDefined()
  })
})

describe('HttpFetcher - robots.txt invalid URL fallback', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns true (allowed) when URL is unparseable', async () => {
    const fetcher = new HttpFetcher({ respectRobotsTxt: true, maxRetries: 0 })
    const isAllowed = (fetcher as unknown as {
      isAllowedByRobots: (url: string, ua: string) => Promise<boolean>
    }).isAllowedByRobots.bind(fetcher)

    const result = await isAllowed('not-a-valid-url', 'TestAgent/1.0')
    expect(result).toBe(true)
  })

  it('treats bare string like "foo" as invalid URL and allows access', async () => {
    const fetcher = new HttpFetcher({ respectRobotsTxt: true, maxRetries: 0 })
    const isAllowed = (fetcher as unknown as {
      isAllowedByRobots: (url: string, ua: string) => Promise<boolean>
    }).isAllowedByRobots.bind(fetcher)

    expect(await isAllowed('foo', 'UA')).toBe(true)
    expect(await isAllowed('://broken', 'UA')).toBe(true)
    expect(await isAllowed('', 'UA')).toBe(true)
  })
})

describe('HttpFetcher - robots.txt crawl-delay and unknown directives', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('ignores crawl-delay directives without affecting allow/disallow parsing', async () => {
    const robotsTxt = [
      'User-agent: *',
      'Crawl-delay: 10',
      'Disallow: /private',
      'Allow: /',
    ].join('\n')

    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.endsWith('/robots.txt')) {
        return makeResponse(robotsTxt, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        })
      }
      return makeResponse('<html><body>' + 'A'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: true, maxRetries: 0 })
    const result = await fetcher.fetch('https://example.com/public')
    expect(result.status).toBe(200)
    await expect(fetcher.fetch('https://crawldelay.example.com/private/page')).rejects.toThrow('robots.txt')
  })

  it('ignores unknown directives like Sitemap', async () => {
    const robotsTxt = [
      'Sitemap: https://example.com/sitemap.xml',
      'Host: example.com',
      'User-agent: *',
      'Disallow: /blocked',
    ].join('\n')

    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.endsWith('/robots.txt')) {
        return makeResponse(robotsTxt, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        })
      }
      return makeResponse('<html><body>' + 'A'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: true, maxRetries: 0 })
    await expect(fetcher.fetch('https://example.com/blocked/x')).rejects.toThrow('robots.txt')
  })

  it('ignores directives before any user-agent line', async () => {
    const robotsTxt = [
      'Disallow: /ignored-because-no-ua',
      'Allow: /also-ignored',
      '',
      'User-agent: *',
      'Disallow: /real',
    ].join('\n')

    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.endsWith('/robots.txt')) {
        return makeResponse(robotsTxt, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        })
      }
      return makeResponse('<html><body>' + 'A'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: true, maxRetries: 0 })
    const result = await fetcher.fetch('https://example.com/ignored-because-no-ua')
    expect(result.status).toBe(200)
  })

  it('handles lines with only a key (no colon value)', async () => {
    const robotsTxt = [
      'User-agent: *',
      'Disallow:',
      'Something-weird',
      'Allow: /',
    ].join('\n')

    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.endsWith('/robots.txt')) {
        return makeResponse(robotsTxt, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        })
      }
      return makeResponse('<html><body>' + 'A'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: true, maxRetries: 0 })
    const result = await fetcher.fetch('https://example.com/anywhere')
    expect(result.status).toBe(200)
  })

  it('applies rule to multiple consecutive user-agent lines in same block', async () => {
    const robotsTxt = [
      'User-agent: BotA',
      'User-agent: BotB',
      'Disallow: /shared-block',
      '',
      'User-agent: *',
      'Allow: /',
    ].join('\n')

    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.endsWith('/robots.txt')) {
        return makeResponse(robotsTxt, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        })
      }
      return makeResponse('<html><body>' + 'A'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({
      respectRobotsTxt: true,
      maxRetries: 0,
      userAgents: ['BotB'],
    })
    await expect(fetcher.fetch('https://example.com/shared-block/page')).rejects.toThrow('robots.txt')
  })

  it('defaults to root path when pathname is empty after URL parsing', async () => {
    const robotsTxt = 'User-agent: *\nAllow: /\nDisallow: /private'
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.endsWith('/robots.txt')) {
        return makeResponse(robotsTxt, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        })
      }
      return makeResponse('<html><body>' + 'A'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: true, maxRetries: 0 })
    const result = await fetcher.fetch('https://example.com')
    expect(result.status).toBe(200)
  })
})

describe('HttpFetcher - robots.txt non-200 responses', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('allows all paths when robots.txt returns 500', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.endsWith('/robots.txt')) {
        return makeResponse('Internal Server Error', { status: 500 })
      }
      return makeResponse('<html><body>' + 'A'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: true, maxRetries: 0 })
    const result = await fetcher.fetch('https://example.com/anything-goes')
    expect(result.status).toBe(200)
  })

  it('allows all paths when robots.txt returns 403', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.endsWith('/robots.txt')) {
        return makeResponse('Forbidden', { status: 403 })
      }
      return makeResponse('<html><body>' + 'A'.repeat(120) + '</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: true, maxRetries: 0 })
    const result = await fetcher.fetch('https://example.com/secret')
    expect(result.status).toBe(200)
  })
})

describe('WebScraper - lazy browser pool creation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates a browser pool on first browser mode call', async () => {
    const scraper = new WebScraper({ mode: 'browser' })
    expect((scraper as unknown as { browserPool: unknown }).browserPool).toBeNull()

    const browserFetchMock = vi.fn().mockResolvedValue({
      url: 'https://example.com',
      status: 200,
      contentType: 'text/html',
      text: 'x'.repeat(250),
      durationMs: 1,
      method: 'browser' as const,
    })
    const fakePool = {
      fetch: browserFetchMock,
      destroy: vi.fn().mockResolvedValue(undefined),
    }

    const originalCreate = (scraper as unknown as {
      getOrCreateBrowserPool: () => unknown
    }).getOrCreateBrowserPool
    ;(scraper as unknown as { getOrCreateBrowserPool: () => unknown }).getOrCreateBrowserPool = function () {
      const self = this as unknown as { browserPool: unknown }
      if (!self.browserPool) {
        self.browserPool = fakePool
      }
      return self.browserPool
    }

    await scraper.scrape('https://example.com')
    expect((scraper as unknown as { browserPool: unknown }).browserPool).toBe(fakePool)
    expect(browserFetchMock).toHaveBeenCalledTimes(1)

    await scraper.scrape('https://example.com/two')
    expect(browserFetchMock).toHaveBeenCalledTimes(2)

    void originalCreate
  })

  it('reuses the same browser pool across scrape calls', async () => {
    const scraper = new WebScraper({ mode: 'browser' })
    const browserFetchMock = vi.fn().mockResolvedValue({
      url: 'https://example.com',
      status: 200,
      contentType: 'text/html',
      text: 'x'.repeat(250),
      durationMs: 1,
      method: 'browser' as const,
    })
    ;(scraper as unknown as { browserPool: { fetch: unknown; destroy: unknown } }).browserPool = {
      fetch: browserFetchMock,
      destroy: vi.fn().mockResolvedValue(undefined),
    }

    const pool1 = (scraper as unknown as { browserPool: unknown }).browserPool
    await scraper.scrape('https://example.com')
    await scraper.scrape('https://example.com/second')
    const pool2 = (scraper as unknown as { browserPool: unknown }).browserPool
    expect(pool1).toBe(pool2)
  })

  it('instantiates real BrowserPool when getOrCreateBrowserPool is invoked without existing pool', () => {
    const scraper = new WebScraper({
      mode: 'browser',
      browser: { maxConcurrency: 2, idleTimeoutMs: 1000, stealth: false, headless: true },
    })
    expect((scraper as unknown as { browserPool: unknown }).browserPool).toBeNull()

    const pool = (scraper as unknown as { getOrCreateBrowserPool: () => BrowserPool }).getOrCreateBrowserPool()
    expect(pool).toBeInstanceOf(BrowserPool)

    ;(scraper as unknown as { browserPool: BrowserPool | null }).browserPool = null
  })
})

describe('BrowserPool - puppeteer not installed error path', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('throws descriptive error when both puppeteer-extra and puppeteer imports fail', async () => {
    const pool = new BrowserPool({ stealth: true, maxConcurrency: 1 })
    const puppeteerExtra = await import('puppeteer-extra')
    const puppeteer = await import('puppeteer')

    ;(puppeteerExtra.default.use as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('puppeteer-extra use failed')
    })
    ;(puppeteer.default.launch as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('no puppeteer')
    })

    ;(pool as unknown as {
      loadPuppeteer: () => Promise<unknown>
    }).loadPuppeteer = async () => {
      try {
        throw new Error('puppeteer-extra missing')
      } catch {
        // Fallthrough to puppeteer
      }
      try {
        throw new Error('puppeteer missing')
      } catch {
        throw new Error(
          'puppeteer is required for browser mode. Install it: npm install puppeteer',
        )
      }
    }

    await expect(pool.acquire()).rejects.toThrow(/puppeteer is required for browser mode/)

    const entries = (pool as unknown as { entries: Array<{ idleTimer: ReturnType<typeof setTimeout> | null }> }).entries
    for (const entry of entries) {
      if (entry.idleTimer !== null) clearTimeout(entry.idleTimer)
    }
    entries.length = 0
    ;(pool as unknown as { destroyed: boolean }).destroyed = true
  })

  it('falls back to puppeteer when stealth=false and puppeteer-extra is not used', async () => {
    const pool = new BrowserPool({ stealth: false, maxConcurrency: 1 })
    const puppeteer = await import('puppeteer')

    const mockBrowser = {
      newPage: vi.fn().mockResolvedValue({
        goto: vi.fn().mockResolvedValue({ status: () => 200 }),
        content: vi.fn().mockResolvedValue('<html></html>'),
        close: vi.fn().mockResolvedValue(undefined),
        browser: vi.fn(),
      }),
      close: vi.fn().mockResolvedValue(undefined),
    }
    ;(puppeteer.default.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser)

    const result = await pool.acquire()
    expect(result).toBeDefined()

    const entries = (pool as unknown as { entries: Array<{ idleTimer: ReturnType<typeof setTimeout> | null }> }).entries
    for (const entry of entries) {
      if (entry.idleTimer !== null) clearTimeout(entry.idleTimer)
    }
    entries.length = 0
    ;(pool as unknown as { destroyed: boolean }).destroyed = true
  })
})

describe('BrowserPool - idle timer expiration', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('closes idle browser after idleTimeoutMs elapses', async () => {
    const pool = new BrowserPool({ stealth: false, maxConcurrency: 1, idleTimeoutMs: 500 })
    const mockPage = {
      goto: vi.fn().mockResolvedValue({ status: () => 200 }),
      content: vi.fn().mockResolvedValue('<html></html>'),
      close: vi.fn().mockResolvedValue(undefined),
      browser: vi.fn(),
      waitForSelector: vi.fn(),
    }
    const mockBrowser = {
      newPage: vi.fn().mockResolvedValue(mockPage),
      close: vi.fn().mockResolvedValue(undefined),
    }
    mockPage.browser = vi.fn(() => mockBrowser)

    const puppeteer = await import('puppeteer')
    ;(puppeteer.default.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser)

    const page = await pool.acquire()
    await pool.release(page)

    const entries = (pool as unknown as {
      entries: Array<{ activePages: number; idleTimer: ReturnType<typeof setTimeout> | null }>
    }).entries
    expect(entries).toHaveLength(1)
    expect(entries[0]!.activePages).toBe(0)
    expect(entries[0]!.idleTimer).not.toBeNull()

    await vi.advanceTimersByTimeAsync(501)
    await Promise.resolve()

    expect(mockBrowser.close).toHaveBeenCalled()
    expect(entries).toHaveLength(0)

    ;(pool as unknown as { destroyed: boolean }).destroyed = true
  })

  it('does not close browser when idle timer fires but activePages > 0', async () => {
    const pool = new BrowserPool({ stealth: false, maxConcurrency: 1, idleTimeoutMs: 200 })
    const mockPage = {
      goto: vi.fn().mockResolvedValue({ status: () => 200 }),
      content: vi.fn().mockResolvedValue('<html></html>'),
      close: vi.fn().mockResolvedValue(undefined),
      browser: vi.fn(),
      waitForSelector: vi.fn(),
    }
    const mockBrowser = {
      newPage: vi.fn().mockResolvedValue(mockPage),
      close: vi.fn().mockResolvedValue(undefined),
    }
    mockPage.browser = vi.fn(() => mockBrowser)

    const puppeteer = await import('puppeteer')
    ;(puppeteer.default.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser)

    const page = await pool.acquire()
    await pool.release(page)

    const entries = (pool as unknown as {
      entries: Array<{ activePages: number; idleTimer: ReturnType<typeof setTimeout> | null }>
    }).entries

    entries[0]!.activePages = 1

    await vi.advanceTimersByTimeAsync(250)
    await Promise.resolve()

    expect(mockBrowser.close).not.toHaveBeenCalled()

    for (const entry of entries) {
      if (entry.idleTimer !== null) clearTimeout(entry.idleTimer)
    }
    entries.length = 0
    ;(pool as unknown as { destroyed: boolean }).destroyed = true
  })

  it('handles browser close error during idle timer expiration', async () => {
    const pool = new BrowserPool({ stealth: false, maxConcurrency: 1, idleTimeoutMs: 100 })
    const mockPage = {
      goto: vi.fn().mockResolvedValue({ status: () => 200 }),
      content: vi.fn().mockResolvedValue('<html></html>'),
      close: vi.fn().mockResolvedValue(undefined),
      browser: vi.fn(),
      waitForSelector: vi.fn(),
    }
    const mockBrowser = {
      newPage: vi.fn().mockResolvedValue(mockPage),
      close: vi.fn().mockRejectedValue(new Error('Already closed remotely')),
    }
    mockPage.browser = vi.fn(() => mockBrowser)

    const puppeteer = await import('puppeteer')
    ;(puppeteer.default.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser)

    const page = await pool.acquire()
    await pool.release(page)

    await vi.advanceTimersByTimeAsync(150)
    await Promise.resolve()

    expect(mockBrowser.close).toHaveBeenCalled()

    const entries = (pool as unknown as { entries: unknown[] }).entries
    expect(entries).toHaveLength(0)

    ;(pool as unknown as { destroyed: boolean }).destroyed = true
  })
})

describe('BrowserPool - concurrency and waiting', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('rejects waiting acquire when pool is destroyed while waiting', async () => {
    const pool = new BrowserPool({ stealth: false, maxConcurrency: 1, idleTimeoutMs: 60000 })
    const mockPage = {
      goto: vi.fn().mockResolvedValue({ status: () => 200 }),
      content: vi.fn().mockResolvedValue('<html></html>'),
      close: vi.fn().mockResolvedValue(undefined),
      browser: vi.fn(),
      waitForSelector: vi.fn(),
    }
    const mockBrowser = {
      newPage: vi.fn().mockResolvedValue(mockPage),
      close: vi.fn().mockResolvedValue(undefined),
    }
    mockPage.browser = vi.fn(() => mockBrowser)

    const puppeteer = await import('puppeteer')
    ;(puppeteer.default.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser)

    await pool.acquire()

    const waitingPromise = pool.acquire()
    const caught = waitingPromise.catch((e: unknown) => e)

    await vi.advanceTimersByTimeAsync(50)
    ;(pool as unknown as { destroyed: boolean }).destroyed = true

    await vi.advanceTimersByTimeAsync(200)

    const err = await caught
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/destroyed while waiting/)

    const entries = (pool as unknown as { entries: Array<{ idleTimer: ReturnType<typeof setTimeout> | null }> }).entries
    for (const entry of entries) {
      if (entry.idleTimer !== null) clearTimeout(entry.idleTimer)
    }
    entries.length = 0
  })

  it('picks up a freed slot during polling when a released page becomes available', async () => {
    const pool = new BrowserPool({ stealth: false, maxConcurrency: 1, idleTimeoutMs: 60000 })
    const mockPage1 = {
      goto: vi.fn().mockResolvedValue({ status: () => 200 }),
      content: vi.fn().mockResolvedValue('<html></html>'),
      close: vi.fn().mockResolvedValue(undefined),
      browser: vi.fn(),
      waitForSelector: vi.fn(),
    }
    const mockPage2 = {
      goto: vi.fn().mockResolvedValue({ status: () => 200 }),
      content: vi.fn().mockResolvedValue('<html></html>'),
      close: vi.fn().mockResolvedValue(undefined),
      browser: vi.fn(),
      waitForSelector: vi.fn(),
    }
    const mockBrowser = {
      newPage: vi.fn().mockResolvedValueOnce(mockPage1).mockResolvedValueOnce(mockPage2),
      close: vi.fn().mockResolvedValue(undefined),
    }
    mockPage1.browser = vi.fn(() => mockBrowser)
    mockPage2.browser = vi.fn(() => mockBrowser)

    const puppeteer = await import('puppeteer')
    ;(puppeteer.default.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser)

    const page1 = await pool.acquire()

    const waitingPromise = pool.acquire()

    await vi.advanceTimersByTimeAsync(50)
    await pool.release(page1)
    await vi.advanceTimersByTimeAsync(120)

    const page2 = await waitingPromise
    expect(page2).toBeDefined()
    expect(mockBrowser.newPage).toHaveBeenCalledTimes(2)

    const entries = (pool as unknown as { entries: Array<{ idleTimer: ReturnType<typeof setTimeout> | null }> }).entries
    for (const entry of entries) {
      if (entry.idleTimer !== null) clearTimeout(entry.idleTimer)
    }
    entries.length = 0
    ;(pool as unknown as { destroyed: boolean }).destroyed = true
  })
})

describe('BrowserPool - release edge cases', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('is a no-op when releasing a page whose browser is not in the pool', async () => {
    const pool = new BrowserPool({ stealth: false, maxConcurrency: 1, idleTimeoutMs: 60000 })
    const unknownBrowser = { close: vi.fn() }
    const orphanPage = {
      browser: vi.fn(() => unknownBrowser),
      close: vi.fn().mockResolvedValue(undefined),
    }

    await expect(pool.release(orphanPage)).resolves.toBeUndefined()
    expect(orphanPage.close).toHaveBeenCalled()

    ;(pool as unknown as { destroyed: boolean }).destroyed = true
  })
})

describe('WebScraper - auto mode threshold boundaries', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('falls back to browser when HTTP returns 399 status (below success range)', async () => {
    const scraper = new WebScraper({ mode: 'auto' })
    const httpFetch = vi.fn().mockResolvedValue({
      url: 'https://example.com',
      status: 399,
      contentType: 'text/html',
      text: 'a'.repeat(500),
      durationMs: 1,
      method: 'http' as const,
    })
    const browserFetch = vi.fn().mockResolvedValue({
      url: 'https://example.com',
      status: 200,
      contentType: 'text/html',
      text: 'b'.repeat(500),
      durationMs: 2,
      method: 'browser' as const,
    })
    ;(scraper as unknown as { httpFetcher: { fetch: unknown } }).httpFetcher = { fetch: httpFetch }
    ;(scraper as unknown as { browserPool: { fetch: unknown; destroy: unknown } }).browserPool = {
      fetch: browserFetch,
      destroy: vi.fn().mockResolvedValue(undefined),
    }

    const result = await scraper.scrape('https://example.com')
    expect(result.method).toBe('http')
  })

  it('accepts HTTP at exactly 101 chars of text', async () => {
    const scraper = new WebScraper({ mode: 'auto' })
    const httpFetch = vi.fn().mockResolvedValue({
      url: 'https://example.com',
      status: 200,
      contentType: 'text/html',
      text: 'a'.repeat(101),
      durationMs: 1,
      method: 'http' as const,
    })
    const browserFetch = vi.fn().mockResolvedValue({
      url: 'https://example.com',
      status: 200,
      contentType: 'text/html',
      text: 'b'.repeat(500),
      durationMs: 2,
      method: 'browser' as const,
    })
    ;(scraper as unknown as { httpFetcher: { fetch: unknown } }).httpFetcher = { fetch: httpFetch }
    ;(scraper as unknown as { browserPool: { fetch: unknown; destroy: unknown } }).browserPool = {
      fetch: browserFetch,
      destroy: vi.fn().mockResolvedValue(undefined),
    }

    const result = await scraper.scrape('https://example.com')
    expect(result.method).toBe('http')
    expect(browserFetch).not.toHaveBeenCalled()
  })
})

describe('ContentExtractor - missing metadata fallback chains', () => {
  const extractor = new ContentExtractor()

  it('returns undefined for description when no meta and no og:description exists', () => {
    const html = '<html><head><title>Only Title</title></head><body><p>Body</p></body></html>'
    const result = extractor.extract(html)
    expect(result.description).toBeUndefined()
  })

  it('returns undefined when all author sources are missing', () => {
    const html = '<html><head><title>T</title></head><body><p>B</p></body></html>'
    const result = extractor.extract(html)
    expect(result.author).toBeUndefined()
  })

  it('returns undefined when all publishedDate sources are missing', () => {
    const html = '<html><head><title>T</title></head><body><p>B</p></body></html>'
    const result = extractor.extract(html)
    expect(result.publishedDate).toBeUndefined()
  })

  it('uses og:published_time only when article:published_time and date are absent', () => {
    const html = '<html><head><meta property="og:published_time" content="2024-06-15T10:00:00Z"></head><body>x</body></html>'
    const result = extractor.extract(html)
    expect(result.publishedDate).toBe('2024-06-15T10:00:00Z')
  })

  it('prefers article:published_time over og:published_time', () => {
    const html = [
      '<html><head>',
      '<meta property="article:published_time" content="2024-06-15T10:00:00Z">',
      '<meta property="og:published_time" content="2023-01-01T00:00:00Z">',
      '</head><body>x</body></html>',
    ].join('')
    const result = extractor.extract(html)
    expect(result.publishedDate).toBe('2024-06-15T10:00:00Z')
  })

  it('ignores empty meta content values and returns undefined', () => {
    const html = '<html><head><meta name="description" content=""></head><body>x</body></html>'
    const result = extractor.extract(html)
    expect(result.description).toBeUndefined()
  })

  it('handles title containing stripped tags falling through to h1', () => {
    const html = '<html><head></head><body><h1><span></span></h1><p>body</p></body></html>'
    const result = extractor.extract(html)
    expect(result.title).toBeUndefined()
  })
})

describe('HttpFetcher - redirect with invalid location header', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('stops redirect chain when location header is missing', async () => {
    const fetchMock = vi.fn(async () =>
      makeResponse('', {
        status: 302,
        headers: { 'content-type': 'text/html' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({
      respectRobotsTxt: false,
      maxRetries: 2,
      followRedirects: false,
      maxRedirects: 5,
      retryDelayMs: 1,
    })
    const result = await fetcher.fetch('https://example.com/noloc')
    expect(result.status).toBe(302)
  })

  it('returns the redirect response when maxRedirects is 0', async () => {
    const fetchMock = vi.fn(async () =>
      makeResponse('', {
        status: 301,
        headers: {
          'content-type': 'text/html',
          'location': 'https://example.com/elsewhere',
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({
      respectRobotsTxt: false,
      maxRetries: 2,
      followRedirects: false,
      maxRedirects: 0,
      retryDelayMs: 1,
    })
    const result = await fetcher.fetch('https://example.com/redir')
    expect(result.status).toBe(301)
  })
})

describe('WebScraper - scrape without extraction options', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('calls http fetcher with empty extraction when no options and no config.extraction', async () => {
    const scraper = new WebScraper({ mode: 'http' })
    const httpFetch = vi.fn().mockResolvedValue({
      url: 'https://example.com',
      status: 200,
      contentType: 'text/html',
      text: 'x'.repeat(250),
      durationMs: 1,
      method: 'http' as const,
    })
    ;(scraper as unknown as { httpFetcher: { fetch: unknown } }).httpFetcher = { fetch: httpFetch }

    await scraper.scrape('https://example.com')

    const callArgs = httpFetch.mock.calls[0]![1] as { timeout: number; extraction?: Record<string, unknown> }
    expect(callArgs.timeout).toBe(30000)
    expect(callArgs.extraction).toBeDefined()
  })

  it('calls scrapeHttp directly with undefined options to hit the undefined branch', async () => {
    const scraper = new WebScraper({ mode: 'http' })
    const httpFetch = vi.fn().mockResolvedValue({
      url: 'https://example.com',
      status: 200,
      contentType: 'text/html',
      text: 'x'.repeat(250),
      durationMs: 1,
      method: 'http' as const,
    })
    ;(scraper as unknown as { httpFetcher: { fetch: unknown } }).httpFetcher = { fetch: httpFetch }

    const scrapeHttp = (scraper as unknown as {
      scrapeHttp: (url: string, timeout: number, options?: unknown) => Promise<unknown>
    }).scrapeHttp.bind(scraper)
    await scrapeHttp('https://example.com', 5000, undefined)

    const callArgs = httpFetch.mock.calls[0]![1] as { timeout: number; extraction?: unknown }
    expect(callArgs.timeout).toBe(5000)
    expect(callArgs).not.toHaveProperty('extraction')
  })

  it('calls scrapeBrowser directly with undefined options to hit the undefined branch', async () => {
    const scraper = new WebScraper({ mode: 'browser' })
    const browserFetch = vi.fn().mockResolvedValue({
      url: 'https://example.com',
      status: 200,
      contentType: 'text/html',
      text: 'x'.repeat(250),
      durationMs: 1,
      method: 'browser' as const,
    })
    ;(scraper as unknown as { browserPool: { fetch: unknown; destroy: unknown } }).browserPool = {
      fetch: browserFetch,
      destroy: vi.fn().mockResolvedValue(undefined),
    }

    const scrapeBrowser = (scraper as unknown as {
      scrapeBrowser: (url: string, timeout: number, options?: unknown) => Promise<unknown>
    }).scrapeBrowser.bind(scraper)
    await scrapeBrowser('https://example.com', 5000, undefined)

    const callArgs = browserFetch.mock.calls[0]![1] as { timeout: number; extraction?: unknown }
    expect(callArgs.timeout).toBe(5000)
    expect(callArgs).not.toHaveProperty('extraction')
  })

  it('uses default 30s timeout when config.timeout is undefined', async () => {
    const scraper = new WebScraper({ mode: 'http' })
    ;(scraper as unknown as { config: { timeout: undefined } }).config.timeout = undefined

    const httpFetch = vi.fn().mockResolvedValue({
      url: 'https://example.com',
      status: 200,
      contentType: 'text/html',
      text: 'x'.repeat(250),
      durationMs: 1,
      method: 'http' as const,
    })
    ;(scraper as unknown as { httpFetcher: { fetch: unknown } }).httpFetcher = { fetch: httpFetch }

    await scraper.scrape('https://example.com')

    const callArgs = httpFetch.mock.calls[0]![1] as { timeout: number }
    expect(callArgs.timeout).toBe(30000)
  })

  it('throws non-Error browser failure with stringified message in auto mode', async () => {
    const scraper = new WebScraper({ mode: 'auto' })
    const httpFetch = vi.fn().mockRejectedValue(new Error('HTTP failed'))
    const browserFetch = vi.fn().mockRejectedValue({ code: 'BROWSER_CRASH', details: 'opaque' })
    ;(scraper as unknown as { httpFetcher: { fetch: unknown } }).httpFetcher = { fetch: httpFetch }
    ;(scraper as unknown as { browserPool: { fetch: unknown; destroy: unknown } }).browserPool = {
      fetch: browserFetch,
      destroy: vi.fn().mockResolvedValue(undefined),
    }

    await expect(scraper.scrape('https://example.com')).rejects.toThrow(
      /Both HTTP and browser fetch failed/,
    )
  })
})

describe('HttpFetcher - response URL handling', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('falls back to request URL when response.url is empty', async () => {
    const response = new Response('<html><body>' + 'X'.repeat(200) + '</body></html>', { status: 200 })
    Object.defineProperty(response, 'url', { value: '' })
    const fetchMock = vi.fn(async () => response)
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 0 })
    const result = await fetcher.fetch('https://example.com/original')
    expect(result.url).toBe('https://example.com/original')
  })

  it('uses response.url when provided (typically after redirect following)', async () => {
    const response = makeResponse('<html><body>' + 'X'.repeat(200) + '</body></html>', {
      url: 'https://example.com/final-destination',
    })
    const fetchMock = vi.fn(async () => response)
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: false, maxRetries: 0 })
    const result = await fetcher.fetch('https://example.com/start')
    expect(result.url).toBe('https://example.com/final-destination')
  })
})
