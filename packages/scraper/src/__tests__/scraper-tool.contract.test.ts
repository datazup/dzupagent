import { describe, expect, it, vi } from 'vitest'
import { normalizeScraperTool, WebScraper } from '../index.js'
import type { FetchResult } from '../types.js'

const baseResult: FetchResult = {
  url: 'https://example.com/tool',
  status: 200,
  contentType: 'text/html',
  text: 'tool response',
  title: 'Example',
  durationMs: 12,
  method: 'http',
}

describe('WebScraper.asTool contract', () => {
  it('exposes cleanHtml and maxLength in the public schema', () => {
    const tool = new WebScraper().asTool()

    expect(tool.id).toBe('web_scraper')
    expect(tool.schema.properties).toMatchObject({
      url: { type: 'string' },
      extractMode: { type: 'string', enum: ['text', 'html', 'metadata', 'all'] },
      cleanHtml: { type: 'boolean' },
      maxLength: { type: 'number' },
    })
  })

  it('passes extractMode, cleanHtml, and maxLength through invoke()', async () => {
    const scraper = new WebScraper()
    const scrape = vi.fn().mockResolvedValue(baseResult)
    ;(scraper as unknown as { scrape: typeof scrape }).scrape = scrape

    const tool = scraper.asTool()
    const raw = await tool.invoke({
      url: 'https://example.com/tool',
      extractMode: 'metadata',
      cleanHtml: false,
      maxLength: 64,
    })

    expect(scrape).toHaveBeenCalledWith('https://example.com/tool', {
      mode: 'metadata',
      cleanHtml: false,
      maxLength: 64,
    })
    expect(JSON.parse(raw)).toMatchObject({
      url: baseResult.url,
      title: baseResult.title,
      text: baseResult.text,
      status: baseResult.status,
      method: baseResult.method,
      durationMs: baseResult.durationMs,
    })
  })

  it('normalizes a scraper tool descriptor into the connector contract shape', () => {
    const tool = normalizeScraperTool({
      name: 'web_scraper',
      description: 'Fetch and extract clean text content from a web URL.',
      schema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
      invoke: async () => 'ok',
    })

    expect(tool.id).toBe('web_scraper')
    expect(tool.name).toBe('web_scraper')
    expect(typeof tool.invoke).toBe('function')
  })

  it('preserves sane defaults when optional tool inputs are omitted', async () => {
    const scraper = new WebScraper()
    const scrape = vi.fn().mockResolvedValue(baseResult)
    ;(scraper as unknown as { scrape: typeof scrape }).scrape = scrape

    const tool = scraper.asTool()
    await tool.invoke({ url: 'https://example.com/defaults' })

    expect(scrape).toHaveBeenCalledWith('https://example.com/defaults', {
      mode: 'text',
    })
  })
})
