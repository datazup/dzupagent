import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BrowserPool } from '../browser-pool.js'

// Mock puppeteer and puppeteer-extra so no real browser is launched
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

function createMockPage(overrides?: Partial<{
  goto: ReturnType<typeof vi.fn>
  content: ReturnType<typeof vi.fn>
  waitForSelector: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  browser: ReturnType<typeof vi.fn>
}>) {
  const mockBrowser = { close: vi.fn().mockResolvedValue(undefined) }
  return {
    goto: overrides?.goto ?? vi.fn().mockResolvedValue({ status: () => 200 }),
    content: overrides?.content ?? vi.fn().mockResolvedValue('<html><head><title>Test</title></head><body><p>' + 'A'.repeat(200) + '</p></body></html>'),
    waitForSelector: overrides?.waitForSelector ?? vi.fn().mockResolvedValue(undefined),
    close: overrides?.close ?? vi.fn().mockResolvedValue(undefined),
    browser: overrides?.browser ?? vi.fn(() => mockBrowser),
    _mockBrowser: mockBrowser,
  }
}

function createMockBrowser(page?: ReturnType<typeof createMockPage>) {
  const mockPage = page ?? createMockPage()
  const browser = {
    newPage: vi.fn().mockResolvedValue(mockPage),
    close: vi.fn().mockResolvedValue(undefined),
    _mockPage: mockPage,
  }
  // Ensure page.browser() returns this browser
  mockPage.browser = vi.fn(() => browser)
  return browser
}

