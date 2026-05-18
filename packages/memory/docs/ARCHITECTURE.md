# @dzupagent/memory Architecture

## Scope
`@dzupagent/memory` is the DzupAgent framework package for memory persistence, retrieval, lifecycle hygiene, and collaborative memory primitives.

The package lives in `packages/memory` and publishes a single ESM entrypoint (`src/index.ts` -> `dist/index.js`) with a broad export surface that includes:
- Core store + service primitives (`createStore`, `MemoryService`, namespace/type contracts).
- Retrieval modules (vector/FTS/graph/fusion/rerank/adaptive routing).
- Lifecycle modules (decay, consolidation, pruning, healing, staleness cleanup).
- Structured overlays (working memory, versioned memory, temporal memory, scoped/tenant wrappers).
- Collaboration/distribution modules (shared namespaces, CRDT, sync protocol/session/transport, shared spaces manager).
- Security/provenance/interoperability modules (sanitization, write policies, encryption, provenance tracking, MCP tool handler, agent-file import/export, multi-modal attachments).

This package is framework-level. It does not host transport servers or product-specific authorization systems; it exposes reusable building blocks consumed by higher layers.

## Responsibilities
- Provide namespace+scope based memory CRUD/search over LangGraph `BaseStore`.
- Keep memory operations non-fatal by default (error swallowing and safe fallbacks are deliberate across many modules).
- Enforce write-time hygiene: sanitization, optional PII redaction hook, and policy-based write decisions.
- Support multiple retrieval strategies and ranking pipelines (keyword, vector, graph, RRF, adaptive intent-based weighting, reranking).
- Maintain memory quality over time (decay, deduplication, contradiction detection, stale pruning, consolidation).
- Support multi-agent memory sharing and replication (space management, CRDT merge, vector clocks, digest/delta sync).
- Track memory provenance and usage references for promotion/analysis paths.
- Provide optional encryption-at-rest wrapper and multi-modal attachment references.
- Expose transport-agnostic MCP memory tools and dispatcher.

## Structure
- `src/index.ts`
- Public barrel with all exported APIs and types.

- Core service and storage
- `memory-service.ts`, `memory-service-store.ts`, `memory-service-search.ts`, `memory-service-prompt.ts`, `memory-service-types.ts`.
- `store-factory.ts`, `store-capabilities.ts`, `memory-types.ts`.

- Write control and hygiene
- `memory-sanitizer.ts`, `write-policy.ts`.
- `staged-writer.ts`, `policy-aware-staged-writer.ts`, `dual-stream-writer.ts`.

- Retrieval stack
- `retrieval/*` (vector, FTS, graph, persistent graph, RRF fusion, hub dampening, PageRank, reranker, adaptive retriever and its submodules, relationship store, void filter, community detector).

- Lifecycle and consolidation
- `decay-engine.ts`, `memory-healer.ts`, `memory-consolidation.ts`, `consolidation-engine.ts`, `memory-pruner.ts`, `semantic-consolidation.ts`, `sleep-consolidator.ts`, `staleness-pruner.ts`, `lesson-dedup.ts`, `consolidation-types.ts`.

- Structured and contextual memory
- `working-memory.ts`, `versioned-working-memory.ts`, `frozen-snapshot.ts`, `observational-memory.ts`, `observation-extractor.ts`, `memory-aware-extractor.ts`, `memory-integrator.ts`, `temporal.ts`, `scoped-memory.ts`, `tenant-scoped-store.ts`, `multi-network-memory.ts`.

- Provenance, security, and interop
- `provenance/*`, `encryption/*`, `agent-file/*`, `multi-modal/*`.
- `memory-service-adapter.ts`, `in-memory-client.ts`, `http-client.ts`, `mcp-memory-server*.ts`.

- Collaboration and distributed sync
- `shared-namespace.ts`, `vector-clock.ts`, `crdt/*`, `sync/*`, `sharing/*`, `graph/*`, `causal/*`, `convention/*`.

- Learning helpers
- `lesson-pipeline.ts`, `rule-engine.ts`, `skill-acquisition.ts`, `skill-packs*.ts`.

- Tests
- Vitest tests are colocated under `src/**/__tests__` and feature subfolders (including `src/*/__tests__`).

