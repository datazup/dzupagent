import type { HttpFetcherConfig, FetchResult } from './types.js'
import { ContentExtractor } from './content-extractor.js'

const DEFAULT_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0',
]

const DEFAULT_CONFIG: HttpFetcherConfig = {
  maxRetries: 3,
  retryDelayMs: 1000,
  respectRobotsTxt: true,
  followRedirects: true,
  maxRedirects: 5,
}

/** Whether an HTTP status code is retryable */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504
}

/**
 * Lightweight HTTP fetcher using native Node.js `fetch()`.
 *
 * Features:
 * - Retry with exponential backoff
 * - User-agent rotation
 * - Redirect following with hop limit
 */
export class HttpFetcher {
  private readonly config: HttpFetcherConfig
  private readonly userAgents: string[]
  private readonly extractor: ContentExtractor
  private userAgentIndex = 0

  constructor(config?: Partial<HttpFetcherConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.userAgents = this.config.userAgents ?? DEFAULT_USER_AGENTS
    this.extractor = new ContentExtractor()
  }

  /** Fetch a URL and return extracted content */
  async fetch(url: string, options?: { timeout?: number }): Promise<FetchResult> {
    const timeout = options?.timeout ?? 30_000
    const startTime = Date.now()

    const response = await this.fetchWithRetry(url, timeout)
    const html = await response.text()
    const contentType = response.headers.get('content-type') ?? 'text/html'

    const extracted = this.extractor.extract(html, { mode: 'all', cleanHtml: true })

    return {
      url: response.url || url,
      status: response.status,
      contentType,
      text: extracted.text,
      title: extracted.title,
      description: extracted.description,
      author: extracted.author,
      publishedDate: extracted.publishedDate,
      html,
      durationMs: Date.now() - startTime,
      method: 'http',
    }
  }

  /** Fetch with exponential backoff retries */
  private async fetchWithRetry(url: string, timeout: number): Promise<Response> {
    let lastError: unknown = null
    let currentUrl = url
    let redirectCount = 0

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = this.config.retryDelayMs * Math.pow(2, attempt - 1)
        // Add jitter: 0-25% of delay
        const jitter = Math.random() * delay * 0.25
        await this.sleep(delay + jitter)
      }

      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), timeout)

        const response = await fetch(currentUrl, {
          headers: {
            'User-Agent': this.getNextUserAgent(),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate',
          },
          signal: controller.signal,
          redirect: this.config.followRedirects ? 'follow' : 'manual',
        })

        clearTimeout(timeoutId)

        // Handle manual redirect following (when followRedirects is false
        // we still need to handle it manually with hop limit)
        if (!this.config.followRedirects && isRedirect(response.status)) {
          const location = response.headers.get('location')
          if (location && redirectCount < this.config.maxRedirects) {
            currentUrl = new URL(location, currentUrl).href
            redirectCount++
            continue
          }
        }

        // Retry on retryable status codes
        if (isRetryableStatus(response.status) && attempt < this.config.maxRetries) {
          lastError = new Error(`HTTP ${response.status}`)
          continue
        }

        return response
      } catch (error: unknown) {
        lastError = error
        if (attempt === this.config.maxRetries) break

        // Don't retry on abort (timeout)
        if (error instanceof DOMException && error.name === 'AbortError') {
          break
        }
      }
    }

    throw new Error(
      `Failed to fetch ${url} after ${this.config.maxRetries + 1} attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    )
  }

  /** Get the next user-agent string via round-robin rotation */
  private getNextUserAgent(): string {
    const ua = this.userAgents[this.userAgentIndex % this.userAgents.length]
    this.userAgentIndex++
    return ua ?? DEFAULT_USER_AGENTS[0]!
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}
