# Quick Fixes (P1, ≤2-4h each) — full-dzupagent 2026-05-06

This file is the consolidated handoff for `/analyze-implement`. It pulls together
the quick-fix prompts from all four domain audits. Per-domain prompt files with
fuller context still live alongside this one (`{code,security,architecture,agent}-quick-fixes.md`).

Each entry below is self-contained: ID, finding ref, files, what to change, validation, target agent.

Total: ~32 quick fixes, ~50h aggregate effort.

## Live-check normalization notes

Do not execute stale entries blindly. `SEC-010` is already fixed in the live checkout, `security.promptInjection` accepts `off | warn | block` rather than `on`, and reusable outbound fetch policy is `fetchWithOutboundUrlPolicy` from `@dzupagent/core`.

---

## SEC-003: Apply outbound URL policy to GitHub connector
**Domain:** Security · **Effort:** 1h · **Severity:** High
**Files:** `packages/connectors/src/github/github-client.ts:213`
**Change:** Replace direct `fetch(url, …)` with `fetchWithOutboundUrlPolicy(url, …)` from `@dzupagent/core`. Strip bearer-token material from any error body that flows into `GitHubApiError(res.status, text)` — addresses SEC-020 in the same edit.
**Validation:** `yarn workspace @dzupagent/connectors test src/github/`; add a unit test asserting that bearer tokens are scrubbed from `GitHubApiError.message`.
**Target agent:** dzupagent-connectors-dev

## SEC-004: Default `security.promptInjection` to a non-off mode
**Domain:** Security · **Effort:** 2h · **Severity:** High
**Files:** `packages/agent/src/agent/run-engine.ts`, `packages/agent/src/agent/agent-types.ts`, related docs/tests
**Change:** Make omitted config default to an explicit non-off compatibility mode, most likely `'warn'` before any future `'block'` default. Add migration notes and keep explicit `'off'` as the opt-out path.
**Validation:** `yarn workspace @dzupagent/agent test`; new agents created without explicit override sanitize or warn on prompt-injection patterns by default.
**Target agent:** dzupagent-agent-dev

## SEC-005: Resolve 32 high-severity dependency CVEs
**Domain:** Security · **Effort:** 4h · **Severity:** High
**Files:** `dzupagent/package.json`, `dzupagent/yarn.lock`
**Change:** Bump axios (prototype pollution + NO_PROXY bypass), node-tar (arbitrary file overwrite), ip-address (XSS via express-rate-limit). Re-run `yarn npm audit --severity high` until clean.
**Validation:** `yarn npm audit --severity high` returns 0 findings; `yarn typecheck` and `yarn test` still green.
**Target agent:** dzupagent-architect

## SEC-010: Enforce LocalWorkspace allowlist when undefined
**Domain:** Security · **Effort:** 0h · **Severity:** Closed
**Files:** `packages/codegen/src/workspace/local-workspace.ts:149`, `packages/codegen/src/workspace/local-workspace.ts:268`
**Change:** Already fixed in the live checkout. The constructor resolves undefined `allowedCommands` to `DEFAULT_ALLOWED_COMMANDS`, and only the literal `'*'` sentinel bypasses the allowlist.
**Validation:** Reuse existing codegen workspace tests or add regression coverage only if a nearby codegen slice is touched.
**Target agent:** n/a

## SEC-013: Enforce GET /runs ownership at LIST time
**Domain:** Security · **Effort:** 1h · **Severity:** Medium
**Files:** `packages/server/src/routes/runs.ts`
**Change:** Add `WHERE owner_id = :tenantId` to LIST query (currently only DETAIL has the predicate).
**Validation:** New integration test asserts cross-tenant LIST returns empty.
**Target agent:** dzupagent-server-dev

## SEC-015: Reject `~/`, `/dev/`, `/proc/` in MCP path validator
**Domain:** Security · **Effort:** 1h · **Severity:** Medium
**Files:** `packages/core/src/mcp/validate-mcp-path.ts`
**Change:** Add explicit deny prefixes after the existing checks: `~/`, `/dev/`, `/proc/`, `/sys/`. Resolve `~` before validation.
**Validation:** Add 4 negative tests to `validate-mcp-path.test.ts`.
**Target agent:** dzupagent-core-dev

