# Security Audit

## Findings

### SECURITY-001 - High - API key revoke/rotate endpoints are not owner-scoped

**Impact:** Any authenticated caller that can reach `/api/keys/:id` or `/api/keys/:id/rotate` can revoke or rotate another owner's API key if they know or guess the key record UUID. Rotation returns a fresh raw key for the victim owner, turning an authorization bug into credential takeover for that owner scope.

**Evidence:** `createApiKeyRoutes` resolves an owner only for create/list (`resolveOwnerId(c)` at `packages/server/src/routes/api-keys.ts:141` and `packages/server/src/routes/api-keys.ts:162`). The revoke path fetches by raw id and calls `store.revoke(id)` without comparing `existing.ownerId` to the requester (`packages/server/src/routes/api-keys.ts:168`). The rotate path does the same, then creates and returns a replacement raw key under `existing.ownerId` (`packages/server/src/routes/api-keys.ts:182`, `packages/server/src/routes/api-keys.ts:206`).

**Remediation:** Enforce ownership or an explicit admin role before revoke/rotate. For non-admin callers, require `existing.ownerId === resolveOwnerId(c)` and return 404 on mismatch. Add tests for cross-owner revoke and rotate attempts.

### SECURITY-002 - High - Global RBAC allows many management routes to bypass authorization

**Impact:** When API-key auth is enabled, roles such as `viewer`, `agent`, or `operator` can still reach state-changing management routes whose path segment is not mapped by `pathToResource`. This includes API-key management, registry mutation, triggers, schedules, prompts/personas/presets/marketplace/reflections, deploy/eval/benchmark surfaces, and mailbox operations depending on configured integrations.

**Evidence:** The RBAC middleware only maps `agents`, `runs`, `tools`, `approve`, and `reject` to resources (`packages/server/src/middleware/rbac.ts:100`). If the path is not recognized, it calls `next()` (`packages/server/src/middleware/rbac.ts:172`). Core and optional route mounting exposes many more `/api/*` route groups (`packages/server/src/composition/core-routes.ts:31`, `packages/server/src/composition/optional-routes.ts:177`, `packages/server/src/composition/optional-routes.ts:189`). Schedules can create/update/delete/trigger workflows (`packages/server/src/routes/schedules.ts:19`, `packages/server/src/routes/schedules.ts:74`, `packages/server/src/routes/schedules.ts:91`, `packages/server/src/routes/schedules.ts:100`), and triggers can store webhook secrets and toggle execution (`packages/server/src/routes/triggers.ts:15`, `packages/server/src/routes/triggers.ts:85`).

**Remediation:** Make RBAC deny-by-default for unknown `/api/*` route groups, then explicitly map every mounted route group to a resource/action. Add route-level guards for high-risk groups such as `/api/keys`, `/api/registry`, `/api/triggers`, `/api/schedules`, `/api/deploy`, `/api/evals`, `/api/benchmarks`, `/api/prompts`, `/api/personas`, and `/api/marketplace`.

### SECURITY-003 - High - Metadata-controlled HTTP connector base URLs can target internal services

**Impact:** A caller that can create a run with HTTP connector tools and metadata can make the server process send arbitrary HTTP requests to a metadata-controlled base origin. The connector blocks path-level origin escape after the base URL is chosen, but it does not prove the base origin is safe. In cloud or internal deployments this can reach localhost, private networks, or metadata endpoints.

**Evidence:** Tool resolution reads `context.metadata.httpBaseUrl` before falling back to `DZIP_HTTP_BASE_URL` (`packages/server/src/runtime/tool-resolver.ts:642`) and passes that value directly to `createHTTPConnector` with optional `metadata.httpHeaders` (`packages/server/src/runtime/tool-resolver.ts:648`, `packages/server/src/runtime/tool-resolver.ts:656`). The connector constructs `new URL(config.baseUrl)` and only checks that each request path stays on the configured origin (`packages/connectors/src/http/http-connector.ts:40`, `packages/connectors/src/http/http-connector.ts:43`). It does not reject private, loopback, link-local, non-HTTPS, or DNS-rebound destinations.