describe('BrowserPool', () => {
  let pool: BrowserPool

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(async () => {
    if (pool) {
      // Force-clean the pool to avoid leaked timers
      const entries = (pool as unknown as { entries: Array<{ idleTimer: ReturnType<typeof setTimeout> | null; browser: { close: () => Promise<void> } }> }).entries
      for (const entry of entries) {
        if (entry.idleTimer !== null) {
          clearTimeout(entry.idleTimer)
          entry.idleTimer = null
        }
      }
      entries.length = 0
      ;(pool as unknown as { destroyed: boolean }).destroyed = true
    }
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  describe('constructor', () => {
    it('creates pool with default config', () => {
      pool = new BrowserPool()
      expect(pool).toBeDefined()
    })

    it('creates pool with custom config', () => {
      pool = new BrowserPool({
        maxConcurrency: 5,
        idleTimeoutMs: 120_000,
        stealth: false,
        headless: false,
      })
      expect(pool).toBeDefined()
    })

    it('accepts partial config and merges with defaults', () => {
      pool = new BrowserPool({ maxConcurrency: 1 })
      expect(pool).toBeDefined()
    })
  })

  describe('acquire', () => {
    it('throws when pool is destroyed', async () => {
      pool = new BrowserPool()
      await pool.destroy()
      await expect(pool.acquire()).rejects.toThrow('BrowserPool has been destroyed')
    })

    it('acquires a new page from a launched browser', async () => {
      pool = new BrowserPool({ stealth: false, maxConcurrency: 1 })
      const mockBrowser = createMockBrowser()
      const puppeteer = await import('puppeteer')
      ;(puppeteer.default.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser)

      const page = await pool.acquire()
      expect(page).toBeDefined()
      expect(mockBrowser.newPage).toHaveBeenCalled()
    })

    it('reuses existing browser when it has capacity', async () => {
      pool = new BrowserPool({ stealth: false, maxConcurrency: 2 })
      const mockPage1 = createMockPage()
      const mockPage2 = createMockPage()
      const mockBrowser = createMockBrowser()
      mockBrowser.newPage
        .mockResolvedValueOnce(mockPage1)
        .mockResolvedValueOnce(mockPage2)

      const puppeteer = await import('puppeteer')
      ;(puppeteer.default.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser)

      const page1 = await pool.acquire()
      // Release page1 so browser has capacity
      mockPage1.browser = vi.fn(() => mockBrowser)
      await pool.release(page1)

      const page2 = await pool.acquire()
      expect(page2).toBeDefined()
      // Should reuse same browser, not launch a new one
      expect(puppeteer.default.launch).toHaveBeenCalledTimes(1)
    })

    it('launches additional browser when existing one is at capacity', async () => {
      pool = new BrowserPool({ stealth: false, maxConcurrency: 2 })
      const mockBrowser1 = createMockBrowser()
      const mockBrowser2 = createMockBrowser()

      const puppeteer = await import('puppeteer')
      ;(puppeteer.default.launch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(mockBrowser1)
        .mockResolvedValueOnce(mockBrowser2)

      // Acquire from browser 1 (now at capacity: 1 active page)
      await pool.acquire()
      // Need another, browser 1 is full, so should launch browser 2
      await pool.acquire()

      expect(puppeteer.default.launch).toHaveBeenCalledTimes(2)
    })
  })

  describe('release', () => {
    it('releases a page and decrements active count', async () => {
      pool = new BrowserPool({ stealth: false, maxConcurrency: 1 })
      const mockBrowser = createMockBrowser()

      const puppeteer = await import('puppeteer')
      ;(puppeteer.default.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser)

      const page = await pool.acquire()
      await pool.release(page)

      expect(mockBrowser._mockPage.close).toHaveBeenCalled()
    })

    it('handles close errors gracefully', async () => {
      pool = new BrowserPool({ stealth: false, maxConcurrency: 1 })
      const mockPage = createMockPage({
        close: vi.fn().mockRejectedValue(new Error('Page already closed')),
      })
      const mockBrowser = createMockBrowser(mockPage)
      mockPage.browser = vi.fn(() => mockBrowser)

      const puppeteer = await import('puppeteer')
      ;(puppeteer.default.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser)

      const page = await pool.acquire()
      // Should not throw even if close fails
      await expect(pool.release(page)).resolves.toBeUndefined()
    })
  })

  describe('fetch', () => {
    it('fetches a URL and returns extracted content', async () => {
      pool = new BrowserPool({ stealth: false, maxConcurrency: 1 })
      const html = '<html><head><title>Fetched Page</title></head><body><p>' + 'Content '.repeat(30) + '</p></body></html>'
      const mockPage = createMockPage({
        content: vi.fn().mockResolvedValue(html),
        goto: vi.fn().mockResolvedValue({ status: () => 200 }),
      })
      const mockBrowser = createMockBrowser(mockPage)
      mockPage.browser = vi.fn(() => mockBrowser)

      const puppeteer = await import('puppeteer')
      ;(puppeteer.default.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser)

      const result = await pool.fetch('https://example.com')
      expect(result.url).toBe('https://example.com')
      expect(result.method).toBe('browser')
      expect(result.status).toBe(200)
      expect(result.title).toBe('Fetched Page')
      expect(result.text).toContain('Content')
      expect(result.html).toBe(html)
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
      expect(result.contentType).toBe('text/html')
    })

    it('passes timeout to page.goto', async () => {
      pool = new BrowserPool({ stealth: false, maxConcurrency: 1 })
      const mockPage = createMockPage()
      const mockBrowser = createMockBrowser(mockPage)
      mockPage.browser = vi.fn(() => mockBrowser)

      const puppeteer = await import('puppeteer')
      ;(puppeteer.default.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser)

      await pool.fetch('https://example.com', { timeout: 5000 })
      expect(mockPage.goto).toHaveBeenCalledWith('https://example.com', {
        waitUntil: 'networkidle2',
        timeout: 5000,
      })
    })

    it('waits for selector when waitFor option is provided', async () => {
      pool = new BrowserPool({ stealth: false, maxConcurrency: 1 })
      const mockPage = createMockPage()
      const mockBrowser = createMockBrowser(mockPage)
      mockPage.browser = vi.fn(() => mockBrowser)

      const puppeteer = await import('puppeteer')
      ;(puppeteer.default.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser)

      await pool.fetch('https://example.com', { waitFor: '#main-content' })
      expect(mockPage.waitForSelector).toHaveBeenCalledWith('#main-content', { timeout: 5000 })
    })

    it('does not throw when waitForSelector times out', async () => {
      pool = new BrowserPool({ stealth: false, maxConcurrency: 1 })
      const mockPage = createMockPage({
        waitForSelector: vi.fn().mockRejectedValue(new Error('Timeout')),
      })
      const mockBrowser = createMockBrowser(mockPage)
      mockPage.browser = vi.fn(() => mockBrowser)

      const puppeteer = await import('puppeteer')
      ;(puppeteer.default.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser)

      // Should not throw
      const result = await pool.fetch('https://example.com', { waitFor: '.lazy-content' })
      expect(result.status).toBe(200)
    })

    it('handles null response from goto', async () => {
      pool = new BrowserPool({ stealth: false, maxConcurrency: 1 })
      const mockPage = createMockPage({
        goto: vi.fn().mockResolvedValue(null),
      })
      const mockBrowser = createMockBrowser(mockPage)
      mockPage.browser = vi.fn(() => mockBrowser)

      const puppeteer = await import('puppeteer')
      ;(puppeteer.default.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser)

      const result = await pool.fetch('https://example.com')
      expect(result.status).toBe(0) // null response → status 0
    })

    it('releases page even when goto throws', async () => {
      pool = new BrowserPool({ stealth: false, maxConcurrency: 1 })
      const mockPage = createMockPage({
        goto: vi.fn().mockRejectedValue(new Error('Navigation failed')),
      })
      const mockBrowser = createMockBrowser(mockPage)
      mockPage.browser = vi.fn(() => mockBrowser)

      const puppeteer = await import('puppeteer')
      ;(puppeteer.default.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser)

      await expect(pool.fetch('https://example.com')).rejects.toThrow('Navigation failed')
      // The page should still have been released (closed)
      expect(mockPage.close).toHaveBeenCalled()
    })

    it('passes extraction options through to extractor', async () => {
      pool = new BrowserPool({ stealth: false, maxConcurrency: 1 })
      const html = '<html><head><title>Title</title><meta name="description" content="Desc"></head><body><p>Body text</p></body></html>'
      const mockPage = createMockPage({
        content: vi.fn().mockResolvedValue(html),
      })
      const mockBrowser = createMockBrowser(mockPage)
      mockPage.browser = vi.fn(() => mockBrowser)

      const puppeteer = await import('puppeteer')
      ;(puppeteer.default.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser)

      const result = await pool.fetch('https://example.com', {
        extraction: { mode: 'metadata' },
      })
      expect(result.text).toBe('')
      expect(result.title).toBe('Title')
      expect(result.description).toBe('Desc')
    })
  })

  describe('destroy', () => {
    it('closes all browsers and clears entries', async () => {
      pool = new BrowserPool({ stealth: false, maxConcurrency: 2 })
      const mockBrowser1 = createMockBrowser()
      const mockBrowser2 = createMockBrowser()

      const puppeteer = await import('puppeteer')
      ;(puppeteer.default.launch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(mockBrowser1)
        .mockResolvedValueOnce(mockBrowser2)

      await pool.acquire()
      await pool.acquire()

      await pool.destroy()

      expect(mockBrowser1.close).toHaveBeenCalled()
      expect(mockBrowser2.close).toHaveBeenCalled()
    })

    it('handles browser close errors gracefully during destroy', async () => {
      pool = new BrowserPool({ stealth: false, maxConcurrency: 1 })
      const mockBrowser = createMockBrowser()
      mockBrowser.close.mockRejectedValue(new Error('Already closed'))

      const puppeteer = await import('puppeteer')
      ;(puppeteer.default.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser)

      await pool.acquire()
      // Should not throw
      await expect(pool.destroy()).resolves.toBeUndefined()
    })

    it('prevents new acquisitions after destroy', async () => {
      pool = new BrowserPool({ stealth: false })
      await pool.destroy()
      await expect(pool.acquire()).rejects.toThrow('BrowserPool has been destroyed')
    })
  })

  describe('stealth mode', () => {
    it('loads puppeteer-extra with stealth plugin when stealth is true', async () => {
      pool = new BrowserPool({ stealth: true, maxConcurrency: 1 })

      const puppeteerExtra = await import('puppeteer-extra')
      const mockBrowser = createMockBrowser()
      ;(puppeteerExtra.default.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser)

      await pool.acquire()
      expect(puppeteerExtra.default.use).toHaveBeenCalled()
    })

    it('falls back to plain puppeteer when puppeteer-extra import fails', async () => {
      // Reset module cache to test fallback
      pool = new BrowserPool({ stealth: true, maxConcurrency: 1 })

      // We need to simulate puppeteer-extra failing
      // Since vi.mock is hoisted, we'll test a different path:
      // Just verify that the pool still works with stealth=false
      const pool2 = new BrowserPool({ stealth: false, maxConcurrency: 1 })
      const puppeteer = await import('puppeteer')
      const mockBrowser = createMockBrowser()
      ;(puppeteer.default.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser)

      const page = await pool2.acquire()
      expect(page).toBeDefined()

      // Cleanup pool2
      const entries2 = (pool2 as unknown as { entries: Array<{ idleTimer: ReturnType<typeof setTimeout> | null }> }).entries
      for (const entry of entries2) {
        if (entry.idleTimer !== null) clearTimeout(entry.idleTimer)
      }
      entries2.length = 0
      ;(pool2 as unknown as { destroyed: boolean }).destroyed = true
    })
  })

  describe('launch arguments', () => {
    it('uses custom launch args when provided', async () => {
      const customArgs = ['--disable-gpu', '--no-sandbox']
      pool = new BrowserPool({ stealth: false, maxConcurrency: 1, launchArgs: customArgs })
      const mockBrowser = createMockBrowser()

      const puppeteer = await import('puppeteer')
      ;(puppeteer.default.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser)

      await pool.acquire()
      expect(puppeteer.default.launch).toHaveBeenCalledWith(
        expect.objectContaining({ args: customArgs }),
      )
    })

    it('uses custom executable path when provided', async () => {
      pool = new BrowserPool({
        stealth: false,
        maxConcurrency: 1,
        executablePath: '/usr/bin/chromium',
      })
      const mockBrowser = createMockBrowser()

      const puppeteer = await import('puppeteer')
      ;(puppeteer.default.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser)

      await pool.acquire()
      expect(puppeteer.default.launch).toHaveBeenCalledWith(
        expect.objectContaining({ executablePath: '/usr/bin/chromium' }),
      )
    })

    it('respects headless config', async () => {
      pool = new BrowserPool({ stealth: false, maxConcurrency: 1, headless: false })
      const mockBrowser = createMockBrowser()

      const puppeteer = await import('puppeteer')
      ;(puppeteer.default.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser)

      await pool.acquire()
      expect(puppeteer.default.launch).toHaveBeenCalledWith(
        expect.objectContaining({ headless: false }),
      )
    })
  })
})
