# Eval/Benchmark Track Improvement Plan

Date: 2026-03-29
Source reviewed: `improvements/EVAL_BANCHARK_TRACK_IMPROVEMENTS.md`

## Review Outcome

The improvement note is directionally correct and mostly validated against the codebase. The following high-impact gaps are confirmed in current code:

1. `packages/rag/src/pipeline.ts`: single cached retriever (`private retriever`) causes tenant stickiness.
2. `packages/evals/src/runner/enhanced-runner.ts`: runner scores `expectedOutput` as both output and reference, so no real system-under-test execution.
3. `packages/evals/src/benchmarks/benchmark-runner.ts`: `llm-judge` fallback remains heuristic when `llm` is missing.
4. `packages/server/src/app.ts`: no benchmark/eval routes are mounted.
5. `packages/playground/src/router/index.ts`: no benchmark/eval route/view.
6. `packages/server/src/runtime/run-worker.ts`: trace id is extracted for logs, but execution is not wrapped in `withForgeContext`.
7. `packages/rag/src/retriever.ts`: source quality extraction is stubbed (`return 0.5`).
8. `packages/rag/src/memory-namespace.ts`: `scopeKeys` declared but not enforced.
9. `packages/scraper/src/scraper.ts` + `packages/scraper/src/http-fetcher.ts`: extraction options not propagated end-to-end.
10. `packages/scraper/src/types.ts` + `packages/scraper/src/http-fetcher.ts`: `respectRobotsTxt` declared but not implemented.

Notes:
- The proposal to split `@dzipagent/core` into multiple facade tiers is valid but broad. It should be staged after correctness/productization work.
- The note filename has a typo (`BANCHARK`). Keep existing filename for traceability unless requested to rename.

## Delivery Strategy

Use 3 execution waves:

- Wave 1: correctness and isolation fixes (minimal API breakage).
- Wave 2: benchmark/eval productization (server + persistence + UI).
- Wave 3: governance, observability depth, and API shaping.

Each wave should end in a mergeable set of PRs with full workspace checks:
`yarn build && yarn typecheck && yarn lint && yarn test`

## Work Plan by PR

## PR-1: `fix(rag): tenant-safe retriever + scope validation + source quality`

Scope:
- `packages/rag/src/pipeline.ts`
- `packages/rag/src/memory-namespace.ts`
- `packages/rag/src/retriever.ts`
- `packages/rag/src/__tests__/*` (new/updated)

Changes:
1. Replace singleton retriever with tenant-aware cache:
   - `private retrievers = new Map<string, HybridRetriever>()`
   - `getRetriever(tenantId)` returns per-tenant instance.
   - add optional lifecycle method: `disposeTenant(tenantId)` and `disposeAll()`.
2. Enforce scope contract in `RagMemoryNamespace`:
   - validate presence/non-empty values for configured `scopeKeys`.
   - reject unknown/empty keys in strict normalization helper.
3. Implement real source quality extraction:
   - parse metadata fields like `source_quality`, `sourceQuality`, `domain_authority`.
   - clamp to `[0,1]`, fallback to `0.5`.

Tests:
- Mixed-tenant retrieval test proving collection isolation.
- Scope validation tests (`missing key`, `empty key`, `valid key set`).
- Quality extraction tests with different metadata shapes.

Definition of done:
- No cross-tenant retrieval contamination in test harness.
- RAG APIs remain backward-compatible for existing callers.

## PR-2: `feat(evals): real target execution + strict scoring mode`

Scope:
- `packages/evals/src/runner/enhanced-runner.ts`
- `packages/evals/src/benchmarks/benchmark-runner.ts`
- `packages/evals/src/types.ts` (if needed)
- `packages/evals/README.md`
- tests under `packages/evals/src/**/__tests__`

Changes:
1. Add executor contract to enhanced runner:
   - `target?: (input, metadata) => Promise<{ output: string; latencyMs?: number; costCents?: number; traceId?: string }>`
   - if `target` exists, use generated output; otherwise fallback to legacy behavior for compatibility.
2. Add strict mode:
   - `strict?: boolean` in benchmark config.
   - for `llm-judge` scorer, throw when `strict === true` and `llm` is missing.
3. Include run metadata in report entries (latency/cost/trace id when available).
4. Update docs with strict mode examples and migration note.

Tests:
- Runner uses target output (not expected output).
- Strict mode failure when dependencies missing.
- Non-strict mode preserves current fallback behavior.

Definition of done:
- Benchmarks can execute a real SUT end-to-end.
- CI can enforce no-heuristic scoring in strict mode.

## PR-3: `feat(server): benchmark API + orchestrator + persistence`

Scope:
- `packages/server/src/app.ts`
- `packages/server/src/routes/benchmarks.ts` (new)
- `packages/server/src/services/benchmark-orchestrator.ts` (new)
- `packages/server/src/persistence/benchmark-run-store.ts` (new, plus in-memory impl)
- `packages/server/src/types/*` (new types as needed)
- tests in `packages/server/src/__tests__`

Changes:
1. Add REST surface:
   - `POST /api/benchmarks/runs`
   - `GET /api/benchmarks/runs/:id`
   - `POST /api/benchmarks/compare`
   - `GET /api/benchmarks/baselines`
   - `PUT /api/benchmarks/baselines/:suiteId`
