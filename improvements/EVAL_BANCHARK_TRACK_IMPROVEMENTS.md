# EVAL_BANCHARK_TRACK_IMPROVEMENTS

## Scope
Analysis covers the current implementation in:
- `packages/evals`
- `packages/otel`
- `packages/playground`
- `packages/rag`
- `packages/server`
- `packages/core`
- `packages/scraper`

Focus area: memory/context-related execution flow, evaluation/benchmarking track, observability, and interface quality.

---

## Executive Summary
The repo has strong building blocks, but the benchmark/eval track is not yet an end-to-end productized flow. The current state is best described as "powerful primitives without a unified runtime track." The largest issues are:

1. **Eval runner does not execute system-under-test outputs** (uses `expectedOutput` as `output`), which limits true regression signal.
2. **RAG retriever is tenant-sticky** due to a single cached retriever instance bound to first tenant collection.
3. **Server + Playground do not expose a benchmark/eval run pipeline** (no eval routes, no benchmark UI route).
4. **OTel trace context is only partially wired** (trace IDs extracted for logs, but not propagated into OTel async context).
5. **Scraper extraction and robots config are declared but not functionally applied.**

---

## Severity-Ranked Findings

### Critical

#### 1) RAG cross-tenant retrieval contamination risk via cached retriever
- Evidence:
  - `packages/rag/src/pipeline.ts:97` keeps a single `private retriever` instance.
  - `packages/rag/src/pipeline.ts:265-292` creates retriever once using the first tenant's `collectionName`.
  - Subsequent `retrieve()` calls (`packages/rag/src/pipeline.ts:192-203`) reuse that same retriever regardless of tenant.
- Impact:
  - In multi-tenant systems, retrieval may query wrong collection after first tenant initialization.
  - This is a data isolation and correctness risk.
- Gap:
  - Missing tenant-aware retriever cache (`Map<tenantId, HybridRetriever>`) or per-call retriever binding.

#### 2) Enhanced eval runner evaluates references against references
- Evidence:
  - `packages/evals/src/runner/enhanced-runner.ts:114-117` sets:
    - `output: entry.expectedOutput ?? ''`
    - `reference: entry.expectedOutput`
- Impact:
  - The runner cannot benchmark a real model/agent output without external wiring.
  - Regression checks can report confidence while not validating real generation quality.
- Gap:
  - Missing "target executor" abstraction in `EvalRunnerConfig` (e.g., `execute(input) -> output`).

### High

#### 3) Benchmark scoring still uses placeholder logic for LLM judge path
- Evidence:
  - `packages/evals/README.md:338` explicitly documents placeholder-style benchmark scoring.
  - `packages/evals/src/benchmarks/benchmark-runner.ts:174-178` falls back to non-empty heuristic when no LLM function is provided.
- Impact:
  - Easy to get false-positive benchmark passes in CI when judge wiring is omitted.
- Gap:
  - Missing strict mode requiring real scorer provider per scorer type.

#### 4) OTel context exists but runtime does not enter async trace scope
- Evidence:
  - OTel context APIs exist in `packages/otel/src/trace-context-store.ts:52-77`.
  - Run worker extracts trace ID only for log correlation in `packages/server/src/runtime/run-worker.ts:163-169`.
- Impact:
  - Incomplete trace continuity across async operations.
  - Span linking quality and distributed debugability are reduced.
- Gap:
  - Missing `withForgeContext` wrapping around run execution lifecycle in server runtime.

#### 5) No server benchmark/eval API surface
- Evidence:
  - Server route mounting in `packages/server/src/app.ts:220-251` has runs, memory, learning, playground, but no eval/benchmark routes.
  - Search in routes yields no eval benchmark endpoints.
- Impact:
  - Benchmarking is library-only, not operationalized for server deployments.
- Gap:
  - Missing `/api/evals/*` and `/api/benchmarks/*` endpoints, persistence, and background execution model.

### Medium

#### 6) Playground has no benchmark/eval workflow route
- Evidence:
  - Router only includes `/`, `/agents`, `/marketplace`, `/runs/:id` (`packages/playground/src/router/index.ts:6-27`).
- Impact:
  - No operator UX for benchmark runs, regression review, baseline management.
- Gap:
  - Missing benchmark dashboard and run-comparison views.

#### 7) RAG quality boosting partially stubbed
- Evidence:
  - `extractSourceQuality()` always returns `0.5` (`packages/rag/src/retriever.ts:231-235`).
- Impact:
  - `qualityBoosting` does not fully use source-level quality signals.
- Gap:
  - Missing metadata normalization for source quality extraction.

#### 8) RagMemoryNamespace config contract not fully enforced
- Evidence:
  - `scopeKeys` declared in config (`packages/rag/src/memory-namespace.ts:16-21`) but never validated/enforced.
- Impact:
  - Scope consistency depends on caller discipline, can create isolation drift.
- Gap:
  - Missing `normalizeAndValidateScope(scope, requiredKeys)` guard.

