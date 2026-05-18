# @dzupagent/connectors-browser Architecture

## Scope
`@dzupagent/connectors-browser` is a Playwright-backed connector package that exposes browser automation capabilities as DzupAgent tools and low-level utilities.

Current scope in `packages/connectors-browser`:
- Tool factory: `createBrowserConnector` in `src/browser-connector.ts`.
- Tool contract adapters: `normalizeBrowserTool`, `normalizeBrowserTools` in `src/connector-contract.ts`.
- Browser lifecycle/auth helpers: `BrowserManager`, `AuthHandler`, navigation policy helpers in `src/browser/*`.
- Crawl and URL discovery: `PageCrawler`, `extractLinks`, URL utils in `src/crawler/*`.
- Extraction primitives: forms, interactive elements, accessibility tree, and screenshots in `src/extraction/*`.

Out of scope for this package:
- Persistent session/state management across tool invocations.
- Storage, queues, HTTP APIs, or orchestration services.
- Cross-package telemetry infrastructure.

## Responsibilities
- Provide a stable package entry (`src/index.ts`) for connector tools and primitives.
- Build tool instances via `createForgeTool` from `@dzupagent/core/tools`.
- Validate tool input schemas using `zod`.
- Enforce browser navigation guardrails with `validateBrowserNavigationUrl`, `installBrowserNavigationPolicy`, and `safeBrowserGoto`.
- Execute bounded crawling with BFS controls (`maxPages`, `maxDepth`, include/exclude patterns).
- Extract structured browser data for agent workflows.
- Keep tool payloads bounded (`MAX_RESULT_LENGTH = 8000` in tool wrappers).

## Structure
Top-level package files:
- `package.json`: ESM package metadata, scripts (`build`, `typecheck`, `lint`, `test`), runtime dependency on `@dzupagent/core`, peer dependencies on `playwright` and `zod`.
- `README.md`: install/usage/API examples.
- `tsup.config.ts`: ESM build from `src/index.ts`, DTS generation, Node 20 target.
- `docs/ARCHITECTURE.md`: this architecture reference.

Source modules:
- `src/index.ts`: public exports.
- `src/browser-connector.ts`: connector config and five tool implementations.
- `src/connector-contract.ts`: conversion from `StructuredToolInterface` to `BaseConnectorTool` shape.
- `src/types.ts`: shared interfaces (`CrawlOptions`, `CrawlResult`, `BrowserNavigationPolicy`, etc.).
- `src/browser/browser-manager.ts`: Playwright launch/context lifecycle.
- `src/browser/auth-handler.ts`: credential/cookie auth and login-page detection.
- `src/browser/navigation-policy.ts`: protocol/origin/host/private-network enforcement and guarded navigation.
- `src/crawler/page-crawler.ts`: crawl queue, navigation, extraction fan-out.
- `src/crawler/link-extractor.ts`: anchor/hash/SPA/data-attribute link discovery.
- `src/crawler/url-utils.ts`: URL normalization, same-origin checks, pattern matching, hash-route detection.
- `src/extraction/form-extractor.ts`: HTML form/field extraction.
- `src/extraction/element-extractor.ts`: interactive element extraction + ARIA attributes.
- `src/extraction/accessibility-tree.ts`: DOM-based role/name/state tree extraction.
- `src/extraction/screenshot-capture.ts`: JPEG screenshot capture with full-page clipping cap.

Tests:
- `src/__tests__/*.test.ts` covering connector tools, crawler behavior, URL/policy rules, auth, extraction, and contract adapters.

## Runtime and Control Flow
Tool runtime (`createBrowserConnector`):
1. Build five tools with `createForgeTool` and `zod` input schemas.
2. On each invocation, create an isolated browser session via `createBrowserSession`:
- `BrowserManager.launch({ headless })`
- `BrowserManager.newContext(...)`
- Optional `AuthHandler.loginWithCredentials(...)` when `config.auth` exists.
3. Run tool-specific behavior:
- `browser-crawl-site`: instantiate `PageCrawler`, iterate async crawl results, summarize counts.
- `browser-capture-screenshot`: navigate with `safeBrowserGoto`, wait for load settle, return base64 payload.
- `browser-extract-forms`: navigate and return `extractForms` JSON.
- `browser-extract-elements`: navigate and return `extractInteractiveElements` JSON.
- `browser-extract-a11y-tree`: navigate and return `extractAccessibilityTree` JSON.
4. Convert operational failures into `Error: ...` strings (rather than throwing).
5. Always close the browser manager in `finally`.

Crawler runtime (`PageCrawler.crawl`):
1. Validate `startUrl` against navigation policy.
2. Initialize BFS queue with depth tracking.
3. Enforce `maxPages`, `maxDepth`, visited dedupe, include/exclude patterns.
4. For each URL:
- Open a page.
- Navigate with `safeBrowserGoto` (hash-route path uses base-url load plus `window.location.hash` update).
- Wait for SPA readiness (`networkidle` best-effort + DOM readiness heuristic).
- Extract links/forms/elements/a11y/screenshot in parallel.
- Yield `CrawlResult`.
- Enqueue discovered links if allowed by origin/policy settings.
5. On page failure, emit `console.warn` and continue.
6. Close each page in `finally`.

