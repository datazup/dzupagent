# @dzupagent/memory-ipc Architecture

## Purpose
`@dzupagent/memory-ipc` is the memory interoperability layer for DzupAgent. It standardizes how memory is represented, exchanged, selected, and analyzed using Apache Arrow tables and Arrow IPC.

At a high level, the package provides:
- A canonical Arrow `MemoryFrame` schema (22 columns)
- Bidirectional mapping between object records and Arrow tables
- Transport helpers (IPC bytes, base64 wrappers, MCP handlers, A2A artifacts)
- Vectorized selection/scoring and memory-budget utilities
- Cross-framework adapters (Mastra, LangGraph, Mem0, Letta, MCP-KG)
- Optional analytics via DuckDB-WASM
- Shared-memory and blackboard primitives for multi-agent coordination

## Design Goals
- Columnar interoperability: all systems converge on one schema.
- Efficient transport: Arrow IPC stream format for compact binary transfer.
- Non-fatal operations: most helpers degrade gracefully instead of throwing.
- Extensible boundaries: adapters, frame variants, and analytics are pluggable.
- Optional heavy deps: DuckDB integration is optional peer dependency.

## Package Layout
- `src/schema.ts`: Canonical `MEMORY_FRAME_SCHEMA` and metadata.
- `src/frame-builder.ts`: Object records -> Arrow `Table`.
- `src/frame-reader.ts`: Arrow `Table` -> object records and filters.
- `src/ipc-serializer.ts`: Arrow IPC and base64 helpers.
- `src/columnar-ops.ts`: Vectorized scoring/filtering/ranking operations.
- `src/token-budget.ts`: Budgeted memory selection + allocator.
- `src/phase-memory-selection.ts`: Conversation-phase-aware selection.
- `src/cache-delta.ts`: Frame diffing for cache/refreeze decisions.
- `src/memory-aware-compress.ts`: Jaccard overlap duplicate analysis.
- `src/shared-memory-channel.ts`: `SharedArrayBuffer` slot channel.
- `src/memory-service-ext.ts`: Adds Arrow import/export to MemoryService-like APIs.
- `src/mcp-memory-transport.ts`: MCP-safe Zod schemas + handlers.
- `src/a2a-memory-artifact.ts`: Agent-to-agent transfer wrapper + sanitization.
- `src/blackboard.ts`: In-memory Arrow blackboard with writer ACL.
- `src/adapters/*`: Cross-framework conversion adapters + registry.
- `src/analytics/*`: DuckDB engine + prebuilt analytical query facade.
- `src/frames/*`: Specialized non-memory frame schemas/builders.
- `src/index.ts`: Public API surface.

## Canonical MemoryFrame Schema
Schema version: `1` in schema metadata (`memory_frame_version=1`).

### Columns (22)
1. `id`
2. `namespace` (dictionary-encoded)
3. `key`
4. `scope_tenant`
5. `scope_project`
6. `scope_agent`
7. `scope_session`
8. `text`
9. `payload_json`
10. `system_created_at` (Int64 ms)
11. `system_expired_at` (Int64 ms, nullable)
12. `valid_from` (Int64 ms)
13. `valid_until` (Int64 ms, nullable)
14. `decay_strength`
15. `decay_half_life_ms`
16. `decay_last_accessed_at` (Int64 ms)
17. `decay_access_count` (Int64)
18. `agent_id` (dictionary-encoded)
19. `category` (dictionary-encoded)
20. `importance`
21. `provenance_source` (dictionary-encoded)
22. `is_active`

### Mapping conventions
- Known value fields (`text`, `_temporal`, `_decay`, `_provenance`, `_agent`, `category`/`type`, `importance`) map to dedicated columns.
- Unknown fields are serialized into `payload_json` (overflow bucket).
- `is_active` is derived from expiration status (`system_expired_at === null` in builder flow).

## Core Data Flow

