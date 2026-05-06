# DzupAgent Monorepo — Code Quality Audit

**Date:** 2026-05-05
**Scope:** All 32 packages in `dzupagent/packages/` (~2,669 TS files, ~256k source LOC)
**Excludes findings already closed by:** Phase 1/2 Security Sprint (2026-05-05) and Sprint B Quick-Fixes (2026-05-05). Prior agent+agent-adapters audits at `audit/full-agent-agent-adapters-2026-05-05/run-001/`.

This audit re-verified the most-cited issues from the prior round (`as never` casts, prompt-caching, workspace-write security tier) and confirms most are resolved. Remaining findings below are **new** or were **out-of-scope** of those audits (they were narrow to agent + agent-adapters).

---

## Summary

| Severity | Count |
|----------|------:|
| P1 (must fix soon) | 7 |
| P2 (should fix) | 14 |
| P3 (nice to have) | 6 |
| **Total** | **27** |

### Repo-wide hot metrics

| Metric | Value | Threshold | Status |
|--------|------:|----------:|:------:|
| `: any` / `as any` in non-test source (excluding doc strings) | 4 real cases | 0 | yellow |
| `as never` casts in non-test source | 38 (33 in `server/`) | <5 | red |
| `as unknown` casts in non-test source | 143 | <50 | yellow |
| `@ts-ignore` / `@ts-expect-error` in non-test source (excl. doc/regex source) | 0 | 0 | green |
| `eslint-disable` lines (mostly `security/detect-unsafe-regex` w/ justification) | 39 | n/a | green (justified) |
| Functions ≥ 80 LOC (sampled hot files) | 13 | <5 | red |
| TODO/FIXME markers in source | 0 | 0 | green |
| Source files with no matching `.test.ts` (critical packages, sum) | 479 / 852 (56%) | <30% | red |

---

## Top 10 findings (ranked by impact)

1. **CODE-01 (P1, server)** — 33 `as never` Hono context casts after `AppEnv` was already created to eliminate them. Stale technical debt; the canonical fix is sitting in `server/src/types.ts` and just isn’t adopted in 6 files. **Fix is low-risk, high-cleanup-value.**
2. **CODE-02 (P1, agent/run-engine)** — `executeStreamingToolCall` is **397 LOC** in a single function — exceeds any reasonable comprehension budget; high blast radius for tool-loop bugs.
3. **CODE-03 (P1, agent-adapters/syncer)** — `planSync` is **324 LOC** with embedded provider-specific branches (codex / claude / dzupagent) that should be polymorphic strategies.
4. **CODE-04 (P1, memory/retrieval)** — 6 of 13 retrieval files (`cross-encoder-rerank`, `fts-search`, `graph-search`, `rrf-fusion`, `vector-search`, `vector-store-search`) have **zero matching `.test.ts`** despite being on hot recall paths.
5. **CODE-05 (P1, security)** — 5 of 6 `security/src/*` source files (PII detector, prompt-injection detector + patterns, fixtures) have no matching `*.test.ts`. Tests exist but only at module-aggregate level.
6. **CODE-06 (P2, agent/orchestration/team)** — 25+ files in `team/` runtime have **no matching tests** (split files); each is small but coverage is shallow.
7. **CODE-07 (P2, flow-ast)** — `validate.ts` 1410 LOC and `parse.ts` 1077 LOC are god files; testable in isolation already (3 test files), but maintainability is poor.
8. **CODE-08 (P2, agent/pipeline-runtime)** — `mergeBranchExecutionResult` ~142 LOC; nested branch/result merge with state mutation; refactor candidate.
9. **CODE-09 (P2, agent/dzip-agent)** — Constructor body 120 LOC mixes config validation, listener wiring, and DI; extract `validateConfig` and `installEventBus` helpers.
10. **CODE-10 (P3, dev/cli)** — ~25 `console.log/error` calls leak into non-CLI runtime (server/lifecycle/human-contact-timeout, syncer warning surface, structured-generate fallback). Replace with logger.

---

## Findings by package

### server (12 findings)