## SEC-016: Sanitize Gemini CLI prompt prefix args
**Domain:** Security · **Effort:** 2h · **Severity:** Medium
**Files:** `packages/agent-adapters/src/gemini/gemini-adapter.ts`
**Change:** When building argv, never inline user prompt content as a flag value. Use `--prompt-file <fd>` or stdin. Ensure prompt cannot start with `-`.
**Validation:** Test asserting a user prompt of `--exec rm -rf /` does not leak as flag; runs as input only.
**Target agent:** dzupagent-connectors-dev

## SEC-017: Default CSP header
**Domain:** Security · **Effort:** 2h · **Severity:** Medium
**Files:** `packages/server/src/middleware/security-headers.ts`
**Change:** Add CSP `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none';` Allow override via config.
**Validation:** Hono integration test asserts `Content-Security-Policy` header on every response.
**Target agent:** dzupagent-server-dev

## SEC-018: Rate-limit SSE stream endpoint
**Domain:** Security · **Effort:** 2h · **Severity:** Medium
**Files:** `packages/server/src/routes/runs.ts` (SSE handler)
**Change:** Apply existing rate-limit middleware to `/api/runs/:id/stream`. Cap concurrent SSE streams per API key.
**Validation:** Test that 11th concurrent stream from the same key returns 429.
**Target agent:** dzupagent-server-dev

## SEC-014: PATCH /api/agent-definitions metadata/guardrails Zod-validate
**Domain:** Security · **Effort:** 2h · **Severity:** Medium
**Files:** `packages/server/src/routes/agents.ts`
**Change:** Define Zod schema for `metadata` (object, max depth 4, max keys 32) and `guardrails` (specific shape). Strip unknown keys before spread into Drizzle row.
**Validation:** Negative test with `{__proto__: {…}}` payload returns 400.
**Target agent:** dzupagent-server-dev

## SEC-019: redactSecrets in route-handler console.error logs
**Domain:** Security · **Effort:** 2h · **Severity:** Low
**Files:** `packages/server/src/routes/*.ts`
**Change:** Replace direct `console.error(err)` with `logger.error(redactSecrets(err))` (existing helper). Wrap in lint rule.
**Target agent:** dzupagent-server-dev

## SEC-020: Strip Authorization from GitHub error logs
**Domain:** Security · **Effort:** (combined with SEC-003) · **Severity:** Low

## SEC-022: RBAC on /api/v1/learning-candidates
**Domain:** Security · **Effort:** 1h · **Severity:** Low
**Files:** `packages/server/src/routes/learning.ts`
**Change:** Add `requireRole('admin')` middleware to GET/POST/PATCH on `/api/v1/learning-candidates`.
**Target agent:** dzupagent-server-dev

## SEC-023: Zod schemas on routes/learning.ts POST handlers
**Domain:** Security · **Effort:** 2h · **Severity:** Low
**Files:** `packages/server/src/routes/learning.ts`
**Change:** Add Zod schemas to POST `/feedback` and `/ingest`. Reject keys matching `__proto__`, `constructor`, `prototype`.
**Target agent:** dzupagent-server-dev

## SEC-024: Replace `c.get('apiKey' as never)` casts
**Domain:** Security · **Effort:** 2h · **Severity:** Low
**Files:** `packages/server/src/routes/*.ts`
**Change:** Use the typed AppEnv `Variables` shape (already migrated in most routes). Remove remaining `as never` casts.
**Target agent:** dzupagent-server-dev

---

## AGT-004: clearTimeout on Promise.race success in invoke.ts
**Domain:** Agent · **Effort:** 1h · **Severity:** Medium
**Files:** `packages/core/src/model-registry/invoke.ts:172`
**Change:** Capture the timeout id; `clearTimeout(id)` in `.finally(...)` so the timer doesn't keep the event loop alive on the success path.
**Validation:** Add unit test that runs 1000 invocations and asserts the active-handle count returns to baseline.
**Target agent:** dzupagent-core-dev

## AGT-008: Reset IterationBudget Set in fork()
**Domain:** Agent · **Effort:** 1h · **Severity:** Low
**Files:** `packages/agent/src/orchestration/iteration-budget.ts`
**Change:** In `fork()`, `new Set(this.seenCalls)` (or empty Set, depending on semantics) instead of sharing reference.
**Target agent:** dzupagent-agent-dev