### 1) Build -> IPC -> Read
1. Domain record objects are added via `FrameBuilder.add(value, meta)`.
2. Builder emits an Arrow table (`build`) or IPC (`toIPC`).
3. Consumer deserializes (`deserializeFromIPC` / `FrameReader.fromIPC`).
4. `FrameReader.toRecords()` reconstructs conventional memory shapes.

### 2) Selection and budgeting
1. Compute score signals (`computeCompositeScore`, phase multipliers, PageRank, etc.).
2. Estimate token costs (`batchTokenEstimate`).
3. Greedy selection under budget (`selectByTokenBudget`, `selectMemoriesByBudget`, `phaseWeightedSelection`).

### 3) Transport boundaries
- IPC/raw bytes: `serializeToIPC` + optional base64 wrappers.
- MCP tool transport: `handleExportMemory`, `handleImportMemory`, `handleMemorySchema`.
- A2A envelope transport: `createMemoryArtifact`, `parseMemoryArtifact`.
- Shared memory transport: `SharedMemoryChannel` slot handles over `SharedArrayBuffer`.

## Feature Inventory

### Record <-> Arrow conversion
- `FrameBuilder`: append/addBatch APIs, single-use `build`, IPC/shared-buffer convenience methods.
- `FrameReader`: namespace listing, typed column access, reconstruction and filters (`filterByNamespace`, `filterActive`, `filterByDecayAbove`, `filterByAgent`).

### IPC serialization
- `serializeToIPC`, `deserializeFromIPC`, `ipcToBase64`, `base64ToIPC`.
- Deliberately non-fatal behavior:
- serialization failure -> empty `Uint8Array`
- deserialization failure -> empty table
- base64 failure -> empty string/bytes

### Columnar operations
- Filtering: `findWeakIndices`, `temporalMask`, `applyMask`, `takeRows`, `partitionByNamespace`
- Scoring/ranking: `computeCompositeScore`, `rankByPageRank`, `applyHubDampeningBatch`
- Cost/similarity: `batchTokenEstimate`, `batchCosineSimilarity`
- Retrieval under budget: `selectByTokenBudget`

### Token budget + phase-aware selection
- `selectMemoriesByBudget`: score/token efficiency greedy selector.
- `TokenBudgetAllocator`: splits global context budget across system/tool/conversation/memory/response reserve.
- `phaseWeightedSelection`: namespace/category multipliers by phase (`planning`, `coding`, `debugging`, `reviewing`, `general`).

### Cache and compression helpers
- `computeFrameDelta`: detects added/removed/modified rows using ID sets + FNV-1a hash of `text + payload_json`.
- `batchOverlapAnalysis`: classifies incoming observations as novel vs duplicate using Jaccard overlap.

### Shared memory / coordination
- `SharedMemoryChannel`: lock-free slot state machine with atomics (`FREE`, `WRITING`, `READY`, `CLAIMED`).
- `ArrowBlackboard`: named tables with designated writer policy and append+read snapshots.

### Integration adapters
- Registry: `createAdapterRegistry`, `createDefaultRegistry`.
- Built-ins:
- `MastraAdapter`
- `LangGraphAdapter`
- `Mem0Adapter`
- `LettaAdapter` (+ `lettaCoreToWorkingMemory`, `workingMemoryToLettaCore`)
- `MCPKGAdapter` (+ `flattenMCPKG`, `reconstructMCPKG`)

### Service and protocol transport
- `extendMemoryServiceWithArrow` for MemoryService-like objects (`get`, `search`, `put`, optional `delete`).
- Merge strategies: `upsert`, `append`, `replace`.
- MCP layer with explicit Zod schemas for request/response validation.
- A2A artifact wrapper with optional sanitization (`redactColumns`, `excludeNamespaces`, `stripPayload`).