#### CODE-01 — Stale `as never` casts despite `AppEnv` typing being available
- **Severity:** P1
- **Files:** `server/src/middleware/identity.ts:83-118`, `middleware/auth.ts:70`, `middleware/rbac.ts:277,339`, `middleware/tenant-scope.ts:57`, `middleware/rate-limiter.ts:190`, `routes/runs.ts:63,75,102,214,383`, `routes/run-guard.ts:30,41,68`, `routes/api-keys.ts:112-118`, `routes/a2a/helpers.ts:58`, `routes/memory-tenant-scope.ts:45`, `routes/openai-compat/auth-middleware.ts:98`, `runtime/consolidation-scheduler.ts:134-153`
- **Why:** `server/src/types.ts` defines `AppEnv = { Variables: { apiKey, forgeIdentity, forgeCapabilities, forgeRole, forgeTenantId } }` precisely so that callers do not need `as never`. Three routes (`skills`, `enrichment-metrics`, `mcp`) already use `AppEnv`; six others do not. The `as never` is then erased with a second `as Record<string, unknown>` re-cast, hiding type drift.
- **Fix:** In each route file, change `new Hono()` → `new Hono<AppEnv>()` and import `AppEnv` from `'../types.js'`. Then strip both casts. Add `apiKey` to `AppVariables` as a typed shape (e.g. `ApiKeyContext`).
- **Effort:** 4–8h (mechanical, but spans ~14 files; needs careful tsc pass).

#### CODE-11 — `runs.ts` route file is 968 LOC with mixed concerns
- **Severity:** P2
- **File:** `server/src/routes/runs.ts`
- **Why:** Route handlers, validation, persistence shims, and SSE streaming mix in one module. Increases blast radius and makes per-handler testing harder.
- **Fix:** Split into `runs/list-handler.ts`, `runs/create-handler.ts`, `runs/stream-handler.ts`, `runs/control-handler.ts`. Keep `runs.ts` as router-only.
- **Effort:** 8h.

#### CODE-12 — `compile.ts` route file is 782 LOC
- **Severity:** P2
- **File:** `server/src/routes/compile.ts`
- **Why:** Same shape as CODE-11.
- **Effort:** 4–8h.

#### CODE-13 — `run-worker-stages.ts` 798 LOC (workers/stages mixed)
- **Severity:** P2
- **File:** `server/src/runtime/run-worker-stages.ts`
- **Fix:** Extract per-stage modules (already a stage abstraction implicit in name). One file per stage, plus a `stages/index.ts` barrel.
- **Effort:** 8h.

#### CODE-14 — `cli/doctor.ts` 715 LOC monolithic doctor
- **Severity:** P3
- **File:** `server/src/cli/doctor.ts`
- **Fix:** Split each diagnostic check into its own module under `cli/doctor/checks/*.ts`; have main `doctor.ts` aggregate.
- **Effort:** 4–8h.

#### CODE-15 — `lifecycle/human-contact-timeout.ts` uses `console.error` for runtime errors
- **Severity:** P3
- **File:** `server/src/lifecycle/human-contact-timeout.ts`
- **Fix:** Inject the structured logger already present in `core/src/logger`.
- **Effort:** 1–2h.

#### CODE-16 — Test coverage gap in server runtime
- **Severity:** P2
- **Files:** 126 of 202 source files in `server/src/` lack matching test (62%).
- **Fix:** Prioritize `runtime/*` and `lifecycle/*` (durability paths). Add fixtures for `run-worker-stages`.
- **Effort:** 16h+.

### agent (5 findings)

#### CODE-02 — `executeStreamingToolCall` 397 LOC in `run-engine.ts`
- **Severity:** P1
- **File:** `agent/src/agent/run-engine.ts:700`
- **Why:** Tool-loop streaming code intermixes budget tracking, stuck detection, transformation, latency reporting. Hard to add a new event type without touching this entire body.
- **Fix:** Extract `applyBudgetGate`, `runToolStreamingPhase`, `recordToolLatencyOutcome`. Keep `executeStreamingToolCall` as an orchestrator <100 LOC.
- **Effort:** 8h.

#### CODE-17 — `executeGenerateRunInner` 270 LOC
- **Severity:** P2
- **File:** `agent/src/agent/run-engine.ts:373`
- **Why:** Already has `executeGenerateRun` (24 LOC) wrapping it; the “inner” function still hides 270 LOC of branching.
- **Fix:** Pull guard prelude, model-call setup, and post-processing into helpers.
- **Effort:** 4–8h.

#### CODE-18 — `tool-loop.ts` `runToolLoop` function spans large chunk; central control loop
- **Severity:** P2
- **File:** `agent/src/agent/tool-loop.ts` (file 825 LOC)
- **Effort:** 8h.

