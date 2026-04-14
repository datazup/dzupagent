# @dzupagent/memory Architecture

This document describes the **current implementation** of `packages/memory` as of April 2026: how the module is organized, what each subsystem does, and how to use the code safely.

## 1. Purpose and Scope

`@dzupagent/memory` is the memory layer for DzupAgent. It provides:

- Namespace-scoped persistence on top of LangGraph `BaseStore`
- Multiple memory models (long-term, working, temporal, graph, shared spaces)
- Retrieval/ranking pipelines (vector, FTS, graph, fusion, adaptive routing)
- Memory quality lifecycle (sanitization, policy gating, dedup, staleness pruning, consolidation)
- Collaboration and portability primitives (provenance, sharing, CRDT/sync, agent-file import/export)

Implementation size (current):

- `91` non-test TypeScript source files under `src/`
- `45` test files under `src/**/__tests__/`

## 2. High-Level Architecture

```text
Application / Agent Runtime
  |
  |  (typed APIs from src/index.ts)
  v
Memory Facades
  - MemoryService (core)
  - WorkingMemory / VersionedWorkingMemory
  - TemporalMemoryService
  - ScopedMemoryService / TenantScopedStore
  - EncryptedMemoryService
  - MultiNetworkMemory / ObservationalMemory
  |
  +--> Policy & Safety
  |      - sanitizeMemoryContent
  |      - WritePolicy / Staged writers
  |
  +--> Retrieval Layer
  |      - Vector / FTS / Graph providers
  |      - RRF fusion / adaptive router / reranking
  |
  +--> Quality Lifecycle
  |      - decay-engine
  |      - memory-healer
  |      - consolidation (heuristic + semantic)
  |      - sleep-consolidator
  |
  +--> Collaboration & Distribution
  |      - sharing/memory-space-manager
  |      - shared-namespace + vector clock + CRDT + sync
  |      - provenance
  |
  +--> Interop
         - mcp-memory-server
         - agent-file import/export
         - multi-modal attachments

Storage
  - BaseStore (in-memory or postgres via createStore)
  - Optional SemanticStoreAdapter for vector indexing/search
```

## 3. Package Structure

Major implementation areas in `src/`:

- Core persistence and store setup:
  - `memory-service.ts`
  - `store-factory.ts`
  - `store-capabilities.ts`
  - `memory-types.ts`
- Memory lifecycle and safety:
  - `memory-sanitizer.ts`
  - `write-policy.ts`
  - `staged-writer.ts`, `policy-aware-staged-writer.ts`, `dual-stream-writer.ts`
  - `decay-engine.ts`
  - `memory-healer.ts`
  - `memory-consolidation.ts`, `semantic-consolidation.ts`, `sleep-consolidator.ts`
- Retrieval:
  - `retrieval/*` (vector, fts, graph, persistent graph, adaptive routing, reranking, fusion, ranking helpers)
- Structured and specialized memory:
  - `working-memory.ts`, `versioned-working-memory.ts`
  - `temporal.ts`
  - `scoped-memory.ts`
  - `tenant-scoped-store.ts`
  - `multi-network-memory.ts`
  - `observational-memory.ts`
- Graph/causal/relationship:
  - `retrieval/relationship-store.ts`
  - `causal/*`
- Collaboration and distributed consistency:
  - `sharing/*`
  - `shared-namespace.ts`
  - `vector-clock.ts`
  - `crdt/*`
  - `sync/*`
- Interop and adapters:
  - `mcp-memory-server.ts`
  - `provenance/*`
  - `encryption/*`
  - `agent-file/*`
  - `multi-modal/*`

## 4. Core Concepts

### 4.1 Namespace + Scope + Key

Most APIs follow this addressing model:

- `namespace`: logical collection name
- `scope`: object containing required scope keys
- `key`: record identifier inside that namespace/scope tuple

`MemoryService` maps namespace config to a tuple via ordered `scopeKeys`.

