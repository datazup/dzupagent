# Security Audit

Current status as of 2026-05-03: all findings from this audit are remediated in
the live repository. The original impact/remediation text is kept as historical
context; each finding now carries explicit status and current evidence so this
document does not read as an open backlog after the fixes landed.

## Findings

### SECURITY-001 - High - A2A push callbacks allow server-side request forgery and task data exfiltration

Status: Resolved

**Impact:** An authenticated A2A caller that owns a task can configure an arbitrary push notification URL. When that task reaches a terminal state, the server POSTs the full task payload to that URL from the server network. In a production deployment this can be used to reach internal services, cloud metadata endpoints, or attacker-controlled endpoints, and it can exfiltrate task inputs, messages, artifacts, and optional callback bearer tokens.

**Evidence:** `handlePushNotificationSet` only checks that `pushNotificationConfig.url` is a string before persisting it for an owned task (`packages/server/src/routes/a2a/jsonrpc-handlers.ts:202`, `packages/server/src/routes/a2a/jsonrpc-handlers.ts:212`). `DrizzleA2ATaskStore` later sends `fetch(config.url, ...)` with the full serialized task body and optional `Authorization: Bearer ${config.token}` when a task is completed or failed (`packages/server/src/a2a/drizzle-a2a-task-store.ts:24`, `packages/server/src/a2a/drizzle-a2a-task-store.ts:33`, `packages/server/src/a2a/drizzle-a2a-task-store.ts:126`). This path does not use the shared outbound URL policy used by MCP HTTP transports.

**Remediation:** Apply the shared outbound URL policy to A2A push callbacks before storing and before delivering them. Default to HTTPS public destinations, block loopback/private/link-local/metadata ranges, validate DNS and redirects, and support host allowlists for deployments that need internal callbacks. Consider redacting sensitive task fields from callback bodies and making callback tokens write-only.

**Resolved evidence:** `handlePushNotificationSet` validates callback URLs with `assertA2APushCallbackUrlAllowed`, both in-memory and Drizzle task stores validate before storage, and delivery uses `fetchWithOutboundUrlPolicy`. Public A2A responses redact callback tokens, and the push payload omits input, messages, artifacts, and the callback config. Regression coverage lives in `packages/server/src/a2a/__tests__/a2a-push-security.test.ts`.

### SECURITY-002 - Medium - Run input guard redaction happens after raw input is persisted and returned

Status: Resolved

**Impact:** Sensitive user input, PII, prompt-injection payloads, and oversized inputs can be accepted, stored, queued, and returned to the caller before the input guard runs. If the worker is delayed, disabled, or fails before the guard stage, the unredacted payload remains in persistence and API responses. The length guard also does not protect JSON parsing or initial database writes.

**Evidence:** `handleCreateRun` parses the request, only size-checks `metadata`, then persists `body.input` directly in `runStore.create` (`packages/server/src/routes/runs.ts:149`, `packages/server/src/routes/runs.ts:153`, `packages/server/src/routes/runs.ts:278`). Queued runs enqueue and respond with `run.input` before worker redaction (`packages/server/src/routes/runs.ts:300`, `packages/server/src/routes/runs.ts:315`). The worker guard scans later in `runAdmissionStage` and updates the stored run only after detecting redacted input (`packages/server/src/runtime/run-worker-stages.ts:67`, `packages/server/src/runtime/run-worker-stages.ts:103`). The guard documentation says callers are expected to overwrite input before persistence and enforces a default maximum serialized input length of 50,000 characters (`packages/server/src/security/input-guard.ts:16`, `packages/server/src/security/input-guard.ts:19`).

**Remediation:** Move input guard scanning, length checks, and redaction into the HTTP create-run path before `runStore.create`, queue enqueue, routing classification, and response serialization. Keep the worker guard as defense in depth, but make boundary admission fail closed for rejected input and persist only the redacted input when redaction is enabled.

**Resolved evidence:** `handleCreateRun` now checks serialized input size, runs the input guard, rejects blocked input, and persists/enqueues/returns `admittedInput` after redaction. The worker guard remains as defense in depth. Regression coverage includes `packages/server/src/__tests__/run-crud-routes.test.ts` and `packages/server/src/__tests__/input-guard.test.ts`.

### SECURITY-003 - Medium - HTTP connector redirect chains bypass the validated base-origin policy

Status: Resolved

