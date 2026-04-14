# `@dzupagent/rag` Implementation Analysis And Gap Assessment

Date: 2026-04-03  
Scope: `packages/rag` only

## Executive Summary

`@dzupagent/rag` has a clean modular decomposition (`SmartChunker` -> `HybridRetriever` -> `ContextAssembler` -> `RagPipeline`) and good use of dependency injection for vector/embedding adapters. Type safety and package-level build/typecheck/lint are in good shape.

The largest risk is correctness and reliability in chunking: there is a reproducible infinite-loop path in `SmartChunker` that causes worker OOM in tests and can hang production ingestion for short inputs.

The second major gap is ingestion lifecycle correctness: pipeline ingestion only upserts and does not remove stale chunks for re-ingested sources, so retrieval can drift to outdated context.

Documentation and public API examples are materially out of sync with actual signatures, creating adoption friction and integration failure risk.

## Methodology

1. Static read-through of source files and tests:
- `src/chunker.ts`, `src/retriever.ts`, `src/assembler.ts`, `src/pipeline.ts`, `src/memory-namespace.ts`, `src/citation-tracker.ts`, `src/types.ts`, `src/index.ts`.
- All tests under `src/__tests__`.
- `README.md`, `vitest.config.ts`, `package.json`.

2. Validation commands executed:
- `yarn workspace @dzupagent/rag build` (pass)
- `yarn workspace @dzupagent/rag typecheck` (pass)
- `yarn workspace @dzupagent/rag lint` (pass)
- `yarn workspace @dzupagent/rag test` (fails with worker OOM)
- `yarn workspace @dzupagent/rag vitest run src/__tests__/chunker-quality.test.ts --reporter=verbose` (reproduces worker OOM)

## Current Implementation Map

- `SmartChunker` (`src/chunker.ts`): boundary-aware chunking + heuristic chunk quality scoring.
- `HybridRetriever` (`src/retriever.ts`): vector, keyword, and RRF-hybrid retrieval; optional quality boosting.
- `QualityBoostedRetriever` (`src/quality-retriever.ts`): wrapper for external source-quality map boosting.
- `ContextAssembler` (`src/assembler.ts`): per-source context mode handling (`off`/`insights`/`full`), token budgeting, citations, prompt builders.
- `RagPipeline` (`src/pipeline.ts`): ingest (chunk/embed/upsert), retrieve, assemble context; tenant-specific retriever cache.
- `RagMemoryNamespace` (`src/memory-namespace.ts`): optional memory-service bridge for chunk persistence/search/delete.
- `CitationTracker` (`src/citation-tracker.ts`): citation extraction and formatting helpers.

## Findings (Severity Ranked)

## Critical

### 1) Infinite loop in `SmartChunker` on short documents can OOM worker/process

Evidence:
- Overlap is computed from target size (`src/chunker.ts:90-93`), often large by default (`targetTokens=1200`, overlap ~720 chars).
- On final segment, `end` is set to `text.length` (`src/chunker.ts:108-110`).
- Next loop start is always `start = end - effectiveOverlap` (`src/chunker.ts:117`).
- If `text.length < effectiveOverlap`, `start` becomes negative, `slice(start, end)` repeatedly yields the same text, and `start` never advances.

Runtime confirmation:
- `yarn workspace @dzupagent/rag test` reports `ERR_WORKER_OUT_OF_MEMORY`.
- Isolated `chunker-quality.test.ts` run also reports `ERR_WORKER_OUT_OF_MEMORY`.

Impact:
- Ingestion on short texts can hang indefinitely.
- Test suite cannot reliably run chunker behavior.
- Potential production memory blow-up.

Remediation:
- Add termination guard: break when `end >= text.length` after emitting last chunk.
- Enforce monotonic progress: `nextStart = Math.max(start + 1, end - effectiveOverlap)`.
- Add defensive maximum-iterations cap as fail-safe.

Regression tests to add:
- short text (`< overlap`) terminates with exactly 1 chunk.
- tiny text + high overlap + `respectBoundaries=true/false` both terminate.
- invariant test: chunk loop must strictly advance or stop.

## High

