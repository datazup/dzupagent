# Wave 21 — Implementation Tracking

> **Start date**: 2026-04-17  
> **Target**: ≥200 new tests, close 5 gaps  
> **Theme**: Orchestrator Deep + RAG Pipeline + OTel Vector Metrics + Server Run Executor + Cache Middleware

---

## Gap Assessment (pre-wave)

| Gap | Prior state | Wave 21 action |
|-----|------------|----------------|
| CF-0022 Multi-agent orchestration | `orchestrator.ts` 434 LOC, 58 tests; `supervisor.ts` 11 tests | Deep expand: 65+ tests |
| CF-0023 RAG corpus / pipeline | `pipeline.ts` 339 LOC (34 tests), `quality-retriever.ts` (9 tests), `assembler.ts` 278 LOC (40 tests) | Deep expand: 60+ tests |
| CF-0058 OTel observability | `vector-metrics.ts` 112 LOC (9 tests), `cost-attribution.ts` 287 LOC — gaps in vector path | Deep expand: 40+ tests |
| — Server run executor | `default-run-executor.ts` + run routes — deep integration gaps | Deep expand: 45+ tests |
| — Cache middleware | `middleware.ts` 6 tests, `cache-middleware.test.ts` 6 tests — very shallow | Deep expand: 35+ tests |

---

## Task Summary

| ID | Task | Package | Gap | Target Tests | Agent | Status |
|----|------|---------|-----|-------------|-------|--------|
| W21-A1 | Agent orchestrator + supervisor deep coverage | `agent` | CF-0022 | +65 | dzupagent-agent-dev | pending |
| W21-A2 | RAG pipeline + quality-retriever + assembler deep | `rag` | CF-0023 | +60 | dzupagent-agent-dev | pending |
| W21-B1 | OTel vector-metrics + cost-attribution deep | `otel` | CF-0058 | +40 | dzupagent-test-dev | pending |
| W21-B2 | Server run executor deep coverage | `server` | — | +45 | dzupagent-server-dev | pending |
| W21-B3 | Cache middleware deep coverage | `cache` | — | +35 | dzupagent-test-dev | pending |

---

## Detailed Task Specs

### W21-A1: Agent Orchestrator + Supervisor Deep Coverage (CF-0022)

**Goal**: `orchestrator.ts` (434 LOC) has 58 tests across 3 files. `supervisor.ts` equivalent has 11 tests. Both need deep coverage of branching paths.

**Files to read first**:
- `packages/agent/src/orchestration/orchestrator.ts` (434 LOC)
- `packages/agent/src/orchestration/orchestration-error.ts`
- `packages/agent/src/orchestration/orchestration-merge-strategy-types.ts`
- `packages/agent/src/__tests__/orchestrator-patterns.test.ts` (gap analysis — 38 tests)
- `packages/agent/src/__tests__/supervisor.test.ts` (gap analysis — 11 tests)
- `packages/agent/src/orchestration/__tests__/orchestration-paths.test.ts` (gap analysis — 9 tests)

**Action**: Create `packages/agent/src/__tests__/orchestrator-deep.test.ts` with 65+ tests.

Cover all orchestration patterns found in the implementation:
- Sequential execution: tasks run in order, later tasks receive prior results
- Parallel execution: tasks run concurrently, all results collected
- Supervisor pattern: delegate to sub-agents, collect results
- Error handling: one sub-agent fails → orchestrator handles (fail-fast vs continue)
- Merge strategies: found in `orchestration-merge-strategy-types.ts` — test each
- Timeout: sub-agent takes too long → timeout error
- Cancellation: orchestration cancelled mid-flight
- Retry: sub-agent fails → retried up to N times
- `OrchestratorError` (from `orchestration-error.ts`): correct type, message, cause
- Telemetry: `orchestration-telemetry.ts` events emitted correctly
- Empty task list: handled gracefully
- Single task: same as sequential with 1 item
- All tasks fail: aggregate error reported
- Partial success: some tasks fail, others succeed
- Result ordering: parallel results returned in deterministic order

**Acceptance criteria**: 65+ new tests, all 2748 existing agent tests pass.

---

### W21-A2: RAG Pipeline + Quality-Retriever + Assembler Deep (CF-0023)

