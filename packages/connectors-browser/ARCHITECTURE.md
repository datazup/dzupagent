# `@dzupagent/connectors-browser` Architecture

## 1. Purpose and Scope

`@dzupagent/connectors-browser` provides Playwright-backed browser automation primitives and wraps them as agent-ready tools for DzupAgent.

Primary responsibilities:

- Create a ready-to-register browser toolset via `createBrowserConnector(...)`.
- Provide low-level APIs for browser lifecycle (`BrowserManager`), auth (`AuthHandler`), crawling (`PageCrawler`), and page extraction (`extractForms`, `extractInteractiveElements`, `extractAccessibilityTree`, `captureScreenshot`).
- Normalize browser tools into a connector-friendly shape (`normalizeBrowserTool`, `normalizeBrowserTools`).

Out of scope:

- Persistent browser/session state across tool calls.
- Cross-domain crawling (crawler is same-origin constrained).
- Runtime orchestration in other packages (this package exports tools; orchestration happens in agent consumers).

## 2. Package Topology

Source root: `packages/connectors-browser/src`

- `index.ts`: public exports.
- `browser-connector.ts`: main connector factory and tool definitions.
- `connector-contract.ts`: normalization helpers for LangChain `StructuredToolInterface`.
- `browser/browser-manager.ts`: browser launch/context/close lifecycle.
- `browser/auth-handler.ts`: username/password and cookie auth helpers.
- `crawler/page-crawler.ts`: BFS crawl engine with SPA-aware waiting.
- `crawler/link-extractor.ts`: anchor/hash-route/SPA route discovery.
- `crawler/url-utils.ts`: URL normalization/origin checks/pattern matching.
- `extraction/form-extractor.ts`: form and field metadata extraction.
- `extraction/element-extractor.ts`: interactive element/ARIA extraction.
- `extraction/accessibility-tree.ts`: accessibility node extraction via DOM role/name heuristics.
- `extraction/screenshot-capture.ts`: JPEG capture with height clipping.
- `__tests__/`: unit and integration-oriented tests.

Build/runtime metadata:

- ESM package, built with `tsup` from `src/index.ts`.
- Runtime dependency: `@dzupagent/agent`.
- Peer dependencies: `playwright`, `zod`.

## 3. Public API Surface

Exported from `src/index.ts`:

1. Connector factory and config:
- `createBrowserConnector(config?)`
- `BrowserConnectorConfig`

2. Contract helpers:
- `normalizeBrowserTool(...)`
- `normalizeBrowserTools(...)`
- `BrowserConnectorTool` type

3. Browser/auth:
- `BrowserManager`
- `AuthHandler`

4. Crawl helpers:
- `PageCrawler`
- `extractLinks(...)`
- `normalizeUrl(...)`
- `isSameOrigin(...)`
- `matchesPattern(...)`
- `isHashRoute(...)`

5. Extraction helpers:
- `extractAccessibilityTree(...)`
- `captureScreenshot(...)`
- `extractForms(...)`
- `extractInteractiveElements(...)`

6. Domain types:
- `CrawlOptions`, `CrawlResult`
- `AccessibilityNode`, `FormInfo`, `FormField`, `ElementInfo`
- `AuthCredentials`, `ScreenshotResult`, `BrowserLaunchOptions`

## 4. Feature Catalog

### 4.1 Agent Tool Factory (`createBrowserConnector`)

`createBrowserConnector` builds five tool instances:

1. `browser-crawl-site`
2. `browser-capture-screenshot`
3. `browser-extract-forms`
4. `browser-extract-elements`
5. `browser-extract-a11y-tree`

Behavioral characteristics:

- Stateless execution model: each tool call opens a fresh browser session and closes it in `finally`.
- Optional auth bootstrapping (`config.auth`) is applied per call.
- Input validation uses `zod` schemas.
- Tool outputs are string-oriented for model integration.
- Structured JSON outputs are truncated to `MAX_RESULT_LENGTH = 8000` characters to cap context size.

### 4.2 Browser Lifecycle (`BrowserManager`)

Capabilities:

- Lazy Playwright import (`import('playwright')`) to avoid eager module load cost.
- `launch(opts)` with default `headless: true`.
- `newContext(opts)` with default viewport `1280x720` and optional proxy.
- Idempotent `close()` and relaunch support.

### 4.3 Authentication (`AuthHandler`)

Supported flows:

- Credential login with configurable selectors, SPA-hydration wait (`waitForFunction`), field detection/fill, submit heuristics, and completion detection via URL changes or post-login DOM indicators.
- Cookie-based login (`loginWithCookies`).
- Heuristic login-page detection (`isLoginPage`) by password input presence.

### 4.4 Crawl Engine (`PageCrawler`)

Core model:

- BFS queue over `{ url, depth }`.
- Stop conditions: `maxPages`, `maxDepth`.
- Include/exclude pattern filtering.
- Same visited-set deduplication.
- Per-page extraction bundle: links, accessibility tree, screenshot, forms, and interactive elements.

SPA-aware behavior:

- Hash route handling (`/#/`, `/#!/`) with base navigation + hash mutation.
- Smart wait strategy: attempts `networkidle` with timeout, checks visible loading indicators, and verifies meaningful main content before extraction.

### 4.5 Link Discovery (`extractLinks`)

Multi-source route discovery:

- Traditional anchors (`a[href]`).
- Hash-route patterns (`#/`, `#!/`).
- SPA route heuristics (Vue router exposure, nav links, data attributes).

Filtering/normalization:

- Skip `javascript:`, `mailto:`, `tel:`, and plain anchors.
- Normalize relative/absolute URLs.
- Keep SPA hash routes, strip non-route hash anchors.
- Restrict to same-origin URLs.
- Deduplicate results.