### 2) Re-ingestion can leave stale vectors in store (data correctness drift)

Evidence:
- `ingest()` only performs `upsert` (`src/pipeline.ts:154-173`).
- IDs are deterministic (`sourceId:index`, from chunker), so old higher indexes from prior ingestion are never deleted if new chunk count shrinks.
- No pipeline-level source purge hook exists before upsert.
- `RagMemoryNamespace` has `deleteBySource` (`src/memory-namespace.ts:206-221`) but is not integrated into `RagPipeline`.

Impact:
- Retrieval may include obsolete chunks from prior source versions.
- Generated context can mix old/new content and silently degrade answer trust.

Remediation:
- Add explicit source lifecycle API: `replaceSource(sourceId, ...)` with delete-then-upsert semantics.
- Prefer versioned chunk IDs plus metadata filter on active version.
- Add vector-store adapter contract for `deleteByFilter` or `deleteBySource`.

Tests to add:
- Reingest same source with fewer chunks should remove old tail chunks.
- Reingest same source with changed content should not return stale content.

### 3) Public README is out of sync with actual API contracts

Evidence:
- README uses unsupported config keys `chunkSize`, `chunkOverlap`, `hybridAlpha` (`README.md:35-38`, `README.md:69-73`).
- README `ingest` example omits required `sourceId` and `sessionId` (`README.md:45-48`), but `IngestOptions` requires them (`src/types.ts:223-229`).
- README examples call non-existent methods (`tracker.createContext`, `tracker.resolve`) (`README.md:111-116`) not present in `CitationTracker` (`src/citation-tracker.ts`).
- README `QualityBoostedRetriever` example shape does not match constructor signature (`README.md:89-99` vs `src/quality-retriever.ts:51-58`, `68-73`).

Impact:
- Consumers will fail integration at compile-time/runtime.
- Increased support burden and reduced package trust.

Remediation:
- Replace README examples with compile-verified snippets tied to current exports.
- Add CI doc-snippet validation (TypeScript compile or tests against markdown examples).

### 4) Test suite reports success counts but fails overall due unhandled OOM; reliability gap in quality gate

Evidence:
- `vitest.config.ts` includes normal test patterns and excludes two placeholder tests (`vitest.config.ts:7-11`).
- Running tests shows many passing tests but global run still exits with unhandled worker OOM.

Impact:
- False confidence from partial pass output.
- Quality gate instability.

Remediation:
- Fix chunker loop first.
- Add dedicated `chunker` stress tests with strict runtime limits.
- Configure CI to fail fast on unhandled Vitest errors with clear artifact logs.

## Medium

### 5) Config contract includes fields that are not operationally used (`reranker`, `autoSummarize`)

Evidence:
- `reranker` is part of retrieval config (`src/types.ts:74-76`) but no reranker logic exists in retriever path.
- `autoSummarize` is in `IngestOptions` (`src/types.ts:231-234`) but unused in `RagPipeline.ingest()` (`src/pipeline.ts:118-183`).

Impact:
- API implies capabilities that do not exist.
- Integrators may depend on no-op settings.

Remediation:
- Either implement or remove/deprecate from public types.
- If deferring implementation, add explicit runtime warning for unsupported options.

### 6) Quality boost math does not normalize all inputs; score inflation/deflation can become unstable

Evidence:
- `applyQualityBoosting()` uses `chunk.qualityScore` directly (`src/retriever.ts:256-260`) without normalization.
- Weights are taken as provided (`src/retriever.ts:253`) with no bound/sum validation.

Impact:
- Invalid metadata or misconfigured weights can produce distorted scores.

Remediation:
- Normalize `chunkQuality` into `[0,1]`.
- Validate weights: non-negative and sum to ~1 (or normalize automatically).

### 7) Context token budget is soft for `insights` mode

Evidence:
- `applyTokenBudget` deliberately preserves `insights` and only drops `full` chunks (`src/assembler.ts:262-270`).

Impact:
- Final assembled context can exceed budget when insights summaries alone are large.

Remediation:
- Add strict-budget option to truncate/summarize oversized insight content.
- Add return metadata indicating whether budget was exceeded.

