# @dzupagent/memory-ipc Architecture

## Scope
`@dzupagent/memory-ipc` is a framework package that standardizes in-memory and over-the-wire memory exchange using Apache Arrow tables and Arrow IPC. The package lives at `packages/memory-ipc` and currently includes:

- Canonical memory frame schema (`src/schema.ts`) and row-oriented conversion helpers (`src/frame-builder.ts`, `src/frame-reader.ts`)
- Arrow IPC and base64 transport helpers (`src/ipc-serializer.ts`)
- Columnar scoring/filtering/ranking operations and token-budgeted selection (`src/columnar-ops.ts`, `src/token-budget.ts`, `src/phase-memory-selection.ts`)
- Cache delta and overlap analysis utilities (`src/cache-delta.ts`, `src/memory-aware-compress.ts`)
- Shared-memory and coordination primitives (`src/shared-memory-channel.ts`, `src/blackboard.ts`)
- Protocol/integration layers (memory service extension, MCP transport handlers, A2A artifact wrapper)
- Cross-framework adapters (`src/adapters/*`) and optional SQL analytics via DuckDB-WASM (`src/analytics/*`)
- Additional Arrow frame families for tool results, codegen, evals, and entity graphs (`src/frames/*`)

The package build exports only `src/index.ts` through `dist` (ESM + d.ts), as configured in `tsup.config.ts` and `package.json`.

## Responsibilities
Primary responsibilities implemented in current code:

- Define the canonical memory frame contract used across components.
- Convert record-shaped memory data to/from Arrow `Table` efficiently.
- Serialize/deserialize memory frames to Arrow IPC bytes and text-safe base64.
- Provide reusable, non-fatal batch utilities for scoring, filtering, selection, and similarity.
- Provide import/export bridges for higher-level protocols:
  - MemoryService-like APIs (`extendMemoryServiceWithArrow`)
  - MCP request/response handlers (`handleExportMemory`, `handleImportMemory`, `handleMemorySchema`)
  - A2A artifact envelope (`createMemoryArtifact`, `parseMemoryArtifact`, `sanitizeForExport`)
- Provide adapter surface for external memory ecosystems (Mastra, LangGraph, Mem0, Letta, MCP KG).
- Provide optional analytics on Arrow tables through DuckDB-WASM when peer dependency is installed.

Non-responsibilities (based on code boundaries):

- No persistence backend ownership (storage is delegated to caller services/adapters).
- No network server or transport daemon.
- No workflow orchestration or app-level authorization policy beyond local writer checks in `ArrowBlackboard`.

## Structure
Top-level source structure:

- `src/index.ts`: package public API exports.
- `src/schema.ts`: canonical memory frame schema constants.
- `src/frame-builder.ts`: `FrameBuilder` and input metadata/value types.
- `src/frame-reader.ts`: `FrameReader` and reconstructed `FrameRecord` type.
- `src/ipc-serializer.ts`: Arrow IPC + base64 helpers.
- `src/columnar-ops.ts`: pure vectorized operations over Arrow tables.
- `src/token-budget.ts`: budget scoring/selection and `TokenBudgetAllocator`.
- `src/phase-memory-selection.ts`: phase-aware namespace/category multipliers.
- `src/cache-delta.ts`: table-delta/refreeze heuristic.
- `src/memory-aware-compress.ts`: Jaccard overlap duplicate detection.
- `src/shared-memory-channel.ts`: `SharedArrayBuffer` + Atomics slot channel.
- `src/blackboard.ts`: `ArrowBlackboard` append/read coordination map.
- `src/memory-service-ext.ts`: Arrow import/export extension for MemoryService-like interfaces.
- `src/mcp-memory-transport.ts`: Zod schemas and MCP-friendly handlers.
- `src/a2a-memory-artifact.ts`: artifact create/parse/sanitize.
- `src/adapters/*`: adapter interfaces, helpers, and built-in adapters.
- `src/analytics/*`: DuckDB engine and canned analytics queries.
- `src/frames/*`: specialized frame schemas/builders.
- `src/__tests__/**`: package tests.

Canonical memory frame schema (`MEMORY_FRAME_SCHEMA`) currently has 22 fields and schema metadata `memory_frame_version=1`.

## Runtime and Control Flow
Core runtime flows implemented by the package:

