# @dzupagent/memory-ipc Architecture

## Scope
`@dzupagent/memory-ipc` is a framework package in `packages/memory-ipc` that defines Arrow-based memory exchange primitives for DzupAgent. The package builds from `src/index.ts` to ESM output in `dist/` and exposes a single root export surface.

The current scope includes:
- Canonical memory frame schema and column constants in `src/schema.ts`.
- Record-to-Arrow conversion in `src/frame-builder.ts` and Arrow-to-record conversion in `src/frame-reader.ts`.
- Arrow IPC and Base64 helpers in `src/ipc-serializer.ts`.
- Columnar scoring, temporal filtering, graph/similarity utilities, and token-budget selection in `src/columnar-ops*.ts`, `src/token-budget.ts`, and `src/phase-memory-selection.ts`.
- Frame diffing and overlap analysis in `src/cache-delta.ts` and `src/memory-aware-compress.ts`.
- Shared memory and blackboard coordination primitives in `src/shared-memory-channel.ts` and `src/blackboard.ts`.
- Protocol bridges in `src/memory-service-ext.ts`, `src/mcp-memory-transport.ts`, and `src/a2a-memory-artifact.ts`.
- Adapter interfaces and built-in adapters in `src/adapters/*`.
- Optional analytics layer backed by DuckDB-WASM in `src/analytics/*`.
- Specialized frame families in `src/frames/*` for tool results, codegen, eval, and entity graphs.
- IPC client abstraction in `src/ipc-client.ts` with in-process backing-service mode.

## Responsibilities
Current code responsibilities are:
- Standardize a canonical memory frame contract (`MEMORY_FRAME_SCHEMA`) with schema metadata (`memory_frame_version`).
- Provide reusable conversion APIs for producing Arrow `Table` objects from memory records and reconstructing records from tables.
- Provide transport-safe serialization/deserialization (`stream`/`file` IPC + Base64).
- Provide batch-friendly memory scoring, filtering, and budget allocation primitives that operate directly on Arrow columns.
- Provide extension points for integrating with existing memory services and MCP handlers without hard-coupling to a specific service package.
- Provide cross-framework import/export adapters (Mastra, LangGraph, Mem0, Letta, MCP knowledge graph).
- Provide optional SQL analytics APIs when `@duckdb/duckdb-wasm` is available.
- Provide supplementary Arrow frame schemas for adjacent workflows (tooling, codegen, eval, graph analytics).

Out of scope for this package:
- Persistent storage ownership.
- Network servers or daemon processes.
- Product-level auth/policy orchestration.

## Structure
Primary layout under `src/`:
- `index.ts`: public exports.
- `schema.ts`: canonical 22-field memory frame schema and constants.
- `frame-builder.ts`: `FrameBuilder` plus input types (`FrameScope`, `FrameTemporal`, `FrameDecay`, `FrameProvenance`, `FrameRecordMeta`, `FrameRecordValue`).
- `frame-reader.ts`: `FrameReader` and reconstructed `FrameRecord` model.
- `ipc-serializer.ts`: `serializeToIPC`, `deserializeFromIPC`, Base64 helpers.
- `ipc-client.ts`: `IpcMemoryClient` and `IpcNotConfiguredError`.
- `columnar-ops.ts`: stable barrel re-exporting focused implementations from:
- `columnar-ops-helpers.ts`
- `columnar-ops-decay.ts`
- `columnar-ops-temporal.ts`
- `columnar-ops-scoring.ts`
- `columnar-ops-graph.ts`
- `token-budget.ts`: budget selection and `TokenBudgetAllocator`.
- `phase-memory-selection.ts`: conversation-phase weighted selection tables and selector.
- `cache-delta.ts`: frozen-vs-current frame delta.
- `memory-aware-compress.ts`: Jaccard overlap classification.
- `shared-memory-channel.ts`: `SharedArrayBuffer` slot channel.
- `blackboard.ts`: in-memory append/read blackboard with writer authorization per table.
- `memory-service-ext.ts`: Arrow export/import wrapper for MemoryService-like APIs.
- `mcp-memory-transport.ts`: Zod schemas + handler functions for memory export/import/schema endpoints.
- `a2a-memory-artifact.ts`: memory artifact envelope create/parse/sanitize utilities.
- `adapters/*`: adapter contract, registry, shared column helpers, and built-in adapter implementations.
- `analytics/*`: DuckDB engine wrapper and domain analytics query helpers.
- `frames/*`: specialized Arrow schemas + builders.
- `__tests__/*`: Vitest suites across modules.