**Goal**: Three under-tested RAG components: `pipeline.ts` (339 LOC, 34 tests), `quality-retriever.ts` (9 tests), `assembler.ts` (278 LOC, 40 tests).

**Files to read first**:
- `packages/rag/src/pipeline.ts` (339 LOC)
- `packages/rag/src/quality-retriever.ts`
- `packages/rag/src/assembler.ts` (278 LOC)
- Existing test files (gap analysis before writing)

**Deliverables**:

1. `packages/rag/src/__tests__/pipeline-deep.test.ts` — 30+ tests:
   - Pipeline with no steps: passes input unchanged
   - Single retrieval step: correct documents retrieved
   - Retrieval + reranking: documents reordered by score
   - Retrieval + filtering: low-score documents removed
   - Error in step: pipeline fails with descriptive error
   - Empty query: handled (returns [] or throws)
   - Score threshold: documents below threshold excluded
   - Max results limit: at most N documents returned
   - Pipeline config: namespace, scope, limit wired correctly
   - Streaming pipeline if implemented: chunks emitted in order

2. `packages/rag/src/__tests__/quality-retriever-deep.test.ts` — 15+ tests:
   - Read `quality-retriever.ts` fully before writing
   - Quality score calculation: higher quality docs ranked first
   - Mixed quality docs: correct ordering
   - All low quality: returns [] or filters all
   - Min quality threshold configurable
   - Deduplication: same content → single result
   - Error from underlying retriever: propagated
   - Empty result from underlying retriever: returns []

3. `packages/rag/src/__tests__/assembler-deep.test.ts` — 15+ tests:
   - Gap-fill from existing assembler tests (read both assembler test files)
   - Token budget: assembler stops adding chunks when budget reached
   - Citation formatting: correct format produced
   - Empty chunks: returns empty string or minimal header
   - Single chunk: no separator needed
   - Multi-chunk: separator between chunks
   - Header/footer injection if supported
   - Truncation of long chunks

**Acceptance criteria**: 60+ new tests, all 231 existing rag tests pass.

---

### W21-B1: OTel Vector Metrics + Cost Attribution Deep (CF-0058)

**Goal**: `vector-metrics.ts` (112 LOC) has only 9 tests. `cost-attribution.ts` (287 LOC) has gaps. Add 40+ tests.

**Files to read first**:
- `packages/otel/src/vector-metrics.ts` (112 LOC)
- `packages/otel/src/cost-attribution.ts` (287 LOC)
- `packages/otel/src/__tests__/vector-metrics.test.ts` (gap analysis — 9 tests)
- `packages/otel/src/__tests__/cost-attribution.test.ts` (gap analysis)
- `packages/otel/src/__tests__/cost-attribution-extended.test.ts` (gap analysis)

**Deliverables**:

1. `packages/otel/src/__tests__/vector-metrics-deep.test.ts` — 25+ tests:
   - Read `vector-metrics.ts` fully before writing
   - All metric types: latency, throughput, error rate, dimension count
   - Record embedding operation: correct metric attributes
   - Record search operation: latency histogram populated
   - Record indexing operation: index size metric
   - Batch operations: batch size attribute recorded
   - Error recording: error metric incremented
   - Metric naming: follows OTel naming conventions (dots, not underscores)
   - Attributes: model name, namespace, collection name
   - Noop mode: no metrics recorded when disabled

2. `packages/otel/src/__tests__/cost-attribution-deep.test.ts` — 15+ tests:
   - Gap-fill from existing cost-attribution tests
   - Read the implementation to find untested paths
   - Multi-provider cost aggregation
   - Cost per agent/session/run breakdown
   - Budget limit threshold triggers
   - Zero-cost operations
   - Currency precision

**Acceptance criteria**: 40+ new tests, all 877 existing otel tests pass.

---

### W21-B2: Server Run Executor Deep Coverage

**Goal**: The run executor is the heart of `@dzupagent/server` — deep integration paths not fully tested.

**Files to read first**:
- `packages/server/src/__tests__/default-run-executor.test.ts` (gap analysis)
- `packages/server/src/__tests__/dzip-agent-run-executor.test.ts` (gap analysis)
- `packages/server/src/__tests__/dzip-agent-run-executor.correlation.test.ts` (gap analysis)
- The actual implementation files these tests cover

