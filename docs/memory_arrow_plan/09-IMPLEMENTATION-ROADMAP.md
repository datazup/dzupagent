# 09 — Implementation Roadmap

> **Total Estimated Effort:** ~76h across 7 sprints
> **Zero Breaking Changes:** Every sprint is additive

---

## 1. Sprint Overview

```
Sprint 1 (P0): Foundation — Schema + FrameBuilder + FrameReader + IPC
  │  8h + 8h = 16h
  │  Deliverables: @dzipagent/memory-ipc package scaffolding,
  │    MEMORY_FRAME_SCHEMA, FrameBuilder, FrameReader, IPC serializer
  │
Sprint 2 (P0): SharedMemoryChannel + MemoryService Integration
  │  8h + 4h = 12h
  │  Deliverables: SharedMemoryChannel, exportFrame/importFrame on MemoryService
  │
Sprint 3 (P0): MCP Memory Exchange + Inter-Agent Patterns
  │  8h + 4h = 12h
  │  Deliverables: memory.export/import/subscribe MCP tools, A2A MemoryArtifact
  │
Sprint 4 (P1): Columnar Operations
  │  10h
  │  Deliverables: All vectorized batch ops, piscina worker integration
  │
Sprint 5 (P1): Context & Token Management
  │  8h
  │  Deliverables: Token budgeting, memory-aware compression, phase-weighted selection
  │
Sprint 6 (P1): Cross-Framework Adapters
  │  12h
  │  Deliverables: Mastra, LangGraph, Mem0, Letta, MCP-KG adapters
  │
Sprint 7 (P2): Agentic Extensions
  │  10h
  │  Deliverables: Tool result frames, codegen frames, DuckDB analytics, Parquet archival
```

---

## 2. Dependency Graph

```
Sprint 1: Foundation
  ├── MEMORY_FRAME_SCHEMA definition (doc 02)
  ├── FrameBuilder class (doc 03)
  ├── FrameReader class (doc 03)
  └── IPC serializer (doc 03)
       │
       ▼
Sprint 2: SharedMemoryChannel + MemoryService
  ├── SharedMemoryChannel (doc 03)
  ├── MemoryService.exportFrame() (doc 03)
  ├── MemoryService.importFrame() (doc 03)
  ├── MemoryService.exportIPC() (doc 03)
  └── MemoryService.importIPC() (doc 03)
       │
       ├────────────────────────────┐
       ▼                            ▼
Sprint 3: MCP + Inter-Agent    Sprint 4: Columnar Ops
  ├── memory.export MCP tool     ├── findWeakIndices()
  ├── memory.import MCP tool     ├── batchDecayUpdate()
  ├── memory.subscribe MCP tool  ├── temporalMask()
  ├── A2A MemoryArtifact         ├── partitionByNamespace()
  └── Blackboard architecture    ├── computeCompositeScore()
       │                         ├── rankByPageRank()
       │                         ├── applyHubDampeningBatch()
       │                         ├── batchTokenEstimate()
       │                         └── selectByTokenBudget()
       │                              │
       ├──────────────────┬──────────┘
       ▼                  ▼
Sprint 5: Context/Token  Sprint 6: Adapters
  ├── Token budgeting     ├── Mastra adapter
  ├── Memory-aware        ├── LangGraph adapter
  │   compression         ├── Mem0 adapter
  ├── Phase-weighted      ├── Letta adapter
  │   selection           └── MCP-KG adapter
  ├── Prompt cache delta
  └── Context transfer
       with Arrow
            │
            ▼
Sprint 7: Agentic Extensions
  ├── ToolResultFrame
  ├── CodegenFrame
  ├── EvalFrame
  ├── EntityGraphFrame
  ├── DuckDB analytics
  ├── Streaming Arrow
  └── Parquet archival
```

---

## 3. Sprint Details

### Sprint 1: Foundation (16h)

| Task | Effort | File | Tests |
|------|--------|------|-------|
| Package scaffolding (package.json, tsconfig, tsup) | 1h | `packages/forgeagent-memory-ipc/` | — |
| MEMORY_FRAME_SCHEMA definition | 2h | `src/schema.ts` | Schema construction, metadata |
| FrameBuilder implementation | 3h | `src/frame-builder.ts` | add(), addBatch(), build(), round-trip |
| FrameReader implementation | 3h | `src/frame-reader.ts` | fromIPC(), toRecords(), filters |
| IPC serializer (toIPC/fromIPC) | 2h | `src/ipc-serializer.ts` | Serialize/deserialize, compression |
| Index exports + integration test | 1h | `src/index.ts` | Full round-trip: Record→Arrow→IPC→Arrow→Record |
| Documentation | 1h | README.md | — |

