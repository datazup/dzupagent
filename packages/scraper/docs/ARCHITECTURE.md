# @dzupagent/scraper Architecture

## Scope
This document covers the current implementation of `@dzupagent/scraper` in `packages/scraper`.

Included sources:
- `src/` runtime modules and public exports
- `src/__tests__/` Vitest suites
- `package.json` package contract and dependencies
- `README.md` usage-facing package description

This package provides scraping and extraction primitives. It does not implement app-level crawling pipelines, persistence, queueing, or telemetry backends.

## Responsibilities
`@dzupagent/scraper` is responsible for:
- Orchestrating URL scraping through `http`, `browser`, or `auto` mode via `WebScraper`
- Fetching HTML with retry, robots policy checks, user-agent rotation, and redirect handling via `HttpFetcher`
- Fetching rendered pages via pooled Puppeteer instances via `BrowserPool`
- Converting HTML into normalized text and metadata via `ContentExtractor`
- Exposing a DzupAgent-compatible connector tool descriptor via `WebScraper.asTool()` and `normalizeScraperTool`

The package returns a normalized `FetchResult` shape across HTTP and browser paths.

## Structure
Top-level package layout:
- `src/index.ts`: public export surface
- `src/types.ts`: config and result contracts (`ScraperConfig`, `FetchResult`, etc.)
- `src/scraper.ts`: `WebScraper` orchestration and tool adapter
- `src/http-fetcher.ts`: HTTP transport, retries, robots parsing/evaluation
- `src/browser-pool.ts`: optional Puppeteer integration with pooling and idle shutdown
- `src/content-extractor.ts`: regex-based HTML cleanup and metadata extraction
- `src/connector-contract.ts`: scraper-specific alias/wrapper over `@dzupagent/core` connector contract
- `src/__tests__/*.test.ts`: unit and deep behavior coverage for all modules
- `docs/ARCHITECTURE.md`: this document

Build and packaging:
- `tsup.config.ts`: ESM build from `src/index.ts`, declaration output, Node 20 target
- `package.json`: single export entrypoint (`.`), dist-only publish files

## Runtime and Control Flow
Primary flow (`WebScraper.scrape(url, options)`):
1. Merge default scraper config with call-level extraction overrides.
2. Route by `ScraperConfig.mode`:
- `http`: call `HttpFetcher.fetch`.
- `browser`: call `BrowserPool.fetch` (lazy pool creation).
- `auto`: try HTTP first, then fallback to browser only when HTTP result is not considered sufficient or HTTP throws a non-robots error.

Auto-mode decision in current code:
- Accept HTTP result only when `status >= 200 && status < 400 && text.length > 100`.
- Otherwise fallback to browser mode.
- If HTTP throws `RobotsDisallowedError`, propagate the error and do not fallback.

Batch flow (`WebScraper.scrapeMany`):
1. Split URL list by `concurrency` (default `5`).
2. Run each batch with `Promise.allSettled`.
3. Return successful `FetchResult` items as-is.
4. Convert failures into synthetic `FetchResult` entries (`status: 0`, error message in `text`, `method: 'http'`).

HTTP flow (`HttpFetcher.fetch`):
1. `fetchWithRetry` executes outbound request with timeout and rotating user-agent.
2. Optional robots check loads and caches `/robots.txt` per origin (10-minute TTL).
3. Retry on status `429/502/503/504` with exponential backoff and jitter.
4. Parse response body and run `ContentExtractor.extract` with merged extraction options.
5. Return `FetchResult` including `html`, metadata, and `method: 'http'`.

Browser flow (`BrowserPool.fetch`):
1. Acquire page from pool (reuse existing browser if idle, launch up to `maxConcurrency`, otherwise wait for slot).
2. Navigate with `waitUntil: 'networkidle2'` and configurable timeout.
3. Optionally `waitForSelector` (non-fatal if selector wait fails).
4. Extract HTML and run `ContentExtractor`.
5. Release page; start idle-close timer when browser has no active pages.

Tool flow (`WebScraper.asTool().invoke`):
1. Convert tool input schema fields (`extractMode`, `cleanHtml`, `maxLength`) into extraction options.
2. Call `scrape(url, extractionOptions)`.
3. Return JSON string including URL, metadata, text, status, method, duration.
4. Exclude `html` and `contentType` from tool response payload.

