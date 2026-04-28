import type { OutboundUrlSecurityPolicy } from '@dzupagent/core'

/** Configuration for the WebScraper */
export interface ScraperConfig {
  /** Use browser pool (requires puppeteer) or HTTP-only mode */
  mode: 'browser' | 'http' | 'auto'
  /** Browser pool configuration */
  browser?: BrowserPoolConfig
  /** HTTP fetcher configuration */
  http?: HttpFetcherConfig
  /** Content extraction options */
  extraction?: ExtractionConfig
  /** Default timeout in ms (default: 30000) */
  timeout?: number
  /** Shared outbound URL policy for HTTP and browser fetches. */
  urlPolicy?: OutboundUrlSecurityPolicy
}

/** Configuration for the Puppeteer browser pool */
export interface BrowserPoolConfig {
  /** Max concurrent browser pages (default: 3) */
  maxConcurrency: number
  /** Idle timeout before closing browser in ms (default: 60000) */
  idleTimeoutMs: number
  /** Enable stealth plugin to bypass bot detection (default: true) */
  stealth: boolean
  /** Run browser in headless mode (default: true) */
  headless: boolean
  /** Additional Chrome launch arguments */
  launchArgs?: string[]
  /** Path to Chrome/Chromium executable */
  executablePath?: string
  /** Outbound URL policy. Defaults to public HTTPS destinations only. */
  urlPolicy?: OutboundUrlSecurityPolicy
}

/** Configuration for the HTTP fetcher */
export interface HttpFetcherConfig {
  /** Max retry attempts on failure (default: 3) */
  maxRetries: number
  /** Base delay between retries in ms (default: 1000) */
  retryDelayMs: number
  /** User-agent strings for rotation */
  userAgents?: string[]
  /** Respect robots.txt rules (default: true) */
  respectRobotsTxt: boolean
  /** Follow HTTP redirects (default: true) */
  followRedirects: boolean
  /** Max redirect hops (default: 5) */
  maxRedirects: number
  /** Outbound URL policy. Defaults to public HTTPS destinations only. */
  urlPolicy?: OutboundUrlSecurityPolicy
}

/** Configuration for content extraction from HTML */
export interface ExtractionConfig {
  /** What to extract from the page */
  mode: 'text' | 'html' | 'metadata' | 'all'
  /** Remove scripts, styles, nav elements (default: true) */
  cleanHtml: boolean
  /** Max content length in chars */
  maxLength?: number
}

/** Result of a fetch/scrape operation */
export interface FetchResult {
  /** The fetched URL */
  url: string
  /** HTTP status code */
  status: number
  /** Content-Type header value */
  contentType: string
  /** Clean extracted text */
  text: string
  /** Page title */
  title?: string | undefined
  /** Meta description */
  description?: string | undefined
  /** Author if found */
  author?: string | undefined
  /** Published date if found */
  publishedDate?: string | undefined
  /** Raw HTML (if requested) */
  html?: string | undefined
  /** Fetch duration in ms */
  durationMs: number
  /** Which method was used */
  method: 'browser' | 'http'
}

/** Schema for the DzupAgent-compatible tool */
export interface ScraperToolSchema {
  url: string
  extractMode?: 'text' | 'html' | 'metadata' | 'all'
  cleanHtml?: boolean
  maxLength?: number
}
