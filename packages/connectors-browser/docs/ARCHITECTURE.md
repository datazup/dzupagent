# @dzupagent/connectors-browser Architecture

## Scope
`@dzupagent/connectors-browser` provides Playwright-powered browser tooling for DzupAgent. In the current codebase (`packages/connectors-browser`), it covers:
- A connector factory (`createBrowserConnector`) that builds five browser tools.
- Browser lifecycle and auth helpers (`BrowserManager`, `AuthHandler`).
- Crawl and extraction primitives (`PageCrawler`, link/url helpers, form/element/a11y/screenshot extractors).
- Tool-contract adapters (`normalizeBrowserTool`, `normalizeBrowserTools`) for `StructuredToolInterface` interop.

Current non-goals in this package:
- Long-lived shared browser state across tool calls.
- Cross-origin crawl traversal.
- Runtime orchestration or persistence layers outside this library.

## Responsibilities
- Expose a stable package entrypoint through `src/index.ts`.
- Build agent-usable tools with `createForgeTool` from `@dzupagent/core`.
- Manage Playwright launch/context/teardown and optional login bootstrap.
- Crawl same-origin pages with bounded BFS and configurable include/exclude pattern filters.
- Extract structured webpage data (forms, interactive elements, accessibility signals, screenshots).
- Keep model-facing payload size bounded (`MAX_RESULT_LENGTH = 8000` for large JSON tool responses).

## Structure
Package files:
- `package.json`: ESM package (`type: module`), scripts (`build`, `typecheck`, `lint`, `test`), runtime dep on `@dzupagent/core`, peer deps on `playwright` and `zod`.
- `README.md`: usage examples and exported API summary.
- `tsup.config.ts`: builds `src/index.ts` to ESM + types for Node 20.
- `docs/ARCHITECTURE.md`: package architecture reference.

Source layout:
- `src/index.ts`: public exports.
- `src/browser-connector.ts`: connector config type + 5 tool definitions.
- `src/connector-contract.ts`: normalization helpers for tool contracts.
- `src/types.ts`: shared data contracts.
- `src/browser/browser-manager.ts`: browser launch/newContext/close wrapper.
- `src/browser/auth-handler.ts`: credential and cookie auth helpers.
- `src/crawler/page-crawler.ts`: BFS crawl generator and SPA wait behavior.
- `src/crawler/link-extractor.ts`: link discovery from anchors/hash routes/SPA surfaces.
- `src/crawler/url-utils.ts`: hash-route detection, URL normalization, origin/pattern checks.
- `src/extraction/form-extractor.ts`: HTML form and field extraction.
- `src/extraction/element-extractor.ts`: interactive element and ARIA extraction.
- `src/extraction/accessibility-tree.ts`: DOM-walk-based accessibility tree extraction.
- `src/extraction/screenshot-capture.ts`: JPEG capture with full-page clipping cap.
- `src/__tests__/*`: Vitest suite for connector flows and helpers.

## Runtime and Control Flow
Tool invocation flow (`createBrowserConnector`):
1. Validate input with tool-specific Zod schemas.
2. Create session via internal `createBrowserSession(config)`:
- `BrowserManager.launch({ headless })`
- `BrowserManager.newContext(...)`
- Optional `AuthHandler.loginWithCredentials(...)` on a temporary page.
3. Execute tool behavior:
- `browser-crawl-site`: run `PageCrawler.crawl(startUrl)` and summarize each page.
- `browser-capture-screenshot`: visit URL, capture screenshot, return base64 JSON payload.
- `browser-extract-forms` / `browser-extract-elements` / `browser-extract-a11y-tree`: visit URL and return extractor output JSON.
4. Return error strings on failures (`Error: ...`) instead of throwing.
5. Always close browser manager in `finally`.