**Remediation:** Do not accept `metadata.httpBaseUrl` from untrusted runs by default. Resolve HTTP connector targets from server-side named profiles or allowlists, validate the selected origin with shared SSRF controls, and require explicit opt-in for internal hosts. Treat metadata-provided headers as secrets and limit them to approved profiles.

### SECURITY-004 - High - Metadata-controlled Git cwd can expose or mutate arbitrary repositories

**Impact:** A caller that can request git tools and set run metadata can point the Git executor at an arbitrary filesystem path accessible to the server process. Git tools can read status/diff/logs and, for `git_commit`, stage and commit changes. In shared runners this can disclose or mutate repositories outside the intended workspace.

**Evidence:** Tool resolution uses `context.metadata.cwd` as the Git executor cwd when present (`packages/server/src/runtime/tool-resolver.ts:555`) and constructs `new GitExecutor({ cwd })` (`packages/server/src/runtime/tool-resolver.ts:558`). `GitExecutor` resolves that cwd with no workspace allowlist or root containment check (`packages/codegen/src/git/git-executor.ts:53`). The git commit tool can call `executor.addAll()` and `executor.commit(message)` (`packages/codegen/src/git/git-tools.ts:114`, `packages/codegen/src/git/git-tools.ts:130`).

**Remediation:** Remove untrusted metadata control over Git cwd, or restrict it to a server-side workspace registry. Enforce a root allowlist before constructing `GitExecutor`, reject absolute paths outside the selected workspace, and require additional approval for mutating git tools.

### SECURITY-005 - High - LocalWorkspace permits absolute paths and traversal outside the workspace root

**Impact:** Any agent/tool flow using `LocalWorkspace` directly can read or write arbitrary host files if a tool call supplies an absolute path or `../` traversal. This undermines the expected project-root boundary for codegen tools and can expose secrets or overwrite files outside the intended checkout.

**Evidence:** `resolvePath` returns absolute paths unchanged and otherwise resolves relative paths against `rootDir` (`packages/codegen/src/workspace/local-workspace.ts:106`). `readFile` and `writeFile` call `resolvePath` without checking that the resolved path stays under `rootDir` (`packages/codegen/src/workspace/local-workspace.ts:113`, `packages/codegen/src/workspace/local-workspace.ts:117`). Codegen tools pass model-supplied `filePath` through workspace read/write APIs (`packages/codegen/src/tools/write-file.tool.ts:18`, `packages/codegen/src/tools/edit-file.tool.ts:57`).

**Remediation:** Replace `resolvePath` with a safe resolver that rejects absolute paths and any resolved path outside `rootDir` using `relative(rootDir, resolved)` checks. Apply the same guard to `cwd` in `runCommand`. Add path traversal tests for read, write, exists, search glob, and command cwd.

### SECURITY-006 - Medium - Memory analytics routes ignore authoritative tenant scope

**Impact:** An authenticated user can query memory analytics for another tenant/owner scope by passing a crafted `scope` query parameter, even though export/import/browse routes force authenticated scope. Depending on the backing memory service, this can leak aggregate statistics and sampled memory-derived data from other scopes.

**Evidence:** `createMemoryRoutes` applies `applyAuthoritativeScope` for `/export` and `/import` (`packages/server/src/routes/memory.ts:82`, `packages/server/src/routes/memory.ts:107`). The analytics helper `getMemoryTableFromQuery` separately parses caller-supplied `scope` JSON and passes it directly into `arrowMemory.exportFrame(namespace, scope, { limit: 10_000 })` (`packages/server/src/routes/memory.ts:127`, `packages/server/src/routes/memory.ts:143`). The tenant-scope helper comment says memory browse, export, import, and analytics routes must not trust caller-supplied scope (`packages/server/src/routes/memory-tenant-scope.ts:4`).

**Remediation:** Route all analytics scope construction through `applyAuthoritativeScope(c, parsedScope, tenantScope)`. Add cross-tenant tests for every `/api/memory/analytics/*` endpoint.

### SECURITY-007 - Medium - Outbound URL fetch surfaces lack shared SSRF controls