## Runtime and Control Flow
1. Frame creation and reconstruction:
- Callers accumulate records in `FrameBuilder.add`/`addBatch` and call `build()` to get an Arrow table.
- Known keys map to fixed schema columns, and unknown keys are serialized into `payload_json`.
- `FrameReader` reconstructs scope, temporal/decay/provenance fields, and payload overflow back to record-shaped objects.

2. Serialization and transport:
- `serializeToIPC` emits Arrow IPC bytes and supports `stream` or `file` format.
- `ipcToBase64` and `base64ToIPC` bridge binary payloads for text protocols.
- `deserializeFromIPC` reconstructs an Arrow table from bytes.

3. Budgeting and selection:
- Columnar scoring computes per-row composite values from decay, importance, and recency.
- Token costs are estimated from text/payload lengths.
- Selection utilities greedily fit high-value records into token budgets (`selectByTokenBudget`, `selectMemoriesByBudget`, `phaseWeightedSelection`, `TokenBudgetAllocator.rebalance`).

4. Service/protocol integration:
- `extendMemoryServiceWithArrow` wraps `get/search/put` and optional `delete` to export/import frames and IPC payloads.
- `handleExportMemory` and `handleImportMemory` validate payload shapes with Zod and route to dependency-provided frame methods.
- `createMemoryArtifact`/`parseMemoryArtifact` package frame data into a fixed A2A envelope (`dzupagent_memory_batch`).

5. Concurrency and coordination:
- `SharedMemoryChannel` manages slot acquisition and data region allocation using atomics and CAS operations.
- `ArrowBlackboard` gates writes by configured writer URI, tracks `writeSeq`, and exposes snapshots for readers.

6. IPC client behavior:
- `IpcMemoryClient` currently works through `backingService` delegation for `get`/`put`/`delete`.
- Remote endpoint mode exists in config shape but intentionally throws `IpcNotConfiguredError` until wire transport is implemented.

## Key APIs and Types
Core schema and frame APIs:
- `MEMORY_FRAME_SCHEMA`, `MEMORY_FRAME_COLUMNS`, `MEMORY_FRAME_VERSION`, `MEMORY_FRAME_FIELD_COUNT`.
- `FrameBuilder`, `FrameReader`.
- `FrameRecord`, `FrameRecordMeta`, `FrameRecordValue`, `FrameScope`, `FrameTemporal`, `FrameDecay`, `FrameProvenance`.

IPC and transport:
- `serializeToIPC`, `deserializeFromIPC`, `ipcToBase64`, `base64ToIPC`.
- `SerializeOptions`.
- `IpcMemoryClient`, `IpcNotConfiguredError`, `IpcMemoryClientConfig`.

Columnar operations and budgeting:
- `findWeakIndices`, `batchDecayUpdate`, `temporalMask`, `applyMask`, `partitionByNamespace`, `computeCompositeScore`, `batchTokenEstimate`, `selectByTokenBudget`, `rankByPageRank`, `applyHubDampeningBatch`, `batchCosineSimilarity`, `takeRows`.
- `selectMemoriesByBudget`, `TokenBudgetAllocator`, `phaseWeightedSelection`.
- `PHASE_NAMESPACE_WEIGHTS`, `PHASE_CATEGORY_WEIGHTS`.
- `CompositeScoreWeights`, `ScoredRecord`, `TokenBudgetAllocation`, `TokenBudgetAllocatorConfig`, `ConversationPhase`.

Integration bridge APIs:
- `extendMemoryServiceWithArrow` and types `MemoryServiceLike`, `MemoryServiceArrowExtension`, `ExportFrameOptions`, `ImportFrameResult`, `ImportStrategy`.
- MCP transport schemas and handlers:
- `exportMemoryInputSchema`, `exportMemoryOutputSchema`, `importMemoryInputSchema`, `importMemoryOutputSchema`, `memorySchemaOutputSchema`.
- `handleExportMemory`, `handleImportMemory`, `handleMemorySchema`.
- A2A memory artifact APIs:
- `createMemoryArtifact`, `parseMemoryArtifact`, `sanitizeForExport`.
- `MemoryArtifact`, `MemoryArtifactMetadata`, `MemoryArtifactPart`, `SanitizeOptions`.