**Impact:** A server-side HTTP connector profile can validate a safe-looking base URL, but a tool call to that origin can follow a server-controlled redirect to loopback, private networks, link-local metadata services, or other disallowed hosts. This preserves the same-origin check at request construction while still allowing SSRF through native fetch redirects.

**Evidence:** The server validates the configured HTTP connector `baseUrl` with `validateMcpHttpEndpoint` before creating the connector (`packages/server/src/runtime/tool-resolver.ts:897`, `packages/server/src/runtime/tool-resolver.ts:904`). The connector then only verifies that the requested path stays on `base.origin` (`packages/connectors/src/http/http-connector.ts:52`, `packages/connectors/src/http/http-connector.ts:55`). It performs a raw `fetch(url.toString(), ...)` without shared outbound URL policy enforcement or redirect revalidation (`packages/connectors/src/http/http-connector.ts:67`). By contrast, the core outbound URL policy includes redirect validation in `fetchWithOutboundUrlPolicy`.

**Remediation:** Replace raw connector fetches with the shared outbound URL policy wrapper and validate every redirect hop. Consider `redirect: 'manual'` plus explicit revalidation, HTTPS-by-default connector profiles, and per-profile allowed host checks at request time as well as registration time.

**Resolved evidence:** `createHTTPConnector` now calls `fetchWithOutboundUrlPolicy` with a connector-specific fetch gate. Redirects are handled manually and every hop is revalidated; off-origin redirects require `allowedHosts`, and private or metadata destinations are blocked by default. Regression coverage lives in `packages/connectors/src/__tests__/http-connector.test.ts`.

### SECURITY-004 - Medium - Browser connector can navigate to arbitrary internal URLs and crawl off origin

Status: Resolved

**Impact:** Browser tools can be used as a server-side browser SSRF primitive. A caller can request screenshots, form extraction, accessibility extraction, or element extraction from internal HTTP services reachable from the server. The crawler can also leave the starting origin through discovered links unless the caller supplies restrictive include patterns.

**Evidence:** Browser tool schemas accept any `z.string().url()` for `startUrl` or `url` (`packages/connectors-browser/src/browser-connector.ts:85`, `packages/connectors-browser/src/browser-connector.ts:109`, `packages/connectors-browser/src/browser-connector.ts:117`). The tools pass those URLs directly to Playwright `page.goto` (`packages/connectors-browser/src/browser-connector.ts:198`, `packages/connectors-browser/src/browser-connector.ts:252`, `packages/connectors-browser/src/browser-connector.ts:295`, `packages/connectors-browser/src/browser-connector.ts:338`). `PageCrawler` queues discovered links without a same-origin default (`packages/connectors-browser/src/crawler/page-crawler.ts:27`, `packages/connectors-browser/src/crawler/page-crawler.ts:113`).

**Remediation:** Add a browser-navigation URL policy that blocks loopback, private, link-local, and metadata destinations by default and revalidates navigation redirects. Make crawling same-origin by default, with explicit allowlists for cross-origin crawling. Expose an intentional unsafe/private-network opt-in for controlled internal scanning deployments.

**Resolved evidence:** Browser navigation now goes through `navigation-policy.ts`, screenshots and crawler starts block private/local/metadata targets by default, and redirected navigation targets are revalidated. The crawler has same-origin defaults with explicit opt-ins for wider crawling. Regression coverage includes `packages/connectors-browser/src/__tests__/navigation-policy.test.ts`, `browser-connector-tools.test.ts`, and `page-crawler.test.ts`.

### SECURITY-005 - Medium - Non-API active routes sit outside the shared RBAC and rate-limit middleware

Status: Resolved

**Impact:** Costly or state-changing surfaces mounted outside `/api/*` do not receive the framework RBAC layer and do not receive the configured framework rate limiter. OpenAI-compatible `/v1/*` routes can drive model execution under their own auth but without the shared rate limiter. A2A `/a2a` routes receive auth only when framework auth is configured, and they do not receive framework RBAC or rate limiting. This increases brute-force, denial-of-wallet, and task-abuse risk on deployments that expose those compatibility surfaces.

**Evidence:** Auth, RBAC, and rate limiting are mounted only for `/api/*` in the shared middleware (`packages/server/src/composition/middleware.ts:167`, `packages/server/src/composition/middleware.ts:184`, `packages/server/src/composition/middleware.ts:190`). A2A routes are mounted at root and protect `/a2a` only with auth when `effectiveAuth` exists (`packages/server/src/composition/optional-routes.ts:201`, `packages/server/src/composition/optional-routes.ts:213`, `packages/server/src/composition/optional-routes.ts:236`). OpenAI compatibility routes are mounted under `/v1/*` with their own auth middleware but no shared rate limiter (`packages/server/src/composition/optional-routes.ts:321`, `packages/server/src/composition/optional-routes.ts:327`).