**Impact:** Several reusable framework surfaces fetch operator- or agent-supplied URLs without blocking loopback, private networks, link-local metadata endpoints, DNS rebinding targets, or non-public redirects. In cloud or internal deployments this can be abused for SSRF against metadata services, internal admin panels, and private APIs.

**Evidence:** MCP HTTP transport calls `fetch(`${config.url}/tools/list`)` and `fetch(`${config.url}/tools/call`)` with no destination validation (`packages/core/src/mcp/mcp-client.ts:279`, `packages/core/src/mcp/mcp-client.ts:379`). The scraper tool accepts arbitrary `url` input and passes it to HTTP/browser fetchers (`packages/scraper/src/scraper.ts:114`, `packages/scraper/src/scraper.ts:142`); `HttpFetcher` follows redirects and fetches target pages and `robots.txt` without private-network checks (`packages/scraper/src/http-fetcher.ts:113`, `packages/scraper/src/http-fetcher.ts:197`). Server notification channels post to configured webhook URLs directly (`packages/server/src/notifications/channels/webhook-channel.ts:36`, `packages/server/src/notifications/channels/email-webhook-channel.ts:45`). A URL validator exists in `agent-adapters`, but these server/MCP/scraper paths do not use it (`packages/agent-adapters/src/utils/url-validator.ts:102`).

**Remediation:** Move URL validation into a shared package and enforce it on all outbound URL-bearing features. Require `https` by default, reject loopback/private/link-local hosts, re-check every redirect hop, resolve DNS and block private resolved IPs, and provide explicit allowlist overrides for trusted internal deployments.

### SECURITY-008 - Medium - Framework app defaults to unauthenticated `/api/*` unless host config opts in

**Impact:** A host that instantiates `createForgeApp` without `config.auth` exposes all mounted `/api/*` routes without authentication. Because many dangerous integrations are mounted only when configured, this is most harmful in partially configured deployments where developers add stores/managers but omit auth.

**Evidence:** `applyAuthAndRbac` returns without mounting auth or RBAC if `!config.auth` (`packages/server/src/composition/middleware.ts:59`). The app then mounts run, agent, registry, API-key, memory, event, deploy, learning, eval, trigger, schedule, prompt, persona, mailbox, and other optional routes based on the rest of the config (`packages/server/src/composition/core-routes.ts:23`, `packages/server/src/composition/optional-routes.ts:66`). In contrast, OpenAI `/v1/*` auth fails closed when no validator is configured (`packages/server/src/routes/openai-compat/auth-middleware.ts:101`).

**Remediation:** Introduce a production fail-closed mode for `/api/*`, or require an explicit `auth: { mode: 'none' }` opt-out with a startup warning/error when high-risk route groups are enabled. Document dev-only unauthenticated mode separately from production configuration.

### SECURITY-009 - Medium - CORS is globally wildcard by default

**Impact:** Any browser origin can call the framework API by default. This is less severe for bearer-token APIs than cookie-authenticated apps, but it increases exposure for browser-held tokens, local development servers, and any future credentialed browser auth mode.

**Evidence:** `applyCors` mounts CORS for all routes with `origin: config.corsOrigins ?? '*'` and allows `Authorization` headers (`packages/server/src/composition/middleware.ts:41`). The code only warns when open CORS is used, preserving the permissive default (`packages/server/src/composition/middleware.ts:48`).

**Remediation:** Default CORS to disabled or an explicit allowlist in production. If backward compatibility requires wildcard, gate it behind `allowWildcardCors: true` or a dev-mode flag and add tests that credentialed origins are not reflected broadly.

### SECURITY-010 - Medium - Public `/metrics` route bypasses app auth

**Impact:** Prometheus metrics can expose operational metadata such as route usage, error volumes, run activity, and potentially tenant/activity labels. If the Hono app is internet-facing and ingress does not block `/metrics`, unauthenticated users can scrape this data.

**Evidence:** `mountPrometheusMetricsRoute` mounts `/metrics` outside the `/api/*` auth middleware path when the configured collector is Prometheus (`packages/server/src/composition/optional-routes.ts:279`). The code comment acknowledges that the route is currently public and expects operators to block it at ingress (`packages/server/src/composition/optional-routes.ts:280`).

