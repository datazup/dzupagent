# @dzupagent/scraper Architecture

## Scope

This document describes the current architecture of `@dzupagent/scraper` in:

- `packages/scraper/src`
- test coverage in `packages/scraper/src/__tests__`
- monorepo integration references as of **April 4, 2026**

It focuses on:

- feature inventory
- runtime flow and control decisions
- public usage patterns
- references from other packages/docs
- validated test and coverage status

## Package Role In DzupAgent

`@dzupagent/scraper` is a scraping + extraction runtime that provides:

1. HTTP-first scraping with retries, robots handling, and extraction.
2. Browser scraping (Puppeteer-based) for JS-heavy pages.
3. Content normalization into a consistent `FetchResult`.
4. Tool-adapter output (`asTool()`) for agent tool loops.

Main entrypoint exports are defined in `src/index.ts`.

## Public API Surface

### Classes

- `WebScraper` (`src/scraper.ts`)
- `HttpFetcher` (`src/http-fetcher.ts`)
- `BrowserPool` (`src/browser-pool.ts`)
- `ContentExtractor` (`src/content-extractor.ts`)

### Contracts and Types

- `normalizeScraperTool`, `ScraperConnectorTool` (`src/connector-contract.ts`)
- `ScraperConfig`, `BrowserPoolConfig`, `HttpFetcherConfig`, `ExtractionConfig`, `FetchResult`, `ScraperToolSchema` (`src/types.ts`)
- `ExtractedContent` (`src/content-extractor.ts`)

## Feature Inventory

### 1) Multi-mode scraping orchestration (`WebScraper`)

Implemented in `src/scraper.ts`.

- `mode: 'http'`: always HTTP fetcher.
- `mode: 'browser'`: always browser pool.
- `mode: 'auto'` (default): HTTP first, browser fallback when:
  - HTTP fails (except robots policy block), or
  - HTTP status is not `2xx/3xx`, or
  - extracted text is too short (`<= 100` chars).

Additional behavior:

- `scrapeMany(urls, { concurrency })`: batch processing with `Promise.allSettled`.
- failed entries return synthetic `FetchResult` with `status: 0` and error message in `text`.
- `destroy()`: disposes browser resources.

### 2) HTTP fetch with policy and resilience (`HttpFetcher`)

Implemented in `src/http-fetcher.ts`.

- Retry policy:
  - retryable status codes: `429`, `502`, `503`, `504`
  - exponential backoff with jitter (0-25%)
  - abort timeout uses `AbortController`
  - no retry on `AbortError`
- robots support:
  - optional `respectRobotsTxt` (default `true`)
  - per-origin robots cache (TTL 10 minutes)
  - supports `Allow`/`Disallow`, wildcard and user-agent matching
- user-agent rotation:
  - round-robin from defaults or caller-provided list
- redirect behavior:
  - native follow when `followRedirects: true`
  - manual hop handling when `followRedirects: false` with `maxRedirects`
- extraction:
  - always runs `ContentExtractor.extract(..., { mode: 'all', cleanHtml: true, ...overrides })`
  - returns `FetchResult` including raw `html`

### 3) Browser resource pool (`BrowserPool`)

Implemented in `src/browser-pool.ts`.

- Optional peer dependency loading:
  - attempts `puppeteer-extra` + stealth plugin first (when enabled)
  - falls back to plain `puppeteer`
  - throws descriptive install error when unavailable
- Pool behavior:
  - one page per browser instance (isolation-first design)
  - max active browser count enforced via `maxConcurrency`
  - at-capacity waiting via polling (100ms interval, 30s timeout)
  - idle browser auto-close via `idleTimeoutMs`
- Browser launch defaults include hardened/container-friendly args.
- Supports `PUPPETEER_EXECUTABLE_PATH` override.
- `fetch(url)` returns same `FetchResult` shape as HTTP mode.

### 4) HTML cleaning and metadata extraction (`ContentExtractor`)

Implemented in `src/content-extractor.ts`.

- Metadata extraction:
  - `title` from `<title>`, fallback first `<h1>`
  - `description` from `meta[name="description"]`
  - `author` from `meta[name="author"]` or `meta[property="article:author"]`
  - `publishedDate` from `article:published_time`, `meta[name="date"]`, or `og:published_time`
