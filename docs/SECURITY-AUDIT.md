# Security Audit

## Findings

### SEC-01 High: API key revoke and rotate endpoints are not owner-scoped

**Impact:** Any authenticated caller that can reach `/api/keys` and knows or obtains another key UUID can revoke that key or rotate it and receive a newly issued raw key for the victim owner. The route also bypasses the generic RBAC map because `/api/keys` is not mapped to a protected resource.

**Evidence:** `createApiKeyRoutes` resolves owner identity for create/list, but delete and rotate fetch by raw `id` and mutate without comparing `existing.ownerId` to `resolveOwnerId(c)`: [packages/server/src/routes/api-keys.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/api-keys.ts:168), [packages/server/src/routes/api-keys.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/api-keys.ts:182). The underlying store `get(id)` and `revoke(id)` are also unscoped by owner: [packages/server/src/persistence/api-key-store.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/persistence/api-key-store.ts:171), [packages/server/src/persistence/api-key-store.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/persistence/api-key-store.ts:199). RBAC only maps `agents`, `runs`, `tools`, and approval paths, so `/api/keys` falls through: [packages/server/src/middleware/rbac.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/middleware/rbac.ts:100), [packages/server/src/middleware/rbac.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/middleware/rbac.ts:172).

**Remediation:** Scope `get`, `revoke`, and rotate operations by resolved owner and tenant, returning 404 on mismatch. Add a `keys` RBAC resource or explicit admin/self-only route guard. Add denial tests for cross-owner revoke and rotate, including the raw-key return path.

### SEC-02 High: Run context and trace routes bypass run owner and tenant checks

**Impact:** A caller with a valid API key can read another tenant's run context or full trace if they know a run ID. Trace and context payloads can contain prompts, tool arguments, model messages, logs, and token lifecycle details.

**Evidence:** The main run handlers centralize owner and tenant enforcement in `loadOwnedRun` and `enforceOwnerAccess`: [packages/server/src/routes/runs.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/runs.ts:82), [packages/server/src/routes/runs.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/runs.ts:125). The context route only checks that the run exists, then returns lifecycle data: [packages/server/src/routes/run-context.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/run-context.ts:168). The trace route follows the same existence-only pattern before returning steps: [packages/server/src/routes/run-trace.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/run-trace.ts:22). These routes are mounted separately after the scoped run routes: [packages/server/src/app.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/app.ts:713).

**Remediation:** Move run ownership and tenant enforcement into a shared exported helper or middleware and apply it to every `/api/runs/:id/*` route, not only handlers in `routes/runs.ts`. Add cross-tenant denial tests for `/context`, `/messages`, token-report routes, approval routes, and enrichment routes.

### SEC-03 High: MCP stdio executable allowlist is bypassable through PATCH

**Impact:** The POST route blocks unapproved stdio commands, but an authorized caller can create a non-stdio server and later PATCH it to `transport: "stdio"` with an arbitrary endpoint. Calling `/test` then passes the stored definition into `MCPClient`, which spawns `definition.endpoint`. If RBAC is disabled, misconfigured, or an admin key is compromised, this becomes host command execution through the MCP management plane.

**Evidence:** POST `/servers` enforces `mcpAllowedExecutables` only when the initial body has `transport === 'stdio'`: [packages/server/src/routes/mcp.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/mcp.ts:52). PATCH accepts unvalidated JSON and immediately calls `updateServer(id, patch)` with no repeated allowlist check: [packages/server/src/routes/mcp.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/mcp.ts:105). `testServer` maps the stored definition to `MCPClient.addServer`, including endpoint, args, env, and transport: [packages/core/src/mcp/mcp-manager.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/src/mcp/mcp-manager.ts:140). The client spawns `config.url` for stdio transports: [packages/core/src/mcp/mcp-client.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/src/mcp/mcp-client.ts:427).

**Remediation:** Validate PATCH payloads with a schema, compute the post-merge server definition, and enforce the same stdio allowlist on any transition into or within stdio transport. Consider rejecting changes to `transport` and `endpoint` unless performed through a dedicated admin operation with audit logging.

