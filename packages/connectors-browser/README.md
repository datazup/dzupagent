# @dzipagent/connectors-browser

Playwright-powered browser automation and extraction tools for DzipAgent.

This package gives you a ready-to-use connector (`createBrowserConnector`) that returns LangChain-compatible tools for crawling, screenshots, form extraction, interactive element discovery, and accessibility-tree inspection.

## Installation

```bash
yarn add @dzipagent/connectors-browser
# or
npm install @dzipagent/connectors-browser
```

Install required peer dependencies:

```bash
yarn add playwright zod
```

## Key Features

- **Tool factory for agents**
  - `createBrowserConnector()` returns 5 prebuilt tools you can register directly in agent tool lists.
- **Built-in browser lifecycle management**
  - Each tool call creates a fresh browser session and closes it automatically to avoid state leaks.
- **Smart SPA-aware crawling**
  - BFS crawling with depth/page limits, include/exclude URL patterns, hash-route support, and hydration-aware waits.
- **Rich extraction output**
  - Capture forms, interactive elements, ARIA/accessibility structures, links, and screenshots.
- **Optional authentication**
  - Supports username/password login flows with SPA-ready login detection.
- **Direct low-level APIs available**
  - You can use `BrowserManager`, `PageCrawler`, and extraction helpers independently outside the connector factory.

## Quick Start (Agent Tools)

```ts
import { DzipAgent } from '@dzipagent/agent'
import { createBrowserConnector } from '@dzipagent/connectors-browser'

const browserTools = createBrowserConnector({
  headless: true,
  crawlOptions: {
    maxPages: 20,
    maxDepth: 2,
    excludePatterns: ['*logout*', '*admin*'],
  },
})

const agent = new DzipAgent({
  name: 'web-auditor',
  model: chatModel,
  systemPrompt: 'Inspect websites and summarize findings.',
  tools: [...browserTools],
})

const result = await agent.generate('Crawl https://example.com and list top forms and nav flows')
console.log(result.text)
```

## Tools Created by `createBrowserConnector`

1. `browser-crawl-site`
   - Crawls pages from a start URL and returns page summaries:
     - `url`, `title`, `linkCount`, `formCount`, `elementCount`
   - Inputs: `startUrl`, optional `maxPages`, `maxDepth`, `includePatterns`, `excludePatterns`.
2. `browser-capture-screenshot`
   - Captures page screenshot and returns JSON payload with `base64`, `mimeType`, `width`, `height`.
3. `browser-extract-forms`
   - Returns form metadata (`action`, `method`, fields, labels, placeholders, required flags, select options).
4. `browser-extract-elements`
   - Returns interactive element metadata (role, label, enabled/visible status, layout location, ARIA attributes).
5. `browser-extract-a11y-tree`
   - Returns a hierarchical accessibility-focused node list (roles, names, states, depth, descriptions).

## Usage Examples

### 1) Authenticated crawling

```ts
import { createBrowserConnector } from '@dzipagent/connectors-browser'

const tools = createBrowserConnector({
  auth: {
    loginUrl: 'https://app.example.com/login',
    username: process.env.APP_USER!,
    password: process.env.APP_PASS!,
  },
  crawlOptions: { maxPages: 30, maxDepth: 3 },
})

// Register `tools` in your agent and invoke `browser-crawl-site`.
```

### 2) Direct crawling without tool wrappers

```ts
import { BrowserManager, PageCrawler } from '@dzipagent/connectors-browser'

const manager = new BrowserManager()
await manager.launch({ headless: true })

try {
  const context = await manager.newContext({ viewport: { width: 1440, height: 900 } })
  const crawler = new PageCrawler(context, {
    maxPages: 10,
    maxDepth: 2,
    includePatterns: ['https://example.com/*'],
  })

  for await (const page of crawler.crawl('https://example.com')) {
    console.log(page.url, page.title, page.forms.length, page.interactiveElements.length)
  }
} finally {
  await manager.close()
}
```

### 3) Extract forms/elements from a single page

```ts
import {
  BrowserManager,
  extractForms,
  extractInteractiveElements,
  extractAccessibilityTree,
} from '@dzipagent/connectors-browser'

const manager = new BrowserManager()
await manager.launch({ headless: true })

try {
  const context = await manager.newContext()
  const page = await context.newPage()
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded' })

  const [forms, elements, a11y] = await Promise.all([
    extractForms(page),
    extractInteractiveElements(page),
    extractAccessibilityTree(page),
  ])

  console.log({ forms: forms.length, elements: elements.length, a11y: a11y.length })
  await page.close()
} finally {
  await manager.close()
}
```

## API Reference

### Main factory

- `createBrowserConnector(config?)`
  - Returns 5 LangChain-compatible tools.
- `BrowserConnectorConfig`
  - `headless?: boolean`
  - `auth?: AuthCredentials`
  - `crawlOptions?: Partial<CrawlOptions>`

### Browser & auth

- `BrowserManager`
  - `launch(opts?)`, `newContext(opts?)`, `close()`
- `AuthHandler`
  - `loginWithCredentials(page, creds)`
  - `loginWithCookies(context, cookies)`
  - `isLoginPage(page)`

### Crawling helpers

- `PageCrawler`
- `extractLinks(page)`
- `normalizeUrl(url, baseUrl)`
- `isSameOrigin(url, baseUrl)`
- `matchesPattern(url, patterns)`
- `isHashRoute(url)`

### Extraction helpers

- `extractAccessibilityTree(page)`
- `captureScreenshot(page)`
- `extractForms(page)`
- `extractInteractiveElements(page)`

### Exported types

- `CrawlOptions`, `CrawlResult`
- `AccessibilityNode`
- `FormInfo`, `FormField`
- `ElementInfo`
- `AuthCredentials`
- `ScreenshotResult`
- `BrowserLaunchOptions`

## Operational Notes

- `createBrowserConnector` tools return string output (JSON for structured payloads).
- Long outputs are truncated to prevent excessive context payload size.
- `captureScreenshot(page)` (direct API) returns a JPEG buffer and metadata; connector tool returns base64 JSON.
- For CI/container usage, ensure Playwright browsers are installed for your environment.

## License

MIT
