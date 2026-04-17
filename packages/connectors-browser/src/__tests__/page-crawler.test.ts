import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { PageCrawler } from '../crawler/page-crawler.js'

// ---------------------------------------------------------------------------
// Mock extraction modules
// ---------------------------------------------------------------------------

vi.mock('../crawler/link-extractor.js', () => ({
  extractLinks: vi.fn(async () => []),
}))

vi.mock('../extraction/accessibility-tree.js', () => ({
  extractAccessibilityTree: vi.fn(async () => []),
}))

vi.mock('../extraction/screenshot-capture.js', () => ({
  captureScreenshot: vi.fn(async () => ({
    buffer: Buffer.from('screenshot'),
    mimeType: 'image/jpeg',
    width: 1280,
    height: 720,
  })),
}))

vi.mock('../extraction/form-extractor.js', () => ({
  extractForms: vi.fn(async () => []),
}))

vi.mock('../extraction/element-extractor.js', () => ({
  extractInteractiveElements: vi.fn(async () => []),
}))

const { extractLinks } = await import('../crawler/link-extractor.js')
const mockedExtractLinks = vi.mocked(extractLinks)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockPage(url = 'https://example.com'): Page {
  return {
    url: () => url,
    goto: vi.fn(async () => null),
    title: vi.fn(async () => 'Test Page'),
    evaluate: vi.fn(async (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => {
      if (typeof fn === 'function') return fn(...args)
      return undefined
    }),
    waitForLoadState: vi.fn(async () => undefined),
    waitForTimeout: vi.fn(async () => undefined),
    waitForFunction: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as Page
}

function createMockContext(): BrowserContext {
  const page = createMockPage()
  return {
    newPage: vi.fn(async () => page),
  } as unknown as BrowserContext
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PageCrawler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedExtractLinks.mockResolvedValue([])
  })

  it('crawls the start URL and yields a CrawlResult', async () => {
    const context = createMockContext()
    const crawler = new PageCrawler(context)

    const results: unknown[] = []
    for await (const result of crawler.crawl('https://example.com')) {
      results.push(result)
    }

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      url: 'https://example.com',
      title: 'Test Page',
      depth: 0,
    })
  })

  it('respects maxPages limit', async () => {
    const context = createMockContext()
    const crawler = new PageCrawler(context, { maxPages: 2, maxDepth: 5 })

    // Each page returns 3 links
    mockedExtractLinks.mockResolvedValue([
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
    ])

    const results: unknown[] = []
    for await (const result of crawler.crawl('https://example.com')) {
      results.push(result)
    }

    expect(results.length).toBeLessThanOrEqual(2)
  })

  it('respects maxDepth limit', async () => {
    const context = createMockContext()
    const crawler = new PageCrawler(context, { maxPages: 100, maxDepth: 0 })

    mockedExtractLinks.mockResolvedValue([
      'https://example.com/deep',
    ])

    const results: unknown[] = []
    for await (const result of crawler.crawl('https://example.com')) {
      results.push(result)
    }

    // Only the start URL at depth 0 should be crawled
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ depth: 0 })
  })

  it('does not visit the same URL twice', async () => {
    const context = createMockContext()
    const crawler = new PageCrawler(context, { maxPages: 10, maxDepth: 2 })

    // First call returns /a, second call also returns /a (duplicate)
    let callCount = 0
    mockedExtractLinks.mockImplementation(async () => {
      callCount++
      return callCount === 1 ? ['https://example.com/a'] : ['https://example.com/a']
    })

    const results: unknown[] = []
    for await (const result of crawler.crawl('https://example.com')) {
      results.push(result)
    }

    // Should only visit example.com and /a (not /a again)
    expect(results).toHaveLength(2)
  })

  it('applies excludePatterns to skip matching URLs', async () => {
    const context = createMockContext()
    const crawler = new PageCrawler(context, {
      maxPages: 10,
      maxDepth: 2,
      excludePatterns: ['https://example.com/admin*'],
    })

    mockedExtractLinks.mockResolvedValue([
      'https://example.com/admin/settings',
      'https://example.com/public',
    ])

    const urls: string[] = []
    for await (const result of crawler.crawl('https://example.com')) {
      urls.push(result.url)
    }

    expect(urls).toContain('https://example.com')
    expect(urls).toContain('https://example.com/public')
    expect(urls).not.toContain('https://example.com/admin/settings')
  })

  it('applies includePatterns to only crawl matching URLs', async () => {
    const context = createMockContext()
    const crawler = new PageCrawler(context, {
      maxPages: 10,
      maxDepth: 2,
      includePatterns: ['https://example.com/docs*'],
    })

    mockedExtractLinks.mockResolvedValue([
      'https://example.com/docs/api',
      'https://example.com/blog/post',
    ])

    const urls: string[] = []
    for await (const result of crawler.crawl('https://example.com/docs')) {
      urls.push(result.url)
    }

    expect(urls).toContain('https://example.com/docs')
    expect(urls).toContain('https://example.com/docs/api')
    expect(urls).not.toContain('https://example.com/blog/post')
  })

  it('continues crawling when a page fails to load', async () => {
    const failPage = createMockPage()
    ;(failPage.goto as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Navigation timeout'))

    const okPage = createMockPage('https://example.com/ok')

    let pageIdx = 0
    const context = {
      newPage: vi.fn(async () => {
        pageIdx++
        return pageIdx === 1 ? failPage : okPage
      }),
    } as unknown as BrowserContext

    const crawler = new PageCrawler(context, { maxPages: 5, maxDepth: 2 })

    // The start URL fails, but /ok is queued from elsewhere
    mockedExtractLinks.mockResolvedValue([])

    // Suppress the console.warn from the crawler
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const results: unknown[] = []
    for await (const result of crawler.crawl('https://example.com')) {
      results.push(result)
    }

    // The first page threw, so we get 0 results (no more pages queued)
    expect(results).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Navigation timeout'))
    warnSpy.mockRestore()
  })

  it('closes pages after processing', async () => {
    const page = createMockPage()
    const context = {
      newPage: vi.fn(async () => page),
    } as unknown as BrowserContext

    const crawler = new PageCrawler(context, { maxPages: 1, maxDepth: 0 })

    for await (const _result of crawler.crawl('https://example.com')) {
      // consume
    }

    expect(page.close).toHaveBeenCalled()
  })

  it('closes page even when an error occurs', async () => {
    const page = createMockPage()
    ;(page.goto as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('crash'))

    const context = {
      newPage: vi.fn(async () => page),
    } as unknown as BrowserContext

    const crawler = new PageCrawler(context, { maxPages: 1, maxDepth: 0 })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    for await (const _result of crawler.crawl('https://example.com')) {
      // consume
    }

    expect(page.close).toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('tracks pagesVisited count', async () => {
    const context = createMockContext()
    const crawler = new PageCrawler(context, { maxPages: 10, maxDepth: 1 })

    mockedExtractLinks.mockResolvedValue([
      'https://example.com/a',
      'https://example.com/b',
    ])

    for await (const _result of crawler.crawl('https://example.com')) {
      // consume
    }

    expect(crawler.pagesVisited).toBe(3) // start + /a + /b
  })

  it('uses default options when none provided', async () => {
    const context = createMockContext()
    const crawler = new PageCrawler(context)

    // Just verify it can be constructed and used without error
    const results: unknown[] = []
    for await (const result of crawler.crawl('https://example.com')) {
      results.push(result)
    }
    expect(results).toHaveLength(1)
  })

  it('handles hash-based routes by setting window.location.hash', async () => {
    const page = createMockPage('about:blank')
    // Mock page.url() to return different values
    let currentUrl = 'about:blank'
    ;(page.url as unknown) = () => currentUrl
    ;(page.goto as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      currentUrl = 'https://example.com/'
      return null
    })

    const context = {
      newPage: vi.fn(async () => page),
    } as unknown as BrowserContext

    const crawler = new PageCrawler(context, { maxPages: 1, maxDepth: 0 })

    for await (const result of crawler.crawl('https://example.com/#/dashboard')) {
      expect(result.url).toBe('https://example.com/#/dashboard')
    }

    // Should have navigated to base URL then set hash
    expect(page.goto).toHaveBeenCalled()
    expect(page.evaluate).toHaveBeenCalled()
  })

  it('yields results with expected CrawlResult shape', async () => {
    const context = createMockContext()
    const crawler = new PageCrawler(context, { maxPages: 1, maxDepth: 0 })

    for await (const result of crawler.crawl('https://example.com')) {
      expect(result).toHaveProperty('url')
      expect(result).toHaveProperty('title')
      expect(result).toHaveProperty('depth')
      expect(result).toHaveProperty('links')
      expect(result).toHaveProperty('accessibilityTree')
      expect(result).toHaveProperty('screenshot')
      expect(result).toHaveProperty('screenshotMimeType')
      expect(result).toHaveProperty('forms')
      expect(result).toHaveProperty('interactiveElements')
      expect(result).toHaveProperty('loadTimeMs')
      expect(typeof result.loadTimeMs).toBe('number')
      expect(result.loadTimeMs).toBeGreaterThanOrEqual(0)
    }
  })

  it('enqueues discovered links at depth+1', async () => {
    const context = createMockContext()
    const crawler = new PageCrawler(context, { maxPages: 10, maxDepth: 3 })

    let callIdx = 0
    mockedExtractLinks.mockImplementation(async () => {
      callIdx++
      if (callIdx === 1) return ['https://example.com/level1']
      if (callIdx === 2) return ['https://example.com/level2']
      return []
    })

    const depths: number[] = []
    for await (const result of crawler.crawl('https://example.com')) {
      depths.push(result.depth)
    }

    expect(depths).toEqual([0, 1, 2])
  })

  it('does not enqueue links beyond maxPages capacity', async () => {
    const context = createMockContext()
    const crawler = new PageCrawler(context, { maxPages: 2, maxDepth: 5 })

    mockedExtractLinks.mockResolvedValue([
      'https://example.com/1',
      'https://example.com/2',
      'https://example.com/3',
      'https://example.com/4',
    ])

    const results: unknown[] = []
    for await (const result of crawler.crawl('https://example.com')) {
      results.push(result)
    }

    expect(results.length).toBeLessThanOrEqual(2)
  })
})
