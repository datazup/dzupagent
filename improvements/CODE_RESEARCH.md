# Code Research: `packages/`

## Scope & Method
- Scope: static review across `packages/*/src` plus structural repo signals.
- Focus: gaps, stability, reusability, performance, duplicates, and feature opportunities.
- Method: code inspection with line-level verification (no full test run performed in this pass).

## Executive Summary
The monorepo has strong breadth and decent unit-test density in core packages, but there are several high-impact risks in runtime wiring:
- Metadata-driven MCP stdio execution creates a command-execution risk if metadata is user-controlled.
- Tool resolver local fallback imports are broken in this repo layout and may silently degrade behavior.
- Several in-memory stores and runtime maps are unbounded, which can cause memory growth in long-lived processes.
- There are clear duplication clusters that reduce maintainability and increase drift risk.

---

## Findings (Ordered by Severity)

### 1) High: Metadata can drive stdio command execution through MCP
- Domain: Security / Stability
- Evidence:
  - Request metadata is accepted directly: `packages/server/src/routes/runs.ts:23`, `:66-82`
  - Runtime passes metadata into executor context: `packages/server/src/runtime/run-worker.ts:291-301`
  - MCP server configs are read from metadata without strict sanitization: `packages/server/src/runtime/tool-resolver.ts:179-188`, `:260-271`
  - Stdio transport executes `config.url` as a process command: `packages/core/src/mcp/mcp-client.ts:433-437`
- Impact:
  - If untrusted callers can influence `metadata.mcpServers` and choose `transport: "stdio"`, this can execute arbitrary local binaries.
- Improvements:
  - Disallow `stdio` transport from request metadata by default.
  - Introduce an allowlist policy for MCP servers/commands at server config level.
  - Validate `url`/`args` against explicit safe patterns and reject relative/unsafe binaries.
  - Add audit logging for all MCP server registrations and calls.

### 2) High: Tool resolver dev fallback paths are broken in current monorepo layout
- Domain: Stability / DX
- Evidence:
  - Fallback paths reference non-existent directories:
    - `packages/server/src/runtime/tool-resolver.ts:140-141` (`dzipagent-codegen`)
    - `packages/server/src/runtime/tool-resolver.ts:329-331` (`dzipagent-connectors`)
  - Actual directories are `packages/codegen` and `packages/connectors`.
- Impact:
  - In local/dev conditions where package imports are unavailable, tool resolution silently fails and disables expected functionality.
- Improvements:
  - Replace fallback paths with valid monorepo-relative imports (or remove fallback and fail fast with actionable error).
  - Add unit tests that exercise fallback resolution in monorepo mode.

### 3) Medium-High: `importFirstAvailable` swallows all import errors, masking real defects
- Domain: Stability / Observability
- Evidence:
  - Broad catch with no error classification: `packages/server/src/runtime/tool-resolver.ts:116-123`
- Impact:
  - Syntax/runtime errors inside a candidate module become indistinguishable from “module not found”, making diagnosis difficult and causing silent degradation.
- Improvements:
  - Only swallow `ERR_MODULE_NOT_FOUND`/`MODULE_NOT_FOUND`; surface all other errors with context.
  - Add structured warning telemetry with candidate path and failure reason.

### 4) Medium: Trace lifecycle remains open on failure/cancel paths
- Domain: Stability / Data integrity
- Evidence:
  - Trace starts unconditionally: `packages/server/src/runtime/run-worker.ts:196`
  - Trace is completed only on success: `packages/server/src/runtime/run-worker.ts:333`
  - Failure/cancel branches do not call `completeTrace`: `packages/server/src/runtime/run-worker.ts:530-575`
- Impact:
  - Failed/cancelled runs may have incomplete trace lifecycle metadata, breaking replay expectations and analytics consistency.
- Improvements:
  - Ensure `completeTrace` (or explicit terminal marker with status) is called in all terminal paths.
  - Add run-worker tests for failure/cancel trace closure.

### 5) Medium: Unbounded in-memory growth hotspots
- Domain: Performance / Stability
- Evidence:
  - Event log unbounded per run and globally: `packages/core/src/persistence/event-log.ts:37-39`, `:53-59`
  - Trace store unbounded by run count: `packages/server/src/persistence/run-trace-store.ts:83`
  - Run/log store unbounded maps: `packages/core/src/persistence/in-memory-store.ts:17-18`, `:65`, `:73`
  - Concurrency pool per-key semaphores never evicted: `packages/core/src/concurrency/pool.ts:36`, `:108-115`
- Impact:
  - Long-lived server processes can accumulate stale state and degrade memory/GC behavior.
- Improvements:
  - Add retention policy knobs (max runs, max logs/run, max traces, idle key eviction).
  - Expose memory gauge metrics and prune counters.
  - Use weak/TTL caches where feasible.

### 6) Medium: Rate limiter key extraction is brittle for Authorization header formats
- Domain: Stability / Fairness
- Evidence:
  - Key extraction slices Authorization directly: `packages/server/src/middleware/rate-limiter.ts:103-106`
- Impact:
  - Non-`Bearer ...` headers can collapse to inconsistent keys (including empty strings), causing accidental cross-client throttling.
- Improvements:
  - Parse `Authorization` scheme explicitly; only consume bearer token for the key.
  - Fallback to IP/session key when scheme is unsupported.