Navigation policy flow (`navigation-policy.ts`):
- Allows only configured protocols (default `http:`/`https:`).
- Optionally restricts origins/hosts.
- Blocks private/local targets by default (`localhost`, loopback/private CIDRs, link-local, metadata host).
- Installs a route interceptor to abort blocked document/navigation requests.
- Revalidates final URL after navigation to catch unsafe redirects.

## Key APIs and Types
Primary factory and adapters:
- `createBrowserConnector(config?: BrowserConnectorConfig)`
- `normalizeBrowserTool(tool)`
- `normalizeBrowserTools(tools)`

Connector tool names:
- `browser-crawl-site`
- `browser-capture-screenshot`
- `browser-extract-forms`
- `browser-extract-elements`
- `browser-extract-a11y-tree`

Browser/auth/navigation APIs:
- `BrowserManager.launch(opts?)`
- `BrowserManager.newContext(opts?)`
- `BrowserManager.close()`
- `AuthHandler.loginWithCredentials(page, creds)`
- `AuthHandler.loginWithCookies(context, cookies)`
- `AuthHandler.isLoginPage(page)`
- `validateBrowserNavigationUrl(url, policy?)`
- `installBrowserNavigationPolicy(page, policy?)`
- `safeBrowserGoto(page, url, options, policy?)`

Crawler and extraction APIs:
- `PageCrawler`
- `extractLinks(page)`
- `normalizeUrl(url, baseUrl)`
- `isSameOrigin(url, baseUrl)`
- `matchesPattern(url, patterns)`
- `isHashRoute(url)`
- `extractForms(page)`
- `extractInteractiveElements(page)`
- `extractAccessibilityTree(page)`
- `captureScreenshot(page, fullPage?)`

Key exported types:
- `BrowserConnectorConfig`
- `CrawlOptions`, `CrawlResult`
- `BrowserNavigationPolicy`
- `AuthCredentials`
- `BrowserLaunchOptions`
- `FormInfo`, `FormField`
- `ElementInfo`
- `AccessibilityNode`
- `ScreenshotResult`

## Dependencies
Runtime dependencies:
- `@dzupagent/core` (`createForgeTool`, base tool normalization).

Peer dependencies:
- `playwright >=1.50.0`
- `zod >=4.0.0`

Dev dependencies:
- `playwright`, `zod`, `vitest`, `tsup`, `typescript`.

Notable implementation detail:
- `BrowserManager.launch` dynamically imports `playwright` (`await import('playwright')`) so module load is deferred until runtime usage.

## Integration Points
- Agent/tool consumers import `createBrowserConnector(...)` and register the returned tools directly.
- Consumers requiring base connector contract compatibility can wrap tools via `normalizeBrowserTools(...)`.
- Non-tool consumers can compose lower-level modules (`BrowserManager`, `PageCrawler`, extractor helpers) directly.
- This package does not expose HTTP endpoints or background jobs; integration is library-level only.

## Testing and Observability
Test surface (Vitest):
- Connector tool behavior and error handling: `browser-connector-tools.test.ts`.
- Entrypoint integration and export usage: `browser-connector.integration.test.ts`.
- Contract mapping: `connector-contract.test.ts`.
- Browser lifecycle manager: `browser-manager.test.ts`.
- Auth workflow helpers: `auth-handler.test.ts`.
- Crawl queue/depth/origin/policy behavior: `page-crawler.test.ts`, `navigation-policy.test.ts`.
- URL/link logic: `url-utils.test.ts`, `link-extractor.test.ts`.
- Extraction and screenshot behavior: `extraction.test.ts`, `screenshot-capture.test.ts`.

Observability currently in package code:
- Crawl failures are logged via `console.warn` in `PageCrawler`.
- Tool methods return explicit error strings for model-facing compatibility.
- No built-in metrics/tracing/log sink abstraction is present.

## Risks and TODOs
- `createBrowserSession` passes `{ headless }` to `BrowserManager.newContext`, but `newContext` currently uses only `viewport` and `proxy`; this context-level `headless` value is ignored.
- Tool output truncation is character-based and can cut JSON structures mid-document, making output non-parseable for strict consumers.
- `matchesPattern` builds regex directly from pattern text without escaping non-glob regex metacharacters; literal pattern intent can be misinterpreted.
- `AuthHandler` login success heuristics are selector/URL based and may need site-specific selectors for robust login in complex SSO flows.
- Accessibility extraction is DOM-heuristic based (not Playwright accessibility snapshot API), so role/name fidelity depends on page markup quality.
- Current tests are mostly mocked/unit-level; there is no package-local live-browser end-to-end suite against real sites.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js

