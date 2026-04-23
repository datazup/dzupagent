# 04 Security Review

## Repository Overview
This review is a static security assessment of `dzupagent`, focused on the runtime and API surfaces most likely to carry security risk in real deployments:

- Primary code reviewed:
  - `packages/server` (app wiring, auth/routing, A2A, MCP, triggers, persistence)
  - `packages/core/src/mcp/*` (MCP client/manager security behavior)
  - `packages/connectors/src/http/http-connector.ts` (SSRF controls in connector layer)
  - `packages/create-dzupagent/src/templates/*` (secure-by-default scaffolding posture)
- Secondary artifacts referenced:
  - `out/workspace-repo-docs-static-portable-markdown/DZUPAGENT.md` (topology/orientation only)
  - `out/knowledge-index/gap-analysis-requirements.config-default.md` (not security-authoritative; used only as context)

The most security-critical attack surface is `createForgeApp` in `packages/server/src/app.ts`, where route mounts and middleware scope are defined.

## Trust Boundaries
- **Users/clients**: HTTP callers to `/api/*`, `/v1/*`, A2A endpoints (`/a2a/*`, `/.well-known/agent.json`), and optional `/metrics`.
- **Authenticated principals**: API key callers processed by `authMiddleware` and OpenAI-compatible Bearer callers processed by `openaiAuthMiddleware`.
- **Tenants**: Tenant and identity abstractions exist (`identity`, `tenant-scope`, `rbac`, `capability-guard`) but are not part of default app wiring.
- **Admins/operators**: Operational APIs (MCP management, deploy, schedules/triggers, marketplace/catalog mutations) currently share the same coarse API-key trust boundary as normal API traffic unless integrators add stricter controls.
- **External providers/webhooks**: Slack/email webhooks, MCP HTTP/SSE servers, optional A2A push notification URLs, and connector-driven outbound calls.
- **Background jobs/queues**: `RunQueue` workers trust queued `metadata` and execute model/tool paths based on it.
- **Storage**: Drizzle/Postgres persists runs, logs, traces, API keys (hashed), triggers, schedules, A2A tasks/messages/artifacts, marketplace/catalog records, and other operational metadata.
- **Internal services**: Event bus, reflector/evals, retrieval feedback, and optional incident-response webhook actions run with server-level trust and can produce side effects.

## Security Strengths
- **API keys are stored hashed, not plaintext**:
  - SHA-256 hashing and CSPRNG key generation in `packages/server/src/persistence/api-key-store.ts` (`hashApiKey`, `generateRawApiKey`, create/validate paths).
- **API-key auth fail-closed behavior exists for `/api/*` when mode is enabled but validator is missing**:
  - `packages/server/src/middleware/auth.ts` returns 503 on invalid auth config.
- **Rate limiting has spoofing-aware defaults**:
  - `trustForwardedFor` defaults to `false` in `packages/server/src/middleware/rate-limiter.ts`.
- **Static file serving path traversal guard exists for playground assets**:
  - `resolveWithinRoot` in `packages/server/src/routes/playground.ts` constrains resolved paths to dist root.
- **MCP stdio hardening primitives are present**:
  - Executable path validation + env sanitization in `packages/core/src/mcp/mcp-security.ts`.
- **CI includes baseline security gates**:
  - Dependency audit, gitleaks secret scan, and SAST checks in `.github/workflows/security.yml`.

## Findings

### High: A2A task-control endpoints bypass global API authentication
- **Impact**:
  - Unauthenticated attackers can submit/list/read/cancel/update A2A tasks when A2A is enabled.
  - This enables unauthorized workload creation, potential sensitive output exposure, and operational disruption.
- **Evidence**:
  - API auth is mounted only on `/api/*`: `packages/server/src/app.ts` (`app.use('/api/*', authMiddleware(...))`).
  - A2A routes are mounted at root: `packages/server/src/app.ts` (`app.route('', a2aRoutes)`).
  - A2A handlers themselves have no auth checks:
    - `packages/server/src/routes/a2a/task-routes.ts`
    - `packages/server/src/routes/a2a/jsonrpc-route.ts`
    - `packages/server/src/routes/a2a/message-routes.ts`
- **Attack path**:
  1. Send unauthenticated `POST /a2a/tasks` or `POST /a2a` to create work.
  2. Poll with `GET /a2a/tasks/:id` or enumerate via `GET /a2a/tasks`.
  3. Cancel or mutate via `POST /a2a/tasks/:id/cancel` or `/messages`.
- **Remediation**:
  - Mount auth middleware explicitly on `/a2a/*` (and JSON-RPC `/a2a`) when A2A is enabled.
  - Add per-task ownership/tenant checks (read/write/cancel/message/push config).
  - Keep only `/.well-known/agent.json` public if discovery is needed.

### High: OpenAI-compatible auth allows trivial token bypass in default validator-less mode
- **Impact**:
  - `/v1/*` accepts any non-empty Bearer token when `validateKey` is not set.
  - Unauthorized model usage and spend abuse become possible in misconfigured deployments.