**Action**: Create `packages/server/src/__tests__/run-executor-deep.test.ts` with 45+ tests.

Cover gaps found after reading existing tests:
- Run lifecycle: created → running → completed state transitions
- Run cancellation mid-execution
- Run timeout: max duration exceeded
- Concurrent runs: two runs for same agent
- Error propagation: executor error → run marked failed
- Event emission: RunStarted, StepCompleted, RunCompleted events emitted
- Retry logic if implemented
- Correlation ID: propagated through all events
- Memory isolation between runs
- Tool call recording during execution
- Stream path: events emitted on stream during execution
- Input validation: missing required fields rejected

**Acceptance criteria**: 45+ new tests, all 1777 existing server tests pass.

---

### W21-B3: Cache Middleware Deep Coverage

**Goal**: `middleware.ts` is the core cache layer but has only 6+22 tests across two files.

**Files to read first**:
- `packages/cache/src/middleware.ts`
- `packages/cache/src/__tests__/cache-middleware.test.ts` (6 tests — gap analysis)
- `packages/cache/src/__tests__/middleware-advanced.test.ts` (16 tests — gap analysis)
- `packages/cache/src/__tests__/middleware-deep.test.ts` (22 tests — gap analysis)

**Action**: Create `packages/cache/src/__tests__/cache-middleware-deep.test.ts` with 35+ tests.

Cover gaps:
- Cache hit: response returned from cache, backend not called
- Cache miss: backend called, result stored in cache
- Cache key generation: model+messages+config hashed correctly
- TTL: cached item expires, backend re-called after expiry
- Cache bypass: `noCache` option skips cache
- Cache invalidation: `invalidate()` removes entry
- Partial response caching: streaming responses cached when complete
- Error from backend: not cached (error pass-through)
- Concurrent identical requests: deduplication (only one backend call)
- Cache metrics: hit/miss counters incremented
- Different model configs produce different cache keys
- Large response: stored and retrieved correctly
- Empty response: stored as empty, not re-fetched

**Acceptance criteria**: 35+ new tests, all 144 existing cache tests pass.

---

## Progress

| ID | Status | Tests Added | Notes |
|----|--------|-------------|-------|
| W21-A1 | ✅ DONE | **69** | `orchestrator-deep.test.ts`. 2817 agent tests pass (was 2748). Covers sequential/parallel/supervisor deep paths, circuit breaker integration, routing policy, merge strategy edges, OrchestrationError, orchestration-telemetry helpers, debate, provider-adapter mode. |
| W21-A2 | ✅ DONE | **84** | `pipeline-deep.test.ts` (36) + `quality-retriever-deep.test.ts` (20) + `assembler-deep.test.ts` (28). 315 rag tests pass (was 231). Covers ingest metadata propagation, retrieve error paths, assembleContext fallbacks, batch embedding boundaries, retriever cache lifecycle; quality boost boundaries & default fallbacks; assembler token budget edges, citation numbering, multi-chunk separators, ordering, source breakdown aggregation. |
| W21-B1 | DONE | **49** | `vector-metrics-deep.test.ts` (30) + `cost-attribution-deep.test.ts` (19). 926 otel tests pass. |
| W21-B2 | DONE | **47** | `run-executor-deep.test.ts`. 1824 server tests pass (was 1777). Covers lifecycle, cancellation, timeout, concurrency, errors, streaming, metadata, logs. |
| W21-B3 | DONE | **35** | `cache-middleware-w21.test.ts`. 179 cache tests pass (was 144). Covers hit/miss, key generation, TTL, bypass, errors, concurrency, large payloads, invalidation. |
| **Total** | — | **284 / ≥200** | All 5 tasks complete. |

---

## Wave 22 Candidates (preview)

- `@dzupagent/server` — WebSocket event bridge deep coverage
- `@dzupagent/memory-ipc` — Arrow IPC schema + DuckDB analytics deep
- `CF-0009` Context management stabilization (message-manager + compression)
- `@dzupagent/agent` — Skill chain executor deep coverage
- `@dzupagent/connectors-documents` — Document ingestion deep coverage