### 8) `RagMemoryNamespace.searchChunks` fabricates positional score instead of using backend relevance

Evidence:
- Output score is `1 / (index + 1)` regardless of provider (`src/memory-namespace.ts:190-193`).

Impact:
- Quality signal distortion when integrating with retrieval ranking.

Remediation:
- Extend `MemoryServiceLike.search` contract to include score.
- If score unavailable, explicitly mark confidence low and keep score optional.

## Low

### 9) Dependency hygiene mismatch

Evidence:
- `@dzupagent/memory` is a direct dependency (`package.json:22-25`) while implementation uses duck-typed `MemoryServiceLike` and no direct runtime import.

Impact:
- Unnecessary dependency footprint and coupling signal mismatch.

Remediation:
- Move to peer/optional dependency or remove if not required at runtime.

## Gap Analysis Matrix

| Area | Current State | Gap | Priority |
|---|---|---|---|
| Chunking reliability | Boundary + overlap logic implemented | Infinite loop on short text; no safety cap | Critical |
| Ingestion lifecycle | Upsert-only flow | No stale-chunk cleanup/versioning | High |
| API/docs alignment | Rich README exists | Examples and types diverge materially | High |
| Retrieval quality controls | RRF + quality boost | No reranker, no MMR/diversity, limited normalization | Medium |
| Budget correctness | Greedy budgeting for full chunks | Soft-budget overflow possible for insights | Medium |
| Memory bridge ranking | Functional integration exists | Relevance score model is synthetic | Medium |
| Operability | Timing value (`queryTimeMs`) exposed | No structured telemetry/tracing/health counters | Medium |
| Dev experience | Good modular exports | No executable docs/examples in CI | Medium |

## Suggested New Features (Prioritized)

### Immediate (Stability + correctness)

1. Deterministic chunking termination safeguards
- Add non-regression tests for short-input/high-overlap and invariant progress checks.
- Add optional hard cap `maxChunksPerDocument` for defensive operation.

2. Source replacement API (`replaceSource`)
- Atomic workflow: delete existing chunks for `(tenantId, sessionId, sourceId)` then ingest new chunks.
- Include idempotency token/version metadata.

3. Executable docs pipeline
- Compile all README snippets in CI.
- Auto-generate API examples from tested fixtures.

### Near-term (Retrieval quality)

4. Real reranking strategy
- Implement `reranker: 'cross-encoder'` path with pluggable model interface.
- Preserve base scores and reranked scores for observability.

5. MMR / diversity-aware retrieval
- Add optional maximal marginal relevance to reduce near-duplicate chunks.
- Config: `diversityLambda`, `fetchK`.

6. Configurable hybrid weighting and score calibration
- Introduce explicit vector/keyword blend configuration beyond pure RRF.
- Normalize heterogeneous score distributions before fusion.

7. Strict token-budget modes
- `budgetMode: 'soft' | 'hard-truncate' | 'compress'`.
- For hard mode, enforce exact token cap with summary compression fallback.

### Medium-term (Operational maturity)

8. Retrieval observability hooks
- Emit structured events: `ingest_started`, `embed_completed`, `search_completed`, `context_assembled`.
- Include chunk counts, token counts, latencies, drop reasons, and budget-trim stats.

9. Built-in evaluation harness integration
- Add package-level eval scenarios (groundedness, citation precision/recall, stale-content leakage checks).
- Integrate with `packages/evals` for regression gating.

10. Policy and safety controls for source text
- Optional prompt-injection heuristics at chunk/assembly stage.
- Track and annotate suspicious chunks for downstream model instructions.

## Validation Snapshot

- `build`: pass
- `typecheck`: pass
- `lint`: pass
- `test`: fail (worker OOM)
- Root cause: chunker termination bug (critical finding #1)

## Recommended Action Plan

1. Fix critical chunker loop + add termination tests.
2. Implement source replacement lifecycle for ingestion.
3. Align README/examples with actual API and enforce snippet CI.
4. Decide `reranker` and `autoSummarize` path: implement or deprecate.
5. Add retrieval quality upgrades (MMR/reranker/calibration) after correctness baseline is stable.