### SEC-04 High: Memory browse/export/import trusts caller-supplied scope instead of authenticated tenant scope

**Impact:** Any authenticated caller that can reach memory routes can request arbitrary namespaces and scopes, including another tenant's scope if the backing memory service uses scope keys for isolation. Import routes can also write data into arbitrary scopes. This is a realistic cross-tenant data exposure or poisoning path in multi-tenant deployments.

**Evidence:** Memory browse reads `namespace` from the URL and `scope` from a JSON query parameter, then passes both directly to `memoryService.search` or `memoryService.get`: [packages/server/src/routes/memory-browse.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/memory-browse.ts:19), [packages/server/src/routes/memory-browse.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/memory-browse.ts:48). Memory export/import routes parse request bodies and pass namespace/scope into `arrowMemory.exportFrame` and `arrowMemory.importFrame` without deriving or enforcing authenticated tenant context: [packages/server/src/routes/memory.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/memory.ts:58), [packages/server/src/routes/memory.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/memory.ts:81). The app mounts these routes under `/api/memory` and `/api/memory-browse`: [packages/server/src/app.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/app.ts:746).

**Remediation:** Derive tenant scope from authenticated key metadata and merge it server-side into every memory route. Reject client-provided tenant keys that conflict with the authenticated tenant. Add tests proving a caller cannot browse, export, import, or run analytics against another tenant's namespace/scope.

### SEC-05 Medium: A2A task routes have authentication but no owner or tenant isolation

**Impact:** In deployments that use A2A with shared task storage, any valid A2A/API credential can list all tasks, fetch task details, or cancel another caller's task. Task metadata and input may contain sensitive prompts or operational context.

**Evidence:** A2A routes are protected by auth only when `effectiveAuth` exists: [packages/server/src/app.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/app.ts:793). The task routes then create, list, get, and cancel tasks without stamping or checking caller identity or tenant: [packages/server/src/routes/a2a/task-routes.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/a2a/task-routes.ts:33), [packages/server/src/routes/a2a/task-routes.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/a2a/task-routes.ts:54), [packages/server/src/routes/a2a/task-routes.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/a2a/task-routes.ts:66), [packages/server/src/routes/a2a/task-routes.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/a2a/task-routes.ts:77). JSON-RPC task methods dispatch to the same task handlers without a visible caller scope: [packages/server/src/routes/a2a/jsonrpc-route.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/a2a/jsonrpc-route.ts:29).

**Remediation:** Extend A2A task records with owner and tenant fields derived from auth metadata. Filter list/get/cancel by those fields and return 404 on mismatch. If A2A is intended to be single-tenant per server, document that explicitly and add a guard that rejects multi-tenant config without scoped storage.

### SEC-06 Medium: MCP management responses expose secret-bearing env and headers

**Impact:** MCP server definitions can include authorization headers and environment variables. Listing or fetching server definitions returns stored definitions as-is, so credentials can be exposed to admin UI logs, API clients, browser devtools, support bundles, or any caller who reaches the MCP management route.

**Evidence:** The request schema allows inline `env` and `headers`: [packages/server/src/routes/schemas.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/schemas.ts:66). `InMemoryMcpManager` stores and returns full definitions with object spreads and no redaction: [packages/core/src/mcp/mcp-manager.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/src/mcp/mcp-manager.ts:71), [packages/core/src/mcp/mcp-manager.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/src/mcp/mcp-manager.ts:177), [packages/core/src/mcp/mcp-manager.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/src/mcp/mcp-manager.ts:182). The route returns those definitions directly from list/get/update/create: [packages/server/src/routes/mcp.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/mcp.ts:45), [packages/server/src/routes/mcp.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/mcp.ts:92).

**Remediation:** Store secrets by reference where possible (`headerRef`, `envRef`) and redact inline `env` and sensitive headers on every response. Add a redaction serializer for MCP definitions and tests for create, list, get, patch, and test responses.

