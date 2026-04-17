# Wave 23 — Implementation Tracking

> **Start date**: 2026-04-17  
> **Target**: ≥200 new tests, close 5 gaps  
> **Theme**: Evals Deep + Codegen Repo-Map/Multi-Edit Deep + Agent-Adapters Registry/Circuit-Breaker Deep + Core Plugin/MCP Deep + Scraper Full-Stack Deep

---

## Baseline (post-Wave 22)

| Package | Tests passing |
|---------|---------------|
| `@dzupagent/evals` | 1,218 |
| `@dzupagent/codegen` | 2,317 (27 skipped) |
| `@dzupagent/agent-adapters` | 2,139 |
| `@dzupagent/core` | 2,610 |
| `@dzupagent/scraper` | 226 |

---

## Gap Assessment (pre-wave)

| Gap | Prior state | Wave 23 action |
|-----|------------|----------------|
| Evals LLM-judge + benchmark runner | `llm-judge-scorer.ts` 85 LOC / 13 tests, `benchmark-runner.ts` 235 LOC / 18 tests, `eval-runner.ts` 60 LOC / 16 tests, `domain-scorer-modules.test.ts` 7 tests | Deep expand: 60+ tests |
| Codegen multi-edit coherence + AST repo map | `multi-edit.tool.ts` 84 LOC / 10 tests, `repo-map-builder.ts` 221 LOC, `git-middleware.ts` / 3 tests, `pipeline-executor.ts` / 4 tests | Deep expand: 60+ tests |
| Agent-Adapters registry + circuit breaker | `adapter-registry.ts` 514 LOC / 8 tests, `circuit-breaker` in core imported, `parallel-executor` 1 test, `dzupagent-integration.test.ts` 2 tests | Deep expand: 55+ tests |
| Core plugin lifecycle + MCP client invocation | `plugin-registry.ts` 91 LOC, `mcp-client.ts` 463 LOC / 0 dedicated tests, `mcp-manager.ts` 210 LOC, `mcp-resources.test.ts` 13 tests, `mcp-sampling.test.ts` 13 tests | Deep expand: 55+ tests |
| Scraper HTTP + Puppeteer extraction | `http-fetcher.test.ts` 3 tests, `scraper-options.test.ts` 4 tests, `scraper-tool.contract.test.ts` 4 tests — thin despite rich source | Deep expand: 45+ tests |

---

## Task Summary

| ID | Task | Package | Target Tests | Agent | Status |
|----|------|---------|-------------|-------|--------|
| W23-A1 | Evals LLM-judge scorer + benchmark runner deep | `evals` | +60 | dzupagent-test-dev | pending |
| W23-A2 | Codegen multi-edit coherence + AST repo map deep | `codegen` | +60 | dzupagent-codegen-dev | pending |
| W23-B1 | Agent-Adapters registry + circuit breaker deep | `agent-adapters` | +55 | dzupagent-connectors-dev | pending |
| W23-B2 | Core plugin lifecycle + MCP client invocation deep | `core` | +55 | dzupagent-core-dev | pending |
| W23-B3 | Scraper HTTP + Puppeteer extraction deep | `scraper` | +45 | dzupagent-connectors-dev | pending |

---

## Detailed Task Specs

### W23-A1: Evals LLM-judge Scorer + Benchmark Runner Deep

**Goal**: `llm-judge-scorer.ts` (85 LOC / 13 tests), `benchmark-runner.ts` (235 LOC / 18 tests), `eval-runner.ts` (60 LOC / 16 tests), `composite-scorer.ts` (72 LOC), `domain-scorer-modules.test.ts` (7 tests) — all thin relative to LOC.

**Files to read first**:
- `packages/evals/src/llm-judge-scorer.ts` (85 LOC)
- `packages/evals/src/benchmarks/benchmark-runner.ts` (235 LOC)
- `packages/evals/src/eval-runner.ts` (60 LOC)
- `packages/evals/src/composite-scorer.ts` (72 LOC)
- `packages/evals/src/__tests__/llm-judge-scorer.test.ts` (13 tests — gap analysis)
- `packages/evals/src/__tests__/benchmark-runner-coverage.test.ts` (gap analysis)
- `packages/evals/src/__tests__/eval-runner.test.ts` (16 tests — gap analysis)
- `packages/evals/src/__tests__/domain-scorer-modules.test.ts` (7 tests — gap analysis)

**Action**: Create `packages/evals/src/__tests__/evals-llm-benchmark-deep.test.ts` with 60+ tests.

Cover:
- LLMJudgeScorer: score returns numeric 0–1, LLM prompt includes expected + actual, structured criteria extraction, rubric scoring, model fallback on error, concurrent scoring safe
- BenchmarkRunner: suite registration, run all suites in order, per-suite timeout, partial failure → continue other suites, trend baseline comparison, regression detection
- EvalRunner: run with dataset, aggregate metrics, per-item score, early stop on threshold miss, result serialization
- CompositeScorer: weighted average across sub-scorers, weight normalization, single scorer passthrough, score clamp 0–1
- DomainScorer modules: correct domain routing, unknown domain → DeterministicScorer fallback
- Error paths: LLM judge timeout → fallback score, benchmark suite throws → caught + reported, corrupt dataset entry skipped