- **Evidence**:
  - `/v1/*` auth middleware is always mounted: `packages/server/src/app.ts`.
  - Middleware explicitly documents and implements dev-mode pass-through for any non-empty token:
    - `packages/server/src/routes/openai-compat/auth-middleware.ts` (comments and `if (config?.validateKey) ...; return next()` behavior).
  - Tests assert this behavior:
    - `packages/server/src/routes/openai-compat/__tests__/routes.test.ts` (auth enabled + arbitrary Bearer token is accepted).
- **Attack path**:
  1. Send `Authorization: Bearer x` to `/v1/chat/completions`.
  2. Request is accepted if deployment enables auth but forgets `validateKey`.
- **Remediation**:
  - Change default behavior to fail closed unless `validateKey` exists.
  - Require explicit `enabled: false` for local dev bypass.
  - Add startup-time hard warning/error for validator-less `/v1/*` in non-dev environments.

### High: MCP management routes expose privileged operations and secret material to any API-key principal
- **Impact**:
  - Any authenticated API key can read MCP server definitions (including `env`/`headers`), mutate lifecycle state, and run `testServer`.
  - This can leak provider credentials and enable server-side network/process interaction via MCP transports.
- **Evidence**:
  - MCP routes mounted under `/api/mcp`: `packages/server/src/app.ts`.
  - Route handlers do not enforce admin-only checks: `packages/server/src/routes/mcp.ts`.
  - Server definitions include secret-capable fields: `packages/core/src/mcp/mcp-registry-types.ts` (`env`, `headers`).
  - `testServer` forwards definition to MCP client connect path:
    - `packages/core/src/mcp/mcp-manager.ts` (`addServer` + `connect` during test).
- **Attack path**:
  1. Authenticate with any valid API key.
  2. Call `GET /api/mcp/servers` to retrieve sensitive MCP config.
  3. Use `POST/PATCH /api/mcp/servers` and `/servers/:id/test` to probe or execute connectivity paths.
- **Remediation**:
  - Gate `/api/mcp/*` with explicit admin RBAC/capability guard.
  - Redact `env`, `headers`, and secret refs from API responses.
  - Restrict transport and endpoint policy for API-managed MCP entries (allowlist + no stdio from external control plane).

### Medium: API key revoke/rotate endpoints lack owner authorization checks (IDOR)
- **Impact**:
  - Any authenticated caller who knows another key ID can revoke/rotate that key.
  - This can disrupt other tenants/users and cause key takeover-like effects.
- **Evidence**:
  - Owner scoping is used for create/list via `resolveOwnerId`: `packages/server/src/routes/api-keys.ts`.
  - `DELETE /:id` and `POST /:id/rotate` only check existence/revocation state, not owner match:
    - same file, revoke/rotate handlers.
- **Attack path**:
  1. Obtain another key ID (logs, accidental exposure, API output leakage).
  2. Call revoke or rotate endpoint with attacker’s own valid API key.
  3. Victim key is invalidated/replaced.
- **Remediation**:
  - Enforce `existing.ownerId === resolveOwnerId(c)` before revoke/rotate.
  - Return 404 for cross-owner attempts to reduce enumeration signal.
  - Add regression tests for cross-owner denial.

### Medium: Trigger webhook secrets are stored plaintext and returned unredacted
- **Impact**:
  - Trigger shared secrets can be exposed to any caller with broad API access.
  - If used for webhook verification elsewhere, secret leakage can permit request forgery.
- **Evidence**:
  - `webhookSecret` persisted as plaintext text column:
    - `packages/server/src/persistence/drizzle-schema.ts` (`trigger_configs.webhook_secret`).
  - Trigger APIs return full trigger records directly:
    - `packages/server/src/routes/triggers.ts` (`c.json(trigger)` / `c.json({ triggers })`).
  - Store maps `webhookSecret` straight through:
    - `packages/server/src/triggers/trigger-store.ts`.
- **Attack path**:
  1. Authenticated caller requests trigger list/get.
  2. Secret values are returned in response payload.
- **Remediation**:
  - Redact `webhookSecret` from all API responses.
  - Encrypt at rest (KMS-managed key) or store only hash where possible.
  - Rotate existing secrets after patch rollout.

### Medium: A2A push-notification callback path is SSRF-like and can exfiltrate task payloads (conditional)
- **Impact**:
  - With `DrizzleA2ATaskStore`, terminal task updates trigger server-side `fetch` to user-provided URLs, forwarding task JSON and optional Bearer token.
  - Can be abused for internal network probing or data exfiltration if attacker can set push config.
- **Evidence**:
  - Push config URL accepted with minimal validation:
    - `packages/server/src/routes/a2a/jsonrpc-handlers.ts` (`tasks/pushNotification/set`).
  - Delivery performs outbound fetch to arbitrary URL, includes optional Authorization header and full task body:
    - `packages/server/src/a2a/drizzle-a2a-task-store.ts` (`deliverPushNotification`).
  - Push config persisted in DB:
    - `packages/server/src/persistence/drizzle-schema.ts` (`push_notification_config`).
- **Attack path**:
  1. Set push URL/token on task.
  2. On terminal state, server issues outbound POST to attacker-controlled or internal target.
  3. Receives serialized task payload and optional token.