Crawler control flow (`PageCrawler`):
1. Start BFS queue at `{ url: startUrl, depth: 0 }`.
2. Enforce `maxPages` and `maxDepth`; skip visited URLs.
3. Apply include/exclude glob-like patterns (`matchesPattern`).
4. Navigate page:
- Hash-route URL: navigate to base URL and then set `window.location.hash`.
- Regular URL: `goto(..., waitUntil: 'domcontentloaded')`.
5. Wait for SPA readiness (best-effort `networkidle`, loading-indicator check, content readiness check).
6. Extract links, accessibility tree, screenshot, forms, and interactive elements in parallel.
7. Yield `CrawlResult`; enqueue newly discovered links at `depth + 1`.
8. On crawl failure, log warning and continue queue processing.

## Key APIs and Types
Primary exports:
- `createBrowserConnector(config?: BrowserConnectorConfig)`
- `normalizeBrowserTool(...)`
- `normalizeBrowserTools(...)`
- `BrowserManager`
- `AuthHandler`
- `PageCrawler`
- `extractLinks(...)`
- `normalizeUrl(...)`
- `isSameOrigin(...)`
- `matchesPattern(...)`
- `isHashRoute(...)`
- `extractForms(...)`
- `extractInteractiveElements(...)`
- `extractAccessibilityTree(...)`
- `captureScreenshot(...)`

Connector tool IDs (current):
- `browser-crawl-site`
- `browser-capture-screenshot`
- `browser-extract-forms`
- `browser-extract-elements`
- `browser-extract-a11y-tree`

Important types:
- `BrowserConnectorConfig`
- `CrawlOptions`
- `CrawlResult`
- `AuthCredentials`
- `BrowserLaunchOptions`
- `FormInfo`, `FormField`
- `ElementInfo`
- `AccessibilityNode`
- `ScreenshotResult`

## Dependencies
Runtime dependencies:
- `@dzupagent/core` (Forge tool creation + base connector normalization).

Peer dependencies:
- `playwright >=1.50.0`
- `zod >=4.0.0`

Development dependencies:
- `playwright`, `vitest`, `tsup`, `typescript`.

Behavioral dependency notes:
- Playwright is dynamically imported in `BrowserManager.launch`, delaying hard dependency load until runtime usage.
- Tool schemas and validation are implemented with `zod` inside `browser-connector.ts`.

## Integration Points
- Agent consumers register `createBrowserConnector(...)` output directly in tool lists.
- Connector consumers expecting `BaseConnectorTool` can normalize returned tools through `normalizeBrowserTools`.
- Consumers can bypass tool wrappers and use primitives (`BrowserManager`, `PageCrawler`, extractors) directly.
- The package exposes library APIs only; no internal HTTP endpoints, queues, or storage integrations exist here.

## Testing and Observability
Current automated tests cover:
- Connector surface and error handling: `browser-connector-tools.test.ts`.
- Public integration behavior and entrypoint exports: `browser-connector.integration.test.ts`.
- Contract normalization helpers: `connector-contract.test.ts`.
- Browser lifecycle behavior: `browser-manager.test.ts`.
- Auth flows: `auth-handler.test.ts`.
- BFS crawl behavior and limits: `page-crawler.test.ts`.
- Link/url utility behavior: `link-extractor.test.ts`, `url-utils.test.ts`.
- Extractor behavior and screenshot clipping: `extraction.test.ts`, `screenshot-capture.test.ts`.

Observability currently in code:
- No dedicated telemetry/tracing subsystem in this package.
- Crawl runtime failures are logged with `console.warn`.
- Tool failures are surfaced as string error outputs for model/tool-call compatibility.

## Risks and TODOs
- `createBrowserSession` passes `headless` into `BrowserManager.newContext(...)`, but `newContext` only consumes `viewport` and `proxy`; this option is effectively ignored at context creation.
- Tool output truncation is character-based and can cut JSON payloads mid-structure, which can make outputs unparsable for downstream strict JSON consumers.
- `matchesPattern` converts glob-like patterns to regex without escaping regex metacharacters outside `*`/`?`, so some literal URLs can match unexpectedly.
- Observability is minimal (`console.warn` only); diagnosing flaky browser environments may require higher-level instrumentation outside this package.
- Accessibility extraction is DOM-heuristic based, not Playwright accessibility tree API based; role/name fidelity can vary by app markup quality.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

