# Security Major Changes — dzupagent (audit 2026-05-06)

**Target agent:** `audit:architecture` then `fix:implement` with explicit ADR.
**Total effort:** ~40h. These changes alter public APIs and require coordination with consuming apps (codev-app, testforge).
**Pre-req:** Quick fixes done. Refactors RF-SEC-01 + RF-SEC-02 done.

---

## MC-SEC-01 — Cross-cutting tenant-isolation framework + audit middleware

**Files:** entire `packages/server/src/`, `packages/agent/src/self-correction/`, `packages/memory/src/tenant-scoped-store.ts`

**Exploit narrative — composite of SEC-001, SEC-009, SEC-013, SEC-022:**

The audit found tenant-isolation gaps across:
- 7 CRUD route families (agents, personas, triggers, schedules, prompts, marketplace, clusters)
- LearningCandidateService (in-process)
- runs LIST handler (per-row OK, list-all leaks IDs)
- learning REST routes (no requireRole)

The piecemeal RF-SEC-02 fix patches the symptoms. The root cause is that there is no architectural boundary forcing route handlers to flow `tenantId`/`ownerId` from auth → service → store. Every new CRUD added re-derives the pattern (often incorrectly).

**Fix description:**

1. **Introduce a typed `RequestScope` Hono variable** (similar to identityMiddleware) that the auth middleware always populates:
   ```ts
   c.set('scope', { tenantId, ownerId, role, apiKeyId } as RequestScope)
   ```
   Routes read `c.get('scope')` (typed) — never `c.get('apiKey' as never)`.

2. **Make every store a `Scoped<T>` wrapper:** stores expose `withScope(scope: RequestScope): ScopedStore<T>`. Unscoped reads/writes throw at runtime + fail compile. Migrate all 7 stores plus `runStore`, `agentStore`, `mailboxStore`, `clusterStore`, `catalogStore`.

3. **Compliance audit log on every mutation:** any handler that mutates state emits a `ComplianceAuditEntry` via the existing `ComplianceAuditLogger`. This closes the prior audit's "no LLM audit log" finding by ensuring CRUD events are also captured (LLM events were already covered).

4. **RBAC defaults:**
   - `viewer`: GET only
   - `user`: GET + POST own resources
   - `operator`: + admin tooling (learning/ingest, MCP servers)
   - `admin`: full
   Default role for legacy keys remains `'operator'` to preserve compatibility, BUT new key issuance defaults to `'user'`.

5. **Add an integration test suite** `packages/server/src/__tests__/tenant-isolation.spec.ts` that for *every* route does:
   - Create resource as tenant A
   - Issue request as tenant B (different `apiKey.id` and `tenantId`)
   - Assert 404
   - Assert audit entry recorded for the access attempt

**Validation command:**
```bash
yarn workspace @dzupagent/server test --filter=tenant-isolation
yarn verify
# 0 cross-tenant leaks across all CRUD families
```

**Effort:** 24h (8h scope plumbing, 8h store refactor, 4h audit hooks, 4h tests)
**Target agent:** `fix:implement` with ADR drafted by `audit:architecture` first.
**Risk:** Breaks consuming apps (codev-app) that bypass the auth middleware in tests. Coordinate test fixtures.

---

## MC-SEC-02 — Centralised secrets-redaction logger replacing direct `console.error`

**Files:**
- New `packages/core/src/logging/secure-logger.ts`
- Refactor every `console.error/warn/log` in `packages/server`, `packages/agent`, `packages/agent-adapters` (~60+ call sites)

**Exploit narrative — composite of SEC-019, SEC-020:**

Today, `redactSecrets` runs only in the global Hono onError. Routine logs in route handlers, codex/claude adapters, and sync helpers go through raw `console.error('[mcp] …')`. When an error message embeds `OPENAI_API_KEY=sk-…` or a bearer header, the secret leaks to stderr and any log aggregator. A targeted attacker who can cause an MCP server registration to fail in a specific way obtains the operator's API key from the log line.

