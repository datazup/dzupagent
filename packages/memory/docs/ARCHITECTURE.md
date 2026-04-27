# @dzupagent/memory Architecture

## Scope
`@dzupagent/memory` is a framework package that provides memory storage, retrieval, lifecycle management, and collaboration primitives for agent systems.

The package is implemented under `packages/memory/src` and published through a single entrypoint (`src/index.ts`) that re-exports:
- Store creation and capability helpers (`createStore`, capability types)
- Core CRUD/search service (`MemoryService`)
- Safety and ingestion controls (sanitizer, write policy, staged writers)
- Retrieval/ranking modules (vector, FTS, graph, fusion, adaptive router, reranker)
- Temporal, scoped, and tenant-isolated memory layers
- Collaboration/distribution modules (shared namespace, CRDT, sync protocol/session)
- Provenance, encryption, multi-modal attachment support, and agent-file import/export
- MCP adapter surface (`MCPMemoryHandler`, tool definitions)

The package is intentionally broad: it contains both low-level primitives and higher-level orchestration helpers (for example `SleepConsolidator`, `MemorySpaceManager`, `ObservationalMemory`, learning pipelines).

## Responsibilities
Primary responsibilities in the current implementation:
- Provide namespace-scoped persistence over LangGraph `BaseStore` via `MemoryService`.
- Keep read/write paths resilient: many operations are deliberately non-fatal and return empty/no-op outcomes on failure.
- Add safety checks on writes (sanitization, policy composition, optional PII redaction hooks).
- Support semantic and hybrid retrieval through pluggable providers and fusion/reranking.
- Manage memory lifecycle over time: decay metadata, staleness pruning, deduplication, contradiction detection, and sleep-time consolidation phases.
- Support multi-agent collaboration and replication with shared spaces, vector clocks, CRDT merge, digest/delta sync.
- Preserve lineage and security properties with provenance metadata and optional at-rest encryption.
- Expose a transport-agnostic MCP tool layer for memory operations.

Out of scope for this package:
- Product-specific tenant/workspace/project authorization policy orchestration.
- Network/server hosting concerns for MCP transport (this package only provides tool schemas + handler logic).

## Structure
Top-level source organization:
- `src/index.ts`: canonical public export surface.
- Core storage/service:
  - `memory-service.ts`
  - `store-factory.ts`
  - `store-capabilities.ts`
  - `memory-types.ts`
- Safety + ingestion:
  - `memory-sanitizer.ts`
  - `write-policy.ts`
  - `staged-writer.ts`
  - `policy-aware-staged-writer.ts`
  - `dual-stream-writer.ts`
- Retrieval:
  - `retrieval/vector-search.ts`, `retrieval/vector-store-search.ts`
  - `retrieval/fts-search.ts`, `retrieval/graph-search.ts`, `retrieval/persistent-graph.ts`
  - `retrieval/rrf-fusion.ts`, `retrieval/adaptive-retriever.ts`
  - `retrieval/cross-encoder-rerank.ts`, `retrieval/pagerank.ts`, `retrieval/hub-dampening.ts`, `retrieval/void-filter.ts`
- Memory lifecycle and consolidation:
  - `decay-engine.ts`, `memory-healer.ts`
  - `memory-consolidation.ts`, `semantic-consolidation.ts`, `sleep-consolidator.ts`
  - `staleness-pruner.ts`, `lesson-dedup.ts`, `consolidation-types.ts`
- Specialized memory models:
  - `working-memory.ts`, `versioned-working-memory.ts`
  - `temporal.ts`
  - `scoped-memory.ts`, `tenant-scoped-store.ts`
  - `multi-network-memory.ts`, `observational-memory.ts`, `memory-integrator.ts`
- Collaboration and distributed sync:
  - `sharing/memory-space-manager.ts`
  - `shared-namespace.ts`, `vector-clock.ts`
  - `crdt/*`
  - `sync/*`
- Provenance, encryption, interoperability:
  - `provenance/*`
  - `encryption/*`
  - `agent-file/*`
  - `multi-modal/*`
  - `mcp-memory-server.ts`
- Additional graph/causal/convention modules:
  - `graph/*`, `causal/*`, `convention/*`

Testing layout:
- Tests are colocated under `src/**/__tests__` and feature folders (`src/*/__tests__`), with Vitest configured in `vitest.config.ts`.