### 4.2 Non-Fatal Design

A core design rule across this package: many operations catch failures and return empty/no-op results instead of throwing. This keeps agent pipelines running under partial memory failures.

### 4.3 Record Metadata Conventions

Common metadata fields used by multiple modules:

- `_decay`: forgetting-curve metadata
- `_temporal`: bi-temporal validity metadata
- `_provenance`: source/lineage metadata
- `_encrypted_value`: at-rest encrypted payload envelope
- `_crdt`: CRDT payload for shared-space conflict resolution
- `_tombstone`, `_deletedAt`: soft-delete / compaction flow

## 5. End-to-End Flows

### 5.1 Standard Write Flow

1. Caller writes via `MemoryService.put(namespace, scope, key, value)`.
2. Optional sanitization runs (`rejectUnsafe` defaults to `true`).
3. Namespace tuple is built from scope keys.
4. Record is persisted to `BaseStore`.
5. If semantic store is configured and namespace is searchable, vector index upsert is attempted.
6. Errors are swallowed (non-fatal contract).

### 5.2 Standard Read/Search Flow

1. `get()` reads a key or lists namespace entries.
2. `search()` delegates to store search for searchable namespaces.
3. Decay-aware reranking applies when records carry `_decay` metadata.
4. Optional vector fusion (RRF) combines keyword and semantic results.
5. Results are returned as record values.

### 5.3 Quality and Consolidation Flow

- Immediate safety: sanitizer and write policies
- Online quality: dedup/staging pipelines
- Offline quality: `SleepConsolidator` runs multi-phase cleanup and synthesis

## 6. Feature Catalog (What Exists Today)

### 6.1 Storage and Core APIs

- `createStore(config)` in `store-factory.ts`
  - `type: 'memory'`: built-in in-memory store
  - `type: 'postgres'`: LangGraph Postgres store (with optional embedding index)
- Store capability flags (`supportsDelete`, `supportsSearchFilters`, `supportsPagination`) enable graceful degradation in higher layers.

### 6.2 Safety and Policy Controls

- `sanitizeMemoryContent()` detects prompt-injection, exfiltration patterns, and invisible unicode.
- `defaultWritePolicy` and `composePolicies(...)` classify writes into:
  - `auto`
  - `confirm-required`
  - `reject`
- `PolicyAwareStagedWriter` forces policy checks before auto-promotion.

### 6.3 Staged and Dual-Path Ingestion

- `StagedWriter`: in-memory 3-stage pipeline
  - captured -> candidate -> confirmed/rejected
- `DualStreamWriter`: fast/slow path
  - fast path stores immediately
  - slow path batches post-processing callback

### 6.4 Working Memory

- `WorkingMemory<T extends zod schema>`
  - Typed state
  - `load/get/update/save`
  - optional auto-save
- `VersionedWorkingMemory`
  - version counter, snapshots, diffs, history, revert
  - history pruning via tombstones when needed

### 6.5 Temporal Memory

- `TemporalMemoryService`
  - Adds `_temporal` metadata
  - supports `asOf` and `validAt` filtering
  - soft-expiry and supersede semantics

### 6.6 Retrieval Stack

Base retrieval primitives:

- `StoreVectorSearch` / `VectorStoreSearch`
- `KeywordFTSSearch`
- `EntityGraphSearch`
- `PersistentEntityGraph`

Ranking/fusion:

- `fusionSearch` (RRF)
- `AdaptiveRetriever` (intent-classified weighted routing)
- `rerank` + `createLLMReranker` (cross-encoder style reranking)
- `applyHubDampening`, `computePPR/queryPPR`, `voidFilter`
- `CommunityDetector` for graph community detection and optional summary generation

### 6.7 Graph, Causal, and Relationships

- `RelationshipStore`: typed edges with traversal and causal chain discovery
- `CausalGraph`: cause-effect relation storage and BFS traversal over causal links