**Remediation:** Extend rate limiting to `/a2a/*` and `/v1/*` when those surfaces are enabled. Add explicit RBAC or capability checks for A2A task mutation and OpenAI-compatible execution. Make the configuration surface clear that these routes need equivalent production controls even though they are not `/api/*`.

**Resolved evidence:** `applyRateLimit` now mounts rate limiting on `/api/*`, `/a2a`, `/a2a/*`, and `/v1/*` when the corresponding surfaces are enabled. Optional A2A and OpenAI-compatible routes also apply RBAC when auth is active and RBAC is not disabled.

### SECURITY-006 - Low - Request body size limits are late and inconsistent across JSON routes

Status: Resolved

**Impact:** Large JSON bodies can consume memory and CPU during parsing before route-level validation rejects them. This is a practical denial-of-service risk on public deployments, especially for routes that accept arbitrary records, compile requests, workflow payloads, MCP profiles, browser or memory data, and OpenAI-compatible chat bodies.

**Evidence:** `applyMiddleware` does not install a global content-length or body-size guard (`packages/server/src/composition/middleware.ts:55`). Many server routes parse request bodies directly with `c.req.json()` or `validateBodyCompat`, including runs, workflows, schemas, MCP, memory, OpenAI compatibility, marketplace, and A2A routes (`packages/server/src/routes/runs.ts:149`, `packages/server/src/validation/route-validator.ts:32`, `packages/server/src/routes/a2a/jsonrpc-route.ts:77`). The create-run route checks only serialized `metadata` size after JSON parsing (`packages/server/src/routes/runs.ts:153`).

**Remediation:** Add a shared request body limit middleware that rejects oversized requests before JSON parsing, with route-specific overrides for legitimately large inputs. Also add per-field serialized-size checks for high-risk payloads such as run input, compile body, MCP profile payloads, and OpenAI-compatible messages.

**Resolved evidence:** `applyJsonBodySizeLimit` installs a JSON body guard for all routes unless explicitly disabled, checks `content-length` before parsing, and falls back to byte counting when the header is absent. Route-specific limits cover larger workflow and OpenAI-compatible payloads. `handleCreateRun` also has a per-field serialized input ceiling.

### SECURITY-007 - Low - Low-level WebSocket control helper defaults can allow unscoped subscriptions

Status: Resolved

**Impact:** Hosts that wire the low-level WebSocket control helper directly can accidentally allow clients to subscribe to all runtime events by omitting a filter. The repository has safer scoped authorization helpers, but the lower-level default is fail-open for subscription scope.

**Evidence:** `normalizeFilter` converts a missing filter to `{}` (`packages/server/src/ws/control-protocol.ts:49`). `createWsControlHandler` defaults `requireScopedSubscription` to `false` and only invokes `authorizeFilter` when the host supplied one (`packages/server/src/ws/control-protocol.ts:89`, `packages/server/src/ws/control-protocol.ts:94`, `packages/server/src/ws/control-protocol.ts:148`). Safer helpers reject missing upgrade guards and unscoped filters by default when used (`packages/server/src/ws/node-upgrade-handler.ts:63`, `packages/server/src/ws/node-upgrade-handler.ts:78`, `packages/server/src/ws/authorization.ts:63`, `packages/server/src/ws/authorization.ts:66`).

**Remediation:** Change the low-level helper default to require scoped subscriptions, or require an explicit `allowUnscopedSubscriptions` option to preserve compatibility. Document the unsafe mode and add tests for omitted filters in direct `createWsControlHandler` usage.

**Resolved evidence:** `createWsControlHandler` now rejects unscoped subscriptions by default and requires `allowUnscopedSubscriptions: true` or the deprecated compatibility opt-out for wildcard subscriptions. Regression coverage includes `packages/server/src/__tests__/ws-control-protocol.test.ts` and `control-protocol-branches.test.ts`.

### SECURITY-008 - Low - Sandbox-enabled codegen can silently fall back to local execution

Status: Resolved

**Impact:** A host can configure a workspace with `sandbox.enabled` and assume tool execution is isolated, but if no sandbox instance is passed, the factory returns a local workspace. Because local command allowlists are optional, misconfiguration can turn intended sandboxed execution into host-local command execution within the configured workspace.