## Runtime and Control Flow
Core runtime flows in current code:

1. Store initialization
- `createStore({ type: 'postgres' | 'memory' })` returns a LangGraph-compatible `BaseStore` with attached capability flags.
- `memory` mode uses `InMemoryBaseStore` and implements `get/put/delete/search` with simple filter/query/pagination behavior.
- `postgres` mode uses `PostgresStore.fromConnString(...)` and optional embedding index config.

2. Standard write path (`MemoryService.put`)
- Optional sanitization (`sanitizeMemoryContent`) and optional PII detector hook run first.
- Namespace tuple is derived from configured `scopeKeys`.
- Searchable namespaces are normalized to include a `text` field.
- `_decay` metadata is auto-injected if absent.
- Record is stored through `BaseStore.put`.
- Optional semantic adapter upsert (`semanticStore.upsert`) runs as non-fatal side work.

3. Standard read/search path (`MemoryService.get/search`)
- `get` resolves either single key or namespace list.
- `search` uses `store.search`; for searchable namespaces it applies decay-aware rescoring.
- If semantic adapter is configured, keyword + vector results are fused with internal RRF logic.
- Optional read tracking calls `ReferenceTracker.trackReference(...)` fire-and-forget.

4. Ingestion control paths
- `StagedWriter`: `captured -> candidate -> confirmed/rejected` with threshold-based auto-promotion.
- `PolicyAwareStagedWriter`: enforces write-policy decision before staging.
- `DualStreamWriter`: fast-path persist + queued slow-path callback batch processing.

5. Consolidation and maintenance
- `SleepConsolidator.run(...)` executes configurable phases (`dedup`, `decay-prune`, `heal`, `lesson-dedup`, `convention-extract`, `staleness-prune`, etc.) across namespaces.
- Failures in individual phases are swallowed so runs continue.

6. Collaboration and replication
- `MemorySpaceManager` governs shared-space lifecycle (create/join/leave/share/query/review/retention/compaction).
- CRDT mode in shared spaces wraps values with `_crdt` and merges through `CRDTResolver` + `HLC`.
- `SyncProtocol` processes `sync:hello/digest/request-delta/delta/ack` messages.
- `SyncSession` manages transport wiring, anti-entropy loops, session state, and sync events.

7. Temporal and encrypted overlays
- `TemporalMemoryService` wraps writes with `_temporal`, supports `supersede`, `expire`, and temporal filters (`asOf`, `validAt`).
- `EncryptedMemoryService` wraps a `MemoryService`, preserving configured plaintext fields and storing encrypted payload in `_encrypted_value`.

## Key APIs and Types
High-value public APIs used as primary integration contract:
- Store and capabilities:
  - `createStore`, `StoreConfig`, `StoreIndexConfig`
  - `MemoryStoreCapabilities`
- Core service:
  - `MemoryService`
  - `NamespaceConfig`, `SemanticStoreAdapter`
- Safety and write gating:
  - `sanitizeMemoryContent`, `SanitizeResult`
  - `defaultWritePolicy`, `composePolicies`, `WritePolicy`, `WriteAction`
  - `StagedWriter`, `PolicyAwareStagedWriter`, `DualStreamWriter`
- Retrieval and ranking:
  - `StoreVectorSearch`, `VectorStoreSearch`, `KeywordFTSSearch`, `EntityGraphSearch`
  - `fusionSearch`
  - `AdaptiveRetriever`, `WeightLearner`, `classifyIntent`
  - `rerank`, `createLLMReranker`
- Structured memory models:
  - `WorkingMemory`, `VersionedWorkingMemory`
  - `TemporalMemoryService`
  - `ScopedMemoryService`, `TenantScopedStore`
- Collaboration and sync:
  - `MemorySpaceManager`
  - `SharedMemoryNamespace`
  - `VectorClock`, `HLC`, `CRDTResolver`
  - `SyncProtocol`, `SyncSession`, `WebSocketSyncTransport`
- Provenance/encryption/interop:
  - `ProvenanceWriter`, `createProvenance`, `extractProvenance`
  - `EncryptedMemoryService`, `EnvKeyProvider`
  - `AgentFileExporter`, `AgentFileImporter`
  - `MultiModalMemoryService`
  - `MCPMemoryHandler`, `MCP_MEMORY_TOOLS`

