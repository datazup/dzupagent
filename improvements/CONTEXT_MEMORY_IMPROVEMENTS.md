# Context + Memory Gap Analysis and Improvement Plan

Date: 2026-03-29
Scope:
- `packages/cache`
- `packages/context`
- `packages/memory`
- `packages/memory-ipc`
- memory/context integration points in `packages/core`

## Executive Summary

The memory/context stack is feature-rich and already quite advanced, but the highest-risk gaps are concentrated in:

1. Optional dependency boundary design (`core` <-> `memory-ipc`) that is declared optional but statically re-exported.
2. Semantics mismatches and incomplete behavior in dev/test paths (`memory` in-memory store, `memory-ipc` import strategy, shared channel allocator assumptions).
3. Limited failure observability due broad non-fatal swallowing across cache/memory paths.
4. Interface sprawl and duplicated logic (token estimation heuristics, broad re-export surfaces) that hurt maintainability and ease of use.
5. Uneven test posture (`cache` has zero unit tests while being used as an infrastructure primitive).

## Current State Snapshot

- `cache`: 6 source files, 0 test files.
- `context`: 11 source files, 8 test files.
- `memory`: 88 source files, 44 test files.
- `memory-ipc`: 31 source files, 21 test files.

Overall maturity:

- `cache`: simple and clean API, but under-tested and minimal policy/key semantics.
- `context`: solid utilities with good test coverage; mostly heuristic/token-estimation based.
- `memory`: broad capability set with good tests; some behavior intentionally non-fatal but too silent.
- `memory-ipc`: powerful IPC/Arrow layer with good coverage; a few strategy/consistency gaps remain.
- `core`: strong facade layer, but optional-memory-ipc contract is currently brittle.

## Findings (By Severity)

## High

1. Optional peer dependency contract is inconsistent in `core` memory-ipc bridge.
- Evidence:
  - `packages/core/src/index.ts:759-760` exports `./memory-ipc.js` unconditionally.
  - `packages/core/src/memory-ipc.ts:7-120` statically re-exports from `@dzipagent/memory-ipc`.
- Impact:
  - If consumers install `@dzipagent/core` without `@dzipagent/memory-ipc` (declared optional), module resolution can fail at runtime/import time depending on loader/bundler behavior.
  - This weakens “optional” semantics and introduces deployment fragility.
- Missing implementation:
  - True optional loading boundary (subpath export only, or lazy runtime accessors with explicit availability checks).

2. In-memory store behavior diverges from production semantics in ways that can hide bugs.
- Evidence:
  - `packages/memory/src/store-factory.ts:60-71` `search(namespacePrefix)` ignores query/filter/limit semantics.
  - `packages/memory/src/store-factory.ts:105-109` returns this implementation for `type: 'memory'`.
- Impact:
  - Local/test behavior may pass while production search behavior differs significantly (especially relevance, filtering, and pagination assumptions).
- Missing implementation:
  - A parity-focused in-memory implementation that respects search options or explicit “limited semantics” typing.

3. Shared memory channel allocator explicitly assumes single-writer and can overwrite data after wrap-around.
- Evidence:
  - `packages/memory-ipc/src/shared-memory-channel.ts:262-273` wrap-around bump allocator.
  - Comment at `:270-271` acknowledges this is insufficient for real concurrency.
- Impact:
  - In concurrent writers/workers, possible data corruption, stale handle reads, or overwritten payloads.
- Missing implementation:
  - Multi-writer safe ring-buffer/free-list allocator with slot-level region ownership checks.

## Medium

1. `memory-ipc` import strategy `replace` is declared but not actually implemented.
- Evidence:
  - `packages/memory-ipc/src/memory-service-ext.ts:220-224` comment says replace is effectively upsert due missing delete capability.
- Impact:
  - API contract misleading; consumers expecting deterministic replacement may get stale records.
- Missing implementation:
  - `MemoryServiceLike` delete support or explicit rejection of unsupported strategies.

2. Shared memory manager includes unimplemented share mode.
- Evidence:
  - `packages/memory/src/sharing/memory-space-manager.ts:168` docs mark subscribe as placeholder.
  - `:182` throws `Subscribe mode is not yet implemented`.
- Impact:
  - Public mode appears supported by type/enum but is not available at runtime.
- Missing implementation:
  - Either complete subscribe-mode semantics or remove from public contract until ready.

3. Retention enforcement uses tombstones instead of true deletion and depends on reconstructable keys.
- Evidence:
  - `packages/memory/src/sharing/memory-space-manager.ts:404-415` writes `_tombstone` instead of deleting.
  - Keys can be synthetic via `keyFromValue` fallback (`record-{i}`).
- Impact:
  - Storage growth, lookup noise, and possible key drift depending on serialization lineage.
- Missing implementation:
  - Explicit delete lifecycle and compaction policy for tombstones.

4. Context transfer persistence has fixed pagination ceilings that can miss data.
- Evidence:
  - `packages/core/src/context/run-context-transfer.ts:83`, `:119`, `:130` uses `search(..., { limit: 100 })`.
- Impact:
  - Sessions with more than 100 entries may silently miss loads/list/clear operations.
- Missing implementation:
  - Key-based direct lookup where possible, plus paginated iteration helpers.

5. Non-fatal swallowing is broad without standardized observability hooks.
- Evidence:
  - `packages/cache/src/middleware.ts:78-80`, `:103-107`
  - `packages/memory/src/memory-service.ts:134-136`, `:160-162`, `:207-209`
- Impact:
  - Operational blind spots: silent failures degrade memory quality/cache utility without traceability.
- Missing implementation:
  - Structured warnings/events/metrics for degraded modes.