**Evidence:** `WorkspaceFactory.create` returns `SandboxedWorkspace` only when both `options.sandbox?.enabled` and a `sandbox` instance are present; otherwise it returns `LocalWorkspace` (`packages/codegen/src/workspace/workspace-factory.ts:18`, `packages/codegen/src/workspace/workspace-factory.ts:21`, `packages/codegen/src/workspace/workspace-factory.ts:25`). `LocalWorkspace.runCommand` enforces `allowedCommands` only when the option is configured (`packages/codegen/src/workspace/local-workspace.ts:199`, `packages/codegen/src/workspace/local-workspace.ts:204`).

**Remediation:** Fail closed when `sandbox.enabled` is true but no sandbox backend is supplied, unless a separate explicit local fallback option is set. Require or strongly default command allowlists for local workspaces used by agent-controlled tools.

**Resolved evidence:** `WorkspaceFactory.create` throws `WorkspaceConfigurationError` when `sandbox.enabled` is true without a sandbox backend, unless `sandbox.allowLocalFallback` is explicitly enabled. Regression coverage lives in `packages/codegen/src/workspace/__tests__/workspace-factory.test.ts`.

### SECURITY-009 - Low - Marketplace tag filtering uses manual SQL literal construction

Status: Resolved

**Impact:** The tag filter currently escapes single quotes before embedding an array literal with `sql.raw`, which reduces obvious injection risk but is still a fragile pattern for untrusted query input. Future changes to tag normalization, database dialect, or escaping could turn this into a SQL injection defect.

**Evidence:** `DrizzleCatalogStore.search` builds a Postgres array literal from `query.tags` with string replacement and injects it through `sql.raw` (`packages/server/src/marketplace/drizzle-catalog-store.ts:144`, `packages/server/src/marketplace/drizzle-catalog-store.ts:147`). Other filters in the same method use parameterized Drizzle helpers such as `ilike` and `eq` (`packages/server/src/marketplace/drizzle-catalog-store.ts:135`, `packages/server/src/marketplace/drizzle-catalog-store.ts:153`).

**Remediation:** Replace the raw array literal with parameterized SQL or a Drizzle-supported array overlap expression that binds tag values as parameters. Add tests with quotes, commas, braces, backslashes, and long tag arrays.

**Resolved evidence:** `DrizzleCatalogStore.search` now uses Drizzle `arrayOverlaps(agentCatalog.tags, query.tags)` instead of constructing raw SQL array literals. Regression coverage in `packages/server/src/__tests__/drizzle-catalog-store.test.ts` includes quotes, commas, braces, backslashes, and long tag arrays.

### SECURITY-010 - Low - Owner-scoped run listing leaks aggregate run counts inside a tenant

Status: Resolved

**Impact:** A caller can learn the total number of matching runs in its tenant even when row data is filtered to the caller's API key owner. This is a low-grade tenant-boundary metadata leak that can reveal another key's run volume for a shared tenant.

**Evidence:** `handleListRuns` fetches tenant-filtered runs and then filters rows by `ownerId` for the requesting API key (`packages/server/src/routes/runs.ts:337`, `packages/server/src/routes/runs.ts:352`, `packages/server/src/routes/runs.ts:357`). The returned `total` uses `runStore.count` with agent, status, and tenant filters but no owner filter, and a comment states that this intentionally matches the unfiltered count when the store lacks ownerId count support (`packages/server/src/routes/runs.ts:362`, `packages/server/src/routes/runs.ts:369`, `packages/server/src/routes/runs.ts:373`).

**Remediation:** Extend the run-store count interface to accept `ownerId` and return owner-scoped totals whenever auth is enabled. Until stores support owner-aware counts, return `visible.length` or omit `total` for owner-scoped listings.

**Resolved evidence:** `handleListRuns` passes the requesting owner filter into both `runStore.list` and `runStore.count`, and `PostgresRunStore.count` applies `ownerId` plus `includeLegacyOwnerless` consistently with list filtering. Regression coverage lives in `packages/server/src/__tests__/runs-list-total.test.ts`.

### SECURITY-011 - Low - Security-sensitive peer dependency ranges allow older consumer installs

Status: Resolved

**Impact:** Published packages can be installed with older peer versions that are outside the versions exercised by this repository's lockfile and security gate. Consumers may satisfy `express >=4.18.0` with a version older than the repository's dev dependency, leaving the adapter compatible with potentially stale web-server dependencies even if repository CI is clean.