1. Build and read memory frame
- Caller accumulates records via `FrameBuilder.add()` / `addBatch()`.
- `FrameBuilder.build()` creates Arrow `Table`; `toIPC()` serializes directly.
- Consumer wraps table in `FrameReader` or constructs from IPC/shared buffer.
- `FrameReader.toRecords()` reconstructs value/meta shape including `_temporal`, `_decay`, `_provenance`, and payload overflow.

2. IPC transport
- `serializeToIPC(table, { format })` writes Arrow stream/file format.
- `ipcToBase64` / `base64ToIPC` bridge binary into string transports.
- `deserializeFromIPC` restores a table.
- Error handling is intentionally non-throwing in serializer helpers (returns empty bytes/table/string on failures).

3. Selection and budgeting
- `computeCompositeScore`, `batchTokenEstimate`, and selectors (`selectByTokenBudget`, `selectMemoriesByBudget`, `phaseWeightedSelection`) rank and pick rows under budget.
- `TokenBudgetAllocator.rebalance()` computes memory vs conversation/system/tool/response slots and returns selected indices.

4. Service/protocol adapters
- `extendMemoryServiceWithArrow()` wraps `get/search/put/(optional delete)` service methods with frame and IPC import/export helpers.
- `handleExportMemory()` and `handleImportMemory()` implement MCP-transport-safe schema-validated payload handling (`arrow_ipc` or `json`).
- `createMemoryArtifact()` and `parseMemoryArtifact()` wrap/unwrap Arrow IPC for A2A-style memory exchange.

5. Concurrent/coordination utilities
- `SharedMemoryChannel` writes IPC bytes into slot-managed shared memory using CAS and atomics state transitions.
- `ArrowBlackboard` enforces per-table designated writer identity and tracks `writeSeq`/`lastWriteAt` snapshots.

## Key APIs and Types
Public API is exported from `src/index.ts`. Major surfaces:

- Schema and contracts
  - `MEMORY_FRAME_SCHEMA`, `MEMORY_FRAME_COLUMNS`, `MEMORY_FRAME_VERSION`, `MEMORY_FRAME_FIELD_COUNT`
  - `MemoryFrameColumn`

- Frame conversion
  - `FrameBuilder`, `FrameReader`
  - `FrameScope`, `FrameTemporal`, `FrameDecay`, `FrameProvenance`, `FrameRecordMeta`, `FrameRecordValue`, `FrameRecord`

- IPC helpers
  - `serializeToIPC`, `deserializeFromIPC`, `ipcToBase64`, `base64ToIPC`
  - `SerializeOptions`

- Columnar and budget operations
  - `findWeakIndices`, `batchDecayUpdate`, `temporalMask`, `applyMask`, `partitionByNamespace`, `computeCompositeScore`, `batchTokenEstimate`, `selectByTokenBudget`, `rankByPageRank`, `applyHubDampeningBatch`, `batchCosineSimilarity`, `takeRows`
  - `selectMemoriesByBudget`, `TokenBudgetAllocator`
  - `phaseWeightedSelection`, `PHASE_NAMESPACE_WEIGHTS`, `PHASE_CATEGORY_WEIGHTS`
  - `CompositeScoreWeights`, `ScoredRecord`, `TokenBudgetAllocation`, `TokenBudgetAllocatorConfig`, `ConversationPhase`

- Delta/compression
  - `computeFrameDelta`, `FrameDelta`
  - `batchOverlapAnalysis`, `OverlapAnalysis`

- Shared memory/blackboard
  - `SharedMemoryChannel`, `SharedMemoryChannelOptions`, `SlotHandle`
  - `ArrowBlackboard`, `BlackboardConfig`, `BlackboardTableDef`, `BlackboardSnapshot`

- Service and protocol bridges
  - `extendMemoryServiceWithArrow`, `ExportFrameOptions`, `ImportFrameResult`, `ImportStrategy`, `MemoryServiceLike`, `MemoryServiceArrowExtension`
  - MCP schemas + handlers + dependency types
  - A2A memory artifact types and sanitization options

- Adapters and analytics
  - Adapter registry interfaces and helpers
  - Built-in adapter classes (Mastra, LangGraph, Mem0, Letta, MCPKG)
  - `DuckDBEngine`, `MemoryAnalytics` and analytics result types

- Extended frames
  - `TOOL_RESULT_SCHEMA`/`ToolResultFrameBuilder`
  - `CODEGEN_FRAME_SCHEMA`/`CodegenFrameBuilder`
  - `EVAL_FRAME_SCHEMA`/`EvalFrameBuilder`
  - `ENTITY_GRAPH_SCHEMA`/`EntityGraphFrameBuilder`

