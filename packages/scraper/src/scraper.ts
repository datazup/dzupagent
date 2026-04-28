import type {
  ScraperConfig,
  ExtractionConfig,
  FetchResult,
  ScraperToolSchema,
} from './types.js'
import { normalizeScraperTool, type ScraperConnectorTool } from './connector-contract.js'
import { HttpFetcher, RobotsDisallowedError } from './http-fetcher.js'
import { BrowserPool } from './browser-pool.js'

const DEFAULT_CONFIG: ScraperConfig = {
  mode: 'auto',
  timeout: 30_000,
}

/**
 * High-level web scraper that orchestrates HTTP fetching and browser-based
 * scraping with automatic fallback.
 *
 * - `mode: 'http'` — always use lightweight HTTP fetch
 * - `mode: 'browser'` — always use Puppeteer browser pool
 * - `mode: 'auto'` — try HTTP first, fall back to browser on failure
 */
export class WebScraper {
  private readonly config: ScraperConfig
  private readonly httpFetcher: HttpFetcher
  private browserPool: BrowserPool | null = null

  constructor(config?: Partial<ScraperConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.httpFetcher = new HttpFetcher({
      ...this.config.http,
      ...(this.config.urlPolicy ? { urlPolicy: this.config.urlPolicy } : {}),
    })
  }

  /** Fetch and extract content from a URL */
  async scrape(
    url: string,
    options?: Partial<ExtractionConfig>,
  ): Promise<FetchResult> {
    const timeout = this.config.timeout ?? 30_000
    const extraction = { ...this.config.extraction, ...options }

    switch (this.config.mode) {
      case 'http':
        return this.scrapeHttp(url, timeout, extraction)

      case 'browser':
        return this.scrapeBrowser(url, timeout, extraction)

      case 'auto':
      default:
        return this.scrapeAuto(url, timeout, extraction)
    }
  }

  /** Scrape multiple URLs concurrently */
  async scrapeMany(
    urls: string[],
    options?: { concurrency?: number } & Partial<ExtractionConfig>,
  ): Promise<FetchResult[]> {
    const concurrency = options?.concurrency ?? 5
    const results: FetchResult[] = []
    const extractionOpts: Partial<ExtractionConfig> | undefined = options
      ? {
          ...(options.mode !== undefined ? { mode: options.mode } : {}),
          ...(options.cleanHtml !== undefined ? { cleanHtml: options.cleanHtml } : {}),
          ...(options.maxLength !== undefined ? { maxLength: options.maxLength } : {}),
        }
      : undefined

    // Process in batches
    for (let i = 0; i < urls.length; i += concurrency) {
      const batch = urls.slice(i, i + concurrency)
      const batchResults = await Promise.allSettled(
        batch.map((u) => this.scrape(u, extractionOpts)),
      )

      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j]!
        const batchUrl = batch[j]!
        if (result.status === 'fulfilled') {
          results.push(result.value)
        } else {
          // Return a failed result rather than throwing
          results.push({
            url: batchUrl,
            status: 0,
            contentType: '',
            text: `Error: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
            durationMs: 0,
            method: 'http',
          })
        }
      }
    }

    return results
  }

  /**
   * Create a DzupAgent-compatible tool descriptor.
   *
   * Follows the pattern used by `createForgeTool` in `@dzupagent/agent` —
   * returns an object with name, description, schema, and invoke function.
   */
  asTool(): ScraperConnectorTool {
    return normalizeScraperTool({
      id: 'web_scraper',
      name: 'web_scraper',
      description:
        'Fetch and extract clean text content from a web URL. Returns the page text, title, and metadata.',
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to scrape' },
          extractMode: {
            type: 'string',
            enum: ['text', 'html', 'metadata', 'all'],
            description: 'What to extract (default: text)',
          },
          cleanHtml: {
            type: 'boolean',
            description: 'Whether to remove scripts, styles, and boilerplate elements (default: true)',
          },
          maxLength: {
            type: 'number',
            description: 'Maximum number of characters to return',
          },
        },
        required: ['url'],
      },
      invoke: async (input: ScraperToolSchema): Promise<string> => {
        const extraction: Partial<ExtractionConfig> = {
          mode: input.extractMode ?? 'text',
        }
        if (input.cleanHtml !== undefined) {
          extraction.cleanHtml = input.cleanHtml
        }
        if (input.maxLength !== undefined) {
          extraction.maxLength = input.maxLength
        }

        const result = await this.scrape(input.url, extraction)

        return JSON.stringify(
          {
            url: result.url,
            title: result.title,
            description: result.description,
            author: result.author,
            publishedDate: result.publishedDate,
            text: result.text,
            status: result.status,
            method: result.method,
            durationMs: result.durationMs,
          },
          null,
          2,
        )
      },
    })
  }

  /** Shut down resources (browser pool) */
  async destroy(): Promise<void> {
    if (this.browserPool) {
      await this.browserPool.destroy()
      this.browserPool = null
    }
  }

  /** Scrape using HTTP only */
  private async scrapeHttp(
    url: string,
    timeout: number,
    options?: Partial<ExtractionConfig>,
  ): Promise<FetchResult> {
    return this.httpFetcher.fetch(url, { timeout, ...(options !== undefined ? { extraction: options } : {}) })
  }

  /** Scrape using browser pool */
  private async scrapeBrowser(
    url: string,
    timeout: number,
    options?: Partial<ExtractionConfig>,
  ): Promise<FetchResult> {
    const pool = this.getOrCreateBrowserPool()
    return pool.fetch(url, { timeout, ...(options !== undefined ? { extraction: options } : {}) })
  }

  /** Try HTTP first, fall back to browser if it fails or returns empty/error content */
  private async scrapeAuto(
    url: string,
    timeout: number,
    options?: Partial<ExtractionConfig>,
  ): Promise<FetchResult> {
    try {
      const result = await this.scrapeHttp(url, timeout, options)

      // If HTTP succeeded with real content, return it
      if (result.status >= 200 && result.status < 400 && result.text.length > 100) {
        return result
      }

      // Content too short or bad status — try browser
      return this.scrapeBrowser(url, timeout, options)
    } catch (error) {
      if (error instanceof RobotsDisallowedError) {
        throw error
      }
      // HTTP failed entirely — try browser as fallback
      try {
        return await this.scrapeBrowser(url, timeout, options)
      } catch (browserError) {
        throw new Error(
          `Both HTTP and browser fetch failed for ${url}: ${
            browserError instanceof Error ? browserError.message : String(browserError)
          }`,
        )
      }
    }
  }

  /** Lazily create the browser pool */
  private getOrCreateBrowserPool(): BrowserPool {
    if (!this.browserPool) {
      this.browserPool = new BrowserPool({
        ...this.config.browser,
        ...(this.config.urlPolicy ? { urlPolicy: this.config.urlPolicy } : {}),
      })
    }
    return this.browserPool
  }
}
