# 01 — Architecture Overview: Arrow-Based Memory Layer

> **Status:** Planning
> **Packages:** `@dzipagent/memory-ipc` (new), `@dzipagent/memory`, `@dzipagent/context`, `@dzipagent/server`

---

## 1. Current Memory Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Agent (DzipAgent / LangGraph)                │
│                                                                   │
│  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────┐  │
│  │ WorkingMemory     │  │ ContextTransfer   │  │ AutoCompress   │ │
│  │ (Zod-validated)   │  │ (cross-intent)    │  │ (4-phase)     │  │
│  └────────┬─────────┘  └────────┬─────────┘  └───────┬───────┘  │
│           │                      │                      │         │
│  ┌────────▼──────────────────────▼──────────────────────▼──────┐ │
│  │                    MemoryService                             │ │
│  │  put(ns, scope, key, Record<string,unknown>) → void         │ │
│  │  get(ns, scope, key?) → Record<string,unknown>[]            │ │
│  │  search(ns, scope, query, limit) → Record<string,unknown>[] │ │
│  └────────┬───────────────────────────────────────────────────┘  │
│           │                                                       │
│  ┌────────▼───────────────────────────────────────────────────┐  │
│  │              ScopedMemoryService (per-agent policies)        │ │
│  │              TemporalMemoryService (bi-temporal)             │  │
│  │              DualStreamWriter (fast/slow path)               │  │
│  └────────┬───────────────────────────────────────────────────┘  │
│           │                                                       │
│  ┌────────▼───────────────────────────────────────────────────┐  │
│  │              AdaptiveRetriever (intent-weighted RRF)         │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐  │  │
│  │  │ Vector   │ │  FTS     │ │  Graph   │ │ Hub/PageRank  │  │  │
│  │  │ Search   │ │ (BM25)   │ │ (Entity) │ │ Dampening     │  │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └───────────────┘  │  │
│  └────────┬───────────────────────────────────────────────────┘  │
│           │                                                       │
│  ┌────────▼───────────────────────────────────────────────────┐  │
│  │              BaseStore (PostgresStore | InMemoryBaseStore)    │ │
│  │              Records: JSON objects with convention-based meta │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

**Problem:** Every boundary crossing (worker threads, MCP calls, A2A transfers, batch ops) requires full JSON serialization/deserialization of `Record<string, unknown>`. This is:
- **Slow** for batch operations (10K records × JSON.parse = ~180ms)
- **Wasteful** for columnar scans (decay scoring touches only `_decay.strength`, yet deserializes entire records)
- **Non-interoperable** (Python agents cannot read our JSON conventions without custom parsers)

---

## 2. Proposed Architecture with Arrow Layer

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Agent (DzipAgent / LangGraph)                            │
│                                                                               │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │                  Existing Memory Stack (unchanged)                     │   │
│  │  WorkingMemory │ ContextTransfer │ AutoCompress │ MemoryService       │   │
│  │  ScopedMemory  │ TemporalMemory  │ DualStream   │ AdaptiveRetriever  │   │
│  └───────┬──────────────────────────────────────────────────────┬───────┘    │
│          │ Record<string,unknown> API                           │             │
│          │ (backward compatible)                                │             │
│          ▼                                                      ▼             │
│  ┌───────────────────────────┐    ┌──────────────────────────────────────┐   │
│  │ BaseStore (Postgres/Mem)  │    │ @dzipagent/memory-ipc (NEW)         │   │
│  │ Row-by-row JSON storage   │    │                                      │    │
│  │ Primary persistence       │    │  FrameBuilder  → Record[] → Table    │    │
│  │                           │    │  FrameReader   → Table → Record[]    │    │
│  │                           │    │  IPC Serializer → Table ↔ Uint8Array │    │
│  │                           │    │  SharedMemChannel → SharedArrayBuf   │    │
│  │                           │    │  ColumnarOps   → vectorized batch    │    │
│  │                           │    │  Adapters      → Mastra/LG/Mem0/... │    │
│  └───────────────────────────┘    └───────┬──────────┬──────────┬───────┘   │
│                                            │          │          │            │
│          ┌─────────────────────────────────┘          │          │            │
│          ▼                                             ▼          ▼            │
│  ┌───────────────┐  ┌────────────────────┐  ┌──────────────────────────┐    │
│  │ Worker Threads │  │ MCP Server         │  │ A2A Protocol             │    │
│  │ (piscina)      │  │ memory.export      │  │ MemoryArtifact           │    │
│  │ SharedArrayBuf │  │ memory.import      │  │ arrow.stream MIME        │    │
│  │ Zero-copy      │  │ memory.subscribe   │  │ Cross-agent transfer     │    │
│  └───────────────┘  └────────────────────┘  └──────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Principle: Arrow is a Parallel Path, Not a Replacement

