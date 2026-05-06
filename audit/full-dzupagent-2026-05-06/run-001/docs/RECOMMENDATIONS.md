# Unified Recommendations — full-dzupagent 2026-05-06 / run-001

Recommendations from all four domains, sorted: **Critical → High → Medium → Low**, then by effort (quick first). Cross-domain duplicates collapsed to a single primary entry; follow-ups noted.

## Live-check normalization notes

These recommendations were corrected against the live checkout before implementation. `SEC-010` is already fixed in `packages/codegen/src/workspace/local-workspace.ts`, approval webhook work belongs in `packages/agent/src/approval/approval-gate.ts`, and `ARCH-022` is not a from-scratch package-boundary CI task because `yarn verify` already runs domain-boundary checks and `packages/testing/src/__tests__/boundary/architecture.test.ts` already enforces configured package boundaries.

---

## 🔴 Active Critical (1)

### REC-CRIT-01: Close cross-tenant access on all CRUD route families
**Source:** SEC-001 (primary) + AGT-001 + SEC-009
**Domain:** Security + Agent
**Phase:** refactor → 24h combined
**Files:**
- `packages/server/src/routes/{agents,personas,triggers,schedules,prompts,marketplace,clusters}.ts`
- `packages/server/src/services/agent-definition-service.ts`
- `packages/agent/src/self-correction/learning-candidate-service.ts`
- `packages/agent-adapters/src/learning/{adapter-learning-loop,learning-store}.ts`

**Why:** SEC-001 confirms 7 CRUD route families have zero tenantId predicate — any authenticated key can read/modify/delete any tenant's agent definitions, personas, triggers, schedules, prompts, marketplace catalog, and cluster configs. AGT-001 confirms the same root cause inside the framework's learning loop (ExecutionRecord, ProviderProfile, LearningStore are flat — provider performance tuning bleeds across tenants). SEC-009 covers LearningCandidateService directly. SEC-02 in the 2026-05-05 audit was claimed closed because `routes/learning.ts` got the wrap, but the wrap was never extended to siblings.

**Fix:** Introduce a single `withTenantScope(c, repo)` middleware/helper used by every route handler before any DB call. Add `tenantId` predicates to every Drizzle/SQL query for these tables. Add a `tenantId` column where missing. Add a boundary integration test that asserts cross-tenant 403/404 behaviour for every route.

**Acceptance:**
- A new test file `cross-tenant-isolation.test.ts` enumerates every CRUD endpoint and asserts cross-tenant access returns 404 (not 403, to avoid existence leakage).
- AdapterLearningLoop ExecutionRecord/ProviderProfile keys include tenantId.
- LearningCandidateService methods take `(tenantId, …)` signature and assert in body.

**Target agent:** dzupagent-server-dev (route surface) + dzupagent-agent-dev (services) + dzupagent-test-dev (boundary test)

---

### REC-ARCH-GATE: Extend existing architecture gates (cycles + dependency completeness)
**Source:** ARCH-022 (primary) + ARCH-015 + ARCH-016
**Domain:** Architecture
**Phase:** refactor → 6h
**Files:** `package.json`, `packages/testing/src/__tests__/boundary/architecture.test.ts`, `.github/workflows/*` (CI)

**Why:** Automated boundary enforcement already exists: `yarn verify` runs `check:domain-boundaries`, and `packages/testing/src/__tests__/boundary/architecture.test.ts` loads machine-readable boundary policy. The remaining gap is narrower: cycle/import completeness checks are not fully enforced, so cycles and missing/unused dependency declarations can still drift.

**Fix:** Extend the existing gate instead of adding it from scratch:
1. `yarn arch:cycles` → fails if `npx madge --circular --extensions ts packages` returns non-empty
2. `yarn arch:deps` → asserts each package's `dependencies` matches actual import set (declared-vs-used)
3. If needed, fold these into the existing boundary/domain scripts so `yarn verify` remains the single repo gate