#### 9) Scraper extraction options are not propagated
- Evidence:
  - `scrapeHttp()` accepts `_options` but ignores them (`packages/scraper/src/scraper.ts:159-165`).
  - `HttpFetcher.fetch()` always extracts with `{ mode: 'all', cleanHtml: true }` (`packages/scraper/src/http-fetcher.ts:54`).
- Impact:
  - Declared extraction API does not match behavior.
- Gap:
  - Missing option plumbing for mode/cleanHtml/maxLength.

#### 10) Scraper robots.txt option is declared but not implemented
- Evidence:
  - Config includes `respectRobotsTxt` (`packages/scraper/src/http-fetcher.ts:15`, `packages/scraper/src/types.ts`), but fetch path does not evaluate robots rules.
- Impact:
  - Compliance expectation mismatch for crawler behavior.
- Gap:
  - Missing robots parser + cache + preflight allow/deny check.

### Low

#### 11) Core API discoverability and abstraction density are very high
- Evidence:
  - `packages/core/src/index.ts` is 831 lines.
  - `packages/core/src/facades/memory.ts` is 387 lines.
- Impact:
  - Cognitive load for consumers; harder to identify minimal stable interfaces.
- Gap:
  - Missing layered interface model (`core-stable`, `core-advanced`, capability-specific adapters).

#### 12) Scorecard relies on externally supplied probes for many critical checks
- Evidence:
  - Multiple `skipCheck(... 'Not evaluated')` branches in `packages/server/src/scorecard/integration-scorecard.ts:150,161,178,202,213,230,284,298`.
- Impact:
  - Useful for advisory reports, but weak as enforceable deployment gate without probe automation.
- Gap:
  - Missing automatic probe collectors for CI/runtime environments.

---

## Implementation Gaps by Package

## `packages/evals`
Missing implementation:
- Target execution contract in enhanced runner.
- Strict scoring mode to disallow heuristic fallbacks in benchmark mode.
- Baseline persistence and trend store (currently compare-in-memory).
- First-class benchmark run artifact model (`runId`, build SHA, model versions, prompt version, dataset hash).

Improvements:
- Add `EvalRunnerConfig.target: (input, metadata) => Promise<{ output, latencyMs?, costCents?, traceId? }>`.
- Add `strict: true` mode to fail benchmark run if scorer dependencies are missing.
- Add `BenchmarkRunStore` interface (file/db) with immutable run snapshots.

## `packages/rag`
Missing implementation:
- Tenant-aware retriever lifecycle.
- Source-quality extraction implementation.
- Scope key enforcement in memory namespace.
- Optional summarization path exists in type (`autoSummarize`) but not implemented in pipeline.

Improvements:
- Use `Map<string, HybridRetriever>` keyed by tenant.
- Introduce `RagScope` type and mandatory normalization.
- Add `SourceQualityProvider` strategy for metadata-driven weighting.
- Implement `autoSummarize` with summary cache keyed by source hash.

## `packages/server`
Missing implementation:
- No eval/benchmark API routes and orchestration.
- No persisted benchmark baseline registry by suite + target + model profile.
- Trace context not promoted to async context execution boundary.

Improvements:
- Add routes:
  - `POST /api/benchmarks/runs`
  - `GET /api/benchmarks/runs/:id`
  - `POST /api/benchmarks/compare`
  - `GET /api/benchmarks/baselines`
  - `PUT /api/benchmarks/baselines/:suiteId`
- Add queue-backed benchmark execution and run logs/traces.
- Wrap worker run execution in `withForgeContext` from extracted metadata.

## `packages/playground`
Missing implementation:
- No benchmark/eval UX.
- No baseline drift visualization.
- No memory-context quality diagnostics per run.

Improvements:
- New routes/views:
  - `/benchmarks`
  - `/benchmarks/:runId`
- Add comparison table (current vs baseline vs previous).
- Add context quality panel: token budget, citation coverage, retrieval precision proxy.

## `packages/otel`
Missing implementation:
- No bridge from server run trace metadata into async local trace context lifecycle.
- Limited semantic events for eval/benchmark lifecycle.

Improvements:
- Add benchmark span helpers (`benchmark.run`, `benchmark.case`, `benchmark.scorer`).
- Add standardized attributes: suite id, dataset version/hash, baseline delta.
- Add trace context bootstrap utility from run metadata to OTel context boundary.

## `packages/core`
Missing implementation:
- Stable minimal interface layer for common consumers.
- Clear separation of "blessed" vs "expert" APIs.

Improvements:
- Introduce facade tiers:
  - `@dzipagent/core/stable`
  - `@dzipagent/core/memory`
  - `@dzipagent/core/observability`
  - `@dzipagent/core/evals` (new)
- Introduce shared contracts package for cross-package interfaces (benchmark run artifact, retrieval diagnostics, run telemetry envelope).

## `packages/scraper`
Missing implementation:
- robots.txt enforcement.
- extraction options propagation.
- clear structured extraction contract for RAG ingestion mode.

Improvements:
- Add `ScrapeForRagResult` and `scrapeForRag()` helper returning normalized source metadata and chunks-ready payload.
- Add robots checker with per-domain cache and TTL.
- Make extraction mode fully honored end-to-end.