### 7) Medium: Duplicate deduplication logic in memory modules
- Domain: Reusability / Maintainability
- Evidence:
  - `tokenize` + `jaccardSimilarity` duplicated:
    - `packages/memory/src/lesson-pipeline.ts:89-108`
    - `packages/memory/src/skill-acquisition.ts:99-118`
  - Timestamp-random ID generation pattern duplicated:
    - `packages/memory/src/lesson-pipeline.ts:111-114`
    - `packages/memory/src/skill-acquisition.ts:121-124`
- Impact:
  - Behavior drift risk and duplicated bug-fix effort.
- Improvements:
  - Extract shared `text-similarity` and `id-factory` utilities under `packages/memory/src/shared/`.
  - Add contract tests that both pipelines use the same semantics.

### 8) Medium: Adapter duplication + intentional stubs reduce reliability
- Domain: Stability / Reusability
- Evidence:
  - Large near-duplicate stub adapters:
    - `packages/agent-adapters/src/qwen/qwen-adapter.ts`
    - `packages/agent-adapters/src/crush/crush-adapter.ts`
  - Multiple TODOs for schema/event mapping and session support, e.g. `packages/agent-adapters/src/crush/crush-adapter.ts:10-13`, `:34`, `:231`, `:268`
  - `agent-adapters` currently has zero tests: package scan summary.
- Impact:
  - High chance of provider-specific behavior drift and runtime mismatch in CLI outputs.
- Improvements:
  - Introduce a shared `JsonlCliAdapterBase` with provider-specific mapping hooks.
  - Add golden transcript tests per provider (message/tool_call/tool_result/error).

### 9) Low-Medium: Large “god files” increase change risk and review cost
- Domain: Maintainability / Performance
- Evidence (top examples):
  - `packages/otel/src/event-metric-map.ts` (~1149 LOC)
  - `packages/evals/src/scorers/domain-scorer.ts` (~1145 LOC)
  - `packages/agent/src/pipeline/pipeline-runtime.ts` (~1115 LOC)
  - `packages/agent/src/agent/dzip-agent.ts` (~835 LOC)
  - `packages/core/src/index.ts` (~831 LOC)
- Impact:
  - Slower onboarding, harder targeted testing, higher merge conflict probability.
- Improvements:
  - Split by bounded contexts (parsers, scoring primitives, orchestration core, IO adapters).

---

## Test Coverage Signals (By Package)
Snapshot (`src` non-test `.ts` files vs `*.test.ts` files):

- `agent`: `src=114`, `tests=67`
- `core`: `src=178`, `tests=57`
- `server`: `src=96`, `tests=43`
- `memory`: `src=88`, `tests=44`
- `memory-ipc`: `src=31`, `tests=21`
- `playground`: `src=21`, `tests=21`

Lower-confidence areas (few or no tests):
- `agent-adapters`: `src=11`, `tests=0`
- `domain-nl2sql`: `src=19`, `tests=0`
- `rag`: `src=9`, `tests=0`
- `scraper`: `src=6`, `tests=0`
- `express`: `src=4`, `tests=0`
- `cache`: `src=6`, `tests=0`

---

## Reusability & Duplicate Hotspots
- Tooling path logic is centralized but has brittle monorepo assumptions (`tool-resolver`).
- Memory learning pipelines (`lesson-pipeline`, `skill-acquisition`) duplicate text similarity and ID generation.
- Provider adapters (Qwen/Crush) are strongly parallel implementations and should share a base transport layer.

---

## Performance Opportunities
1. Add retention and eviction for in-memory runtime stores (`event-log`, `run-trace-store`, `in-memory-store`, `concurrency pool`).
2. Add sampling/downscoping for verbose event tracing in high-throughput runs.
3. Split oversized files and isolate “hot path” logic into smaller, benchmarkable units.
4. Convert expensive “sort-all-then-slice” list patterns in in-memory stores to bounded heaps/cursors when collections grow.

---

## Feature Opportunities
1. MCP Safety Policy Engine
- Central allow/deny rules for transport types, domains, stdio commands, and tool names.

2. Runtime Retention Manager
- Unified retention config and scheduled pruning for run logs, traces, and event logs.

3. Adapter Conformance Harness
- Shared contract tests for all CLI adapters with golden fixtures and fuzzed JSONL streams.

4. Reliability Dashboard
- Expose unresolved-tool rates, import fallback failures, trace closure completeness, and memory growth metrics.

5. Shared Similarity Toolkit
- Reusable tokenization, normalization, and similarity strategies for memory modules.

---

## Prioritized Remediation Roadmap

### Immediate (1-3 days)
- Block metadata-driven `stdio` MCP by default; add allowlist checks.
- Fix broken monorepo fallback paths in `tool-resolver`.
- Change `importFirstAvailable` to only suppress module-not-found errors.
- Ensure trace closure on all terminal run outcomes.

### Short-term (1-2 sprints)
- Add retention limits/eviction policies for in-memory stores.
- Refactor duplicated memory similarity + ID logic into shared utilities.
- Introduce adapter contract tests for `agent-adapters`.

### Mid-term (2-4 sprints)
- Decompose oversized files into modular units with focused test suites.
- Add reliability/performance dashboards and SLO alerts for resolver/trace/memory health.

---

## Assumptions & Gaps
- This analysis is static; no end-to-end runtime or load test was executed in this pass.
- Security severity depends on deployment trust boundaries (especially who can submit run metadata).
- Dependency-level vulnerability scanning was not part of this review.