## Low

1. Cache key derivation is narrow and may collide across materially different request shapes.
- Evidence:
  - `packages/cache/src/key-generator.ts:14-19` only uses `messages`, `model`, `temperature`, `maxTokens`.
- Impact:
  - Potential wrong-cache-hit risk for requests differing by tools/system/provider options.
- Missing implementation:
  - Configurable key schema and canonicalization strategy.

2. Token estimation logic is repeated heuristically across modules.
- Evidence:
  - `packages/context/src/message-manager.ts:80-82`
  - `packages/context/src/context-transfer.ts:120-123`
  - Similar heuristic patterns in `memory-ipc` budgeting paths.
- Impact:
  - Drift and inconsistency in compression/transfer/budget behavior.
- Missing implementation:
  - Shared token estimation utility contract.

3. `cache` package has no unit tests.
- Evidence:
  - no `*.test.ts` under `packages/cache/src` (count: 0).
- Impact:
  - Regression risk in key generation, TTL/LRU behavior, and backend error handling.
- Missing implementation:
  - Baseline test suite for middleware + backends + keying policy.

## Missing Implementation Summary

Priority-ordered missing implementation:

1. Optional dependency-safe `core` memory-ipc loading model.
2. Parity-safe in-memory store search semantics (or explicit capability typing and warnings).
3. SharedMemoryChannel multi-writer-safe allocation strategy.
4. Real `replace` semantics for `memory-ipc` import (or explicit strategy removal).
5. Complete or deprecate `subscribe` share mode in `MemorySpaceManager`.
6. Paginated key-safe retrieval/cleanup for run context transfer persistence.
7. Observability layer for non-fatal degraded operations.
8. Cache test suite and stronger cache key configurability.

## Refactoring Opportunities (Reusability + Better Interfaces)

## 1) Introduce a Unified Memory/Context Runtime Contract

Create shared core-level interfaces:

- `ContextCompressor` (`compress(messages, options) -> result`)
- `MemoryRetriever` (`retrieve(query, scope, budget) -> ranked memories`)
- `TokenEstimator` (`estimate(input, modelHint?) -> tokens`)
- `DegradationReporter` (`warn(event)`)

This reduces duplicated heuristics and makes behavior pluggable per provider/model.

## 2) Split “Facade Exports” from “Optional Feature Bridges”

For `core`:

- Keep stable base exports in main entrypoint.
- Move optional heavy integrations to explicit subpath exports:
  - `@dzipagent/core/memory-ipc` (only if installed)
- Avoid unconditional `export *` from optional peers in root index.

## 3) Normalize Store Capabilities via Capability Flags

Add explicit capabilities to store abstractions:

- `supportsVectorSearch`
- `supportsFilterSearch`
- `supportsDelete`
- `supportsPagination`

Then require runtime negotiation (with warnings/fallback) instead of silent semantic drift.

## 4) Centralize Error/Degradation Telemetry

Introduce shared event model (core):

- `cache:degraded`
- `memory:write_dropped`
- `memory:index_failed`
- `context:compression_fallback`

All current catch-and-continue paths should emit lightweight structured diagnostics.

## 5) Consolidate Token-Budget Logic

Extract reusable token-budget module for:

- message compression (`context`)
- transfer truncation (`context-transfer`)
- memory selection (`memory-ipc`)

Use one default estimator + model-specific overrides.

## Suggested New Core Features

1. `ContextMemoryOrchestrator` (new core module)
- Single entrypoint that performs:
  - context compression,
  - memory retrieval under budget,
  - transfer injection,
  - prompt assembly.
- Returns full diagnostics (`tokens in/out`, truncations, skipped memory reasons).

2. `MemoryConsistencyMode`
- Modes: `strict | tolerant | silent`.
- Governs current non-fatal behavior for memory/cache writes/reads/indexing.
- `strict` throws, `tolerant` returns + warning, `silent` current behavior.

3. `CapabilityAwareStoreFactory`
- Produces a store object with explicit capability metadata and adapter shims.
- Prevents feature assumptions from leaking into callers.

4. `OptionalDependencyGuard`
- Utility to safely detect/install-check optional peers and expose `isAvailable()`.
- Used by `core` for memory-ipc, vectordb adapters, and similar optional modules.

5. `RetentionCompactor`
- Periodic compaction utility for tombstones/expired records in shared memory spaces.

## Recommended Roadmap

## Phase 1 (Immediate: reliability + correctness)

1. Fix optional memory-ipc export boundary in `core`.
2. Implement/clarify `replace` strategy in `memory-ipc` import path.
3. Remove or implement `subscribe` mode in memory sharing API.
4. Add cache unit tests and baseline CI gate for `@dzipagent/cache`.

## Phase 2 (Short-term: interface quality)

1. Introduce capability metadata for stores and memory adapters.
2. Add standardized degradation events across cache/context/memory.
3. Replace fixed `limit: 100` scans in run context transfer with robust key/pagination behavior.

## Phase 3 (Mid-term: abstraction + reusability)

1. Build shared token estimation + budgeting module.
2. Introduce `ContextMemoryOrchestrator` in `core`.
3. Refactor packages to consume shared contracts and reduce duplicate heuristics.

## Validation Plan

After implementation, validate with:

1. Contract tests for optional dependency behavior (core loads without memory-ipc installed).
2. Store parity tests comparing memory vs postgres behavior for query/filter/limit semantics.
3. Concurrency stress tests for shared memory channel (multi-writer contention).
4. Golden tests for cache keying with different provider/tool/system options.
5. End-to-end context+memory prompt assembly tests under tight token budgets.