The existing `Record<string, unknown>` → BaseStore path is unchanged. Arrow provides an alternative path for:
1. **Bulk export/import** — `MemoryService.exportFrame()` / `importFrame()`
2. **Cross-thread transfer** — `SharedMemoryChannel` for piscina workers
3. **Cross-process exchange** — Arrow IPC over MCP tools
4. **External interop** — Arrow IPC in A2A Artifacts
5. **Batch analytics** — columnar operations on Arrow Tables

---

## 3. Data Flow: Record Lifecycle with Arrow

### 3.1 Normal Write Path (Unchanged)

```
Agent → MemoryService.put(ns, scope, key, value)
  → sanitize → enrich(text field) → BaseStore.put()
```

### 3.2 Batch Export to Arrow

```
MemoryService.exportFrame(ns, scope, options)
  → BaseStore.search(ns) → Record<string,unknown>[]
  → FrameBuilder.addBatch(records)
  → FrameBuilder.build() → Arrow Table
  → (optional) tableToIPC() → Uint8Array for transfer
```

### 3.3 Cross-Thread Consolidation

```
Main thread:
  → exportFrame('lessons', scope) → Table
  → SharedMemoryChannel.write(table) → { offset, length }
  → post { offset, length } to piscina worker

Worker thread:
  → SharedMemoryChannel.read(offset, length) → Table (ZERO COPY)
  → ColumnarOps.findWeakIndices(table, 0.1) → Int32Array of row indices
  → ColumnarOps.batchDecayUpdate(table, now) → Float64Array of new strengths
  → ColumnarOps.temporalMask(table, { validAt: now }) → Uint8Array mask
  → build result Table with processed data
  → SharedMemoryChannel.write(resultTable) → { offset, length }
  → post result back to main thread

Main thread:
  → SharedMemoryChannel.read(offset, length) → result Table
  → FrameReader.toRecords() → Record[]
  → MemoryService.put() for each updated record
```

### 3.4 MCP Memory Exchange

```
Agent A (process 1)                    Agent B (process 2)
     │                                       │
     │─── MCP: memory.export ──────────►     │
     │    { namespace, scope, format:        │
     │      'arrow_ipc', limit: 100 }       │
     │                                       │
     │    MemoryService.exportFrame()        │
     │    → Table → tableToIPC()             │
     │    → base64 encode                    │
     │                                       │
     │◄── response: { data: 'base64...',    │
     │      schema_version: 1,               │
     │      record_count: 87 }               │
     │                                       │
     │    base64 decode → tableFromIPC()     │
     │    → FrameReader → records[]          │
     │    → MemoryService.importFrame()      │
```

### 3.5 Integration with 05-MEMORY-SHARING Features

```
SharedMemorySpace.share({mode: 'push'})
  → ProvenanceWriter.put()          # inject _provenance (F2)
  → MemoryService.put()             # persist to BaseStore
  → DzipEventBus.emit()            # notify subscribers
  │
  └── (when Arrow export needed):
      → FrameBuilder.add(record)     # provenance → Arrow columns
      → FrameBuilder.build()         # temporal → Arrow columns
      → tableToIPC()                 # for MCP/A2A transfer
      → CRDTResolver.mergeMaps()     # on import, if conflictResolution='crdt' (F5)
```

---

## 4. Package Dependency Graph

```
@dzipagent/memory-ipc          (NEW — Arrow-based IPC)
  ├── apache-arrow               ~2MB, zero-copy columnar format
  ├── @dzipagent/memory         MemoryService, types, temporal, scoped
  └── adapters/
      ├── mastra-adapter.ts
      ├── langgraph-adapter.ts
      ├── mem0-adapter.ts
      ├── letta-adapter.ts
      └── mcp-kg-adapter.ts

@dzipagent/memory               (UNCHANGED — no Arrow dependency)
  └── @langchain/langgraph        BaseStore

@dzipagent/context              (UNCHANGED — no Arrow dependency)
  └── @dzipagent/memory          for extraction bridge

@dzipagent/server               (EXTENDED — Arrow MCP tools)
  ├── @dzipagent/memory-ipc     for export/import/subscribe
  ├── @dzipagent/memory
  └── hono, drizzle, etc.

@dzipagent/agent                (EXTENDED — Arrow worker integration)
  ├── @dzipagent/memory-ipc     for SharedMemoryChannel
  ├── @dzipagent/memory
  └── @dzipagent/context
```