2. Introduce service boundary:
   - `BenchmarkOrchestrator`
   - `BaselineService`
   - `BenchmarkRunStore` abstraction (start with in-memory adapter).
3. Add queue-friendly execution path (start synchronous if needed, keep async-ready API shape).

Tests:
- route contract tests (status, payload shape, error paths).
- baseline update/compare behavior.

Definition of done:
- Benchmarks are operable through server APIs, not only library calls.

## PR-4: `feat(server+otel): trace-context bridging for run execution`

Scope:
- `packages/server/src/runtime/run-worker.ts`
- `packages/otel/src/*` (helper additions if required)
- `packages/server` runtime tests

Changes:
1. Build Forge context from run metadata + run/agent ids.
2. Wrap run execution lifecycle with `withForgeContext(...)`.
3. Ensure nested async operations can read current context.
4. Keep extraction failure non-fatal.

Tests:
- Async boundary propagation test using `currentForgeContext()`.
- Ensure logs still include traceId fallback when no context.

Definition of done:
- Trace correlation is available through async execution path, not only log fields.

## PR-5: `feat(playground): benchmark dashboard + run comparison`

Scope:
- `packages/playground/src/router/index.ts`
- new views/components under `packages/playground/src/views` and `src/components`
- API client module(s) under `src/api`
- UI tests if existing test setup supports them

Changes:
1. Add routes:
   - `/benchmarks`
   - `/benchmarks/:runId`
2. Add benchmark list/run detail/comparison views.
3. Add baseline delta visualization and case-level drilldown.
4. Keep UX thin over server APIs (no business logic duplication).

Definition of done:
- Operator can trigger, inspect, and compare runs via playground.

## PR-6: `feat(scraper): extraction options + robots enforcement`

Scope:
- `packages/scraper/src/scraper.ts`
- `packages/scraper/src/http-fetcher.ts`
- `packages/scraper/src/types.ts`
- new helper: `packages/scraper/src/robots.ts` (if implemented)
- tests under `packages/scraper/src/__tests__`

Changes:
1. Thread extraction options (`mode`, `cleanHtml`, `maxLength`) through `WebScraper -> HttpFetcher -> ContentExtractor`.
2. Implement `respectRobotsTxt`:
   - fetch and parse `/robots.txt` by origin.
   - in-memory cache with TTL.
   - deny fetch when disallowed for configured user-agent.
3. Preserve opt-out behavior when `respectRobotsTxt=false`.

Tests:
- extraction mode propagation cases.
- robots allow/deny behavior with cached rules.

Definition of done:
- Public scraper config matches actual runtime behavior.

## PR-7: `feat(evals+server+playground): run artifact provenance and baseline policy`

Scope:
- `packages/evals`, `packages/server`, `packages/playground`
- optional shared types package (`packages/contracts-evals`) if introduced now

Changes:
1. Persist immutable run artifact fields:
   - `runId`, `suiteId`, `datasetHash`, `model`, `promptVersion`, `buildSha`, timestamps.
2. Baseline comparison guard:
   - block compare when dataset hash differs unless explicit override.
3. Add trend/history APIs and UI.

Definition of done:
- Regressions are compared on provenance-compatible runs only.

## PR-8 (optional, post-stabilization): `refactor(core): contracts + facade split`

Scope:
- `packages/core`, optional `packages/contracts-evals`

Changes:
1. Introduce stable contracts module for eval/benchmark artifacts and retrieval diagnostics.
2. Re-export from `core` progressively to avoid breaking imports.
3. Deprecate direct deep imports with migration notes.

Definition of done:
- Shared interfaces are centralized without breaking existing consumers.

## Dependency Graph

Execution order:
1. PR-1 and PR-2 in parallel (different packages, minimal overlap).
2. PR-4 can run in parallel with PR-3.
3. PR-5 depends on PR-3 API readiness.
4. PR-6 can run in parallel with PR-3/4/5.
5. PR-7 depends on PR-2 and PR-3; PR-5 consumes it for trend UI.
6. PR-8 only after PR-1..PR-7 stabilize.

## Risk Register and Mitigations

1. API churn risk in eval runner:
   - Mitigation: additive config fields + backward-compatible defaults.
2. Server route sprawl:
   - Mitigation: route handlers remain thin; orchestration in service layer.
3. Multi-tenant regression risk in RAG:
   - Mitigation: dedicated mixed-tenant tests + explicit retriever cache lifecycle.
4. Robots parser edge cases:
   - Mitigation: conservative parser with clear deny/allow precedence and tests.
5. UI drift from backend payloads:
   - Mitigation: typed API client and contract tests against route schemas.

## Validation Matrix

Per PR:
- Unit tests for changed modules.
- Package-level test run for touched workspace.

Per wave:
- Full monorepo gate:
  - `yarn build`
  - `yarn typecheck`
  - `yarn lint`
  - `yarn test`

Operational checks after PR-3+PR-5:
- Trigger benchmark run via API and via Playground.
- Compare against baseline.
- Verify strict mode failure path.
- Verify trace id correlation through run logs/context.

## Suggested Execution Start (Next Actions)

1. Start PR-1 and PR-2 immediately (highest correctness ROI).
2. In parallel, scaffold server benchmark route/service/store skeletons (PR-3).
3. After PR-3 API contracts are stable, implement Playground routes/views (PR-5).