Wire into the PR workflow after the baseline is either fixed or explicitly allowlisted.

**Acceptance:** PR with a deliberate cycle introduction fails CI with the cycle path printed.

**Target agent:** dzupagent-architect

---

### REC-CRIT-AGT: (Bundled with REC-CRIT-01) — addressed there.
*This slot was reserved for AGT-001 but is consolidated above.*

---

## 🟠 High (16)

### REC-H-01: Add outbound URL policy + HMAC signing to ApprovalGate webhook
**Source:** SEC-002 + AGT-002
**Phase:** refactor → 4h
**Files:** `packages/agent/src/approval/approval-gate.ts:275-322`
**Fix:** Reuse existing outbound URL policy (already used elsewhere); add HMAC SHA-256 signing with timestamp headers so receivers can authenticate and reject stale callbacks.
**Target agent:** dzupagent-agent-dev

### REC-H-02: Apply outbound URL policy to GitHub connector
**Source:** SEC-003 (+ SEC-020 leak)
**Phase:** quick → 2h (combined)
**Files:** `packages/connectors/src/github/github-client.ts:213`
**Fix:** Route `fetch` through `fetchWithOutboundUrlPolicy` from `@dzupagent/core`. Strip bearer-token material from error text before constructing `GitHubApiError`.
**Target agent:** dzupagent-connectors-dev

### REC-H-03: Default `security.promptInjection` to a non-off mode
**Source:** SEC-004
**Phase:** quick → 2h
**Files:** `packages/agent/src/agent/run-engine.ts`, `packages/agent/src/agent/agent-types.ts`, related docs/tests
**Fix:** Make the omitted-config default an explicit compatibility decision, most likely `'warn'` before any future `'block'` default. Add migration notes and document the explicit `'off'` opt-out.
**Target agent:** dzupagent-agent-dev

### REC-H-04: Resolve 32 high-severity dependency CVEs
**Source:** SEC-005
**Phase:** quick → 4h
**Files:** `dzupagent/package.json`, `dzupagent/yarn.lock`
**Fix:** Bump axios (prototype pollution + NO_PROXY bypass), node-tar (arbitrary file overwrite), ip-address (XSS via express-rate-limit). Re-run `yarn npm audit` and add CI gate.
**Target agent:** dzupagent-architect

### REC-H-05: Zod-validate all 207 user-input touch points
**Source:** SEC-006
**Phase:** refactor → 12h
**Files:** `packages/server/src/routes/*.ts`
**Fix:** For each route handler, define a Zod schema and use `c.req.valid('json')`. Reject unknown keys (`.strict()`). Replace ad-hoc `typeof body['x']` checks. Adds defence against `__proto__`/`constructor` and depth bombs.
**Target agent:** dzupagent-server-dev

### REC-H-06: Hash webhook secrets at rest
**Source:** SEC-007
**Phase:** refactor → 4h
**Files:** `packages/server/src/db/drizzle-schema.ts:214` + trigger CRUD
**Fix:** Migrate `triggers.webhook_secret` to `webhook_secret_hash` (HMAC verification on inbound, never read back). Provide one-time rotation script.
**Target agent:** dzupagent-server-dev

### REC-H-07: Apply PII detector to tool results and learning candidates
**Source:** SEC-008 + AGT-010 + AGT-014
**Phase:** refactor → 8h
**Files:** `packages/memory/src/sanitizer/*`, `packages/agent/src/orchestration/tool-loop/result-pipeline.ts`, MemoryStore.put boundary
**Fix:** Pull PII detector into a single guard helper. Apply at: tool-result emit, learning-candidate ingest, MemoryStore.put. Wire AGT-010's missing scanner.
**Target agent:** dzupagent-agent-dev