### 6.8 Quality Maintenance and Consolidation

- `memory-healer`: duplicate/contradiction/staleness analysis
- `memory-consolidation`: deterministic 4-phase heuristic consolidation
- `semantic-consolidation`: LLM-assisted merge/update/delete/contradiction decisions
- `sleep-consolidator`: orchestrates multi-phase cleanup and extraction jobs

### 6.9 Multi-Agent Access and Sharing

- `ScopedMemoryService`: per-agent namespace permissions + violation tracking
- `MemorySpaceManager`:
  - create/join/leave shared spaces
  - push or pull-request style writes
  - CRDT merge option for conflict strategy
  - retention and tombstone compaction
  - event subscriptions
- `SharedMemoryNamespace`: in-memory replicated namespace with vector clocks and merge reports

### 6.10 CRDT and Network Sync

- `HLC` (hybrid logical clock)
- `CRDTResolver` (LWW register/map + OR-set)
- `SyncProtocol` and `SyncSession`
  - hello/digest/request-delta/delta/ack handshake
  - anti-entropy loop
  - transport abstraction (`SyncTransport`)

### 6.11 Provenance, Encryption, and Portability

- `ProvenanceWriter`
  - auto provenance injection and lineage extension
  - deterministic content hashing
- `EncryptedMemoryService`
  - AES-256-GCM at-rest encryption
  - configurable plaintext fields preserved for searchability
  - key management via `EncryptionKeyProvider` (e.g., `EnvKeyProvider`)
- `AgentFileExporter` / `AgentFileImporter`
  - export/import memory packages with signature support

### 6.12 Additional Specialized Modules

- `MultiNetworkMemory`: routes records across factual/experiential/opinion/entity networks
- `ObservationExtractor`, `MemoryAwareExtractor`, `ObservationalMemory`: observation extraction + dedup + reflection workflows
- `LessonPipeline`, `DynamicRuleEngine`, `SkillAcquisitionEngine`, `SkillPackLoader`: learning-oriented memory pipelines
- `MultiModalMemoryService`: attachment-aware memory records
- `TenantScopedStore`: strict tenant/project namespace prefix isolation on raw store operations
- `MCPMemoryHandler`: exposes memory tools for MCP servers

## 7. How To Use (Recipes)

### 7.1 Minimal setup: MemoryService + in-memory store

```ts
import { createStore, MemoryService } from '@dzupagent/memory'

const store = await createStore({ type: 'memory' })

const memory = new MemoryService(store, [
  { name: 'lessons', scopeKeys: ['tenantId', 'bucket'], searchable: true },
  { name: 'decisions', scopeKeys: ['tenantId', 'bucket'], searchable: false },
])

const scope = { tenantId: 't1', bucket: 'global' }

await memory.put('lessons', scope, 'lesson-1', {
  text: 'Validate all external input at API boundaries.',
})

const results = await memory.search('lessons', scope, 'validate input', 5)
const promptBlock = memory.formatForPrompt(results, { header: '## Lessons' })
```

### 7.2 Add typed working memory

```ts
import { z } from 'zod'
import { WorkingMemory } from '@dzupagent/memory'

const wm = new WorkingMemory({
  schema: z.object({
    currentGoal: z.string().optional(),
    blockedBy: z.array(z.string()).default([]),
  }),
  store: memory,
  namespace: 'decisions',
})

await wm.load(scope)
await wm.update(scope, { currentGoal: 'Finish onboarding flow' })
```

### 7.3 Add policy-gated ingestion

```ts
import { PolicyAwareStagedWriter, defaultWritePolicy } from '@dzupagent/memory'

const staged = new PolicyAwareStagedWriter({
  autoPromoteThreshold: 0.7,
  autoConfirmThreshold: 0.9,
  maxPending: 200,
  policies: [defaultWritePolicy],
})

staged.capture({
  key: 'obs-1',
  namespace: 'lessons',
  scope,
  value: { text: 'Never commit plaintext API keys.' },
  confidence: 0.95,
})
```