**Remediation:** Add framework-level protection for `/metrics`: bind on an internal listener, require a metrics token, or accept an explicit IP allowlist/middleware guard. Keep ingress blocking as defense in depth, not the only control.

### SECURITY-011 - Medium - MCP HTTP/SSE endpoint registration has no private-network validation

**Impact:** An authorized MCP administrator can register HTTP/SSE endpoints that target localhost, private networks, or link-local metadata services. This is a narrower SSRF case than the systemic outbound URL issue because MCP registration is admin-only by default, but MCP connectivity tests and tool calls can still reach internal services from the server process.

**Evidence:** The MCP route validates stdio executable allowlists, but not HTTP/SSE endpoint URLs before `mcpManager.addServer(body)` (`packages/server/src/routes/mcp.ts:107`, `packages/server/src/routes/mcp.ts:126`). The MCP client then calls `fetch` against `config.url` for discovery and calls (`packages/core/src/mcp/mcp-client.ts:279`, `packages/core/src/mcp/mcp-client.ts:379`). Metadata-defined MCP servers do validate HTTP/SSE scheme and can enforce `DZIP_MCP_ALLOWED_HTTP_HOSTS`, but the configured-server route does not require equivalent host policy (`packages/server/src/runtime/tool-resolver.ts:304`, `packages/server/src/runtime/tool-resolver.ts:311`).

**Remediation:** Validate MCP endpoint URLs at registration, patch time, metadata extraction, and connection time. Require `http`/`https`, reject private/loopback/link-local destinations unless explicitly allowlisted, and revalidate persisted definitions to catch DNS changes.

### SECURITY-012 - Medium - Tool credentials can be stored in run metadata

**Impact:** Callers can place connector credentials and MCP secrets into run metadata that is persisted with the run. If run metadata is visible through API responses, logs, traces, exports, or database reads, those secrets can leak beyond the intended tool invocation boundary.

**Evidence:** Tool resolution accepts `metadata.githubToken`, `metadata.slackToken`, `metadata.httpHeaders`, and metadata-defined MCP `env`/`headers` (`packages/server/src/runtime/tool-resolver.ts:592`, `packages/server/src/runtime/tool-resolver.ts:617`, `packages/server/src/runtime/tool-resolver.ts:648`, `packages/server/src/runtime/tool-resolver.ts:342`). Run creation stores `metadata: tracedMetadata` directly in the run store (`packages/server/src/routes/runs.ts:273`, `packages/server/src/routes/runs.ts:276`). MCP management responses redact server config secrets, but that redaction does not cover generic run metadata storage (`packages/server/src/routes/mcp.ts:49`).

**Remediation:** Remove token/header inputs from persisted metadata. Accept credentials only through server-side secret references or scoped profiles, redact known secret fields before persistence, and add tests that run creation/list/read responses cannot return connector tokens or MCP env/header values.

### SECURITY-013 - Low - WebSocket upgrade helper allows requests by default if host omits a guard

**Impact:** A host that uses `createNodeWsUpgradeHandler` without `shouldHandleRequest` accepts any HTTP upgrade request for the bound server. The session manager starts with a deny-all event subscription, but an unauthenticated socket can still connect and exercise control-message parsing and connection resources.

**Evidence:** `createNodeWsUpgradeHandler` sets `allowed` to `true` when `options.shouldHandleRequest` is not provided (`packages/server/src/ws/node-upgrade-handler.ts:55`). The safer scoped authorization exists for subscription filters (`packages/server/src/ws/authorization.ts:57`) and `WSSessionManager.attach` starts with `eventTypes: []` (`packages/server/src/ws/session-manager.ts:30`), but the upgrade itself is not fail-closed.

**Remediation:** Require an explicit upgrade guard or scope resolver for production helpers, or provide a secure factory that rejects by default. Add documentation and tests showing unauthenticated upgrades are dev-only.

### SECURITY-014 - Low - Security headers are not set by the server composition layer

**Impact:** If the Hono server directly serves browser-accessible routes such as playground or management surfaces, missing headers reduce defense in depth against clickjacking, MIME sniffing, and referrer leakage. The current reviewed code is mostly JSON APIs, so this is not as severe as it would be for a template-rendering app.