**Acceptance criteria:**
- `FrameBuilder.build()` produces a valid Arrow Table from `Record<string,unknown>[]`
- `FrameReader.toRecords()` reconstructs identical records from Arrow Table
- `tableToIPC()` → `tableFromIPC()` round-trip preserves all data
- All temporal, decay, provenance metadata survives round-trip
- Dictionary encoding active for namespace, agent_id, category columns
- 100% of existing record conventions (_decay, _temporal, _agent, _tag_*) handled

### Sprint 2: SharedMemoryChannel + MemoryService (12h)

| Task | Effort | File | Tests |
|------|--------|------|-------|
| SharedMemoryChannel implementation | 4h | `src/shared-memory-channel.ts` | Write/read, zero-copy verify |
| Atomics-based signaling | 2h | (part of SharedMemoryChannel) | Concurrent read/write |
| MemoryService.exportFrame() | 1.5h | `@dzipagent/memory` extension | Export 1K records |
| MemoryService.importFrame() | 1.5h | `@dzipagent/memory` extension | Import with upsert/append/replace |
| MemoryService.exportIPC() | 1h | (delegates to exportFrame + serialize) | IPC bytes output |
| MemoryService.importIPC() | 1h | (delegates to deserialize + importFrame) | IPC bytes input |
| Integration test: worker thread | 1h | `__tests__/shared-channel.test.ts` | Main↔worker round-trip |

**Acceptance criteria:**
- SharedMemoryChannel.write() + read() achieves zero-copy (verified via buffer identity)
- MemoryService.exportFrame() returns Arrow Table matching all records in namespace
- MemoryService.importFrame() correctly handles upsert, append, replace strategies
- Worker thread can read Arrow Table from SharedArrayBuffer without JSON parsing

**Depends on:** Sprint 1

### Sprint 3: MCP + Inter-Agent Patterns (12h)

| Task | Effort | File | Tests |
|------|--------|------|-------|
| memory.export MCP tool | 2h | `@dzipagent/server` | Export via MCP, verify Arrow IPC |
| memory.import MCP tool | 2h | `@dzipagent/server` | Import via MCP, verify records |
| memory.subscribe MCP tool | 2h | `@dzipagent/server` | Streaming RecordBatch |
| memory.schema MCP tool | 1h | `@dzipagent/server` | Schema discovery |
| A2A MemoryArtifact wrapper | 2h | `src/a2a-memory-artifact.ts` | Create/parse artifact |
| Blackboard prototype | 2h | `src/blackboard.ts` | SWMR, atomic seq numbers |
| Integration test: MCP round-trip | 1h | `__tests__/mcp-exchange.test.ts` | Export→Import via MCP |

**Acceptance criteria:**
- MCP client can export memories as Arrow IPC (base64), import into different store
- memory.subscribe streams RecordBatches as changes occur
- A2A MemoryArtifact contains valid Arrow IPC with correct MIME type
- Blackboard supports concurrent reads from 4+ workers

**Depends on:** Sprint 2

### Sprint 4: Columnar Operations (10h)

| Task | Effort | File | Tests |
|------|--------|------|-------|
| findWeakIndices() | 0.5h | `src/columnar-ops.ts` | 10K records, verify indices |
| batchDecayUpdate() | 1h | `src/columnar-ops.ts` | Ebbinghaus formula verification |
| temporalMask() | 1h | `src/columnar-ops.ts` | asOf + validAt filtering |
| partitionByNamespace() | 0.5h | `src/columnar-ops.ts` | 5 namespaces, verify partition |
| batchCosineSimilarity() | 1h | `src/columnar-ops.ts` | Known vectors, verify scores |
| computeCompositeScore() | 1h | `src/columnar-ops.ts` | Weighted combination |
| rankByPageRank() | 1.5h | `src/columnar-ops.ts` | Small graph, verify convergence |
| applyHubDampeningBatch() | 0.5h | `src/columnar-ops.ts` | Logarithmic attenuation |
| batchTokenEstimate() | 0.5h | `src/columnar-ops.ts` | Known texts, verify estimates |
| selectByTokenBudget() | 1h | `src/columnar-ops.ts` | Budget constraint satisfaction |
| Piscina worker integration | 1.5h | `src/worker-ops.ts` | Run ops in worker thread |