**Acceptance criteria**: 60+ new tests, all 1218 existing evals tests pass.

---

### W23-A2: Codegen Multi-Edit Coherence + AST Repo Map Deep

**Goal**: `multi-edit.tool.ts` (84 LOC / 10 tests), `repo-map-builder.ts` (221 LOC), `git-middleware.ts` (3 tests), `pipeline-executor.ts` (4 tests) — critical paths with shallow coverage.

**Files to read first**:
- `packages/codegen/src/tools/multi-edit.tool.ts` (84 LOC)
- `packages/codegen/src/repomap/repo-map-builder.ts` (221 LOC)
- `packages/codegen/src/git/git-middleware.ts`
- `packages/codegen/src/__tests__/multi-edit-tool.test.ts` (10 tests — gap)
- `packages/codegen/src/__tests__/repo-map.test.ts` (gap analysis)
- `packages/codegen/src/__tests__/repomap/repo-map-builder.test.ts` (gap analysis)
- `packages/codegen/src/__tests__/git-middleware.test.ts` (3 tests — gap)
- `packages/codegen/src/__tests__/pipeline-executor.test.ts` (4 tests — gap)

**Action**: Create `packages/codegen/src/__tests__/codegen-multiedit-repomap-deep.test.ts` with 60+ tests.

Cover:
- MultiEditTool: atomic multi-file apply, rollback on partial failure, lint validation after edit, coherence check (no orphan imports), conflict detection between edits, no-op on empty edit list
- RepoMapBuilder: symbol extraction from TS file, import graph edges, export detection, incremental update on changed file, large repo slicing to token budget, circular import detection
- GitMiddleware: pre-commit hook fires, abort on lint failure, commit hash returned, dirty state detection
- PipelineExecutor: sequential stage execution, stage failure → rollback prior stages, parallel stage support, stage output passed to next
- Error paths: multi-edit with overlapping ranges → error, repo-map on non-TS file → graceful, git middleware on no-git dir → error

**Acceptance criteria**: 60+ new tests, all 2317 existing codegen tests pass.

---

### W23-B1: Agent-Adapters Registry + Circuit Breaker Deep

**Goal**: `adapter-registry.ts` (514 LOC / 8 tests), `parallel-executor` (1 test), `dzupagent-integration.test.ts` (2 tests), circuit breaker imported from core — all critically undertested given complexity.

**Files to read first**:
- `packages/agent-adapters/src/registry/adapter-registry.ts` (514 LOC — read fully)
- `packages/agent-adapters/src/registry/task-router.ts`
- `packages/agent-adapters/src/registry/event-bus-bridge.ts`
- `packages/agent-adapters/src/__tests__/adapter-registry.test.ts` (8 tests — gap)
- `packages/agent-adapters/src/__tests__/parallel-executor.contract.test.ts` (1 test — gap)
- `packages/agent-adapters/src/__tests__/dzupagent-integration.test.ts` (2 tests — gap)

**Action**: Create `packages/agent-adapters/src/__tests__/adapter-registry-circuit-breaker-deep.test.ts` with 55+ tests.

Cover:
- AdapterRegistry: register adapter, execute routes to correct adapter, circuit breaker opens after threshold failures, open circuit → fallback adapter used, circuit resets after timeout, health status reflects CB state
- Task routing: TagBasedRouter selects correct adapter by tags, no match → default, priority ordering
- EventBusBridge: adapter events forwarded to DzupEventBus, event scoping correct, disconnect cleans up listeners
- Parallel execution: multiple adapters in parallel, first-done wins, all-fail → error aggregated
- Registry lifecycle: deregister adapter, re-register with new config, list registered adapters
- Error paths: execute on empty registry → error, circuit breaker half-open probe, adapter throws mid-stream

**Acceptance criteria**: 55+ new tests, all 2139 existing agent-adapters tests pass.

---

### W23-B2: Core Plugin Lifecycle + MCP Client Invocation Deep

**Goal**: `plugin-registry.ts` (91 LOC / 0 dedicated tests), `mcp-client.ts` (463 LOC / 0 dedicated tests), `mcp-manager.ts` (210 LOC), `mcp-resources.test.ts` (13 tests), `mcp-sampling.test.ts` (13 tests) — critically under-tested given 463 LOC MCP client.

**Files to read first**:
- `packages/core/src/plugin/plugin-registry.ts` (91 LOC)
- `packages/core/src/plugin/plugin-types.ts`
- `packages/core/src/plugin/plugin-discovery.ts`
- `packages/core/src/mcp/mcp-client.ts` (463 LOC — read fully)
- `packages/core/src/mcp/mcp-manager.ts` (210 LOC)
- `packages/core/src/mcp/mcp-reliability.ts`
- `packages/core/src/mcp/__tests__/mcp-resources.test.ts` (13 tests — gap)
- `packages/core/src/mcp/__tests__/mcp-sampling.test.ts` (13 tests — gap)
- `packages/core/src/__tests__/circuit-breaker.test.ts` (9 tests — gap)

