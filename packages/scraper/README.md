# @dzipagent/scraper

High-performance web scraping and content extraction for DzipAgent.

This package provides a unified interface for fetching web content using either fast HTTP requests or full browser automation (Puppeteer), with built-in support for cleaning and extracting structured data from HTML.

## Installation

```bash
yarn add @dzipagent/scraper
# or
npm install @dzipagent/scraper
```

### Optional Dependencies

For browser-based scraping, you must install Puppeteer and related plugins:

```bash
yarn add puppeteer puppeteer-extra puppeteer-extra-plugin-stealth
```

## Key Features

- **Dual Scraping Modes**
  - `HTTP`: Fast, lightweight fetching for static sites.
  - `Browser`: Full Puppeteer-powered rendering for JavaScript-heavy SPAs.
  - `Auto`: Automatically chooses the best mode based on page characteristics.
- **Smart Content Extraction**
  - `ContentExtractor` automatically identifies and extracts the main article text, metadata, and structured data while stripping away nav, ads, and footers.
- **Browser Pool Management**
  - `BrowserPool` manages a pool of browser instances to optimize resource usage and performance during bulk scraping.
- **Agent Integration**
  - `WebScraper.asTool()` returns a LangChain-compatible tool for easy integration into your DzipAgent toolsets.
- **Stealth Support**
  - Integrated with `puppeteer-extra-plugin-stealth` to reduce bot detection.

## Quick Start

```ts
import { WebScraper } from '@dzipagent/scraper'

const scraper = new WebScraper({
  timeout: 30000,
  browser: { headless: true }
})

// Scrape a single URL
const result = await scraper.scrape('https://example.com/blog/article-1', {
  mode: 'auto'
})

console.log(result.content) // Cleaned main text
console.log(result.metadata.title)
```

## Usage Examples

### 1) Bulk Scraping

Efficiently scrape multiple URLs using the built-in browser pool.

```ts
import { WebScraper } from '@dzipagent/scraper'

const scraper = new WebScraper()

const results = await scraper.scrapeMany([
  'https://site-a.com',
  'https://site-b.com',
  'https://site-c.com'
], { concurrency: 3 })

for (const res of results) {
  if (res.success) {
    console.log(`Scraped ${res.url}: ${res.content.length} chars`)
  }
}
```

### 2) Integration with DzipAgent

Register the scraper as a tool for your AI agents.

```ts
import { DzipAgent } from '@dzipagent/agent'
import { WebScraper } from '@dzipagent/scraper'

const scraper = new WebScraper()

const agent = new DzipAgent({
  name: 'researcher',
  tools: [scraper.asTool()]
})

const response = await agent.generate('Find the latest news about quantum computing from nature.com')
```

### 3) Manual Content Extraction

Use the `ContentExtractor` directly on existing HTML strings.

```ts
import { ContentExtractor } from '@dzipagent/scraper'

const html = '<html><body><nav>...</nav><main><h1>Title</h1><p>Body...</p></main></body></html>'
const extractor = new ContentExtractor()

const cleaned = extractor.extract(html, { 
  url: 'https://example.com',
  includeMetadata: true 
})

console.log(cleaned.markdown)
```

## API Reference

### Main Classes
- `WebScraper` — Unified entry point for scraping tasks.
- `BrowserPool` — Manages Puppeteer instances.
- `HttpFetcher` — Lightweight HTTP client for static pages.
- `ContentExtractor` — Logic for cleaning and parsing HTML content.

### Core Types
- `ScrapeOptions` / `ScrapeResult`
- `ExtractedContent`
- `BrowserPoolConfig`

## License

MIT