**Evidence:** Middleware composition mounts CORS, auth/RBAC, rate limiting, metrics, and error handling (`packages/server/src/composition/middleware.ts:30`), but no security header middleware or equivalent response headers are applied. Optional playground and OpenAI-compatible routes can be mounted on the same app (`packages/server/src/composition/optional-routes.ts:133`, `packages/server/src/composition/optional-routes.ts:259`).

**Remediation:** Add a small Hono security-header middleware for production deployments: `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options` or CSP `frame-ancestors`, and a CSP for any HTML-rendering route. Keep route-specific overrides for developer playgrounds.

### SECURITY-015 - Low - OpenAI-compatible auth accepts only exact-case `Bearer`

**Impact:** Some standards-compliant clients sending `authorization: bearer <token>` may fail auth. This is primarily interoperability rather than a direct vulnerability, but brittle auth parsing can lead operators to disable auth during integration testing.

**Evidence:** `openaiAuthMiddleware` extracts a token only when `authHeader.startsWith('Bearer ')` is true (`packages/server/src/routes/openai-compat/auth-middleware.ts:72`). The `/api/*` rate limiter uses a case-insensitive Bearer regex (`packages/server/src/middleware/rate-limiter.ts:62`), so parsing behavior is inconsistent.

**Remediation:** Use a shared, case-insensitive bearer-token parser for `/api/*`, `/v1/*`, rate limiting, WebSocket auth adapters, and tests.

### SECURITY-016 - Low - API-key creation accepts unbounded names and `expiresIn` values

**Impact:** Authenticated callers can store very large key names or nonsensical expiry values. This can bloat storage, make audit views noisy, or create effectively non-expiring keys if store behavior treats invalid values loosely.

**Evidence:** `POST /api/keys` only checks that `body.name` is a string, with no length or character constraints (`packages/server/src/routes/api-keys.ts:120`). `expiresIn` is accepted when it is any number and passed to the store (`packages/server/src/routes/api-keys.ts:143`). Rotate repeats the loose `expiresIn` handling (`packages/server/src/routes/api-keys.ts:198`).

**Remediation:** Validate request bodies with a schema. Bound `name` length, trim whitespace, reject control characters, require `expiresIn` to be a positive finite integer within a configured maximum, and add tests for invalid values.

### SECURITY-017 - Info - Dependency audit is available but was not run in this audit

**Impact:** Current transitive dependency vulnerabilities cannot be claimed from this review. The repo has a lockfile and audit scripts, but there is no captured current `yarn audit` output in this step.

**Evidence:** Root scripts include `audit:deps` and `audit:deps:summary` (`package.json:52`). The snapshot confirms the workspace uses Yarn 1 and has a lockfile. This audit did not execute `yarn audit` because the task requested current-code review and no runtime validation should be claimed unless captured.

**Remediation:** Run `yarn audit --summary` and triage production-impacting advisories separately from dev-tool noise. Prioritize network parsers, HTTP clients, auth/session libraries, database drivers, browser automation, and server frameworks.

### SECURITY-018 - Info - Test fixtures intentionally contain fake secret patterns

**Impact:** Naive secret scanners will report many test-only tokens. This is not evidence of leaked real secrets, but it can hide true positives if CI does not distinguish fixtures from production source.

**Evidence:** Pattern search found hardcoded token-like strings primarily under `packages/**/__tests__`, such as Slack/GitHub/API-key fixtures. Production code instead reads provider keys from config or env, and MCP HTTP responses redact configured env/headers (`packages/server/src/routes/mcp.ts:49`).

**Remediation:** Keep fixture secret patterns clearly fake and allowlisted in scanner config. Run secret scanning over source and tests, but report fixture hits separately so real source leaks remain high signal.

## Finding Manifest