**Action**: Create `packages/core/src/__tests__/plugin-mcp-deep.test.ts` with 55+ tests.

Cover:
- PluginRegistry: register plugin, load order respects dependencies, duplicate plugin → error, unload cleans up hooks, lifecycle hooks (onLoad, onUnload) fire
- PluginDiscovery: discover from directory, manifest validation, invalid manifest skipped with warning
- MCPClient: tool invocation async, streaming tool result, tool list from server, resource read, sampling request/response, connection retried on disconnect
- MCPManager: client registered by server ID, invoke by server+tool name, manager routes to correct client, multi-server isolation
- MCPReliability: retry on transient error, circuit breaker on repeated failure, timeout enforced
- Error paths: plugin with missing dep → load error, MCP tool not found → error, MCP server unreachable → circuit open, sampling timeout

**Acceptance criteria**: 55+ new tests, all 2610 existing core tests pass.

---

### W23-B3: Scraper HTTP + Puppeteer Extraction Deep

**Goal**: `http-fetcher.test.ts` (3 tests), `scraper-options.test.ts` (4 tests), `scraper-tool.contract.test.ts` (4 tests) — only 11 of 226 scraper tests on the core HTTP/options/contract layer.

**Files to read first**:
- `packages/scraper/src/http-fetcher.ts`
- `packages/scraper/src/scraper.ts`
- `packages/scraper/src/content-extractor.ts`
- `packages/scraper/src/connector-contract.ts`
- `packages/scraper/src/types.ts`
- `packages/scraper/src/__tests__/http-fetcher.test.ts` (3 tests — gap)
- `packages/scraper/src/__tests__/scraper-options.test.ts` (4 tests — gap)
- `packages/scraper/src/__tests__/scraper-tool.contract.test.ts` (4 tests — gap)

**Action**: Create `packages/scraper/src/__tests__/scraper-http-contract-deep.test.ts` with 45+ tests.

Cover:
- HttpFetcher: GET request, redirect follow, custom headers, timeout enforced, retry on 5xx, robots.txt respect, rate limit via delay, concurrent fetches bounded
- Scraper options: JS rendering enabled → Puppeteer used, JS disabled → HTTP only, custom user-agent, cookie jar, max depth crawl, include/exclude patterns
- ConnectorContract: scrape tool conforms to contract schema, input validation, output schema matches, error output schema
- Content extraction: main content extracted (not nav/footer), markdown conversion, image alt text preserved, code block fenced
- Error paths: DNS failure → error, HTTP 404 → not-found error, robots.txt blocks → skip URL, Puppeteer crash → fallback to HTTP
- Integration: full scrape pipeline (fetch → extract → return structured), concurrent URL queue

**Acceptance criteria**: 45+ new tests, all 226 existing scraper tests pass.

---

## Progress

| ID | Status | Tests Added | Notes |
|----|--------|-------------|-------|
| W23-A1 | ✅ DONE | **97** | `evals-llm-benchmark-deep.test.ts`. 1,315 evals tests pass (was 1,218). LLMJudgeScorer (21), runBenchmark (20), compareBenchmarks (5), createBenchmarkWithJudge (2), EvalRunner (9), CompositeScorer (14), DomainScorer (16), error paths (10). Exceeded 60 target. |
| W23-A2 | ✅ DONE | **84** | `codegen-multiedit-repomap-deep.test.ts`. 2,401 codegen tests pass (was 2,317). MultiEditTool (20), RepoMapBuilder (24), GitMiddleware (14), PipelineExecutor (18), error paths (8). Exceeded 60 target. |
| W23-B1 | ✅ DONE | **85** | `adapter-registry-circuit-breaker-deep.test.ts`. 2,224 agent-adapters tests pass (was 2,139). Registration (14), CircuitBreaker (14), executeWithFallback (11), health (7), getForTask (6), TagBasedRouter (11), CostOptimizedRouter (4), RoundRobin (3), CompositeRouter (4), EventBusBridge (6), cleanup (4). Exceeded 55 target. |
| W23-B2 | ✅ DONE | **83** | `plugin-mcp-deep.test.ts`. 2,693 core tests pass (was 2,610). PluginRegistry (18), validateManifest (8), discoverPlugins (7), resolvePluginOrder (6), MCPClient (25), InMemoryMcpManager (6), McpReliabilityManager (13). Exceeded 55 target. |
| W23-B3 | ✅ DONE | **47** | `scraper-http-contract-deep.test.ts`. 325 scraper tests pass (was 226). HttpFetcher (14), WebScraper options (6), ConnectorContract (7), content extraction (4), error paths (5+1), integration (11). Exceeded 45 target. |
| **Total** | — | **396 / ≥275** | All 5 tasks complete. Exceeded target by 44%. |

---

## Wave 24 Candidates (preview)

- `@dzupagent/rag` — Chunking strategies + retrieval deep + citation deep
- `@dzupagent/memory` — Decay/consolidation + store factory deep
- `@dzupagent/agent` — Workflow engine + supervisor orchestration deep
- `@dzupagent/server` — REST API route coverage + Drizzle persistence deep
- `@dzupagent/otel` — Trace propagation + metrics deep