- Text extraction:
  - can run in clean mode (`cleanHtml: true`) or raw tag-strip mode
  - strips boilerplate/noise elements and comments
  - decodes named + numeric entities
  - whitespace/newline normalization
  - optional `maxLength` truncation
- Metadata-only mode (`mode: 'metadata'`) skips text extraction.

### 5) Tool contract support (`asTool` + `normalizeScraperTool`)

Implemented in `src/scraper.ts` and `src/connector-contract.ts`.

- `WebScraper.asTool()` provides a generic object contract:
  - `id`, `name`, `description`, `schema`, `invoke(input)`
- `normalizeScraperTool()` ensures stable `id` (defaults to name).
- Output is JSON stringified and intentionally excludes raw `html` and `contentType`.

## Runtime Flow

### Single URL (`WebScraper.scrape`)

1. Merge default/config/override extraction options.
2. Switch by mode.
3. HTTP mode:
   - fetch URL
   - enforce robots policy if enabled
   - retry/backoff as needed
   - extract content and metadata
4. Browser mode:
   - lazy-create pool
   - acquire page
   - navigate + optional selector wait
   - extract content
   - release page
5. Auto mode:
   - try HTTP first
   - if robust result, return
   - else fallback to browser
   - if robots policy blocks HTTP, do not bypass with browser

### Batch URLs (`WebScraper.scrapeMany`)

1. Split into fixed-size batches (`concurrency`, default 5).
2. Execute batch in parallel with `Promise.allSettled`.
3. Normalize both success/failure into `FetchResult[]`.
4. Continue until all batches complete.

## Data Model and Config Semantics

### Input Configuration

- `ScraperConfig`
  - global mode/timeouts and module-specific configs
- `HttpFetcherConfig`
  - retry, robots, redirects, user-agents
- `BrowserPoolConfig`
  - concurrency, stealth, launch behavior
- `ExtractionConfig`
  - extraction mode, cleaning toggle, max length

### Output Contract (`FetchResult`)

Uniform shape across HTTP and browser paths:

- URL/status/content-type
- normalized text + metadata
- optional raw HTML
- duration
- method discriminator (`http` or `browser`)

This consistency is what allows `WebScraper` mode switching without changing downstream consumers.

## Usage Examples

### 1) Basic auto-mode scraping

```ts
import { WebScraper } from '@dzupagent/scraper'

const scraper = new WebScraper({ mode: 'auto', timeout: 30_000 })
const result = await scraper.scrape('https://example.com/article')

console.log(result.method, result.status)
console.log(result.title)
console.log(result.text.slice(0, 500))

await scraper.destroy()
```

### 2) Batch scrape with bounded parallelism

```ts
const results = await scraper.scrapeMany(
  ['https://a.com', 'https://b.com', 'https://c.com'],
  { concurrency: 2, cleanHtml: true, mode: 'text' },
)

for (const r of results) {
  if (r.status === 0) {
    console.error(`Failed ${r.url}: ${r.text}`)
    continue
  }
  console.log(`OK ${r.url} (${r.method})`)
}
```

### 3) Tool usage in an agent

```ts
import { DzupAgent } from '@dzupagent/agent'
import { WebScraper } from '@dzupagent/scraper'

const scraper = new WebScraper({ mode: 'auto' })
const agent = new DzupAgent({
  tools: [scraper.asTool()],
})
```

### 4) Low-level direct HTTP fetcher

```ts
import { HttpFetcher } from '@dzupagent/scraper'

const fetcher = new HttpFetcher({
  respectRobotsTxt: true,
  maxRetries: 3,
  retryDelayMs: 1000,
})

const data = await fetcher.fetch('https://example.com')
console.log(data.status, data.title)
```

### 5) Low-level browser pool

```ts
import { BrowserPool } from '@dzupagent/scraper'

const pool = new BrowserPool({ maxConcurrency: 2, stealth: true })
const data = await pool.fetch('https://example.com', {
  waitFor: '.article',
  timeout: 30_000,
})

await pool.destroy()
```

## Monorepo References and Usage

### Runtime imports from other packages