**Acceptance criteria:**
- Each columnar op produces identical results to the JSON row-by-row equivalent
- Performance: ≥10x speedup over JSON path for 10K records on each op
- Piscina worker correctly receives and returns Arrow Tables via SharedMemoryChannel
- All ops are non-fatal (catch errors, return empty/default)

**Depends on:** Sprint 2

### Sprint 5: Context & Token Management (8h)

| Task | Effort | File | Tests |
|------|--------|------|-------|
| batchTokenEstimate integration | 1h | `@dzipagent/context` extension | Budget analysis |
| selectByTokenBudget integration | 1.5h | `@dzipagent/context` extension | Knapsack selection |
| Memory-aware auto-compress hook | 1.5h | `@dzipagent/context` extension | Dedup-aware extraction |
| Phase-weighted memory selection | 1.5h | `@dzipagent/context` extension | Phase × namespace boost |
| Prompt cache delta computation | 1h | `@dzipagent/memory-ipc` | Frozen vs current diff |
| Context transfer with Arrow | 1.5h | `@dzipagent/context` extension | IntentContext.memoryFrame |

**Acceptance criteria:**
- Token budget selection stays within budget while maximizing composite score
- Phase-weighted selection boosts relevant namespaces for current conversation phase
- Prompt cache delta correctly detects when memory has changed enough to re-freeze
- Context transfer includes Arrow IPC bytes when memory frame available

**Depends on:** Sprint 4

### Sprint 6: Cross-Framework Adapters (12h)

| Task | Effort | File | Tests |
|------|--------|------|-------|
| Adapter interface definition | 1h | `src/adapters/types.ts` | — |
| Mastra adapter | 2.5h | `src/adapters/mastra-adapter.ts` | Bidirectional round-trip |
| LangGraph Store adapter | 2h | `src/adapters/langgraph-adapter.ts` | Store item ↔ Arrow |
| Mem0 adapter | 2h | `src/adapters/mem0-adapter.ts` | Fact ↔ Arrow |
| Letta adapter | 2h | `src/adapters/letta-adapter.ts` | Core/archival ↔ Arrow |
| MCP KG adapter | 2h | `src/adapters/mcp-kg-adapter.ts` | Entity/relation ↔ Arrow |
| Integration test: cross-framework | 0.5h | `__tests__/adapters.test.ts` | Each adapter round-trip |

**Acceptance criteria:**
- Each adapter's `toFrame()` → `fromFrame()` round-trip preserves all data
- Each adapter's `canAdapt()` correctly identifies compatible records
- Field mappings documented and tested for each framework
- Adapters handle missing/extra fields gracefully (non-fatal)

**Depends on:** Sprint 1 (schema only, no other deps)

### Sprint 7: Agentic Extensions (10h)

| Task | Effort | File | Tests |
|------|--------|------|-------|
| ToolResultFrame schema + builder | 1.5h | `src/frames/tool-result-frame.ts` | Build from tool results |
| CodegenFrame schema + builder | 1.5h | `src/frames/codegen-frame.ts` | Build from generated files |
| EvalFrame schema + builder | 1h | `src/frames/eval-frame.ts` | Build from eval results |
| EntityGraphFrame | 1h | `src/frames/entity-graph-frame.ts` | Build from entity index |
| DuckDB-WASM MemoryAnalytics | 2h | `src/analytics/memory-analytics.ts` | SQL queries over Arrow |
| Streaming Arrow (WebSocket) | 1.5h | `src/streaming/arrow-stream.ts` | Stream RecordBatches |
| Parquet archival | 1.5h | `src/archival/parquet-archival.ts` | Archive + restore |

**Acceptance criteria:**
- Each frame schema properly typed and constructible
- DuckDB-WASM executes SQL over Arrow Tables without data copy
- WebSocket streams RecordBatches to connected clients
- Parquet archive/restore preserves all data with ≥5x compression over JSON

**Depends on:** Sprint 4 (columnar ops), Sprint 3 (server integration)

---