**Key constraint:** `@dzipagent/memory` NEVER depends on `apache-arrow`. Arrow is always opt-in via the separate `@dzipagent/memory-ipc` package. This keeps the core memory package lightweight for consumers who don't need IPC.

---

## 5. Performance Model

### 5.1 Where Arrow Wins

| Operation | JSON Path | Arrow Path | Speedup |
|-----------|----------|-----------|---------|
| Transfer 1K records between threads | ~35ms (serialize + deserialize) | ~0.1ms (SharedArrayBuffer) | **350x** |
| Scan `decay_strength` over 10K records | ~35ms (deserialize all, extract field) | ~0.5ms (column scan) | **70x** |
| Temporal filter on 10K records | ~25ms (deserialize, check 4 fields) | ~0.3ms (column mask) | **83x** |
| Group 10K records by namespace | ~15ms (hash map over deserialized) | ~1ms (dictionary partition) | **15x** |
| Export 1K records to wire format | ~12ms (JSON.stringify, ~850KB) | ~3ms (IPC, ~320KB) | **4x** |

### 5.2 Where Arrow Does NOT Help

| Operation | Why Arrow doesn't help |
|-----------|----------------------|
| Single record put/get | Arrow overhead exceeds JSON for 1 record |
| WorkingMemory read/write | Small structured state, Zod validation is the right tool |
| LLM-driven extraction | Bottleneck is LLM inference, not data format |
| Semantic search query | Bottleneck is vector store query, not result format |
| Small conversation (<20 messages) | Not enough data volume for columnar advantage |

### 5.3 Break-Even Point

Arrow becomes faster than JSON at approximately **50+ records** for transfers and **100+ records** for batch operations. Below these thresholds, the Arrow overhead (schema construction, RecordBatch allocation) exceeds the JSON path.

**Design implication:** All Arrow APIs provide fallback to JSON for small datasets. The `FrameBuilder.build()` method returns early with a simple wrapper for <50 records.

---

## 6. Security Considerations

### 6.1 SharedArrayBuffer Security

`SharedArrayBuffer` requires Cross-Origin Isolation headers (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`) in browser contexts. In Node.js (our primary target), SharedArrayBuffer is available without restrictions.

**Mitigation:** SharedMemoryChannel is Node.js-only. Browser-based agents use Arrow IPC over MessagePort (structured clone transfer, not zero-copy but still faster than JSON).

### 6.2 Memory Safety

Arrow Tables are immutable after construction. Workers cannot corrupt the main thread's data through a SharedArrayBuffer because:
1. The main thread writes the Arrow IPC bytes to the buffer
2. Workers read the buffer via `tableFromIPC()` which creates an immutable Table
3. Workers write results to a separate region of the buffer
4. Main thread reads results after worker signals completion via Atomics

### 6.3 Encryption Integration

Records encrypted via `EncryptedMemoryService` (F6 from 05-MEMORY-SHARING) store ciphertext in the `payload_json` column. The `text` column contains only non-sensitive metadata (or is null). Arrow transfers of encrypted records preserve the encryption — decryption happens only at the consuming agent after import.

### 6.4 Provenance Integrity

Provenance data (F2) is stored in dedicated Arrow columns (`agent_id`, `category`, `importance`). The full provenance chain is in `payload_json` for complex lineage. Arrow IPC preserves provenance intact — no transformation or loss during transfer.

---

## 7. Compatibility Matrix

| Component | Arrow Integration Level | Breaking Changes |
|-----------|------------------------|-----------------|
| `MemoryService` | New methods: `exportFrame()`, `importFrame()`, `exportIPC()`, `importIPC()` | None — additive |
| `ScopedMemoryService` | Unchanged — policies enforced before Arrow conversion | None |
| `TemporalMemoryService` | Temporal columns in MemoryFrame; `temporalMask()` columnar op | None |
| `DualStreamWriter` | Slow-path receives Arrow RecordBatch instead of PendingRecord[] | None (internal) |
| `AdaptiveRetriever` | Results can be merged as RecordBatches | None — additive |
| `PersistentEntityGraph` | Entity edges as Arrow Table | None — additive |
| `WorkingMemory` | No Arrow integration (small structured data) | None |
| `ObservationExtractor` | No Arrow integration (LLM-driven) | None |
| `SemanticConsolidator` | Receives Arrow Table, returns consolidation decisions | None — additive |
| `autoCompress` | Can use Arrow for batch message scoring | None — additive |
| `ContextTransferService` | IntentContext can carry Arrow serialized memories | None — additive |
| `PhaseAwareWindowManager` | Retention scoring on Arrow columns | None — additive |