## Runtime and Control Flow
1. Store bootstrap
- `createStore()` selects `memory` or `postgres` mode.
- `memory` mode uses internal `InMemoryBaseStore` with query/filter/pagination support.
- `postgres` mode uses `PostgresStore.fromConnString(...)` and optional embedding index config.
- Capabilities are attached via `attachMemoryStoreCapabilities` so higher layers can branch on delete/filter/pagination support.

2. Core write path (`MemoryService.put`)
- Resolve namespace from `NamespaceConfig` and validate required scope keys.
- Sanitize text/content (`sanitizeMemoryContent`), optionally reject unsafe content.
- Optionally run caller-provided `detectPII` and emit `memory:pii_redacted` via event bus.
- Ensure searchable namespaces contain a `text` field.
- Auto-inject `_decay` metadata when missing.
- Persist through `BaseStore.put`.
- If configured, upsert semantic copy to `SemanticStoreAdapter` (non-fatal side path).

3. Core read/search path (`MemoryService.get/search`)
- `get` reads single key or namespace listing.
- `search` runs store search, applies decay-based rescoring, and optionally fuses vector results via RRF.
- If a reference tracker is configured and `ReadContext` is provided, citation tracking is fire-and-forget.

4. Write gating pipelines
- `StagedWriter`: `captured -> candidate -> confirmed/rejected` with thresholds.
- `PolicyAwareStagedWriter`: policy decision gates staging behavior.
- `DualStreamWriter`: fast-path persist + batched slow-path callback for enrichment.

5. Lifecycle maintenance
- `ConsolidationEngine` clusters by key prefix, writes `:__summary__` records, and weakens consolidated children.
- `MemoryPruner` runs TTL pass then capacity pass.
- `SleepConsolidator` orchestrates phase-based maintenance (`dedup`, `decay-prune`, `heal`, `lesson-dedup`, `convention-extract`, `staleness-prune`, etc.) and continues on per-phase errors.

6. Collaboration and sync
- `MemorySpaceManager` manages shared spaces (`create/join/leave/share/query/review`), retention, and tombstone compaction.
- `SharedMemoryNamespace` provides LWW+vector-clock merge semantics and conflict tracking.
- `SyncProtocol` performs digest/request-delta/delta/ack state exchange.
- `SyncSession` wires transports, state transitions, anti-entropy loops, and sync events.

7. Wrappers and adapters
- `TemporalMemoryService` overlays bi-temporal metadata (`_temporal`) and active/history filtering.
- `EncryptedMemoryService` encrypts sensitive payload portions into `_encrypted_value` while keeping configured plaintext fields searchable.
- `memoryServiceToClient`, `InMemoryMemoryClient`, and `HttpMemoryClient` bridge to `@dzupagent/agent-types` `MemoryClient` usage patterns.
- `MCPMemoryHandler` routes `MCP_MEMORY_TOOLS` to memory operations using default namespace/scope.

## Key APIs and Types
Core primitives:
- `createStore`, `StoreConfig`, `StoreIndexConfig`.
- `MemoryService`, `MemoryServiceOptions`, `NamespaceConfig`, `FormatOptions`, `SemanticStoreAdapter`.
- `MemoryStoreCapabilities`.

Write hygiene and policy:
- `sanitizeMemoryContent`, `SanitizeResult`.
- `defaultWritePolicy`, `composePolicies`, `WritePolicy`, `WriteAction`.
- `StagedWriter`, `PolicyAwareStagedWriter`, `DualStreamWriter`.

Retrieval:
- `StoreVectorSearch`, `VectorStoreSearch`, `KeywordFTSSearch`, `EntityGraphSearch`, `PersistentEntityGraph`.
- `fusionSearch`, `AdaptiveRetriever`, `WeightLearner`, `rerank`.

Lifecycle:
- `ConsolidationEngine`, `MemoryPruner`, `SemanticConsolidator`, `SleepConsolidator`.
- `findDuplicates`, `findContradictions`, `findStaleRecords`, `healMemory`.

Structured/overlay services:
- `WorkingMemory`, `VersionedWorkingMemory`, `FrozenMemorySnapshot`, `TemporalMemoryService`.
- `ScopedMemoryService`, `TenantScopedStore`.

Collaboration/distributed:
- `MemorySpaceManager`, `SharedMemoryNamespace`, `VectorClock`, `HLC`, `CRDTResolver`.
- `SyncProtocol`, `SyncSession`, `WebSocketSyncTransport`.