- **Remediation**:
  - Enforce URL allowlist/blocklist and protocol restrictions for push callbacks.
  - Strip sensitive fields from callback body.
  - Reject localhost/link-local/private CIDRs unless explicitly allowed by policy.
  - Treat this as high severity when combined with Finding 1 (unauth A2A).

## Sensitive Data And Secrets Review
- **API keys**:
  - Strong handling: raw key shown once, only hash persisted (`api-key-store.ts`).
- **MCP credentials**:
  - `env`/`headers` can contain secrets and are exposed by MCP management API responses (`mcp.ts`, `mcp-registry-types.ts`).
- **Trigger secrets**:
  - `webhookSecret` persisted plaintext and returned in trigger payloads (`drizzle-schema.ts`, `trigger-store.ts`, `triggers.ts`).
- **A2A push tokens**:
  - Stored in `pushNotificationConfig` and used in outbound Authorization headers (`drizzle-a2a-task-store.ts`).
- **Run/session data**:
  - Run input/output/metadata/logs/traces can include user prompts, tool results, internal routing metadata, and potentially sensitive context (`runs.ts`, `postgres-stores.ts`).
- **Error/logging exposure**:
  - Global handler logs request method/path plus raw error message (`app.ts`), increasing chance of sensitive operational details landing in logs.
- **Cookies/sessions**:
  - No major cookie/session auth plane observed in reviewed server path; Bearer/API-key token model dominates.
- **At-rest encryption**:
  - No application-layer encryption found for trigger secrets, MCP secret fields, or generic run metadata payloads before persistence.

## Authorization And Isolation Review
- **Authn layering**:
  - `/api/*` can be protected by API key middleware if configured.
  - `/v1/*` uses separate middleware with permissive validator-less behavior.
  - A2A root endpoints are outside `/api/*` auth scope.
- **Authz granularity**:
  - Default wiring is coarse: authenticated caller can access broad operational routes.
  - Ownership checks are inconsistent (present for API key list/create, missing for revoke/rotate).
- **Tenant isolation**:
  - Tenant/identity/RBAC/capability middleware exists but is not mounted by default in `createForgeApp`.
  - Resource routes generally lack explicit tenant-scoped filtering at handler layer.
- **Admin/control plane separation**:
  - High-impact control routes (`/api/mcp`, trigger/schedule/deploy management) are not separated from regular API user role by default.
- **Public sharing surfaces**:
  - `/.well-known/agent.json` is intentionally public.
  - `/metrics` is mounted outside `/api/*` auth scope when Prometheus collector is enabled.
  - A2A control surfaces become public in current mount pattern.

## Residual Risks
- **Secure-by-default drift in scaffolding**:
  - `create-dzupagent` templates include insecure or inconsistent auth defaults (for example, `full-stack` template sets `auth: { mode: 'none' }`; other templates reference unsupported auth mode strings), increasing deployment misconfiguration risk.
- **Coarse API key model**:
  - System behavior assumes API keys are trusted principals, but does not enforce least-privilege partitioning for sensitive operational APIs.
- **Outbound egress control gaps**:
  - Multiple fetch-capable paths (MCP connectivity, A2A push callbacks, notification webhooks, deploy checks) lack centralized outbound policy enforcement.
- **Data minimization/redaction gaps**:
  - Run and trace surfaces can expose rich payloads useful for debugging but risky for multitenant or shared-admin environments.
- **Queue/job trust boundary**:
  - Run metadata is heavily trusted by downstream execution, including tool/profile behavior; policy hardening exists in parts but is not globally enforced.

## Recommended Remediation Plan
1. **Immediate (0-7 days)**
   - Enforce auth on all A2A task-control endpoints (`/a2a`, `/a2a/tasks*`, `/a2a/tasks/:id/messages`).
   - Fail closed for `/v1/*` when `validateKey` is absent.
   - Add owner checks to API key revoke/rotate endpoints.
   - Restrict `/api/mcp/*` to admin-only and redact secret-bearing fields from responses.
   - Redact `webhookSecret` and other secret fields from trigger API responses.

2. **Short-term (1-4 weeks)**
   - Introduce a default secure middleware stack in `createForgeApp`:
     - `identityMiddleware` + `tenantScopeMiddleware` + RBAC/capability guards for sensitive routes.
   - Add centralized policy for outbound URL validation (A2A callbacks, MCP HTTP/SSE endpoints, webhooks).
   - Add regression tests for:
     - unauthenticated A2A denial
     - cross-owner API key mutation denial
     - non-admin MCP route denial
     - secret redaction in trigger/MCP APIs
   - Reduce sensitive payload exposure in run/log/trace APIs via redaction toggles and scope filters.

3. **Structural (1-2 quarters)**
   - Implement principal-resource-action authorization policy (ABAC/RBAC hybrid) with tenant-aware resource ownership checks.
   - Split control-plane APIs (MCP, deploy, trigger/schedule management) from data-plane APIs and require stronger auth.
   - Add application-layer encryption/key management for persisted secrets and high-sensitivity metadata.
   - Harden scaffolding so generated projects are secure-by-default and compile-time valid for supported auth modes.
