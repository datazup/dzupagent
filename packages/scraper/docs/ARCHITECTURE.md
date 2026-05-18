# @dzupagent/scraper Architecture

## Scope
This document describes the current implementation of `@dzupagent/scraper` under `packages/scraper`.

Covered artifacts:
- Runtime source in `src/`
- Public package contract in `package.json`
- Usage notes in `README.md`
- Package tests in `src/__tests__/`

Out of scope:
- App-level crawl orchestration and persistence
- Queueing/scheduling systems
- Cross-package observability pipelines

## Responsibilities
The package provides reusable scraping primitives for DzupAgent:
- Route scraping through HTTP, browser, or auto mode via `WebScraper`
- Fetch remote HTML over HTTP with retry/backoff, robots checks, redirect handling, and URL policy enforcement via `HttpFetcher`
- Fetch rendered HTML via optional Puppeteer-based pooling via `BrowserPool`
- Extract text and metadata from HTML via `ContentExtractor`
- Expose a DzupAgent-compatible tool descriptor (`asTool`) through the shared connector contract normalization seam

## Structure
Current source layout:
- `src/index.ts`: public exports
- `src/types.ts`: config/result/tool input types (`ScraperConfig`, `FetchResult`, `ScraperToolSchema`, etc.)
- `src/scraper.ts`: `WebScraper` orchestration, batch scraping, tool adapter, lifecycle (`destroy`)
- `src/http-fetcher.ts`: HTTP transport, retry logic, robots parsing/evaluation/cache, SSRF policy wiring
- `src/browser-pool.ts`: dynamic Puppeteer loading, browser/page pooling, idle shutdown, browser fetch path
- `src/content-extractor.ts`: regex-based metadata extraction and text cleanup
- `src/connector-contract.ts`: scraper alias wrapper over `normalizeBaseConnectorTool`
- `src/__tests__/`: module and contract coverage suites
- `docs/ARCHITECTURE.md`: this document

Build/package wiring:
- `tsup.config.ts`: ESM bundle from `src/index.ts`, declaration emit, Node 20 target, sourcemaps
- `package.json`: single `.` export to `dist/index.js` + `dist/index.d.ts`

## Runtime and Control Flow
Primary call path (`WebScraper.scrape(url, options)`):
1. Merge per-call extraction options with configured defaults.
2. Dispatch by `config.mode`:
3. `http` -> `HttpFetcher.fetch`
4. `browser` -> `BrowserPool.fetch` (lazy pool init)
5. `auto` -> HTTP first; fallback to browser when HTTP response is weak or HTTP fails with non-robots errors.

Auto-mode acceptance threshold:
- Keep HTTP result only when `200 <= status < 400` and extracted `text.length > 100`.
- Fall back to browser otherwise.
- Re-throw `RobotsDisallowedError` without browser fallback.

Batch path (`WebScraper.scrapeMany`):
1. Process URLs in batches sized by `concurrency` (default `5`).
2. For each batch, execute `Promise.allSettled` over `scrape` calls.
3. Preserve successful `FetchResult` values.
4. Normalize per-URL failures into synthetic `FetchResult` entries (`status: 0`, error in `text`, `method: 'http'`).

HTTP path (`HttpFetcher.fetch`):
1. Execute `fetchWithRetry` with timeout and rotating user-agent.
2. Optionally evaluate robots.txt before fetching target URL.
3. Enforce outbound URL policy through `@dzupagent/core/security` (`fetchWithOutboundUrlPolicy`, `validateOutboundUrl`).
4. Retry retryable statuses (`429`, `502`, `503`, `504`) with exponential backoff + jitter.
5. Extract content/metadata through `ContentExtractor` and return normalized `FetchResult`.

Robots behavior details:
- Per-origin robots cache with 10-minute TTL.
- If robots fetch fails or policy rejects robots URL, fetcher defaults to allow.
- Matching supports specific user-agent groups and wildcard group (`*`).