### Analytics
- `DuckDBEngine` (optional `@duckdb/duckdb-wasm` peer dependency): single-table and multi-table SQL.
- `MemoryAnalytics` prebuilt queries:
- `decayTrends`
- `namespaceStats`
- `expiringMemories`
- `agentPerformance`
- `usagePatterns`
- `duplicateCandidates`
- `custom`

### Extended frame families
- `ToolResultFrameBuilder` + `TOOL_RESULT_SCHEMA`
- `CodegenFrameBuilder` + `CODEGEN_FRAME_SCHEMA`
- `EvalFrameBuilder` + `EVAL_FRAME_SCHEMA`
- `EntityGraphFrameBuilder` + `ENTITY_GRAPH_SCHEMA`

## How To Use

### 1) Build and read a MemoryFrame
```ts
import { FrameBuilder, FrameReader } from '@dzupagent/memory-ipc'

const builder = new FrameBuilder()
builder.add(
  {
    text: 'Use PostgreSQL for transactional data',
    _temporal: { systemCreatedAt: Date.now(), validFrom: Date.now() },
    _decay: { strength: 0.9, halfLifeMs: 86_400_000 },
    _provenance: { createdBy: 'agent://planner', source: 'decision-log' },
    category: 'decision',
    importance: 0.85,
    customTag: 'db', // goes to payload_json
  },
  {
    id: 'mem-1',
    namespace: 'decisions',
    key: 'db-choice',
    scope: { tenant: 't1', project: 'p1', agent: 'planner' },
  },
)

const table = builder.build()
const records = new FrameReader(table).toRecords()
```

### 2) Serialize and transfer over wire
```ts
import { serializeToIPC, deserializeFromIPC, ipcToBase64, base64ToIPC } from '@dzupagent/memory-ipc'

const ipc = serializeToIPC(table)
const payload = ipcToBase64(ipc) // send over JSON transport

const restored = deserializeFromIPC(base64ToIPC(payload))
```

### 3) Retrieve memories within a token budget
```ts
import { selectMemoriesByBudget } from '@dzupagent/memory-ipc'

const selected = selectMemoriesByBudget(table, 3000, {
  minScore: 0.2,
  phaseWeights: { decisions: 1.8, lessons: 1.4 },
})

const rowIndices = selected.map((s) => s.rowIndex)
```

### 4) Use phase-aware retrieval
```ts
import { phaseWeightedSelection } from '@dzupagent/memory-ipc'

const selection = phaseWeightedSelection(table, 'debugging', 2000)
```

### 5) Extend a MemoryService-like implementation
```ts
import { extendMemoryServiceWithArrow } from '@dzupagent/memory-ipc'

const memoryWithArrow = extendMemoryServiceWithArrow(memoryService)

const exported = await memoryWithArrow.exportIPC('decisions', { tenant: 't1' })
await memoryWithArrow.importIPC('decisions', { tenant: 't2' }, exported, 'upsert')
```

### 6) Plug into MCP handlers
```ts
import { handleExportMemory, handleImportMemory, handleMemorySchema } from '@dzupagent/memory-ipc'

const exportResult = await handleExportMemory(
  { namespace: 'decisions', format: 'arrow_ipc', limit: 100 },
  { exportFrame: deps.exportFrame },
)

const importResult = await handleImportMemory(
  {
    data: exportResult.data,
    format: exportResult.format,
    namespace: 'decisions',
    merge_strategy: 'upsert',
  },
  { importFrame: deps.importFrame },
)

const schema = handleMemorySchema()
```

### 7) Use built-in adapters
```ts
import { createDefaultRegistry } from '@dzupagent/memory-ipc'

const registry = createDefaultRegistry()
const adapter = registry.get('langgraph')
if (!adapter) throw new Error('Adapter missing')

const table = adapter.toFrame(langGraphItems)
const restored = adapter.fromFrame(table)
```