**Fix description:**

1. Create a `secureLogger` class in `@dzupagent/core` that:
   - Wraps `console.error/warn/info`.
   - Always pipes through `redactSecrets` and a configurable PII detector before output.
   - Supports structured logging (`logger.error({ event: 'mcp_error', err, context })`).
   - Allows tests to capture and assert on output.

2. Replace all `console.error` in `packages/server`, `packages/agent`, `packages/agent-adapters` with `secureLogger.error`.

3. Add an ESLint rule (`no-restricted-syntax`) that disallows `console.error` outside of approved files.

4. Add OTel correlation: `secureLogger` reads the active span from `@dzupagent/otel` and tags every log with `traceId`/`spanId` for forensics.

**Validation:**
```bash
grep -rn "console\.\(error\|warn\|log\)" packages/server/src packages/agent/src packages/agent-adapters/src \
  | grep -v "__tests__\|secure-logger\.ts" | wc -l
# expect 0
yarn lint    # passes
yarn workspace @dzupagent/core test --filter=secure-logger
```

**Effort:** 12h
**Target agent:** `fix:implement`

---

## MC-SEC-03 — Default outbound URL policy on every fetch in the framework

**Files:** every `fetch(...)` in:
- `packages/agent/src/approval/approval-gate.ts:297` (covered by QF-SEC-01)
- `packages/connectors/src/github/github-client.ts:213` (covered by QF-SEC-02)
- `packages/connectors/src/slack/slack-connector.ts:18`
- `packages/connectors/src/http/http-connector.ts:82` (already routed — verify)
- `packages/agent-adapters/src/observability/*.ts`
- Internal HTTP clients in `mcp-client.ts` (already routed — verify)
- Anywhere `await fetch(` appears in `packages/`

**Exploit narrative:** Despite a robust `fetchWithOutboundUrlPolicy` helper, individual subsystems forget to use it. The QF-SEC-01/02 fixes patch the worst offenders, but the architectural root cause is that `fetch` is globally available. A future feature added by anyone, anywhere, will face the same trap.

**Fix description:**

1. Add an ESLint rule (`no-restricted-globals: ['fetch']` plus `no-restricted-imports` on `node:http`/`https`) that disallows raw `fetch` everywhere except an approved allowlist (`packages/core/src/security/outbound-url-policy.ts`, the test files, and the redirect-handling internals).

2. Replace remaining call sites with `fetchWithOutboundUrlPolicy`.

3. In monorepo CI, run a custom check that fails if any new `fetch(` call appears outside the allowlist.

4. Document the override path: callers that genuinely need a non-policy-checked fetch must import `__internalUnpolicedFetch` and add an inline `// eslint-disable-next-line` comment that is reviewed in PR.

**Validation:**
```bash
grep -rn "\\bfetch(" packages/ --include='*.ts' \
  | grep -v "__tests__\|outbound-url-policy\|fetchWithOutboundUrlPolicy" \
  | wc -l
# expect 0 (or matches the allowlist length)
yarn workspace @dzupagent/core test --filter=outbound-url-policy
yarn lint
```

**Effort:** 8h (audit + replacement + ESLint config)
**Target agent:** `fix:implement`

---

## Sequencing notes

1. Apply Quick Fixes first (parallelisable, ~10h) — they reduce blast radius on the worst Critical/High items.
2. RF-SEC-02 (tenant scoping refactor) before MC-SEC-01 (architectural refactor); RF-SEC-02 lays the column work, MC-SEC-01 codifies the pattern.
3. RF-SEC-01 (Zod everywhere) is independent and can run in parallel with RF-SEC-02 once schemas merge cleanly.
4. MC-SEC-02 / MC-SEC-03 (logger + ESLint guards) should land last — they encode the rules that prevent regressions.
5. Re-run `audit:security` after every MC- change to validate gates.