Browser path (`BrowserPool.fetch`):
1. Validate outbound URL with `validateOutboundUrl`.
2. Acquire one page from pool (one active page per browser entry).
3. Navigate with `waitUntil: 'networkidle2'` and timeout.
4. Optionally wait for selector (`waitFor`) with best-effort timeout handling.
5. Extract HTML + metadata/text using `ContentExtractor`.
6. Always release page in `finally`; schedule browser idle close when page count returns to zero.

Tool path (`WebScraper.asTool().invoke`):
1. Map tool input (`extractMode`, `cleanHtml`, `maxLength`) to extraction options.
2. Call `scrape(url, extraction)`.
3. Return JSON string with selected fields (`url`, metadata, `text`, `status`, `method`, `durationMs`).
4. Omit `html` and `contentType` from tool output.

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
- Connector contract aliases:
- `ScraperConnectorTool`
- `normalizeScraperTool`
- Classes:
- `HttpFetcher`
- `ContentExtractor`
- `BrowserPool`
- `WebScraper`

Important type semantics:
- `ScraperConfig.mode`: `'browser' | 'http' | 'auto'`
- `FetchResult.method`: `'browser' | 'http'`
- `ExtractionConfig.mode`: `'text' | 'html' | 'metadata' | 'all'`
- `ScraperToolSchema` uses optional extraction knobs around required `url`

Notable runtime errors:
- `RobotsDisallowedError` is thrown when robots policy blocks a URL.
- Browser mode throws descriptive missing-peer error if Puppeteer packages are not installed.

## Dependencies
Runtime dependency:
- `@dzupagent/core` (security helpers and connector contract primitives)

Optional peer dependencies (required for browser mode):
- `puppeteer`
- `puppeteer-extra`
- `puppeteer-extra-plugin-stealth`

Dev/build dependencies:
- `typescript`
- `tsup`
- `vitest`

Runtime assumptions:
- Node.js 20+ (native `fetch`, `AbortController`, ESM target)
- Browser scraping depends on host compatibility with Puppeteer launch requirements

## Integration Points
With `@dzupagent/core`:
- `normalizeScraperTool` wraps `normalizeBaseConnectorTool` for consistent connector shape.
- HTTP and browser URL safety checks use core outbound URL policy utilities.

With agent/tool consumers:
- Consumers can call `WebScraper.scrape`, `scrapeMany`, or register `WebScraper.asTool()` in tool arrays.
- Tool schema is plain JSON Schema-like object and is compatible with DzupAgent tool invocation conventions.

Configuration seam:
- Shared `urlPolicy` can be passed at `ScraperConfig` root and is propagated to both HTTP and browser subsystems.

## Testing and Observability
Test surface:
- Unit/deep suites cover each module and integration seams:
- `http-fetcher*.test.ts`, `robots-and-fetcher.test.ts`
- `browser-pool.test.ts`
- `content-extractor*.test.ts`
- `scraper-*.test.ts`, `w15-j2-edges.test.ts`
- `connector-contract-deep.test.ts`

Verified behaviors in tests include:
- Auto-mode fallback thresholds and robots-specific rethrow behavior
- Retry/backoff behavior and retryable-status boundaries
- Redirect policy handling and header propagation
- URL policy rejection paths (private networks, metadata endpoints)
- Tool schema/output contract shape
- Browser pool lifecycle, idle closure, waiting/timeout, and destroy safety

Observability currently in code:
- No built-in logging/metrics/tracing hooks in runtime classes.
- One production warning path exists: `HttpFetcher` emits `DZUPAGENT_SCRAPER_NO_ALLOWLIST` when no explicit allowlist is configured in production.

## Risks and TODOs
Current implementation risks and follow-ups:
- `ContentExtractor` uses regex heuristics rather than DOM parsing; complex/malformed markup can reduce extraction quality.
- `BrowserPool.acquire` uses polling (`100ms`) with a fixed wait timeout (`30s`), which can become inefficient under contention.
- `scrapeMany` normalizes all failures as `method: 'http'`, which can blur attribution when browser mode actually failed.
- Browser mode is runtime-optional; missing peer dependencies fail only when browser path is used.
- No package-native instrumentation hooks for request IDs, structured logs, or metrics.
- README examples still refer to `result.content`, while runtime returns `FetchResult.text`.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js

