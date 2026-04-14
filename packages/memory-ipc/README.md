# @dzupagent/memory-ipc

<!-- AUTO-GENERATED-START -->
## Package Overview

> Arrow-based IPC for inter-agent memory sharing in DzupAgent

**Maturity:** Experimental | **Coverage:** N/A | **Exports:** 24

| Metric | Value |
|--------|-------|
| Source Files | 28 |
| Lines of Code | 8,956 |
| Test Files | 13 |
| Internal Dependencies | `@dzupagent/memory` |

### Quality Gates
✓ Build | ✓ Typecheck | ✓ Lint | ✓ Test | ✓ Coverage

### Install
```bash
npm install @dzupagent/memory-ipc
```
<!-- AUTO-GENERATED-END -->

Arrow-based IPC for inter-agent memory sharing in DzupAgent. Provides a canonical 22-column Apache Arrow schema, builder/reader for memory frames, IPC serialization, columnar operations, token budget allocation, cross-framework adapters, and MCP transport.

## Installation

```bash
yarn add @dzupagent/memory-ipc
# or
npm install @dzupagent/memory-ipc
```

## Quick Start

```ts
import {
  FrameBuilder,
  FrameReader,
  serializeToIPC,
  deserializeFromIPC,
  TokenBudgetAllocator,
} from '@dzupagent/memory-ipc'

// Build a memory frame
const builder = new FrameBuilder()
builder.add({
  key: 'lesson-1',
  text: 'Always validate input at API boundaries',
  namespace: 'lessons',
  scope: { tenantId: 't1', projectId: 'p1' },
  temporal: { createdAt: new Date(), accessCount: 5 },
  decay: { score: 0.95, halfLifeMs: 86400000 },
})
const table = builder.build()

// Read records from a frame
const reader = new FrameReader(table)
for (const record of reader) {
  console.log(record.key, record.text, record.decay?.score)
}

// Serialize for IPC transfer
const buffer = serializeToIPC(table)
const restored = deserializeFromIPC(buffer)

// Token-budget-aware memory selection
const allocator = new TokenBudgetAllocator({ totalBudget: 4000 })
const selected = allocator.allocate(table)
```

## API Reference

### Schema

- `MEMORY_FRAME_SCHEMA` -- canonical 22-column Arrow schema
- `MEMORY_FRAME_COLUMNS` -- column name constants
- `MEMORY_FRAME_VERSION` / `MEMORY_FRAME_FIELD_COUNT` -- schema metadata

### Frame Builder / Reader

- `FrameBuilder` -- fluent API to construct Arrow tables from memory records
- `FrameReader` -- iterable reader that extracts typed records from Arrow tables

**Types:** `FrameScope`, `FrameTemporal`, `FrameDecay`, `FrameProvenance`, `FrameRecordMeta`, `FrameRecordValue`, `FrameRecord`

### IPC Serialization

- `serializeToIPC(table, options?)` -- serialize Arrow table to IPC buffer
- `deserializeFromIPC(buffer)` -- deserialize IPC buffer to Arrow table
- `ipcToBase64(buffer)` / `base64ToIPC(base64)` -- Base64 encoding for JSON/HTTP transport

**Types:** `SerializeOptions`

### Columnar Operations

Vectorized operations that work directly on Arrow columns (no row-by-row iteration):

- `findWeakIndices(table, threshold)` -- find records below a decay threshold
- `batchDecayUpdate(table, halfLifeMs)` -- apply decay to all records
- `temporalMask(table, since)` -- mask records by creation date
- `partitionByNamespace(table)` -- group records by namespace
- `computeCompositeScore(table, weights)` -- compute weighted scores
- `batchTokenEstimate(table)` -- estimate token count per record
- `selectByTokenBudget(table, budget)` -- select records within a token budget
- `rankByPageRank(table, links)` -- PageRank-based ranking
- `applyHubDampeningBatch(table)` -- hub dampening for over-connected nodes
- `batchCosineSimilarity(table, query)` -- batch cosine similarity
- `takeRows(table, indices)` -- extract specific rows

### Token Budget

- `TokenBudgetAllocator` -- allocate memory records across namespaces within a token budget
- `selectMemoriesByBudget(table, budget)` -- simple budget-based selection
- `phaseWeightedSelection(table, phase)` -- select memories weighted by conversation phase

**Types:** `CompositeScoreWeights`, `ScoredRecord`, `TokenBudgetAllocation`, `TokenBudgetAllocatorConfig`, `ConversationPhase`

### Cache Delta

- `computeFrameDelta(prev, curr)` -- compute delta between two frames for incremental sync

**Types:** `FrameDelta`

### Memory-Aware Compression

- `batchOverlapAnalysis(table)` -- detect overlap between memory records

**Types:** `OverlapAnalysis`

### Shared Memory Channel

- `SharedMemoryChannel` -- zero-copy shared memory between agents using SharedArrayBuffer

**Types:** `SharedMemoryChannelOptions`, `SlotHandle`

### Adapters

- `createAdapterRegistry()` -- registry for cross-framework adapters
- Built-in adapters: Mastra, LangGraph, Mem0, Letta, MCP-KG

**Types:** `MemoryFrameAdapter`, `AdapterValidationResult`, `AdapterRegistry`, `FrameColumnArrays`

### MCP Memory Transport

MCP-compatible handlers for memory export/import:

- `handleExportMemory(input, deps)` -- export memories as Arrow IPC
- `handleImportMemory(input, deps)` -- import memories from Arrow IPC
- `handleMemorySchema()` -- return the memory frame schema

**Types:** `ExportMemoryInput`, `ImportMemoryInput`, `ExportMemoryOutput`, `ImportMemoryOutput`

### A2A Memory Artifact

- `createMemoryArtifact(table, metadata)` -- wrap memory as an A2A artifact
- `parseMemoryArtifact(artifact)` -- unwrap an A2A artifact back to Arrow
- `sanitizeForExport(table, options)` -- strip sensitive data before export

**Types:** `MemoryArtifact`, `MemoryArtifactPart`, `SanitizeOptions`

### Blackboard

- `ArrowBlackboard` -- shared Arrow-backed blackboard for multi-agent coordination

**Types:** `BlackboardConfig`, `BlackboardTableDef`, `BlackboardSnapshot`

### Extended Frames

Specialized frame schemas for domain-specific data:

- `ToolResultFrameBuilder` / `TOOL_RESULT_SCHEMA` -- tool execution results
- `CodegenFrameBuilder` / `CODEGEN_FRAME_SCHEMA` -- code generation file data
- `EvalFrameBuilder` / `EVAL_FRAME_SCHEMA` -- evaluation results
- `EntityGraphFrameBuilder` / `ENTITY_GRAPH_SCHEMA` -- entity relationship graphs

**Types:** `ToolResultEntry`, `CodegenFileEntry`, `EvalResultEntry`, `EntityGraphEntry`

### MemoryService Extension

- `extendMemoryServiceWithArrow(service)` -- add Arrow import/export to an existing MemoryService

**Types:** `ExportFrameOptions`, `ImportFrameResult`, `ImportStrategy`

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `apache-arrow` | `^19.0.0` | Apache Arrow columnar data |
| `zod` | `^3.23.0` | Schema validation |

## Peer Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@dzupagent/memory` | `workspace:*` | Memory service (optional) |

## License

MIT