Important metadata conventions used across modules:
- `_decay`: decay/scoring metadata
- `_temporal`: bi-temporal metadata
- `_provenance`: lineage/source metadata
- `_encrypted_value`: encrypted envelope
- `_crdt`: CRDT map payload for shared writes
- `_tombstone`, `_deletedAt`: soft-delete/compaction markers

## Dependencies
Declared package dependencies (`package.json`):
- Runtime:
  - `@dzupagent/cache`
  - `@dzupagent/memory-ipc`
- Peer dependencies:
  - `@langchain/core` (>=1.0.0)
  - `@langchain/langgraph` (>=1.0.0)
  - `zod` (>=4.0.0)
- Dev dependencies include:
  - `@langchain/langgraph-checkpoint-postgres`
  - `tsup`, `typescript`, `vitest`

Runtime platform dependencies in code:
- LangGraph `BaseStore` contract for storage primitives.
- Node `crypto` for encryption and hashing (`aes-256-gcm`, SHA-256, UUID usage through `node:crypto`).
- Optional embeddings interface for semantic indexing (`StoreIndexConfig`).

## Integration Points
Direct integration seams in current code:
- Storage backend integration:
  - Supply `BaseStore` via `createStore(...)` or custom store object compatible with `MemoryService`.
- Semantic retrieval integration:
  - Provide `SemanticStoreAdapter` to `MemoryService` for upsert/search fusion.
- Event and telemetry hooks:
  - `MemoryServiceOptions.eventBus` for PII redaction events.
  - `AdaptiveRetriever` event emitter for source success/failure and health tracking.
  - `MemorySpaceManager` global and per-space event subscription.
  - `SyncSession.onEvent(...)` for sync lifecycle telemetry.
- Security integration:
  - `MemoryServiceOptions.detectPII` hook (structural compatibility with external PII detectors).
  - `EncryptionKeyProvider` for encryption key management.
- Multi-agent/product integration:
  - `ScopedMemoryService` access policies.
  - `TenantScopedStore` namespace isolation wrappers.
- MCP integration:
  - `MCP_MEMORY_TOOLS` for tool registration.
  - `MCPMemoryHandler.handleToolCall(...)` for tool dispatch into memory services.

## Testing and Observability
Testing:
- Test runner: Vitest (`vitest.config.ts`).
- Test globs: `src/**/*.test.ts`, `src/**/*.spec.ts`.
- Coverage provider/reporters: V8 + `text` and `json-summary`.
- Coverage thresholds:
  - statements: 70
  - branches: 60
  - functions: 60
  - lines: 70

Observability currently implemented in code:
- Non-fatal design is pervasive; many modules swallow exceptions by design.
- Retrieval observability:
  - `AdaptiveRetriever` tracks per-provider success/failure/latency and emits retrieval events.
- Shared-space observability:
  - `MemorySpaceManager` emits lifecycle/write/conflict/tombstone-compaction events.
- Sync observability:
  - `SyncSession` emits connected/disconnected/delta/error events and exposes `stats()`.
- Memory write observability:
  - `MemoryService` can emit `memory:pii_redacted` when redaction occurs.

## Risks and TODOs
Code-backed risks and open implementation caveats:
- Packaging boundary risk in `store-factory.ts`:
  - Postgres store is statically imported from `@langchain/langgraph-checkpoint-postgres/store`, while package metadata keeps `@langchain/langgraph-checkpoint-postgres` in dev dependencies.
- Value-only read contract in `MemoryService`:
  - `get/search` return values without canonical keys; several modules fall back to `_key`/`key` heuristics or synthetic keys.
- Temporal history semantics:
  - `TemporalMemoryService.getHistory(...)` documents key-prefix behavior but currently merges broad list/search results and sorts by temporal metadata.
- Encryption key rotation keying:
  - `EncryptedMemoryService.rotateKey(...)` falls back to synthetic keys when `_key` is absent.
- In-memory backend parity:
  - `InMemoryBaseStore` provides practical local behavior but is not guaranteed parity with Postgres backend semantics.
- Sync conflict metrics:
  - `SyncSession` exposes `conflicts` in stats/events, but current conflict count accounting remains minimal.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js