## 4. Integration with ecosystem_plan/05-MEMORY-SHARING.md

The 8 features in 05-MEMORY-SHARING have their own implementation schedule. The Arrow plan coordinates:

| 05-MEMORY-SHARING Feature | Arrow Sprint | Integration Point |
|---|---|---|
| F2: Provenance (P0, 4h) | Sprint 1 | Provenance fields in MEMORY_FRAME_SCHEMA |
| F1: SharedMemorySpace (P0, 12h) | Sprint 3 | MCP memory exchange tools use Arrow IPC |
| F6: Encryption (P1, 6h) | Sprint 1 | Encrypted envelope in payload_json column |
| F8: Convention (P1, 8h) | Sprint 4 | Convention records as Arrow Table for batch checks |
| F3: CausalGraph (P1, 8h) | Sprint 4 | CAUSAL_EDGE_SCHEMA, vectorized traversal |
| F4: AgentFile (P1, 8h) | Sprint 3 | Arrow IPC as binary section in .af archive |
| F5: CRDT (P2, 16h) | Sprint 7 | HLC columns, vectorized merge |
| F7: MultiModal (P2, 8h) | Sprint 7 | Attachment metadata columns |

**Recommended sequencing:** Implement 05-MEMORY-SHARING F2 (Provenance) first, then Arrow Sprint 1, then 05-MEMORY-SHARING F1 (SharedSpaces) in parallel with Arrow Sprint 2-3. This ensures provenance columns exist in the schema before SharedSpaces uses Arrow for transfer.

---

## 5. Testing Strategy

### Unit Tests (per sprint, in @dzipagent/memory-ipc)

- **Framework:** Vitest
- **Store:** InMemoryBaseStore (no database required)
- **Arrow:** Real `apache-arrow` library (no mocks)
- **Coverage target:** ≥90% line coverage on all new code

### Integration Tests

| Test | Sprint | Description |
|------|--------|-------------|
| Record round-trip (1K records) | 1 | Records → Arrow → IPC → Arrow → Records, verify equality |
| SharedArrayBuffer worker | 2 | Main thread writes, worker reads zero-copy, processes, writes back |
| MCP export/import | 3 | Full MCP tool invocation: export from agent A, import into agent B |
| Consolidation via Arrow | 4 | 10K records → Arrow → decay/temporal/PageRank → update store |
| Token-budgeted memory selection | 5 | Select memories within 4K token budget, verify fit |
| Cross-framework adapter chain | 6 | DzipAgent → Arrow → Mastra format → Arrow → DzipAgent |
| DuckDB SQL analytics | 7 | Arrow Table → DuckDB query → result verification |

### Performance Benchmarks

| Benchmark | Sprint | Target |
|-----------|--------|--------|
| Transfer 1K records via JSON vs Arrow IPC | 1 | Arrow ≥4x faster |
| Transfer 1K records via SharedArrayBuffer | 2 | Arrow ≥100x faster than JSON |
| Temporal filter 10K records | 4 | Arrow ≥50x faster than row-by-row |
| Decay score 10K records | 4 | Arrow ≥50x faster than row-by-row |
| Token budget selection 5K records | 5 | Arrow ≥20x faster than JSON sort |

---

## 6. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `apache-arrow` package size (~2MB) | Medium | Low | Separate package; consumers opt-in |
| SharedArrayBuffer not available in all environments | Low | Medium | Fallback to MessagePort structured clone |
| Arrow schema evolution (adding columns) | Medium | Medium | Forward-compat rules, version field |
| DuckDB-WASM stability | Medium | Low | Optional dependency, graceful fallback |
| Performance regression in small datasets (<50 records) | Medium | Low | Auto-detect: use JSON path for small sets |
| Worker thread complexity (debugging, error propagation) | Medium | Medium | Comprehensive logging, non-fatal wrapper |

---

## 7. Definition of Done

A sprint is complete when:

1. All tasks have passing unit tests (Vitest)
2. Integration tests pass with InMemoryBaseStore
3. TypeScript strict mode: zero errors (`yarn typecheck`)
4. ESLint: zero errors (`yarn lint`)
5. Performance benchmarks meet targets (where applicable)
6. Exports added to `@dzipagent/memory-ipc/src/index.ts`
7. JSDoc on all public APIs
8. No breaking changes to existing `@dzipagent/memory` or `@dzipagent/context` APIs