### 7.4 Use adaptive retrieval over multiple providers

```ts
import {
  AdaptiveRetriever,
  StoreVectorSearch,
  KeywordFTSSearch,
  EntityGraphSearch,
} from '@dzupagent/memory'

const retriever = new AdaptiveRetriever({
  providers: {
    vector: new StoreVectorSearch(store),
    fts: new KeywordFTSSearch(),
    graph: new EntityGraphSearch(),
  },
  namespace: ['t1', 'global'],
  learnFromFeedback: true,
})

const records = (await memory.get('lessons', scope)).map((value, i) => ({
  key: String(i),
  value,
}))

const ranked = await retriever.search('why did auth fail yesterday?', records, 10)
```

### 7.5 Run sleep-time consolidation

```ts
import { SleepConsolidator } from '@dzupagent/memory'

const consolidator = new SleepConsolidator({
  model: cheapModel,
  maxLLMCalls: 20,
  decayPruneThreshold: 0.1,
})

const report = await consolidator.run(store, [
  ['t1', 'global'],
  ['t1', 'decisions'],
])
```

### 7.6 Add temporal semantics

```ts
import { TemporalMemoryService } from '@dzupagent/memory'

const temporal = new TemporalMemoryService(memory)

await temporal.put('decisions', scope, 'pricing-v1', {
  text: 'Price is 19 USD',
})

const historical = await temporal.search(
  'decisions',
  scope,
  'price',
  10,
  { asOf: Date.now() - 7 * 24 * 60 * 60 * 1000 },
)
```

### 7.7 Provenance + encryption wrapper

```ts
import {
  ProvenanceWriter,
  EncryptedMemoryService,
  EnvKeyProvider,
} from '@dzupagent/memory'

const provenance = new ProvenanceWriter(memory)
await provenance.put('lessons', scope, 'k1', { text: 'Use retries with backoff.' }, {
  agentUri: 'forge://team/planner',
  source: 'direct',
  confidence: 0.9,
})

const encrypted = new EncryptedMemoryService({
  memoryService: memory,
  keyProvider: new EnvKeyProvider(),
  encryptedNamespaces: ['lessons'],
})
```

### 7.8 Shared memory spaces

```ts
import { MemorySpaceManager } from '@dzupagent/memory'

const spaces = new MemorySpaceManager({ memoryService: memory })

const space = await spaces.create({
  name: 'team-knowledge',
  owner: 'forge://acme/planner',
  conflictResolution: 'crdt',
})

await spaces.join(space.id, 'forge://acme/executor', 'read-write')
await spaces.share({
  from: 'forge://acme/planner',
  spaceId: space.id,
  key: 'deploy-rule',
  value: { text: 'Run smoke tests before deploy.' },
  mode: 'push',
})
```

### 7.9 Export/import portable memory packs

```ts
import { AgentFileExporter, AgentFileImporter } from '@dzupagent/memory'

const exporter = new AgentFileExporter({
  memoryService: memory,
  agentName: 'planner',
  agentUri: 'forge://acme/planner',
  scope,
})

const file = await exporter.export({ sign: true })

const importer = new AgentFileImporter(memory, scope)
const validation = importer.validate(file)
if (validation.valid) {
  await importer.import(file, { conflictStrategy: 'merge', verifySignature: true })
}
```

## 8. Extension Points

Primary extension seams in current codebase:

- Retrieval:
  - Provide custom `VectorSearchProvider`
  - Plug custom cross-encoder provider
  - Customize adaptive strategies and feedback learning
- Safety:
  - Compose additional write policies
  - Use staged/dual-stream workflows with custom callbacks
- Consolidation:
  - Customize phase selection and thresholds in `SleepConsolidator`
  - Swap LLM model tiers for semantic consolidation