```json
{
  "domain": "security",
  "counts": { "critical": 0, "high": 5, "medium": 7, "low": 4, "info": 2 },
  "findings": [
    { "id": "SECURITY-001", "severity": "high", "title": "API key revoke/rotate endpoints are not owner-scoped", "file": "packages/server/src/routes/api-keys.ts" },
    { "id": "SECURITY-002", "severity": "high", "title": "Global RBAC allows many management routes to bypass authorization", "file": "packages/server/src/middleware/rbac.ts" },
    { "id": "SECURITY-003", "severity": "high", "title": "Metadata-controlled HTTP connector base URLs can target internal services", "file": "packages/server/src/runtime/tool-resolver.ts" },
    { "id": "SECURITY-004", "severity": "high", "title": "Metadata-controlled Git cwd can expose or mutate arbitrary repositories", "file": "packages/server/src/runtime/tool-resolver.ts" },
    { "id": "SECURITY-005", "severity": "high", "title": "LocalWorkspace permits absolute paths and traversal outside the workspace root", "file": "packages/codegen/src/workspace/local-workspace.ts" },
    { "id": "SECURITY-006", "severity": "medium", "title": "Memory analytics routes ignore authoritative tenant scope", "file": "packages/server/src/routes/memory.ts" },
    { "id": "SECURITY-007", "severity": "medium", "title": "Outbound URL fetch surfaces lack shared SSRF controls", "file": "packages/scraper/src/http-fetcher.ts" },
    { "id": "SECURITY-008", "severity": "medium", "title": "Framework app defaults to unauthenticated /api/* unless host config opts in", "file": "packages/server/src/composition/middleware.ts" },
    { "id": "SECURITY-009", "severity": "medium", "title": "CORS is globally wildcard by default", "file": "packages/server/src/composition/middleware.ts" },
    { "id": "SECURITY-010", "severity": "medium", "title": "Public /metrics route bypasses app auth", "file": "packages/server/src/composition/optional-routes.ts" },
    { "id": "SECURITY-011", "severity": "medium", "title": "MCP HTTP/SSE endpoint registration has no private-network validation", "file": "packages/server/src/routes/mcp.ts" },
    { "id": "SECURITY-012", "severity": "medium", "title": "Tool credentials can be stored in run metadata", "file": "packages/server/src/runtime/tool-resolver.ts" },
    { "id": "SECURITY-013", "severity": "low", "title": "WebSocket upgrade helper allows requests by default if host omits a guard", "file": "packages/server/src/ws/node-upgrade-handler.ts" },
    { "id": "SECURITY-014", "severity": "low", "title": "Security headers are not set by the server composition layer", "file": "packages/server/src/composition/middleware.ts" },
    { "id": "SECURITY-015", "severity": "low", "title": "OpenAI-compatible auth accepts only exact-case Bearer", "file": "packages/server/src/routes/openai-compat/auth-middleware.ts" },
    { "id": "SECURITY-016", "severity": "low", "title": "API-key creation accepts unbounded names and expiresIn values", "file": "packages/server/src/routes/api-keys.ts" },
    { "id": "SECURITY-017", "severity": "info", "title": "Dependency audit is available but was not run in this audit", "file": "package.json" },
    { "id": "SECURITY-018", "severity": "info", "title": "Test fixtures intentionally contain fake secret patterns", "file": "packages" }
  ]
}
```

## Scope Reviewed

Current-code security review for the `dzupagent` workspace, based first on `context/repo-snapshot.md` from audit run `full-dzupagent-2026-04-28/run-001`, then selective source inspection. Reviewed areas included:

- Server transport/auth surfaces: Hono app composition, `/api/*` auth/RBAC/rate limiting, OpenAI-compatible `/v1/*` auth, API-key management, run routes, memory routes, MCP routes, WebSocket helpers, metrics route, and notification channels.
- Tenant and authorization boundaries: run owner/tenant guards, memory tenant-scope helpers, registry/schedule/trigger/API-key routes, and WebSocket scoped subscription helpers.
- Unsafe input and execution paths: MCP HTTP/stdio transports, scraper fetchers, webhook delivery, runtime tool resolver metadata, HTTP/Git connector tools, codegen workspace/file tools, Docker sandbox execution, SQL tools/connectors, and local command wrappers.
- Secrets/dependency posture: package manifests, env-driven secret handling, MCP secret redaction, metadata credential handling, memory encryption key provider, secret scanner/rules, and audit scripts.

Generated output, dependency folders, and old audit artifacts were not used as evidence. No runtime validation commands were run for this audit.