Coordination and analytics:
- `SharedMemoryChannel`, `SharedMemoryChannelOptions`, `SlotHandle`.
- `ArrowBlackboard`, `BlackboardConfig`, `BlackboardTableDef`, `BlackboardSnapshot`.
- `DuckDBEngine`, `MemoryAnalytics` and analytics result row types.

Adapters and extended frames:
- `createAdapterRegistry` and adapter interfaces/types.
- Built-in adapter classes are implemented in `src/adapters/*`.
- Extended frame builders and schemas for tool results, codegen, eval, and entity graph data.

## Dependencies
From `package.json`:
- Runtime dependencies:
- `apache-arrow` `^19.0.0` for schema/table/vector/IPC primitives.
- `zod` `^4.3.6` for runtime input/output validation in MCP transport.
- Optional peer dependency:
- `@duckdb/duckdb-wasm` `>=1.29.0` used only by analytics modules.
- Dev/build/test dependencies:
- `typescript`, `tsup`, `vitest`.

Build/export profile:
- ESM-only build (`format: ['esm']`) via `tsup`.
- Output path `dist/` with generated `.d.ts` and sourcemaps.
- Target runtime `node20`.

## Integration Points
Implemented integration boundaries:
- Memory service extension:
- `extendMemoryServiceWithArrow(memoryService)` expects `get/search/put` and optional `delete`.
- Import strategies are `upsert`, `append`, and `replace`.

- MCP transport handlers:
- `handleExportMemory(input, deps)` requires `deps.exportFrame(...)`.
- `handleImportMemory(input, deps)` requires `deps.importFrame(...)`.
- Supports `arrow_ipc` and `json` payload formats.

- A2A exchange:
- `createMemoryArtifact` and `parseMemoryArtifact` provide a stable envelope for inter-agent memory batch transfer.

- Adapter registry:
- Registry APIs support registering custom adapters and looking them up by source-system name.
- Built-in implementations cover Mastra, LangGraph, Mem0, Letta, and MCP KG.

- Shared-memory coordination:
- `SharedMemoryChannel` integrates with worker/process handoff through `SharedArrayBuffer` references.
- `ArrowBlackboard` integrates with multi-agent pipelines that need append-only shared tables and writer authorization.

- Analytics:
- `DuckDBEngine` and `MemoryAnalytics` integrate as optional SQL analytics over Arrow tables when the peer dependency is installed.

## Testing and Observability
Testing:
- Test runner: Vitest (`vitest run`) with Node environment and 30s timeout.
- Test locations: `src/__tests__` with focused suites for frames, adapters, transport, branch/error paths, shared-memory channel, blackboard, analytics, and end-to-end round trips.
- Coverage thresholds in `vitest.config.ts`:
- statements `>= 60`
- branches `>= 50`
- functions `>= 50`
- lines `>= 60`
- Current local `coverage/coverage-summary.json` reports high package coverage (total lines/statements ~98%, branches ~94.5%, functions ~99.4%).

Observability:
- No central logger or metrics backend is embedded in this package.
- Some APIs return explicit operational counters/timings:
- `batchOverlapAnalysis.analysisMs`
- DuckDB query results with `executionMs` and `rowCount`
- MCP import/export and service import flows with `imported/skipped/conflicts` and warnings
- Error behavior is intentionally mixed:
- Fail-soft defaults in many data/columnar/serializer helpers.
- Explicit throw behavior for misuse in coordination or strict strategy paths (for example unauthorized blackboard writes, replace strategy without delete support, invalid shared-channel writes).

## Risks and TODOs
- `src/schema.ts` header comment says "21-column schema" but the schema currently defines 22 fields.
- `createDefaultRegistry()` exists in `src/adapters/index.ts` but is not exported from package root `src/index.ts`; root consumers cannot access it directly.
- `IpcMemoryClient` remote endpoint mode is not implemented yet and intentionally throws when no `backingService` is configured.
- Several APIs choose fail-soft behavior (empty table/array/string or zeroed values) on errors, which improves resilience but can hide upstream failures if callers do not validate outputs.
- Shared-memory allocation uses a wrapping bump pointer and relies on slot lifecycle discipline (`release`) and external coordination in cross-process multi-writer scenarios.
- `replace` strategy in memory service extension is strict and can throw when existing records do not expose recoverable keys.
- Runtime assumptions include availability of `Buffer`, `TextEncoder`, `TextDecoder`, `performance`, and `SharedArrayBuffer` in the host environment.
- README metadata appears partially stale relative to code/package metadata (for example peer dependency notes and dependency version notes), so package docs can drift if not regenerated together.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js