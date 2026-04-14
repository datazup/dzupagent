import { describe, it, expect, vi } from 'vitest'
import { WebScraper } from '../scraper.js'
import { RobotsDisallowedError } from '../http-fetcher.js'
import type { FetchResult } from '../types.js'

const baseResult: FetchResult = {
  url: 'https://example.com',
  status: 200,
  contentType: 'text/html',
  text: 'x'.repeat(250),
  durationMs: 10,
  method: 'http',
}

describe('WebScraper extraction option propagation', () => {
  it('passes merged extraction options into HTTP fetcher', async () => {
    const scraper = new WebScraper({
      mode: 'http',
      extraction: {
        mode: 'metadata',
        cleanHtml: false,
        maxLength: 1200,
      },
    })

    const fetch = vi.fn().mockResolvedValue(baseResult)
    ;(scraper as unknown as { httpFetcher: { fetch: typeof fetch } }).httpFetcher = { fetch }

    await scraper.scrape('https://example.com', {
      mode: 'text',
      maxLength: 80,
    })

    expect(fetch).toHaveBeenCalledWith('https://example.com', {
      timeout: 30_000,
      extraction: {
        mode: 'text',
        cleanHtml: false,
        maxLength: 80,
      },
    })
  })

  it('passes extraction options into browser fallback in auto mode', async () => {
    const scraper = new WebScraper({
      mode: 'auto',
      extraction: {
        mode: 'text',
        cleanHtml: true,
      },
    })

    const fetchHttp = vi.fn().mockResolvedValue({
      ...baseResult,
      text: 'too short for auto-mode threshold',
    })
    const fetchBrowser = vi.fn().mockResolvedValue({
      ...baseResult,
      method: 'browser',
      text: 'y'.repeat(400),
    })

    ;(scraper as unknown as { httpFetcher: { fetch: typeof fetchHttp } }).httpFetcher = {
      fetch: fetchHttp,
    }
    ;(scraper as unknown as { browserPool: { fetch: typeof fetchBrowser } }).browserPool = {
      fetch: fetchBrowser,
    }

    await scraper.scrape('https://example.com/path', {
      mode: 'metadata',
      cleanHtml: false,
      maxLength: 42,
    })

    expect(fetchHttp).toHaveBeenCalledWith('https://example.com/path', {
      timeout: 30_000,
      extraction: {
        mode: 'metadata',
        cleanHtml: false,
        maxLength: 42,
      },
    })
    expect(fetchBrowser).toHaveBeenCalledWith('https://example.com/path', {
      timeout: 30_000,
      extraction: {
        mode: 'metadata',
        cleanHtml: false,
        maxLength: 42,
      },
    })
  })

  it('falls back to browser when HTTP fetch fails for a non-policy reason', async () => {
    const scraper = new WebScraper({
      mode: 'auto',
      extraction: {
        mode: 'html',
        cleanHtml: true,
      },
    })

    const fetchHttp = vi.fn().mockRejectedValue(new Error('HTTP 503'))
    const fetchBrowser = vi.fn().mockResolvedValue({
      ...baseResult,
      method: 'browser',
      text: 'z'.repeat(320),
    })

    ;(scraper as unknown as { httpFetcher: { fetch: typeof fetchHttp } }).httpFetcher = {
      fetch: fetchHttp,
    }
    ;(scraper as unknown as { browserPool: { fetch: typeof fetchBrowser } }).browserPool = {
      fetch: fetchBrowser,
    }

    const result = await scraper.scrape('https://example.com/failover', {
      mode: 'metadata',
      cleanHtml: false,
      maxLength: 33,
    })

    expect(result.method).toBe('browser')
    expect(fetchHttp).toHaveBeenCalledWith('https://example.com/failover', {
      timeout: 30_000,
      extraction: {
        mode: 'metadata',
        cleanHtml: false,
        maxLength: 33,
      },
    })
    expect(fetchBrowser).toHaveBeenCalledWith('https://example.com/failover', {
      timeout: 30_000,
      extraction: {
        mode: 'metadata',
        cleanHtml: false,
        maxLength: 33,
      },
    })
  })

  it('does not fall back to browser when robots.txt blocks the HTTP request', async () => {
    const scraper = new WebScraper({
      mode: 'auto',
    })

    const fetchHttp = vi.fn().mockRejectedValue(
      new RobotsDisallowedError('https://example.com/private/page'),
    )
    const fetchBrowser = vi.fn().mockResolvedValue({
      ...baseResult,
      method: 'browser',
      text: 'browser fallback should not be used',
    })

    ;(scraper as unknown as { httpFetcher: { fetch: typeof fetchHttp } }).httpFetcher = {
      fetch: fetchHttp,
    }
    ;(scraper as unknown as { browserPool: { fetch: typeof fetchBrowser } }).browserPool = {
      fetch: fetchBrowser,
    }

    await expect(scraper.scrape('https://example.com/private/page')).rejects.toThrow(
      'Blocked by robots.txt',
    )
    expect(fetchBrowser).not.toHaveBeenCalled()
  })
})