### REC-H-08: Enforce LocalWorkspace allowlist when undefined
**Source:** SEC-010
**Phase:** done
**Files:** `packages/codegen/src/workspace/local-workspace.ts:149`, `packages/codegen/src/workspace/local-workspace.ts:268`
**Fix:** Already implemented in the live checkout. `allowedCommands === undefined` resolves to `DEFAULT_ALLOWED_COMMANDS`, and `allowedCommands: '*'` is the explicit opt-out sentinel.
**Target agent:** n/a

### REC-H-09: Consolidate two security stacks
**Source:** AGT-003 + ARCH-004
**Phase:** major → 24h
**Files:** `packages/core/src/security/*` (3,094 LOC), `packages/security/src/*` (464 LOC)
**Fix:** Move PII patterns, prompt-injection rules, output filters from core/security to packages/security. Make core/security a thin re-export until one release of deprecation. Single ContentScanner — all consumers (memory write, tool result, learning ingest) go through it.
**Target agent:** dzupagent-core-dev

### REC-H-10: Invert agent-adapters/workflow → agent layering
**Source:** ARCH-001
**Phase:** refactor → 8h
**Files:** `packages/agent-adapters/src/workflow/{default-pipeline-executor,adapter-workflow,pipeline-assembler}.ts`
**Fix:** Move `PipelineRuntime` interface + `PipelineRuntimeEvent` from `@dzupagent/agent` to a contract package (e.g., `runtime-contracts`). agent and agent-adapters both depend on the contract; neither depends on the other.
**Target agent:** dzupagent-architect

### REC-H-11: Shrink core barrel from 225 exports
**Source:** ARCH-002 + ARCH-013 + CODE-013 + CODE-012
**Phase:** refactor → 8h
**Files:** `packages/core/src/index.ts` (877 LOC), `packages/agent/src/index.ts` (821 LOC)
**Fix:** Curate `index.ts` to ~50 stable exports. Move advanced/internal symbols to subpath imports (`@dzupagent/core/mcp`, `@dzupagent/core/persistence`, etc.). Mark agent's 40 deprecated shims with explicit removal milestone (next major).
**Target agent:** dzupagent-core-dev + dzupagent-agent-dev

### REC-H-12: Decompose `runToolLoop` (362 LOC, depth 10)
**Source:** CODE-002
**Phase:** refactor → 6h
**Files:** `packages/agent/src/orchestration/run-tool-loop.ts`
**Fix:** Extract pipeline stages: PreToolGuards → ToolDispatch → PostToolValidation → StuckCheck → BudgetCheck. Each stage is its own pure function. Test each stage independently.
**Target agent:** dzupagent-agent-dev

### REC-H-13: Backfill tests for 6 untested agent helpers (≥400 LOC each)
**Source:** CODE-005
**Phase:** major → 24h
**Files:** `run-engine-streaming-helpers.ts` (717 LOC), `confidence-calculator.ts` (348 LOC), and 4 others (see CODE-AUDIT.md CODE-005)
**Target agent:** dzupagent-test-dev

### REC-H-14: Backfill tests for 5 server zero-test files
**Source:** CODE-006
**Phase:** refactor → 12h
**Files:** `packages/server/src/routes/{deploy,scorecard}*.ts`
**Target agent:** dzupagent-test-dev

### REC-H-15: Eliminate 28 intra-package circular deps
**Source:** ARCH-005
**Phase:** refactor → 16h
**Files:** distribution: agent-adapters 10, server 8, agent 6, core 2, adapter-types 1
**Fix:** Most cycles in agent-adapters trace to `claude/codex/gemini` adapters mutually importing `provider-profile`. Most server cycles trace to `composition/types.ts` (see ARCH-011). Break by introducing intermediate contract files; consolidate `composition/types.ts`.
**Target agent:** dzupagent-architect

### REC-H-16: Extract core/vectordb → @dzupagent/rag
**Source:** ARCH-003
**Phase:** major → 32h
**Files:** `packages/core/src/vectordb/*`, `packages/rag/src/*`
**Fix:** Make `@dzupagent/rag` the canonical vector-DB surface. Re-export adapters from rag. Remove duplication in core. core/vectordb becomes a thin re-export shim for one release.
**Target agent:** dzupagent-architect