### 4.6 Data Extraction Helpers

- `extractForms(page)`: forms, method/action, field metadata, labels, required flags, select options.
- `extractInteractiveElements(page)`: role/label/enabled/visible/location/ARIA map for interactive elements.
- `extractAccessibilityTree(page)`: role+name+state oriented node list with depth and optional value/description/state flags.
- `captureScreenshot(page, fullPage?)`: JPEG output (`quality: 80`), full-page height cap at `viewportHeight * 3`, and return shape `{ buffer, mimeType, width, height }`.

## 5. Runtime Flow

### 5.1 High-Level Tool Invocation Flow

```text
Agent invokes tool
  -> createBrowserSession(config)
      -> BrowserManager.launch()
      -> BrowserManager.newContext()
      -> optional AuthHandler.loginWithCredentials()
  -> tool-specific page action (crawl/screenshot/extraction)
  -> stringify (and possibly truncate) result
  -> BrowserManager.close() in finally
```

### 5.2 Crawl Flow (`browser-crawl-site`)

```text
Input schema validated
  -> merge config.crawlOptions with per-call overrides
  -> new PageCrawler(context, mergedOptions)
  -> for await crawler.crawl(startUrl):
       collect summary for each page
  -> return JSON summary string (truncated if >8k chars)
```

### 5.3 Direct API Flow (without tool wrappers)

```text
BrowserManager.launch()
  -> context = BrowserManager.newContext()
  -> page = context.newPage()
  -> page.goto(...)
  -> call extraction helpers as needed
  -> close page/context via BrowserManager.close()
```

## 6. Usage Examples

### 6.1 Register Tools in DzupAgent

```ts
import { DzupAgent } from '@dzupagent/agent'
import { createBrowserConnector } from '@dzupagent/connectors-browser'

const browserTools = createBrowserConnector({
  headless: true,
  crawlOptions: { maxPages: 20, maxDepth: 2 },
})

const agent = new DzupAgent({
  name: 'web-auditor',
  model: chatModel,
  tools: [...browserTools],
})
```

### 6.2 Invoke a Specific Tool Programmatically

```ts
import { createBrowserConnector, normalizeBrowserTools } from '@dzupagent/connectors-browser'

const tools = createBrowserConnector({ headless: true })
const normalized = normalizeBrowserTools(tools)

const crawlTool = normalized.find((t) => t.id === 'browser-crawl-site')
if (!crawlTool) throw new Error('crawl tool missing')

const output = await crawlTool.invoke({
  startUrl: 'https://example.com',
  maxPages: 5,
  maxDepth: 1,
})

console.log(output)
```

### 6.3 Use Low-Level APIs Directly

```ts
import {
  BrowserManager,
  extractForms,
  extractInteractiveElements,
} from '@dzupagent/connectors-browser'

const manager = new BrowserManager()
await manager.launch({ headless: true })

try {
  const context = await manager.newContext()
  const page = await context.newPage()
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded' })

  const [forms, elements] = await Promise.all([
    extractForms(page),
    extractInteractiveElements(page),
  ])

  console.log({ forms: forms.length, elements: elements.length })
  await page.close()
} finally {
  await manager.close()
}
```

## 7. Cross-Package References in This Monorepo

Analysis date: `2026-04-04`

Searches across `packages/**`, `docs/**`, and root `README.md` found:

- No direct imports of `@dzupagent/connectors-browser` outside this package.
- No other workspace `package.json` currently declares `@dzupagent/connectors-browser` as a dependency.
- No external references to `createBrowserConnector` or tool ids (`browser-crawl-site`, etc.) outside this package.

Interpretation:

- The package is currently self-contained and not yet wired into another workspace package.
- Its current in-repo usage is test-driven and documentation-driven rather than cross-package runtime integration.

## 8. Test Coverage and Validation

Executed commands:

- `yarn workspace @dzupagent/connectors-browser test`
- `yarn workspace @dzupagent/connectors-browser vitest run --coverage`

Result:

- Test files: `7`
- Total tests: `76`
- Status: all passing

Coverage snapshot (v8):

- Overall: `63.62%` statements, `70.32%` branches, `65.11%` functions, `63.62%` lines
- Strongly covered modules:
- `browser/browser-manager.ts`: `100%` across metrics.
- `crawler/url-utils.ts`: `96.92%` statements, `93.33%` branches.
- `extraction/form-extractor.ts`: `100%` statements/lines.
- Lower-coverage hotspots:
- `crawler/page-crawler.ts`: `8.29%` statements, `0%` branches/functions.
- `browser-connector.ts`: `46.11%` statements, `7.69%` functions.
- `crawler/link-extractor.ts`: `67.02%` statements, `58.62%` branches.

Coverage interpretation:

- Helper modules are well tested with mocked browser/document surfaces.
- End-to-end behavior of crawl orchestration (`PageCrawler`) and full connector tool execution paths (`browser-connector`) has limited coverage and is the primary testing gap.

## 9. Risks and Improvement Opportunities

1. `PageCrawler` runtime paths are under-tested.
- Add focused tests for BFS queue behavior, include/exclude filters, max depth/page limits, and hash-route transitions.

2. Connector tool lifecycle/error paths are under-tested.
- Add tests asserting session cleanup on thrown errors and tool output truncation behavior.

3. DOM heuristics are framework-dependent.
- Add fixtures for multiple real SPA patterns (Vue/React/Next/Angular) to reduce false negatives in route/auth extraction.

4. No in-repo consumer integration currently.
- Add an integration example in another package (or an adapter test harness) to validate contract stability across package boundaries.