### 8) Create and sanitize A2A artifacts
```ts
import { createMemoryArtifact, parseMemoryArtifact, sanitizeForExport } from '@dzupagent/memory-ipc'

const { table: safeTable } = sanitizeForExport(table, {
  redactColumns: ['text', 'payload_json'],
  excludeNamespaces: ['secrets'],
})

const artifact = createMemoryArtifact(safeTable, 'agent://source')
const parsed = parseMemoryArtifact(artifact)
```

### 9) Shared-memory channel between threads/workers
```ts
import { SharedMemoryChannel } from '@dzupagent/memory-ipc'

const channel = new SharedMemoryChannel({ maxBytes: 64 * 1024 * 1024, maxSlots: 16 })
const handle = channel.writeTable(table)

const workerSide = new SharedMemoryChannel({ existingBuffer: channel.sharedBuffer, maxSlots: 16 })
const readBack = workerSide.readTable(handle)
workerSide.release(handle)
```

### 10) Run SQL analytics
```ts
import { MemoryAnalytics } from '@dzupagent/memory-ipc'

const analytics = await MemoryAnalytics.create()
const stats = await analytics.namespaceStats(table)
await analytics.close()
```

## Extensibility Guidance

### Add a new adapter
1. Implement `MemoryFrameAdapter<TExternal>`.
2. Keep `toFrame`/`fromFrame` non-throwing and skip malformed rows.
3. Implement `canAdapt` and `validate` for shape diagnostics.
4. Register with `createAdapterRegistry()` or add to a custom default registry.

### Add a new frame family
1. Define a `Schema` in `src/frames/<name>-frame.ts`.
2. Add a builder that converts domain entries to `tableFromArrays`.
3. Export through `src/frames/index.ts` and root `src/index.ts`.
4. Add tests for schema field count + round-trip expectations.

## Operational Notes and Constraints
- `FrameBuilder` is single-use after `build()`.
- `SharedMemoryChannel` allocator is simple bump+wrap; comments explicitly note single-writer assumption for safe wrap behavior.
- Most APIs swallow internal errors and return safe defaults; callers should validate outputs (`numRows`, byte length) for strict workflows.
- `replace` import strategy in `extendMemoryServiceWithArrow` requires `delete()` support.
- DuckDB analytics require optional peer dependency `@duckdb/duckdb-wasm`.

## Test Posture
The package has broad unit and integration coverage, with focused tests per feature area.