### SEC-07 Low: Dependency risk is not continuously proven by the repo-local audit gates

**Impact:** The repo depends on a broad security-sensitive surface: Hono/server routes, Express compatibility, Vite/playground tooling, Playwright/Puppeteer/browser automation, document parsers, database drivers, Docker integration, and optional RAG/vector dependencies. Without a captured advisory scan, dependency exposure remains an operational unknown.

**Evidence:** The root `package.json` only pins workspace-level dev tooling, while package manifests introduce the runtime dependency surface, including Hono, Express compatibility, browser automation, Qdrant, document parsing, and DuckDB: [packages/server/package.json](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/package.json:45), [packages/express/package.json](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/express/package.json:25), [packages/scraper/package.json](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/scraper/package.json:24), [packages/connectors-documents/package.json](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/connectors-documents/package.json:21), [packages/rag/package.json](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/rag/package.json:28). No runtime dependency advisory command was run or captured for this audit.

**Remediation:** Add a documented dependency audit gate for the monorepo, capture results in release evidence, and pin or constrain high-risk optional dependency ranges where consumers could otherwise resolve vulnerable versions.

## Scope Reviewed

- Server auth/authz: API key middleware, RBAC middleware, OpenAI-compatible auth, API key persistence and routes.
- Tenant boundaries: run creation/list/detail paths, run context and trace routes, memory routes, A2A task routes, RAG/Qdrant tenant filtering.
- Secrets: API key hashing, MCP env/header handling, notification env usage, committed `.env*` files.
- Unsafe input and execution paths: MCP stdio registration/testing, sandbox command execution, codegen file tools, Docker sandbox path handling.
- Dependency risk: root and package manifests plus lockfile presence. No advisory scan was run.

Baseline review was kept separate from implementation status. Prior audit artifacts and prep files were used only for workflow shape; findings above are from current repository code.

## Strengths

- API keys are generated with 32 random bytes, stored only as SHA-256 hashes, and raw keys are returned only at creation time.
- OpenAI-compatible `/v1/*` auth is secure by default: omitted auth config rejects requests unless `enabled: false` is explicit.
- Main `/api/runs` create/list/get/cancel paths already stamp owner and tenant metadata and enforce scoped reads for the handlers in `routes/runs.ts`.
- MCP stdio registration has a POST-time executable allowlist, and child-process environment overrides block dangerous variables such as `NODE_OPTIONS`, `LD_PRELOAD`, and `PATH`.
- Docker sandbox defaults are reasonably defensive for validation mode: no network, read-only container, no-new-privileges, memory/CPU limits, and path traversal checks for uploaded/downloaded files.
- Qdrant shared-collection retrieval appends a `tenantId` filter when a tenant is supplied or configured by default.
- No repo-local `.env` or `.env.*` files were found in the current checkout during this review.

## Open Questions Or Assumptions

- I did not run server tests, browser tests, or dependency advisory commands for this audit, so all findings are static code-review findings.
- It is unclear whether production hosts always configure `auth.mode = 'api-key'`, `apiKeyStore`, and default RBAC. If any production host sets `auth` absent or `rbac = false`, several route risks become materially higher.
- The intended tenancy model for memory services and A2A task stores is not fully documented in the reviewed code. Findings assume shared services may be used in multi-tenant deployments.
- Some protections may exist at an API gateway, reverse proxy, or deployment layer; they were not visible in repository code and were not treated as current-code mitigations.

## Recommended Next Actions

1. Fix `SEC-01` and add cross-owner API key revoke/rotate denial tests. This is the cleanest immediate privilege-boundary bug.
2. Create a shared run-scope guard and apply it to every `/api/runs/:id/*` route, then add cross-tenant tests for context, messages, token-report, approvals, and enrichment endpoints.
3. Close the MCP PATCH allowlist bypass and add MCP response redaction in the same package-scoped security pass.
4. Force authenticated tenant scope into memory and A2A routes or document and enforce single-tenant-only deployment constraints.
5. Add a repeatable dependency advisory gate and record its output separately from this static baseline audit.