Provenance/security/interop:
- `ProvenanceWriter`, `createProvenance`, `extractProvenance`, `createContentHash`.
- `EnvKeyProvider`, `EncryptedMemoryService`.
- `AgentFileExporter`, `AgentFileImporter`.
- `MultiModalMemoryService`, `InMemoryAttachmentStorage`.
- `MCPMemoryHandler`, `MCP_MEMORY_TOOLS`.

Metadata conventions used by multiple modules:
- `_decay`, `_temporal`, `_provenance`, `_encrypted_value`, `_crdt`, `_tombstone`/`_deletedAt`.

## Dependencies
Direct runtime dependencies (`package.json`):
- `@dzupagent/agent-types`
- `@dzupagent/cache`
- `@dzupagent/memory-ipc`

Peer dependencies:
- `@langchain/core` (>=1.0.0)
- `@langchain/langgraph` (>=1.0.0)
- `zod` (>=4.0.0)

Build/test toolchain:
- `typescript`, `tsup`, `vitest`.

Important implementation note:
- `store-factory.ts` imports `PostgresStore` from `@langchain/langgraph-checkpoint-postgres/store`; that package is currently listed in `devDependencies` rather than `dependencies`.

## Integration Points
- LangGraph store integration
- Use `createStore(...)` or pass any structurally compatible `BaseStore` to higher-level modules.

- Semantic retrieval integration
- Provide a `SemanticStoreAdapter` in `MemoryServiceOptions` to enable vector upsert/search fusion.

- Event/telemetry integration
- `MemoryServiceOptions.eventBus` (`memory:pii_redacted`, `memory:consolidated`, `memory:error`).
- `AdaptiveRetriever` event emitter (`memory:retrieval_source_succeeded|failed`).
- `MemorySpaceManager` global/per-space event handlers.
- `SyncSession.onEvent(...)` for connection/sync/error events.

- Security integration
- PII detector hook (`detectPII`) and write policy composition.
- Encryption key provider integration (`EncryptionKeyProvider`, `EnvKeyProvider`).

- Cross-process tracking integration
- Reference tracking through in-memory or Redis-backed trackers for citation/promotion pipelines.

- MCP integration
- Tool schemas via `MCP_MEMORY_TOOLS`, and call dispatch via `MCPMemoryHandler`.

- Agent compatibility integration
- `MemoryClient` bridge (`memoryServiceToClient`, `HttpMemoryClient`, `InMemoryMemoryClient`).

## Testing and Observability
Testing:
- Test runner: Vitest (`vitest.config.ts`).
- Included globs: `src/**/*.test.ts`, `src/**/*.spec.ts`.
- Coverage provider/reporters: V8 with `text` and `json-summary` outputs.
- Coverage thresholds: statements 70, branches 60, functions 60, lines 70.
- Current codebase includes broad module-level test coverage across core, retrieval, sync, sharing, provenance, encryption, MCP, and wrappers.

Observability and diagnostics in code:
- Most operations are intentionally non-fatal; failures are often swallowed to avoid breaking agent flows.
- Retrieval health tracking is built into adaptive retrieval (`ProviderHealthTracker` metrics and emitted source success/failure events).
- Shared space emits lifecycle/conflict/compaction events.
- Sync session exposes lifecycle events and session stats (`sentDeltas`, `receivedDeltas`, `conflicts`, `lastSyncAt`).
- HTTP client emits structured request outcome signals via `onRequestResult` callback.

## Risks and TODOs
- Postgres store packaging risk
- `PostgresStore` is statically imported, but `@langchain/langgraph-checkpoint-postgres` is not a runtime dependency declaration.

- Key/record identity gaps in value-only APIs
- Core `MemoryService.get/search` return value objects without canonical record keys; multiple modules still rely on `_key`/`key` fallbacks or synthetic keys.

- Temporal history contract mismatch
- `TemporalMemoryService.getHistory(...)` documents key-prefix intent, but currently merges broad list/search results and sorts them; strict prefix filtering is not enforced.

- Encryption fail-open behavior
- `EncryptedMemoryService.put(...)` writes plaintext when no active key is available.

- Multi-modal attachment retrieval mismatch
- `MultiModalMemoryService._getAttachmentsInternal()` expects `record.value` when reading from `MemoryService.get(...)`, but `MemoryService.get(...)` already returns plain value records.

- Sync conflict metric accounting
- `SyncSession` exposes a `conflicts` stat field, but current event/stat updates do not increment `_conflicts` from merge outcomes.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js