## Key APIs and Types
Public exports from `src/index.ts`:
- Types:
- `ScraperConfig`
- `BrowserPoolConfig`
- `HttpFetcherConfig`
- `ExtractionConfig`
- `FetchResult`
- `ScraperToolSchema`
- `ExtractedContent`
- Connector contract:
- `normalizeScraperTool`
- `ScraperConnectorTool`
- Classes:
- `HttpFetcher`
- `ContentExtractor`
- `BrowserPool`
- `WebScraper`

Notable semantics:
- `ScraperConfig.mode`: `'browser' | 'http' | 'auto'`
- `FetchResult.method`: `'browser' | 'http'`
- `ScraperToolSchema.extractMode`: `'text' | 'html' | 'metadata' | 'all'`

## Dependencies
Runtime dependencies:
- `@dzupagent/core`: used for base connector tool normalization in `connector-contract.ts`

Peer dependencies (all optional, required for browser mode):
- `puppeteer`
- `puppeteer-extra`
- `puppeteer-extra-plugin-stealth`

Dev/build dependencies:
- `typescript`
- `tsup`
- `vitest`

Platform assumptions:
- Node.js 20+ (from tsup target and native `fetch`/`AbortController` usage)
- Browser scraping relies on Puppeteer runtime availability and launch environment compatibility

## Integration Points
Internal integration seams:
- `normalizeScraperTool` delegates ID normalization and base contract shaping to `normalizeBaseConnectorTool` from `@dzupagent/core`.
- `WebScraper.asTool()` exposes a tool descriptor consumable by DzupAgent tool loops.

Consumer-facing integration:
- Consumers typically instantiate `WebScraper` and call `scrape`, `scrapeMany`, or `asTool`.
- `README.md` shows integration into `DzupAgent` tools (`tools: [scraper.asTool()]`).

Cross-package usage in this monorepo is mostly documented rather than directly imported in source modules outside `packages/scraper`.

## Testing and Observability
Test coverage shape:
- Unit and deep tests exist for all major modules under `src/__tests__/`.
- Test files include:
- HTTP behavior (`http-fetcher.test.ts`, `http-fetcher-deep.test.ts`, `robots-and-fetcher.test.ts`, `scraper-http-contract-deep.test.ts`)
- Browser pool behavior (`browser-pool.test.ts`, `w15-j2-edges.test.ts` sections)
- Extraction behavior (`content-extractor.test.ts`, `content-extractor-deep.test.ts`)
- WebScraper orchestration/tool contract (`scraper-integration.test.ts`, `scraper-deep.test.ts`, `scraper-options.test.ts`, `scraper-tool.contract.test.ts`, `connector-contract-deep.test.ts`)

Observed verification characteristics:
- Tests validate option propagation, fallback behavior, redirects, robots parsing, retries, schema shape, and output field inclusion/exclusion.
- Browser tests rely heavily on module mocking rather than launching a real browser.

Observability in runtime code:
- No built-in logging, tracing, or metrics hooks are present in package runtime modules.
- Error visibility is primarily through thrown errors and `FetchResult` error text in `scrapeMany` fail-normalization paths.

## Risks and TODOs
Current risks from code and package contract:
- `ContentExtractor` is regex-based and can mis-handle complex or malformed HTML patterns compared with DOM parsing.
- `BrowserPool` waits for capacity using polling (`100ms`) with a fixed wait timeout (`30s`), which may be inefficient under heavy contention.
- `scrapeMany` encodes failures as `method: 'http'` even when browser mode was configured, which can blur failure attribution.
- Optional Puppeteer peer dependencies mean browser mode can fail at runtime if consumers do not install peers.
- Package has `test` but no `test:coverage` script in `package.json`, limiting standardized per-package coverage gating from package scripts.
- Runtime has no explicit instrumentation hooks, making production diagnosis dependent on caller-level logging.

Doc-to-code drift note:
- `README.md` references `result.content` in one quick-start example, but `FetchResult` currently exposes `text` (not `content`).

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