- Collaboration:
  - Choose conflict strategy per shared space (`lww`, `manual`, `crdt`)
  - Add event consumers via `MemorySpaceManager` subscriptions
- Encryption:
  - Implement custom `EncryptionKeyProvider`
- Sync:
  - Implement `SyncTransport` for custom network channels

## 9. Operational Notes

- The package is designed to be resilient; many APIs are intentionally non-fatal.
- Store behavior differences are handled via `store-capabilities` flags.
- Several modules rely on record-level metadata conventions (`_decay`, `_provenance`, etc.); keep these stable if extending internals.
- For changes spanning multiple subsystems, validate with package tests:

```bash
yarn workspace @dzupagent/memory test
```

## 10. Export Surface

All public APIs are re-exported through `src/index.ts`. For consumers, this file is the canonical contract.

## 11. Current Caveats and Trade-offs

These are implementation-level behaviors to keep in mind when integrating:

- `MemoryService.get()` and `search()` return only values, not canonical keys. Some downstream modules therefore rely on `_key` conventions or fallbacks when they need key-aware operations.
- `TemporalMemoryService.getHistory(...)` currently combines broad list/search results and sorts by temporal metadata. Its `keyPrefix` behavior is best-effort rather than strict key-based filtering.
- `createStore({ type: 'memory' })` is intentionally simple and optimized for local/test scenarios. Its search path is namespace-prefix-based and not feature-parity with production-grade semantic backends.
- `EncryptedMemoryService` preserves configured plaintext fields for searchability and wraps the rest in `_encrypted_value`; key rotation quality depends on how reliably record keys are represented in values.
- Many modules are non-fatal by design, which improves resilience but means production deployments should add explicit telemetry around empty-result and fallback paths.

## 12. Related Tests by Feature (What to Run on Updates)

This section maps major feature areas to the tests that currently validate them. Use it as the baseline regression checklist when updating a feature.

Current full-suite status (last run): **45 test files / 1095 tests passed** via:

```bash
yarn workspace @dzupagent/memory test
```

### 12.1 Core retrieval and ranking

- Feature: adaptive routing, weights, provider failures, observability
  - Tests:
    - `src/__tests__/adaptive-retriever.test.ts`
    - `src/__tests__/retrieval-weight-learning.test.ts`
    - `src/__tests__/retrieval-observability.test.ts`
- Feature: score post-processing and ranking helpers
  - Tests:
    - `src/__tests__/void-filter.test.ts`
    - `src/__tests__/pagerank.test.ts`
    - `src/__tests__/hub-dampening.test.ts`
- Feature: entity/graph retrieval structures
  - Tests:
    - `src/__tests__/persistent-graph.test.ts`
    - `src/__tests__/community-detector.test.ts`
    - `src/__tests__/relationship-store.test.ts`
    - `src/causal/__tests__/causal-graph.test.ts`

### 12.2 Store + vector integration

- Feature: memory service vector behavior and semantic store adapter integration
  - Tests:
    - `src/__tests__/vector-integration.test.ts`
- Feature: tenant/project namespace isolation wrappers
  - Tests:
    - `src/__tests__/tenant-scoped-store.test.ts`

### 12.3 Safety, policy, and encrypted persistence

- Feature: fast/slow ingestion and policy/sanitization gates
  - Tests:
    - `src/__tests__/dual-stream-writer.test.ts`
    - `src/__tests__/policy-aware-staged-writer.test.ts`
- Feature: key provider behavior, encryption/decryption, rotation, tamper handling
  - Tests:
    - `src/__tests__/encryption.test.ts`

### 12.4 Structured and temporal memory models

- Feature: versioned working state, history, diffs, revert, pruning
  - Tests:
    - `src/__tests__/versioned-working-memory.test.ts`
- Feature: bi-temporal storage and filtering (`asOf`, `validAt`, supersede/expire)
  - Tests:
    - `src/__tests__/temporal.test.ts`