## AGT-011: Add jitter to circuit-breaker cooldown
**Domain:** Agent · **Effort:** 1h · **Severity:** Low
**Files:** `packages/core/src/model-registry/circuit-breaker.ts`
**Change:** Add ±20% jitter to cooldown delay to avoid thundering-herd retry on shared provider outages.
**Target agent:** dzupagent-core-dev

## AGT-015: Auto-compress consecutive-failure count to per-run
**Domain:** Agent · **Effort:** 2h · **Severity:** Low
**Files:** `packages/agent/src/orchestration/auto-compress.ts`
**Change:** Track terminal-error count on the run context, not the loop instance.
**Target agent:** dzupagent-agent-dev

---

## CODE-010: Eliminate `!.` non-null asserts in server hot routes
**Domain:** Code · **Effort:** 2h · **Severity:** Medium
**Files:** `packages/server/src/routes/mcp.ts` (14), other route files (14)
**Change:** Replace `config.mcpManager!.…` with explicit narrowing or early-return guard. Add Zod-validated server options if needed.
**Target agent:** dzupagent-server-dev

## CODE-011: Remove `!.` at memory boundary
**Domain:** Code · **Effort:** 1h · **Severity:** Medium
**Files:** `packages/memory/src/void-filter.ts`, `packages/memory/src/adaptive-retriever.ts`
**Change:** Use proper guard or default. Asserts at boundaries are a smell.
**Target agent:** dzupagent-core-dev

## CODE-019: Named timeout constants
**Domain:** Code · **Effort:** 2h · **Severity:** Low
**Files:** various
**Change:** Replace magic timeout numbers (e.g. `30_000`, `120_000`) with named constants in a per-package `timeouts.ts`.
**Target agent:** dzupagent-core-dev

## CODE-020: Removal-milestone JSDoc on 40 deprecated re-exports
**Domain:** Code · **Effort:** 2h · **Severity:** Low
**Files:** `packages/agent/src/index.ts`
**Change:** Add `@deprecated since X.Y, removed in X+1.0` to each shim.
**Target agent:** dzupagent-agent-dev

---

## ARCH-014: Add READMEs to remaining 12/32 packages
**Domain:** Architecture · **Effort:** 4h · **Severity:** Low
**Files:** packages without README.md
**Change:** Stub each missing README with: purpose, public API, layer, dependencies, example.
**Target agent:** dzupagent-architect

## ARCH-015: Add CI gate for circular dependencies
**Domain:** Architecture · **Effort:** 1h · **Severity:** Medium (part of REC-ARCH-GATE)
**Files:** `package.json` scripts, CI workflow
**Change:** Add cycle detection as an extension to the existing `verify` boundary/domain checks. Prefer a baseline/no-new-cycles gate if the current cycle set is not fixed in the same tranche.
**Target agent:** dzupagent-architect

## ARCH-017: Remove direct QdrantAdapter re-export from core/index
**Domain:** Architecture · **Effort:** 0.5h · **Severity:** Low
**Files:** `packages/core/src/index.ts:783`
**Change:** Move to `@dzupagent/core/vectordb/qdrant` subpath. Will become unnecessary after REC-H-16 (vectordb → rag).
**Target agent:** dzupagent-core-dev

## ARCH-018: Verify agent-adapters subpath exports usage
**Domain:** Architecture · **Effort:** 1h · **Severity:** Low
**Files:** `packages/agent-adapters/src/index.ts`
**Change:** Grep for each subpath import; remove unused.
**Target agent:** dzupagent-architect

## ARCH-006: Document leaf-type-package convention in ADR
**Domain:** Architecture · **Effort:** 1h · **Severity:** Low (informational)
**Files:** `dzupagent/docs/adr/`
**Change:** New ADR: "core may depend on pure-leaf-type packages (agent-types, runtime-contracts, eval-contracts) when they declare zero `dependencies`". Codify the rule.
**Target agent:** dzupagent-architect

---

## Total: ~32 quick fixes (~50h)

Per-domain detail with full prompt bodies remains in:
- `code-quick-fixes.md` (10 P1 from Code domain)
- `security-quick-fixes.md` (10 SEC quick fixes)
- `architecture-quick-fixes.md` (12 ARCH quick fixes)
- `agent-quick-fixes.md` (6 AGT quick fixes)
