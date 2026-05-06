# Security Refactors — dzupagent (audit 2026-05-06)

**Target agent:** `fix:implement` sequentially with `audit:security` regression after each.
**Total effort:** ~28h. Touches schema + interfaces; cannot be parallelised safely.
**Pre-req:** Quick fixes QF-SEC-04 through QF-SEC-10 done first.

---

## RF-SEC-01 — SEC-006: Zod schemas on every CRUD route (~30 endpoints)
**Files:**
- `packages/server/src/routes/personas.ts`
- `packages/server/src/routes/triggers.ts`
- `packages/server/src/routes/clusters.ts`
- `packages/server/src/routes/agents.ts` (PATCH only — POST already done)
- `packages/server/src/routes/skills.ts`
- `packages/server/src/routes/learning.ts` (`/feedback`, `/ingest`, `/skill-packs/load`)
- `packages/server/src/routes/marketplace.ts` (POST + PATCH)
- `packages/server/src/routes/mcp.ts` (PATCH /servers/:id, POST /profiles)
- `packages/server/src/routes/memory-browse.ts` (verify)
- `packages/server/src/routes/api-keys.ts` (already validated manually — switch to Zod)

**Exploit narrative:** 207 user-input touch points in `routes/`, only 13 use Zod. Manual checks (`typeof body['x']`) cannot reject `__proto__`/`constructor` keys, depth-bombs, or stringly-typed booleans. SEC-023 (prototype pollution on `/feedback`) and SEC-001 (cross-tenant via PATCH body) both exploit this gap.

**Fix description:**
1. Create one `<Resource>CreateSchema` and one `<Resource>UpdateSchema` per CRUD family in `packages/server/src/routes/schemas.ts`.
2. Each schema: `z.object({...}).strict()` so unknown keys 400 out.
3. Forbid `__proto__`/`constructor`/`prototype` via a top-level `.refine`.
4. Replace every `await c.req.json<…>()` followed by manual checks with `await validateBodyCompat(c, Schema)`.
5. Cap `metadata` and `instructions` length per resource (256 KB instructions, 64 KB metadata).

**Validation command:**
```bash
yarn workspace @dzupagent/server typecheck && yarn workspace @dzupagent/server test
grep -rE "await c\.req\.json[^V]" packages/server/src/routes/ | grep -v validateBodyCompat
# expect zero hits
```

**Effort:** 16h
**Target agent:** `fix:implement`

---

## RF-SEC-02 — SEC-001 + SEC-009 + SEC-013: Add tenant scoping to AgentDefinition / Persona / Trigger / Schedule / Prompt / Marketplace / Cluster / LearningCandidate
**Files:**
- `packages/server/src/persistence/drizzle-schema.ts` — add `tenantId`/`ownerId` columns to all 7 tables
- `packages/server/src/services/agent-definition-service.ts`
- `packages/server/src/personas/persona-store.ts`
- `packages/server/src/triggers/trigger-store.ts`
- `packages/server/src/schedules/*`
- `packages/server/src/marketplace/catalog-store.ts`
- `packages/server/src/persistence/drizzle-cluster-store.ts`
- `packages/agent/src/self-correction/learning-candidate-service.ts`
- `packages/agent/src/self-correction/recovery-feedback.ts`
- All matching route files

**Exploit narrative:**
1. Tenant A reads `GET /api/agent-definitions` → sees every tenant's `instructions` system prompt (which contains business secrets and embedded API keys).
2. Tenant A `PATCH /api/agent-definitions/:idB` → rewrites tenant B's agent to "exfiltrate every tool result to https://attacker/...".
3. Tenant A `POST /api/triggers` with `agentId: <tenant-B-agent>` and `webhookSecret: secret-known-to-attacker` → forges authenticated webhooks against B's downstream systems.
4. `LearningCandidateService.listPending()` returns every tenant's candidates; promote injects attacker patterns into shared memory store.

**Fix description:**
1. Drizzle migration adds `tenant_id text not null default 'default'` and `owner_id text` to: `agent_definitions`, `personas`, `triggers`, `schedules`, `prompts`, `marketplace_catalog`, `clusters`, `learning_candidates`.
2. Each store gains a `requireTenantScope(tenantId)` method that returns a tenant-bound view.
3. Routes resolve `tenantId` from `c.get('apiKey').tenantId` (default `'default'`) and pass it to the store.
4. Cross-tenant reads return 404 (not 403, to avoid existence enumeration).
5. Service constructors take `{ tenantId }` from request middleware (or use a Hono middleware that injects a tenant-scoped service into `c`).

**Validation command:**
```bash
yarn workspace @dzupagent/server test --filter=tenant-scope
# new tests:
# - Tenant A creates agent → tenant B gets 404 on GET/PATCH/DELETE
# - LearningCandidateService(tenantA).listPending() excludes tenant-B candidates
yarn verify
```