#### CODE-09 — `dzip-agent.ts` constructor 120 LOC
- **Severity:** P2
- **File:** `agent/src/agent/dzip-agent.ts:170`
- **Effort:** 4h.

#### CODE-19 — `delegating-supervisor.ts` 847 LOC with `markCircuitBreakerRecorded` 149 LOC and `guardDuplicateSpecialistAssignmentIds` 117 LOC
- **Severity:** P2
- **File:** `agent/src/orchestration/delegating-supervisor.ts:384,533`
- **Fix:** Extract circuit-breaker bookkeeping to a `circuit-breaker-recorder.ts`; assignment validation → its own module.
- **Effort:** 8h.

### agent-adapters (3 findings)

#### CODE-03 — `planSync` 324 LOC in syncer
- **Severity:** P1
- **File:** `agent-adapters/src/dzupagent/syncer.ts:261`
- **Why:** Branches on `target` (codex/claude/dzupagent) with target-specific filesystem layout logic inline. Violates open/closed: adding a new agent is an in-place edit.
- **Fix:** Define `SyncStrategy` interface; create `codex-sync-strategy.ts`, `claude-sync-strategy.ts`, `dzupagent-sync-strategy.ts`; `planSync` becomes a strategy lookup + delegation (~30 LOC).
- **Effort:** 8h.

#### CODE-20 — `codex-adapter.ts` 1125 LOC, `runStreamed` body large
- **Severity:** P2
- **File:** `agent-adapters/src/codex/codex-adapter.ts`
- **Fix:** Extract event-mapping (currently inline) to dedicated `codex-event-mapper.ts`. Extract abort/timeout handling.
- **Effort:** 8h.

#### CODE-21 — `claude-adapter.ts` `mapRawEvent` 143 LOC
- **Severity:** P2
- **File:** `agent-adapters/src/claude/claude-adapter.ts:320`
- **Fix:** Replace large switch with a dispatch table `RAW_EVENT_HANDLERS: Record<RawType, Handler>`.
- **Effort:** 4h.

### memory (3 findings)

#### CODE-04 — Retrieval test gaps
- **Severity:** P1
- **Files:** `memory/src/retrieval/cross-encoder-rerank.ts`, `fts-search.ts`, `graph-search.ts`, `rrf-fusion.ts`, `vector-search.ts`, `vector-store-search.ts`
- **Why:** All six are on the recall hot path and have **no matching `.test.ts`**. Indirect tests via `retrieval-observability.test.ts` and `retrieval-weight-learning.test.ts` exist but don’t isolate behaviour.
- **Fix:** Per-file unit tests with deterministic fixtures (mock vector store, mock graph index). Reranker should have golden cases (top-k stability under tied scores).
- **Effort:** 16h+.

#### CODE-22 — `memory-space-manager.ts` 950 LOC
- **Severity:** P2
- **File:** `memory/src/sharing/memory-space-manager.ts`
- **Fix:** Already has `compactTombstones` 84 LOC — split lifecycle (create/seal/compact) from membership (grant/revoke/list).
- **Effort:** 8h.

#### CODE-23 — `convention-extractor.ts` 748 LOC
- **Severity:** P3
- **File:** `memory/src/convention/convention-extractor.ts`
- **Fix:** Split per-extractor strategy.
- **Effort:** 8h.

### security (1 finding)

#### CODE-05 — Per-file unit tests missing
- **Severity:** P1
- **Files:** `security/src/pii/detector.ts`, `security/src/prompt-injection/detector.ts`, `security/src/prompt-injection/patterns.ts`
- **Why:** Aggregate tests exist (`__tests__/pii-detector.test.ts`, `prompt-injection.test.ts`) but each is <100 LOC for security-critical patterns. Pattern array is hand-maintained — needs golden fixtures.
- **Fix:** Add dedicated `patterns.test.ts` covering each pattern with allow/block fixtures (fixtures dir is empty: `security/src/prompt-injection/fixtures` has 0 files but is imported as if populated). **Empty fixture directory is its own bug — see CODE-24.**
- **Effort:** 8h.