**Evidence:** `@dzupagent/express` declares `express: ">=4.18.0"` as a peer dependency while using `express: "^4.21.0"` in dev dependencies (`packages/express/package.json:24`, `packages/express/package.json:29`). `@dzupagent/test-utils` also declares `express: ">=4.18.0"` (`packages/test-utils/package.json:24`, `packages/test-utils/package.json:26`). The security workflow audits the repository lockfile with `yarn audit --level moderate`, which does not prove every allowed peer minimum remains acceptable for consumers (`.github/workflows/security.yml:43`, `.github/workflows/security.yml:45`).

**Remediation:** Raise lower bounds for security-sensitive peers to currently supported patched versions, or use tighter compatible ranges such as a patched Express 4 range plus Express 5 once validated. Add release guidance that peer dependency lower bounds are security-maintained, not only API-compatible.

**Resolved evidence:** `@dzupagent/express` and `@dzupagent/test-utils` now require `express >=4.22.1 <5` as a peer and use `express ^4.22.1` for local validation. Package architecture docs list the patched lower bound.

```json
{
  "domain": "security",
  "counts": { "critical": 0, "high": 0, "medium": 0, "low": 0, "info": 0, "resolved": 11 },
  "findings": [
    { "id": "SECURITY-001", "severity": "high", "status": "resolved", "title": "A2A push callbacks allow server-side request forgery and task data exfiltration", "file": "packages/server/src/a2a/drizzle-a2a-task-store.ts" },
    { "id": "SECURITY-002", "severity": "medium", "status": "resolved", "title": "Run input guard redaction happens after raw input is persisted and returned", "file": "packages/server/src/routes/runs.ts" },
    { "id": "SECURITY-003", "severity": "medium", "status": "resolved", "title": "HTTP connector redirect chains bypass the validated base-origin policy", "file": "packages/connectors/src/http/http-connector.ts" },
    { "id": "SECURITY-004", "severity": "medium", "status": "resolved", "title": "Browser connector can navigate to arbitrary internal URLs and crawl off origin", "file": "packages/connectors-browser/src/browser-connector.ts" },
    { "id": "SECURITY-005", "severity": "medium", "status": "resolved", "title": "Non-API active routes sit outside the shared RBAC and rate-limit middleware", "file": "packages/server/src/composition/middleware.ts" },
    { "id": "SECURITY-006", "severity": "low", "status": "resolved", "title": "Request body size limits are late and inconsistent across JSON routes", "file": "packages/server/src/composition/middleware.ts" },
    { "id": "SECURITY-007", "severity": "low", "status": "resolved", "title": "Low-level WebSocket control helper defaults can allow unscoped subscriptions", "file": "packages/server/src/ws/control-protocol.ts" },
    { "id": "SECURITY-008", "severity": "low", "status": "resolved", "title": "Sandbox-enabled codegen can silently fall back to local execution", "file": "packages/codegen/src/workspace/workspace-factory.ts" },
    { "id": "SECURITY-009", "severity": "low", "status": "resolved", "title": "Marketplace tag filtering uses manual SQL literal construction", "file": "packages/server/src/marketplace/drizzle-catalog-store.ts" },
    { "id": "SECURITY-010", "severity": "low", "status": "resolved", "title": "Owner-scoped run listing leaks aggregate run counts inside a tenant", "file": "packages/server/src/routes/runs.ts" },
    { "id": "SECURITY-011", "severity": "low", "status": "resolved", "title": "Security-sensitive peer dependency ranges allow older consumer installs", "file": "packages/express/package.json" }
  ]
}
```

## Scope Reviewed

This review started from `context/repo-snapshot.md` in the prepared audit pack, then selectively inspected current source and configuration files in the DzupAgent repository. The review focused on the requested security domain: authentication, authorization, tenant and owner boundaries, secret handling, unsafe input paths, MCP and tool execution paths, outbound network sinks, browser and HTTP connectors, workspace command execution, SQL construction, WebSocket subscriptions, and dependency-risk controls.

Reviewed source areas included:

- Server composition and middleware: `packages/server/src/app.ts`, `packages/server/src/composition/*`, `packages/server/src/middleware/*`.
- Auth and tenant-sensitive routes: `packages/server/src/routes/api-keys.ts`, `packages/server/src/routes/runs.ts`, `packages/server/src/routes/a2a/*`, OpenAI compatibility routes, metrics, MCP, marketplace, and route-plugin mounting.
- Runtime guardrails and tool resolution: `packages/server/src/runtime/*`, `packages/server/src/security/*`, `packages/core/src/security/outbound-url-policy.ts`, and `packages/core/src/mcp/mcp-client.ts`.
- Connector and execution packages: `packages/connectors/src/http/http-connector.ts`, `packages/connectors-browser/src/*`, and `packages/codegen/src/workspace/*`.
- Dependency and CI metadata: root security workflow and selected package manifests.

Generated artifacts, dependency directories, distribution output, and old audit artifacts were not scanned. No runtime validation, dependency audit, fuzzing, or exploit proof-of-concept execution was run for this step.

## Strengths

- Production framework `/api/*` routes require explicit auth configuration, and wildcard CORS is blocked in production unless explicitly opted in (`packages/server/src/composition/middleware.ts:43`, `packages/server/src/composition/middleware.ts:92`).
- API-key storage uses high-entropy raw keys and stores only SHA-256 hashes; raw key material is only returned at creation or rotation time (`packages/server/src/persistence/api-key-store.ts`).
- RBAC is deny-by-default for unmatched `/api/*` paths in the current middleware and includes admin-only path families for high-risk management routes (`packages/server/src/middleware/rbac.ts`).
- Run and A2A records carry owner or tenant scope, and the main run and A2A task read paths apply owner or tenant filters before returning row data.
- MCP server registration has strong controls: stdio executables require an allowlist, MCP response serialization redacts env and sensitive headers, and HTTP/SSE MCP endpoints use the shared outbound URL policy (`packages/server/src/routes/mcp.ts`, `packages/server/src/security/mcp-url-policy.ts`).
- The shared outbound URL policy blocks loopback, private, link-local, and metadata ranges by default and revalidates redirect locations for policy-wrapped fetches (`packages/core/src/security/outbound-url-policy.ts`).
- The core MCP client uses the outbound URL policy for HTTP transports and validates stdio executable paths before spawning child processes (`packages/core/src/mcp/mcp-client.ts`).
- WebSocket upgrade handling has secure defaults when the higher-level helper is used: it rejects upgrades without an explicit guard and includes scoped subscription authorization helpers (`packages/server/src/ws/node-upgrade-handler.ts`, `packages/server/src/ws/authorization.ts`).
- Codegen workspace file operations include root-containment checks and avoid shell interpolation for `LocalWorkspace.runCommand` by using `execFile` (`packages/codegen/src/workspace/local-workspace.ts`).
- CI includes a blocking dependency audit, gitleaks scan, lint, and grep-based SAST patterns for dangerous JavaScript constructs (`.github/workflows/security.yml`).

## Open Questions Or Assumptions

- The audit assumes A2A, OpenAI compatibility, browser connectors, HTTP connectors, and codegen workspaces may be enabled by consuming applications; risk is lower for deployments that do not expose those optional surfaces.
- The audit did not verify deployed reverse-proxy limits, WAF rules, network egress policies, container isolation, or cloud metadata protections. Those controls can reduce exploitability but should not be required for framework safety.
- Dependency risk was reviewed from manifests and CI configuration only. No `yarn audit`, SCA scan, or lockfile vulnerability validation was executed in this step.
- Route-plugin risks were reviewed as an extension boundary. Host-supplied plugins can intentionally mount protected or public routes, so the main security question is whether the framework defaults make accidental bypasses obvious.

## Recommended Next Actions

1. Fix `SECURITY-001` first by centralizing all server-side outbound URL sinks, including A2A push callbacks, on the shared outbound URL policy.
2. Move run input guard scanning, redaction, and serialized-size enforcement into the HTTP create-run boundary before persistence and response generation.
3. Apply request-time URL policy enforcement to HTTP connector fetches and browser navigations, including redirect revalidation and same-origin crawl defaults.
4. Extend production controls for active non-`/api` surfaces by adding rate limits and capability checks to `/a2a/*` and `/v1/*`.
5. Add a global body-size guard before JSON parsing, then add targeted serialized-field limits for high-risk payloads.
6. Fail closed on sandbox misconfiguration and tighten low-level WebSocket subscription defaults.
7. Replace the marketplace raw SQL array literal with parameterized query construction.
8. Add focused regression tests for each fixed finding, then run package-scoped checks first and `yarn verify` before closing the full audit remediation lane.