### 12.5 Consolidation and quality lifecycle

- Feature: semantic consolidation actions and failure handling
  - Tests:
    - `src/__tests__/semantic-consolidation.test.ts`
- Feature: offline multi-phase consolidation orchestration
  - Tests:
    - `src/__tests__/sleep-consolidator.test.ts`
- Feature: M4 support algorithms
  - Tests:
    - `src/__tests__/consolidation-types.test.ts`
    - `src/__tests__/lesson-dedup.test.ts`
    - `src/__tests__/convention-extractor-m4.test.ts`
    - `src/__tests__/staleness-pruner.test.ts`

### 12.6 Learning pipelines and memory intelligence

- Feature: lesson extraction/retrieval
  - Tests:
    - `src/__tests__/lesson-pipeline.test.ts`
- Feature: dynamic rule learning and lifecycle
  - Tests:
    - `src/__tests__/rule-engine.test.ts`
- Feature: skill crystallization and pack loading
  - Tests:
    - `src/__tests__/skill-acquisition.test.ts`
    - `src/__tests__/skill-packs.test.ts`
- Feature: observation extraction and reflection
  - Tests:
    - `src/__tests__/memory-aware-extractor.test.ts`
    - `src/__tests__/observational-memory.test.ts`
- Feature: prompt context integration reads
  - Tests:
    - `src/__tests__/memory-integrator.test.ts`

### 12.7 Access control, collaboration, and sync

- Feature: scoped namespace read/write permissions
  - Tests:
    - `src/__tests__/scoped-memory.test.ts`
- Feature: shared namespace semantics and CRDT merge behavior
  - Tests:
    - `src/__tests__/shared-namespace.test.ts`
    - `src/__tests__/shared-namespace-crdt.test.ts`
    - `src/__tests__/vector-clock.test.ts`
    - `src/crdt/__tests__/crdt.test.ts`
- Feature: shared-space lifecycle and retention flows
  - Tests:
    - `src/sharing/__tests__/shared-spaces.test.ts`
- Feature: replication protocol/session transport logic
  - Tests:
    - `src/sync/__tests__/sync.test.ts`

### 12.8 Graph and MCP integration

- Feature: team memory graph model/query/conflict scoring
  - Tests:
    - `src/__tests__/team-memory-graph.test.ts`
- Feature: MCP tool definitions and request handler behavior
  - Tests:
    - `src/__tests__/mcp-memory-server.test.ts`

### 12.9 Interop and adjunct features

- Feature: convention extraction and conformance checks
  - Tests:
    - `src/convention/__tests__/convention.test.ts`
- Feature: provenance metadata and integrity hash behavior
  - Tests:
    - `src/provenance/__tests__/provenance.test.ts`
- Feature: agent-file export/import and signature handling
  - Tests:
    - `src/agent-file/__tests__/agent-file.test.ts`
- Feature: multi-modal attachment storage/index behavior
  - Tests:
    - `src/multi-modal/__tests__/multi-modal.test.ts`
- Feature: text similarity and ID helpers
  - Tests:
    - `src/__tests__/shared-utils.test.ts`

### 12.10 Targeted test commands for feature updates

Examples:

```bash
# Temporal changes
yarn workspace @dzupagent/memory test -- src/__tests__/temporal.test.ts

# Retrieval/ranking changes
yarn workspace @dzupagent/memory test -- src/__tests__/adaptive-retriever.test.ts src/__tests__/retrieval-weight-learning.test.ts src/__tests__/void-filter.test.ts

# Sharing/CRDT/sync changes
yarn workspace @dzupagent/memory test -- src/__tests__/shared-namespace-crdt.test.ts src/sharing/__tests__/shared-spaces.test.ts src/sync/__tests__/sync.test.ts

# Consolidation changes
yarn workspace @dzupagent/memory test -- src/__tests__/semantic-consolidation.test.ts src/__tests__/sleep-consolidator.test.ts
```