Important export nuance:

- `createDefaultRegistry()` exists in `src/adapters/index.ts` but is not re-exported from package root `src/index.ts`; package-root consumers currently get `createAdapterRegistry()` and can instantiate/register adapters themselves.

## Dependencies
From `package.json`:

Runtime dependencies:

- `apache-arrow` `^19.0.0`: core table/schema/vector/IPC operations.
- `zod` `^4.3.6`: MCP input/output schema validation.

Peer dependency (optional):

- `@duckdb/duckdb-wasm >=1.29.0`: required only for analytics classes under `src/analytics/*`.

Behavioral dependency note:

- Analytics module dynamically imports DuckDB and throws a descriptive `DuckDBUnavailableError` when peer dependency is missing.

Build/test toolchain:

- `tsup`, `typescript`, `vitest`.
- `tsup` builds ESM + d.ts to `dist/` targeting Node 20.

## Integration Points
Implemented integration boundaries:

- Memory service integration
  - `extendMemoryServiceWithArrow(memoryService)` wraps service implementations exposing `get/search/put` (+ optional `delete`).
  - Supports import strategies: `upsert`, `append`, `replace`.

- MCP layer integration
  - `handleExportMemory(input, deps)` expects dependency `exportFrame(ns, scope, opts)`.
  - `handleImportMemory(input, deps)` expects dependency `importFrame(ns, scope, table, strategy)`.
  - `handleMemorySchema()` emits memory frame field metadata.

- External memory ecosystems
  - Built-in adapters for `mastra`, `langgraph`, `mem0`, `letta`, and `mcp-knowledge-graph`.
  - Registry pattern enables custom adapter registration.

- Worker-thread/agent-process sharing
  - `SharedMemoryChannel` uses `SharedArrayBuffer` + atomics for slot/state-managed exchange.
  - Default contract is single producer writer unless `multiWriter` is explicitly enabled and externally coordinated.

- A2A artifact exchange
  - `createMemoryArtifact` and `parseMemoryArtifact` package Arrow IPC in a fixed artifact envelope (`dzupagent_memory_batch`).

## Testing and Observability
Testing surface (Vitest):

- Test config in `vitest.config.ts` (`environment: node`, 30s timeout).
- Coverage thresholds configured at package level:
  - statements: 60
  - branches: 50
  - functions: 50
  - lines: 60
- Test suites cover core modules, adapters, analytics, transport, branch/error paths, and integration round-trips (`src/__tests__/**`).

Observability currently in code:

- No dedicated logging/metrics emitter inside package runtime modules.
- Some functions include measurable output fields:
  - `batchOverlapAnalysis` returns `analysisMs`.
  - `DuckDBEngine.query/queryMulti` return `executionMs` and `rowCount`.
  - MCP and import APIs return structured counters (`imported/skipped/conflicts`, warnings).
- Error strategy is mixed by layer:
  - computational/serialization helpers often fail-safe with empty/default results.
  - coordination primitives (`SharedMemoryChannel`, `ArrowBlackboard`) throw explicit errors for invalid operations.

## Risks and TODOs
Current implementation risks or sharp edges visible in code:

- Schema docstring drift
  - `schema.ts` file header says “21-column schema” while actual schema defines 22 fields.

- Package root export gap for default adapter registry
  - `createDefaultRegistry()` exists but is not exported from package root `index.ts`, which may surprise consumers expecting one-call built-in registration.

- Non-fatal fallbacks can hide failures
  - `ipc-serializer` and several columnar helpers swallow errors and return empty/default values, which is robust for runtime safety but can mask upstream misuse without additional caller-side checks.

- `SharedMemoryChannel` wrap-around allocator does not include overwrite protection
  - Writer wraps `next_write_offset` when full; safety depends on caller slot lifecycle discipline (`release`) and external coordination in multi-writer/cross-process scenarios.

- Replace import strategy strictness
  - `replace` in memory service extension requires both `delete` support and existing records with recoverable keys; otherwise it throws.

- Environment assumptions
  - `performance.now()`, `TextEncoder`/`TextDecoder`, `Buffer`, and `SharedArrayBuffer` are used directly; package targets Node 20 but non-Node runtimes need compatibility checks.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