Current status: **no direct runtime imports from sibling packages** were found.

Search used:

- `rg -n "@dzupagent/scraper|WebScraper|web_scraper" packages --glob '!packages/scraper/**'`

Result: no matches in non-scraper package source.

### Monorepo-level references that do exist

1. Docs hub lists scraper package:
   - `docs/README.md`
2. Dedicated package docs and examples:
   - `docs/packages/scraper.md`
3. Migration guide includes scraper adoption and `scraper.asTool()` integration:
   - `docs/guides/migration-from-custom.md`
4. Runtime test inventory marks `scraper` as runtime-critical:
   - `scripts/check-runtime-test-inventory.mjs`

### Contract compatibility with `@dzupagent/agent`

- `WebScraper.asTool()` returns `{ name/id, description, schema, invoke }`.
- `@dzupagent/agent` tool loop accepts JSON-schema-like tool schemas (`packages/agent/src/agent/tool-loop.ts`).
- `createForgeTool` in `@dzupagent/agent` follows a similar conceptual tool shape (`packages/agent/src/tools/create-tool.ts`), so scraper tool descriptors fit expected orchestration semantics.

## Test Coverage Analysis

Validation command run:

- `yarn workspace @dzupagent/scraper test --coverage`

Observed result:

- 6 test files
- 90 tests
- all passing

### Test suites

- `content-extractor.test.ts`
- `http-fetcher.test.ts`
- `robots-and-fetcher.test.ts`
- `scraper-options.test.ts`
- `scraper-integration.test.ts`
- `scraper-tool.contract.test.ts`

### Coverage snapshot (V8)

Overall:

- Statements: **78.83%**
- Branches: **86.85%**
- Functions: **94.11%**
- Lines: **78.83%**

Per file:

| File | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| `browser-pool.ts` | 18.51% (50/270) | 0% (0/1) | 0% (0/1) | 18.51% (50/270) |
| `connector-contract.ts` | 100% (22/22) | 100% (2/2) | 100% (1/1) | 100% (22/22) |
| `content-extractor.ts` | 99.51% (204/205) | 94.87% (37/39) | 100% (7/7) | 99.51% (204/205) |
| `http-fetcher.ts` | 95.30% (284/298) | 82.60% (76/92) | 92.85% (13/14) | 95.30% (284/298) |
| `index.ts` | 100% (10/10) | 100% | 100% | 100% (10/10) |
| `scraper.ts` | 99.11% (224/226) | 90.24% (37/41) | 100% (11/11) | 99.11% (224/226) |
| `types.ts` | 100% (89/89) | 100% | 100% | 100% (89/89) |

### Main uncovered areas

1. `browser-pool.ts` is largely untested (lines 51-270 uncovered).
2. `http-fetcher.ts` uncovered areas:
   - manual redirect branch (`followRedirects: false` path)
   - invalid URL path handling in robots evaluator
   - specific user-agent group matching branch in robots selector
3. `scraper.ts` uncovered lazy pool creation lines (test mocking bypasses constructor path).
4. `content-extractor.ts` has a minor uncovered branch around self-closing cleanup replacement logic.

## Quality Notes and Constraints

### Strengths

- Clear modular split between orchestration, transport, extraction, and tool contract.
- Strong unit/integration coverage for HTTP + orchestration + extractor behavior.
- Good policy stance with explicit robots handling and no robots bypass fallback.
- Optional heavy dependencies (Puppeteer) are truly optional through dynamic imports.

### Current constraints / risks

1. Browser mode behavior has minimal direct test coverage.
2. `ExtractionConfig.mode` includes `'html'` and `'all'`, but extractor returns text + metadata only; raw HTML currently comes from fetch result payload, not extractor mode semantics.
3. Browser pool wait loop uses polling and timeout callback patterns that are not currently validated by tests.

### Recommended test expansion (high value)

1. Add dedicated `browser-pool.test.ts` with mocked Puppeteer launcher/page objects.
2. Add HTTP redirect-manual tests (`followRedirects: false`) and non-wildcard robots user-agent group matching tests.
3. Add one `WebScraper` test that exercises real `getOrCreateBrowserPool()` path without monkey patching `browserPool`.