#### CODE-24 — Empty fixture directory imported in tests
- **Severity:** P2
- **File:** `security/src/prompt-injection/fixtures/`
- **Why:** Directory exists with size 0 but `allow.fixtures.ts` and `warn-block.fixtures.ts` are referenced in coverage gap list. Either they were lost in a commit or never committed.
- **Fix:** Confirm via `git log --all --diff-filter=D -- security/src/prompt-injection/fixtures/`; restore or delete reference.
- **Effort:** 1–2h (investigation), 4h+ if regenerating fixtures.

### flow-ast / flow-dsl / flow-compiler (3 findings)

#### CODE-07 — `validate.ts` 1410 LOC + `parse.ts` 1077 LOC
- **Severity:** P2
- **Files:** `flow-ast/src/validate.ts`, `flow-ast/src/parse.ts`
- **Fix:** Split validate.ts by node-kind (already has helper modules `validation-descriptors.ts`, `validation-helpers.ts`, `validation-traversal.ts` — finish migration). Same for parse.
- **Effort:** 16h+ (large but mechanical because helpers exist).

#### CODE-25 — `flow-dsl/normalize.ts` 1018 LOC
- **Severity:** P3
- **File:** `flow-dsl/src/normalize.ts`
- **Effort:** 8h.

#### CODE-26 — `flow-compiler/stages/semantic.ts` 807 LOC; `visit` 117 LOC
- **Severity:** P2
- **File:** `flow-compiler/src/stages/semantic.ts:160`
- **Fix:** Extract per-node-kind visitors into a registry.
- **Effort:** 8h.

### evals (1 finding)

#### CODE-27 — `eval-orchestrator.ts` `executeRun` 95 LOC + `reconcilePersistedRuns` 84 LOC
- **Severity:** P2
- **File:** `evals/src/orchestrator/eval-orchestrator.ts:412,257`
- **Effort:** 4–8h.

### orchestration test gaps (CODE-06)

#### CODE-06 — `agent/src/orchestration/team/*` test gaps (25+ files)
- **Severity:** P2
- **Files:** All `team/team-runtime-*.ts` split modules, `team/patterns/*.ts`, `topology/*.ts`, `routing/*.ts`, `merge/*.ts`, `contract-net/*.ts`, `provider-adapter/*.ts`
- **Why:** Sprint B split a monolith into ~30 small files but per-file tests didn’t follow. Indirect coverage exists via integration tests in `__tests__/team-runtime.test.ts` but file-level regression detection is weak.
- **Fix:** Add a focused `<file>.test.ts` for the leaf primitives (`bid-strategies`, routing strategies, merge strategies — at least the ones still uncovered: `all-required`, `first-wins`, `use-partial`, `hash-routing`, `llm-routing`, `round-robin-routing`, `rule-based-routing`).
- **Effort:** 16h+.

### Cross-cutting / minor

#### CODE-28 — `as unknown` overuse (143 cases) suggests structural typing gaps
- **Severity:** P3
- **Files:** Distributed across all packages.
- **Why:** Each individual cast is small and arguably correct, but density indicates models that should be discriminated unions.
- **Fix:** Audit per package; many cases in `routes/*` chain `c.get('apiKey' as never) as Record<string, unknown> | undefined` — this collapses to one cast once CODE-01 lands.
- **Effort:** 16h+.

#### CODE-29 — `console.warn` used for stream-runner slow gap warning
- **Severity:** P3
- **Files:** `agent-adapters/src/base/stream-runner.ts`, `agent-adapters/src/middleware/memory-enrichment.ts`, `agent-adapters/src/dzupagent/syncer.ts`
- **Effort:** 1–2h.

#### CODE-30 — `connectors-browser/auth-handler.ts:128` uses `as never` for DOM probe
- **Severity:** P3
- **File:** `connectors-browser/src/browser/auth-handler.ts`
- **Why:** Probing `'__vue_app__' in (appEl as never)` to detect framework — works but `as Record<string, unknown>` is more honest.
- **Effort:** 1–2h.

#### CODE-31 — `flow-compiler/semantic.ts:324` uses `// eslint-disable no-new-func`
- **Severity:** P2
- **File:** `flow-compiler/src/stages/semantic.ts:324`
- **Why:** Dynamic function constructor in compiler stage — this is a real safety risk (RCE if compiler input is attacker-controlled). Already flagged in security audit context but verify input-source guarantees and document.
- **Fix:** Add a comment explaining the trust boundary; add a runtime guard that the input has been schema-validated by `flow-ast` first; if not, throw.
- **Effort:** 4h.

---