## Strengths

- OpenAI-compatible `/v1/*` auth fails closed unless a validator is configured or auth is explicitly disabled; it no longer silently falls through when `validateKey` is absent (`packages/server/src/routes/openai-compat/auth-middleware.ts:53`).
- MCP stdio server registration is guarded by an explicit executable allowlist in both create and patch flows (`packages/server/src/routes/mcp.ts:110`, `packages/server/src/routes/mcp.ts:171`).
- Metadata-defined MCP servers reject non-HTTP/SSE schemes by default and can be constrained to `DZIP_MCP_ALLOWED_HTTP_HOSTS`; metadata-defined stdio requires explicit `DZIP_MCP_ALLOW_METADATA_STDIO` (`packages/server/src/runtime/tool-resolver.ts:226`, `packages/server/src/runtime/tool-resolver.ts:290`, `packages/server/src/runtime/tool-resolver.ts:304`).
- MCP management responses redact inline `env` values and sensitive headers before returning server definitions (`packages/server/src/routes/mcp.ts:49`).
- Run read/write subroutes use owner and tenant scoping helpers that deliberately return 404 for foreign runs, reducing cross-tenant enumeration (`packages/server/src/routes/runs.ts:82`, `packages/server/src/routes/run-guard.ts:99`).
- Memory export/import/browse routes have an authoritative scope helper that forces tenant/owner scope from authenticated API-key metadata where wired (`packages/server/src/routes/memory-tenant-scope.ts:66`).
- SQL query tooling uses AST parsing to reject non-`SELECT` statements and the PostgreSQL connector sets read-only transactions for pooled connections (`packages/connectors/src/sql/sql-tools.ts:127`, `packages/connectors/src/sql/adapters/postgresql.ts:76`).
- Docker sandbox default mode disables network, mounts the work dir read-only, sets a read-only filesystem, and uses memory/CPU limits (`packages/codegen/src/sandbox/docker-sandbox.ts:296`).
- The repo has dedicated security primitives and tests for injection, escalation, secret detection, tool governance, MCP security, and tenant-scoped memory.

## Open Questions Or Assumptions

- I assumed public API exposure is possible for `@dzupagent/server`; if every deployment sits behind an authenticated gateway, findings around app-level auth/CORS/metrics become defense-in-depth rather than direct exposure.
- I assumed run metadata can be supplied by users or upstream products in at least some deployments. If a trusted orchestrator fully controls metadata, `SECURITY-003`, `SECURITY-004`, and `SECURITY-012` are still hardening issues but have lower direct exploitability.
- I did not verify database schema constraints for API-key ownership or expiry; findings are based on route-level authorization and validation behavior.
- I did not run dependency audit, tests, or runtime probes. No validation outcomes are claimed.
- Some endpoints are optional and only mounted when their corresponding stores/managers are configured. Findings note the risk when those integrations are enabled.
- Existing URL validation in `agent-adapters` does not appear to be reused by server/MCP/scraper surfaces; if a consuming app wraps these surfaces with its own validation, residual SSRF risk may be lower in that app.

## Recommended Next Actions

1. Fix `SECURITY-001` immediately: owner/admin guard for API-key revoke and rotate, plus focused cross-owner tests.
2. Fix `SECURITY-002` by converting RBAC to deny-by-default for unknown `/api/*` route groups and mapping every mounted management route.
3. Fix `SECURITY-003`, `SECURITY-004`, and `SECURITY-012` by replacing user-controlled tool metadata with server-side tool profiles for HTTP, Git, MCP, GitHub, and Slack connectors.
4. Fix `SECURITY-005` by enforcing root-contained paths in `LocalWorkspace` for read/write/exists/command cwd.
5. Patch memory analytics to use `applyAuthoritativeScope` and add cross-tenant route tests.
6. Create one shared outbound URL policy and wire it into MCP HTTP/SSE, scraper, webhook notification, approval, HTTP connector, and adapter callback surfaces.
7. Add production-hardening defaults: explicit auth opt-out, non-wildcard CORS, protected `/metrics`, and security headers.
8. Run dependency audit as a separate captured gate and triage only realistically reachable production advisories.