---

## 🟡 Medium (selected highlights — full list in CROSS-DOMAIN-MATRIX.md)

### REC-M-01: clearTimeout on Promise.race success in invoke.ts
**Source:** AGT-004 — quick 1h — `packages/core/src/model-registry/invoke.ts:172`. Memory leak under sustained load.

### REC-M-02: Use @anthropic-ai/tokenizer for Claude models
**Source:** AGT-005 — refactor 4h — `packages/context/src/tokenizer/tiktoken-counter.ts`. Currently routes through cl100k_base which under-counts ~7-12% on Claude.

### REC-M-03: Stuck detector idle counter race after parallel-mode pause
**Source:** AGT-006 — refactor 4h — `packages/agent/src/orchestration/stuck-detector.ts`. Reset counter on resume, not at next-iter entry.

### REC-M-04: Persist approval timeout decision
**Source:** AGT-007 — refactor 4h — `approval-gate.ts`. Write `decision: 'timeout'` to durable store before cancelling.

### REC-M-05: Enrich LLM audit log with tenantId/prompt/response
**Source:** AGT-009 — refactor 6h — `packages/agent/src/observability/audit-log.ts`. Currently logs (model, tokens, cost) only.

### REC-M-06: Move permission tier check to write-tool issuance
**Source:** AGT-012 — refactor 6h — `packages/codegen/src/permissions/*`. Catch tier violation before sandbox write attempt.

### REC-M-07: Decompose 9 god files (>900 LOC)
**Source:** ARCH-007 + CODE-001 + ARCH-012 — major 32h. List in CROSS-DOMAIN-MATRIX.md.

### REC-M-08: Extract core mid-tier subdomains
**Source:** ARCH-010 — major 40h. Move mcp, protocol, skills, identity, persistence, formats from core to dedicated packages — shrinks core by ~50%.

### REC-M-09: Replace `composition/types.ts` kitchen-sink ambient module
**Source:** ARCH-011 — refactor 4h — root cause of 2 server cycles.

### REC-M-10: Split `server/routes/runs.ts` (969 LOC)
**Source:** ARCH-012 + CODE-018 — refactor 8h — split into list/detail/stream/control sub-routers.

### REC-M-11: Dedup mtime-cache loaders
**Source:** CODE-003 — refactor 4h — extract a shared `MtimeCache` to dzupagent-kit or core.

### REC-M-12: Resolve `MemoryEntry` interface name collision
**Source:** CODE-004 — refactor 4h.

### REC-M-13: Replace ~50 `console.*` calls with defaultLogger
**Source:** CODE-009 — refactor 4h.

### REC-M-14: Eliminate `!.` non-null asserts in server hot routes
**Source:** CODE-010 + CODE-011 — quick 3h combined — narrow types instead.

### REC-M-15: Replace `new Function` paths with controlled evaluator
**Source:** SEC-011 + SEC-012 — refactor 10h combined.

### REC-M-16: Enforce GET /runs ownership at LIST time
**Source:** SEC-013 — quick 1h.

### REC-M-17: Reject `~/`, `/dev/`, `/proc/` in MCP path validator
**Source:** SEC-015 — quick 1h.

### REC-M-18: Sanitize Gemini CLI prompt prefix args
**Source:** SEC-016 — quick 2h.

### REC-M-19: Default CSP header
**Source:** SEC-017 — quick 2h.

### REC-M-20: Rate-limit SSE stream endpoint
**Source:** SEC-018 — quick 2h.

### REC-M-21: PATCH /api/agent-definitions metadata/guardrails Zod-validate
**Source:** SEC-014 — quick 2h.

---

## 🟢 Low (selected highlights — full list in CROSS-DOMAIN-MATRIX.md)