## Quick fixes (P1, < 2h each)

- **CODE-15** — Replace `console.error` in `server/src/lifecycle/human-contact-timeout.ts` with logger (1h).
- **CODE-30** — Replace `as never` DOM probe in `connectors-browser/src/browser/auth-handler.ts:128,132` (1h).
- **CODE-29** — Move 3 `console.warn` calls to logger in `agent-adapters` (1h).

(Note: CODE-01 is P1 but 4–8h, so it does not qualify here.)

---

## Refactor candidates (P2, 4–8h)

- **CODE-01** — Adopt `AppEnv` across server routes/middleware; strip `as never` (4–8h, P1 by impact).
- **CODE-02** — Split `executeStreamingToolCall` (8h).
- **CODE-09** — Extract DzupAgent constructor helpers (4h).
- **CODE-11** — Split `routes/runs.ts` (8h).
- **CODE-12** — Split `routes/compile.ts` (4–8h).
- **CODE-14** — Split `cli/doctor.ts` (4–8h).
- **CODE-17** — Slim `executeGenerateRunInner` (4–8h).
- **CODE-19** — Extract from `delegating-supervisor.ts` (8h).
- **CODE-20** — Extract codex event mapper (8h).
- **CODE-21** — `mapRawEvent` dispatch table (4h).
- **CODE-22** — Split `memory-space-manager.ts` (8h).
- **CODE-26** — `semantic.ts` visitor registry (8h).
- **CODE-27** — Slim `eval-orchestrator` (4–8h).
- **CODE-31** — Document `no-new-func` trust boundary (4h).

---

## Major changes (P3 / P2 ≥ 16h)

- **CODE-03** — Strategy-pattern refactor of `planSync` in `agent-adapters/dzupagent/syncer.ts`. Adding new agent targets becomes additive.
- **CODE-04** — Add per-file tests for `memory/src/retrieval/*` (16h+ for full coverage).
- **CODE-05 + CODE-24** — Restore security fixtures and add per-file pattern tests.
- **CODE-06** — Per-file tests for `agent/src/orchestration/team/*` and routing/merge primitives.
- **CODE-07** — Finish migration of `flow-ast/validate.ts` + `parse.ts` into per-kind helpers.
- **CODE-13** — Split `run-worker-stages.ts` per stage.
- **CODE-16** — Server runtime test coverage uplift (62% of files lack tests).
- **CODE-23** — Convention extractor split.
- **CODE-25** — `flow-dsl/normalize.ts` split.
- **CODE-28** — Reduce `as unknown` density via discriminated unions.

---

## What did NOT show up (positive findings)

- Zero `TODO`/`FIXME`/`HACK` markers in source — clean.
- Zero `JSON.parse` without try/catch.
- Zero empty `catch {}` blocks.
- Zero `// @ts-ignore` / `// @ts-expect-error` in production source (only in regex strings/docs).
- All `eslint-disable` lines have justifications (mostly `security/detect-unsafe-regex` for ReDoS-bounded patterns).
- The `: any` and `as any` matches are almost all in:
  - JSDoc/example strings
  - Comment patterns inside guardrail rules (which detect `any` in user code).
  - Real cases: only `core/src/llm/tokenizer.ts:86,97,100` (`globalThis as any` for runtime feature detection — eslint-disabled with reason) — acceptable.
- Prompt-cache (Critical from prior audit) is implemented.
- Workspace-write security tier is fixed.

---

## Suggested sprint plan

**Sprint 1 (1 week, 1 dev)** — Quick wins: CODE-15, CODE-29, CODE-30, CODE-01 (the big mechanical adopt), CODE-21. Net effect: 33 `as never` casts removed; logger consistency; server typing aligned with `AppEnv`.

**Sprint 2 (2 weeks, 1 dev)** — Function-size refactors: CODE-02, CODE-03, CODE-09, CODE-17, CODE-19, CODE-20. Hot paths in tool-loop, syncer, and supervisor become testable per-piece.

**Sprint 3 (2 weeks, 1 dev)** — Test coverage: CODE-04, CODE-05, CODE-06, CODE-24. Closes the security and recall coverage gaps.

**Sprint 4 (2 weeks, 1 dev)** — God-file splits: CODE-07, CODE-11, CODE-12, CODE-13, CODE-22, CODE-25, CODE-26.

Total: ~7 dev-weeks, 27 findings closed.