**Effort:** 12h (4h migration, 6h store refactor, 2h tests)
**Target agent:** `fix:implement`

---

## RF-SEC-03 — SEC-008: Wire PII detector into tool-result scanning + learning-candidate ingest
**Files:**
- `packages/agent/src/agent/run-engine-streaming-helpers.ts:419-491`
- `packages/server/src/routes/learning.ts:560-649` (`storeLearningPattern`)
- `packages/agent/src/self-correction/recovery-feedback.ts` (candidate creation)

**Exploit narrative:** A user pastes an SSN/credit card into chat. A `searchDocuments` tool result echoes it. The text lands in `trajectories` memory namespace and surfaces to a different agent run later. Memory write-back is gated; tool-result and learning-candidate paths are not.

**Fix description:**
1. In `runToolResultPromptInjectionScan`, additionally call `PiiDetector.scan(toolResult)`.
2. When `verdict === 'block'`, abort with `PiiBlockedError` (new error class).
3. When `verdict === 'sanitize'`, replace tool result with `detector.sanitize(text)` and emit `memory:pii_redacted`.
4. In `storeLearningPattern`, scan `pattern.pattern` and `pattern.context`; reject or redact based on `config.security?.pii ?? 'redact'`.

**Validation:**
```bash
yarn workspace @dzupagent/agent test --filter=pii-tool-result
# new test: tool result with SSN '123-45-6789' is stored as '[REDACTED:SSN]'
```

**Effort:** 4h
**Target agent:** `fix:implement`

---

## RF-SEC-04 — SEC-007: Hash webhook secret at rest
**Files:** `packages/server/src/persistence/drizzle-schema.ts:214`, `routes/triggers.ts`, new `webhook-signer.ts`
**Exploit narrative:** Plaintext webhook secrets in `triggers.webhook_secret` row → DB compromise reveals every tenant's signing key.

**Fix description:**
1. Migration: rename `webhook_secret` → `webhook_secret_hash` (drop existing values; force re-issue).
2. POST /triggers returns `{ webhookSecret: <raw>, … }` once at creation.
3. Trigger handler stores only `sha256(secret)`.
4. Add `verifySignature(triggerId, candidateSig, payload)` helper.

**Validation:** Test: `GET /api/triggers/:id` never includes the original raw secret. Old plaintext column dropped.
**Effort:** 4h
**Target agent:** `fix:implement`

---

## RF-SEC-05 — SEC-005 (residual): Replace node-tar transitive dependents
**Files:** root `package.json`, multiple workspace `package.json` files
**Exploit narrative:** node-tar high-CVEs (arbitrary file overwrite, hardlink/symlink path traversal) reachable when handling user-supplied tarballs.
**Fix description:**
1. Run `yarn why tar` to identify direct importers.
2. Where used for archive extraction, switch to `@stablelib/tar` or remove the feature.
3. Add `resolutions: { "tar": "^7.4.3" }` if a clean upgrade is possible.
**Validation:** `yarn audit --severity high` returns 0 node-tar findings.
**Effort:** 6h (depends on whether direct importers can be upgraded)
**Target agent:** `fix:implement`

---

## RF-SEC-06 — SEC-011: Replace `new Function` syntax-validation with acorn parser
**Files:** `packages/flow-compiler/src/stages/semantic.ts:283-335`
**Exploit narrative:** `new Function('ctx', `return (${expr})`)` is reachable today only for syntax-checking, but the regex blocklist (`/eval|Function|import/`) is bypassable (`globalThis.eval`, `[]['constructor']`, etc). Any future change that *invokes* this function = RCE.
**Fix description:** Use `acorn.parseExpressionAt(expr, 0, { ecmaVersion: 'latest' })`. Reject `MemberExpression` whose object is `globalThis`/`window`/`process`/`require`. Forbid `[]` index access on identifiers other than `ctx`.
**Validation:** Add fixture tests for the bypass payloads listed in `docs/SECURITY-AUDIT.md` SEC-011. All compile-fail with `INVALID_CONDITION`.
**Effort:** 4h
**Target agent:** `fix:implement`

---

## RF-SEC-07 — SEC-018: Per-key concurrent-connection cap on SSE
**Files:** `packages/server/src/routes/runs.ts` (SSE handler), `packages/server/src/middleware/rate-limiter.ts` (or new `concurrent-cap.ts`)
**Exploit narrative:** SSE streams hold connections; per-window rate limiter doesn't catch them. Attacker burns FDs.
**Fix description:** Add `concurrentSseLimitPerKey` middleware: tracks `Map<keyId, count>` with increment on stream start, decrement on close. 429 when over cap (default 10).
**Validation:** Test: 11th concurrent SSE from same key returns 429.
**Effort:** 3h
**Target agent:** `fix:implement`