- AGT-008: Reset IterationBudget Set in fork() (1h)
- AGT-011: Add jitter to circuit-breaker cooldown (1h)
- AGT-013: Retry on invocation error in ModelRegistry (4h)
- AGT-015: Consolidate auto-compress error count to per-run (2h)
- ARCH-014: Add READMEs to remaining 12/32 packages (4h)
- ARCH-017: Remove direct QdrantAdapter re-export from core/index (0.5h)
- ARCH-019: Add subpath exports to memory package (4h)
- ARCH-020: Split optional-dep adapters into separate packages (8h)
- CODE-014 + CODE-021: 173 `as never` casts in test files — replace with test-utils factories (10h combined)
- CODE-019: Named timeout constants (2h)
- CODE-020: Removal-milestone JSDoc on 40 deprecated re-exports (2h)
- SEC-019: redactSecrets in route-handler console.error (2h)
- SEC-021: JSON depth/size cap on metadata fields (4h)
- SEC-022: RBAC on /api/v1/learning-candidates (1h)
- SEC-023: Zod schemas on routes/learning.ts POST handlers (2h)
- SEC-024: Replace `c.get('apiKey' as never)` casts after AppEnv migration (2h)

---

## Verified-closed (do not re-open)

These prior-audit findings were re-checked against current code and confirmed remediated:

- ✅ C-01 prompt caching (Anthropic cache_control wired in agent-adapters)
- ✅ H-01 workspace-write → bypassPermissions (Claude SDK adapter returns `'default'`)
- ✅ REC-002 git arg injection (now uses `execFile` with array args)
- ✅ REC-003 bootstrap risk-tier bug
- ✅ Durable approvals (MC sprint 2026-05-04)
- ✅ OrchestratorFacade split (909 → 279 LOC)
- ✅ MC-01 cache token split (cacheReadTokens + cacheWriteTokens)
- ✅ Production `as never` count: down from 15 to 4 (rest are doc comments / lint-rule definitions)
- ✅ AppEnv migration: 0 live `c.set('apiKey' as never)` calls remaining
- ✅ Production `@ts-ignore` / `@ts-expect-error`: 0
- ✅ TODO/FIXME in production code body: 0
- ✅ API key SHA-256 hashing + randomBytes(32)
- ✅ LLM audit log emits `llm:invoked` event picked up by ComplianceAuditLogger (note: payload incomplete — see AGT-009)
- ✅ Outbound URL policy with DNS resolution + IPv4/IPv6 private-range checks (note: not applied everywhere — see SEC-002, SEC-003)

---

## Suggested sprint sequencing

**Sprint A — Critical drift burn-down (2-3 days):** REC-CRIT-01 (cross-tenant) only. Keep this tranche narrow and route/service-test driven.

**Sprint B — Outbound and webhook hardening (1-2 days):** REC-H-01 and REC-H-02 together. They share outbound URL policy semantics and should be validated before starting broader defaults work.

**Sprint C — Security defaults and input validation (2 days):** REC-H-03 plus the Zod route-validation subset that protects the CRUD routes touched in Sprint A. Treat `SEC-010` as closed, not queued.

**Sprint D — Architecture gate completion (1-2 days):** REC-ARCH-GATE, focused on cycle detection and declared-vs-actual dependency completeness. Do not re-add boundary/domain checks from scratch.

**Sprint E — Security stack consolidation (4 days):** REC-H-09 (core/security → packages/security), REC-H-07 (PII at boundaries), AGT-009 (audit log enrichment).

**Sprint F — Test backfill (5 days):** REC-H-13 + REC-H-14 + CODE-007 + CODE-008 + CODE-022. Bring under-tested critical paths to coverage parity.

**Sprint G — Decomposition and optional extractions:** runToolLoop/runs.ts/barrel work first, then ARCH-003, ARCH-010, ARCH-008, ARCH-009, ARCH-020 as separate sprints.

Total runway: ~510h ≈ 13 dev-weeks (one engineer) or ~5 wall-clock weeks with three engineers parallelising A→B/C/D in the first two weeks.