---

## Proposed New Core Features

1. **Benchmark Track Core (`@dzipagent/core/evals`)**
- Shared interfaces:
  - `BenchmarkTarget`
  - `BenchmarkRunArtifact`
  - `BaselinePolicy`
  - `RegressionDecision`
- Benefits:
  - Unifies eval contracts across server, playground, and CLI.

2. **Retrieval Diagnostics Envelope**
- Standardized object attached to runs:
  - topK ids
  - rerank deltas
  - token-budget drops
  - citation coverage score
- Benefits:
  - Makes memory/context quality measurable in both runtime and benchmarks.

3. **Context Quality Gates**
- Rule engine before final generation:
  - min citation count
  - max unsupported claim risk (scorer output)
  - min retrieval confidence.
- Benefits:
  - Converts context quality from analytics-only to enforcement-ready.

4. **Trace-Linked Evaluation IDs**
- Every eval case and benchmark run gets trace-correlated IDs.
- Benefits:
  - One-click drilldown from benchmark regression to raw run trace.

5. **Dataset Provenance & Freeze**
- Dataset hash/version stored with each run.
- Baseline comparisons blocked when dataset hash mismatches unless explicitly overridden.

---

## Refactoring Plan for Reusability and Better Abstractions

## 1) Introduce shared contract package
Create `packages/contracts-evals` (or `packages/core-contracts`) with:
- `EvalCaseExecution`
- `EvalRunSummary`
- `BenchmarkRunRecord`
- `RetrievalQualityMetrics`

Why:
- Removes duplicated shape definitions across evals/server/playground.
- Enables stable interfaces for integrations.

## 2) Decouple execution from scoring in evals
Current issue: runner owns input shape and assumes output.
Refactor to:
- `Executor` stage: generates outputs.
- `Scoring` stage: scores generated outputs.
- `Aggregation` stage: baseline/regression decisions.

Why:
- Clear SRP boundaries.
- Easier to test each stage and swap implementations.

## 3) Tenant-safe retriever factory
Refactor `RagPipeline`:
- replace single `retriever` with factory/cache per tenant.
- include explicit `disposeTenant(tenantId)`.

Why:
- Prevents collection cross-binding.
- improves lifecycle control.

## 4) Server benchmark service boundary
Add services:
- `BenchmarkOrchestrator`
- `BaselineService`
- `BenchmarkPersistence`

Why:
- Keeps routes thin and testable.
- Enables CLI + HTTP parity via shared service.

## 5) Playground data access layer
Create typed clients:
- `BenchmarkApiClient`
- `EvalApiClient`
- `RetrievalDiagnosticsClient`

Why:
- Reduces ad-hoc endpoint string usage and response-shape coupling.

---

## Target End-State: Benchmark Track Architecture

Flow:
1. User/CI triggers benchmark suite run (`server` API/CLI).
2. Server enqueues benchmark run and executes via `evals` with real target executor.
3. Each case emits OTel spans and retrieval diagnostics.
4. Results persisted as immutable run artifact with dataset/model/prompt provenance.
5. Regression engine compares against managed baseline policy.
6. Playground renders trend and diff (suite, scorer, case-level drilldown).

Core entities:
- `BenchmarkSuiteDefinition`
- `BenchmarkRunArtifact`
- `BenchmarkBaseline`
- `BenchmarkComparison`
- `RegressionPolicy`

---

## Delivery Roadmap

### Phase 1 (Correctness and Risk)
- Fix tenant-sticky retriever in `rag`.
- Add executor contract to `evals` runner.
- Add strict mode to benchmark scoring (no placeholder fallback in strict).
- Wire `withForgeContext` in server worker path.

### Phase 2 (Productization)
- Implement benchmark/eval server routes + queue worker.
- Add benchmark persistence + baseline management.
- Add playground benchmark routes and comparison UI.

### Phase 3 (Quality and Governance)
- Add retrieval diagnostics envelope and context quality gates.
- Add OTel benchmark semantic spans and attributes.
- Add automated scorecard probes to reduce skip-based checks.

---

## Acceptance Criteria

1. Running benchmark with strict mode fails if any scorer dependency is missing.
2. Benchmarks use real generated outputs, not expected output placeholders.
3. Multi-tenant RAG retrieval is tenant-correct across mixed tenant traffic.
4. Every benchmark run can be compared to baseline with persisted provenance.
5. Playground can display benchmark trend, regression deltas, and case drilldown.
6. Benchmark spans are correlated with run traces via trace IDs.

---

## Suggested Immediate PR Breakdown

1. `fix(rag): make retriever tenant-aware and add scope validation`
2. `feat(evals): add target executor contract and strict benchmark mode`
3. `feat(server): add benchmark run and baseline routes + persistence`
4. `feat(playground): add benchmark dashboard and run comparison views`
5. `feat(otel): add benchmark semantic spans and run-context bridging`
6. `refactor(core): add stable eval contracts and facade split`

