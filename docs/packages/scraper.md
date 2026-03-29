# @dzipagent/scraper -- Web Scraping

Web scraping toolkit with HTTP fetching, Puppeteer browser pool, content
extraction, and a DzipAgent-compatible tool interface.

## Installation

```bash
yarn add @dzipagent/scraper
```

Optional peer dependencies:
- `puppeteer` -- required for browser mode
- `puppeteer-extra` + `puppeteer-extra-plugin-stealth` -- for stealth mode (bot detection bypass)

HTTP mode works with zero optional dependencies using Node.js native `fetch()`.

## Quick Start

```ts
import { WebScraper } from '@dzipagent/scraper'

const scraper = new WebScraper({ mode: 'auto' })

// Scrape a single URL
const result = await scraper.scrape('https://example.com/article')
console.log(result.title)   // page title
console.log(result.text)    // clean extracted text
console.log(result.author)  // author if found

// Scrape multiple URLs concurrently
const results = await scraper.scrapeMany(
  ['https://a.com', 'https://b.com', 'https://c.com'],
  { concurrency: 3 },
)

// Clean up browser pool
await scraper.destroy()
```

## Components

### WebScraper

High-level orchestrator with three modes:

- `'http'` -- lightweight HTTP-only fetching (fastest, no browser dependency)
- `'browser'` -- Puppeteer-based rendering (handles SPAs, JS-rendered content)
- `'auto'` -- tries HTTP first, falls back to browser on failure or sparse content (<100 chars)

```ts
const scraper = new WebScraper({
  mode: 'auto',        // 'http' | 'browser' | 'auto' (default: 'auto')
  timeout: 30_000,     // default timeout in ms
  http: { /* HttpFetcherConfig */ },
  browser: { /* BrowserPoolConfig */ },
  extraction: { mode: 'text', cleanHtml: true },
})
```

Methods:

- `scrape(url, options?)` -- fetch and extract content from a URL
- `scrapeMany(urls, options?)` -- batch scraping with concurrency control (default 5)
- `asTool()` -- returns a DzipAgent-compatible tool descriptor
- `destroy()` -- shut down the browser pool

`scrapeMany` uses `Promise.allSettled` -- failed URLs return a result with
`status: 0` and the error message in `text`, rather than throwing.

### HttpFetcher

Lightweight fetcher using Node.js native `fetch()` with retry, user-agent
rotation, and redirect handling.

```ts
import { HttpFetcher } from '@dzipagent/scraper'

const fetcher = new HttpFetcher({
  maxRetries: 3,          // retry attempts on failure (default 3)
  retryDelayMs: 1000,     // base delay between retries (default 1000)
  respectRobotsTxt: true, // respect robots.txt (default true)
  followRedirects: true,  // follow HTTP redirects (default true)
  maxRedirects: 5,        // max redirect hops (default 5)
  userAgents: [            // custom user-agent rotation pool
    'Mozilla/5.0 ...',
  ],
})

const result = await fetcher.fetch('https://example.com', { timeout: 30_000 })
```

Retry behavior:
- Exponential backoff with 0-25% jitter
- Retries on status 429, 502, 503, 504
- No retry on timeout (AbortError)
- Rotates user-agent string on each request

### BrowserPool

Puppeteer browser pool with concurrency control, idle timeout, and optional
stealth plugin.

```ts
import { BrowserPool } from '@dzipagent/scraper'

const pool = new BrowserPool({
  maxConcurrency: 3,     // max concurrent browser pages (default 3)
  idleTimeoutMs: 60_000, // close idle browsers after 60s (default 60_000)
  stealth: true,         // use puppeteer-extra-plugin-stealth (default true)
  headless: true,        // headless mode (default true)
  launchArgs: ['--no-sandbox', ...],  // custom Chrome args
  executablePath: '/path/to/chrome',  // custom Chrome path
})

// Acquire a page, use it, release it
const page = await pool.acquire()
// ... use page ...
await pool.release(page)

// Or use the high-level fetch method
const result = await pool.fetch('https://example.com', {
  timeout: 30_000,
  waitFor: '.article-content',  // optional CSS selector to wait for
})

await pool.destroy()
```

Puppeteer is loaded via dynamic import -- it remains an optional peer dependency.
If stealth mode is enabled, the pool tries `puppeteer-extra` + stealth plugin
first, falling back to plain `puppeteer`. The `PUPPETEER_EXECUTABLE_PATH`
environment variable is respected for custom Chrome paths.

Pool management:
- One page per browser for isolation
- Idle browsers are closed after `idleTimeoutMs`
- When at capacity, `acquire()` polls every 100ms with a 30s timeout
- `destroy()` gracefully closes all browsers

### ContentExtractor

Regex-based HTML content extraction (no DOM library dependency).

```ts
import { ContentExtractor } from '@dzipagent/scraper'

const extractor = new ContentExtractor()
const content = extractor.extract(html, {
  mode: 'all',       // 'text' | 'html' | 'metadata' | 'all'
  cleanHtml: true,   // remove scripts, styles, nav, etc. (default true)
  maxLength: 50_000, // truncate content to N chars
})

// content.text           -- clean extracted text
// content.title          -- from <title> or first <h1>
// content.description    -- from meta[name="description"]
// content.author         -- from meta[name="author"] or og:article:author
// content.publishedDate  -- from article:published_time or og:published_time
```

Noise removal strips: `<script>`, `<style>`, `<noscript>`, `<nav>`, `<header>`,
`<footer>`, `<aside>`, `<iframe>`, `<svg>`, `<form>`, hidden elements, and
HTML comments. Block elements are converted to newlines for readability.
HTML entities (named and numeric) are decoded.

## FetchResult

All scraping methods return:

```ts
interface FetchResult {
  url: string            // the fetched URL
  status: number         // HTTP status code
  contentType: string    // Content-Type header
  text: string           // clean extracted text
  title?: string         // page title
  description?: string   // meta description
  author?: string        // author if found
  publishedDate?: string // published date if found
  html?: string          // raw HTML (if requested)
  durationMs: number     // fetch duration in ms
  method: 'browser' | 'http'  // which method was used
}
```

## DzipAgent Tool Integration

`asTool()` returns a tool descriptor compatible with `@dzipagent/agent`:

```ts
const scraper = new WebScraper({ mode: 'auto' })
const tool = scraper.asTool()

// tool.name        = 'web_scraper'
// tool.description = 'Fetch and extract clean text content from a web URL...'
// tool.schema      = { type: 'object', properties: { url, extractMode }, required: ['url'] }
// tool.invoke      = async ({ url, extractMode? }) => JSON.stringify(result)
```

Register it with an agent:

```ts
import { DzipAgent } from '@dzipagent/agent'

const agent = new DzipAgent({
  tools: [scraper.asTool()],
  // ...
})
```

## Exports

```ts
// Classes
export { WebScraper, HttpFetcher, BrowserPool, ContentExtractor }

// Types
export type { ScraperConfig, BrowserPoolConfig, HttpFetcherConfig,
              ExtractionConfig, FetchResult, ScraperToolSchema, ExtractedContent }
```