### Feature-to-Test Coverage Matrix
| Feature Area | Primary Implementation | Related Tests | What Is Covered |
|---|---|---|---|
| Canonical schema + metadata | `src/schema.ts` | `src/__tests__/schema.test.ts` | Field count (22), required vs nullable columns, version metadata, exported column constants. |
| Builder/reader conversion | `src/frame-builder.ts`, `src/frame-reader.ts` | `src/__tests__/round-trip.test.ts` | `add`, `addBatch`, single-use `build`, overflow-to-`payload_json`, filters, record reconstruction. |
| IPC and base64 transport | `src/ipc-serializer.ts` | `src/__tests__/round-trip.test.ts`, `src/__tests__/memory-ipc.integration.test.ts` | Arrow IPC serialization/deserialization, base64 round-trips, invalid-data non-fatal behavior. |
| Columnar ops (masking/scoring/ranking) | `src/columnar-ops.ts` | `src/__tests__/columnar-ops.test.ts` | Weak decay detection, temporal filtering, masking, namespace partitioning, composite score, token estimate, budget selection, PageRank, hub dampening, cosine similarity, row extraction. |
| Budget and phase selection | `src/token-budget.ts`, `src/phase-memory-selection.ts` | `src/__tests__/token-budget.test.ts`, `src/__tests__/phase-memory-selection.test.ts` | Greedy selection under budget, score/token efficiency ordering, allocator rebalance, phase namespace/category weighting behavior. |
| Cache delta + overlap compression | `src/cache-delta.ts`, `src/memory-aware-compress.ts` | `src/__tests__/cache-delta.test.ts`, `src/__tests__/memory-aware-compress.test.ts` | Added/removed/modified detection with thresholding, Jaccard duplicate/novel classification and threshold sensitivity. |
| Shared memory channel | `src/shared-memory-channel.ts` | `src/__tests__/shared-memory-channel.test.ts` | Slot lifecycle, write/read/release, max slot bounds, oversized payload rejection, reuse after release, cross-instance access through `existingBuffer`. |
| MemoryService extension | `src/memory-service-ext.ts` | `src/__tests__/memory-service-ext.test.ts` | `exportFrame`, `importFrame`, `exportIPC`, `importIPC`, query/limit behavior, merge strategies (`upsert`/`append`/`replace`), delete requirement for replace. |
| MCP transport handlers | `src/mcp-memory-transport.ts` | `src/__tests__/mcp-memory-transport.test.ts`, `src/__tests__/memory-ipc.integration.test.ts` | Export/import handler behavior for `arrow_ipc` and `json`, malformed input handling, schema descriptor output, dependency call wiring. |
| A2A artifact + sanitization | `src/a2a-memory-artifact.ts` | `src/__tests__/a2a-memory-artifact.test.ts` | Artifact envelope integrity, temporal metadata calculation, parse round-trip, redaction, namespace exclusion, payload stripping. |
| Blackboard coordination | `src/blackboard.ts` | `src/__tests__/blackboard.test.ts` | Writer authorization, append concatenation, read snapshots, update sequence tracking, cleanup via `dispose`. |
| Adapter registry | `src/adapters/adapter-interface.ts`, `src/adapters/index.ts` | `src/__tests__/adapters/adapter-registry.test.ts` | Empty/default registry behavior, registration/lookup, override semantics, built-in adapter presence. |
| Adapter conversion behavior | `src/adapters/*.ts` | `src/__tests__/adapters/langgraph-adapter.test.ts`, `src/__tests__/adapters/mastra-adapter.test.ts`, `src/__tests__/adapters/mem0-adapter.test.ts`, `src/__tests__/adapters/letta-adapter.test.ts`, `src/__tests__/adapters/mcp-kg-adapter.test.ts`, `src/__tests__/adapters/frame-columns.test.ts` | `canAdapt`, `validate`, `toFrame`, `fromFrame`, payload handling, round-trips, helper transforms (`flattenMCPKG`/`reconstructMCPKG`, Letta core conversions). |
| Analytics engine + query facade | `src/analytics/duckdb-engine.ts`, `src/analytics/memory-analytics.ts` | `src/__tests__/analytics/duckdb-engine.test.ts` | Registration/unregistration lifecycle, single/multi-table query flow, cleanup on error, SQL generation behavior in analytics facade methods. |
| Extended frame builders | `src/frames/*.ts` | `src/__tests__/frames.test.ts` | Schema field counts and row mapping for tool-result, codegen, eval, entity-graph frame families, plus hash stability checks for codegen hashing. |

### Integration-Level Coverage
- `src/__tests__/memory-ipc.integration.test.ts` validates cross-module interoperability through the public exports (`src/index.ts`) for build/read/transport/schema flows.

### Coverage Notes For Feature Updates
- For any feature update in this package, add or update tests in the closest domain test file listed above.
- If behavior crosses domains (for example, builder + transport + adapter), add an integration assertion in `src/__tests__/memory-ipc.integration.test.ts`.
- Keep non-fatal fallback behavior explicitly tested when changing serialization, selection, or adapter parsing logic.

## Build and Validation Commands
From repository root:
- `yarn build --filter=@dzupagent/memory-ipc`
- `yarn typecheck --filter=@dzupagent/memory-ipc`
- `yarn lint --filter=@dzupagent/memory-ipc`
- `yarn test --filter=@dzupagent/memory-ipc`

If package API changes impact docs or consumers, follow monorepo guidance in `AGENTS.md` and run broader checks before merge.
