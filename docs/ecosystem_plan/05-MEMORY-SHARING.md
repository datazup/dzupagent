# 05 — Memory Sharing Protocol

> **Created:** 2026-03-24
> **Status:** Planning
> **Package:** `@dzipagent/memory`
> **Dependencies:** `@dzipagent/memory` (existing), `@dzipagent/core` (DzipEventBus)
> **Estimated Total Effort:** 70h across 8 features

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Feature Specifications](#2-feature-specifications)
   - [F1: Shared Memory Spaces (P0, 12h)](#f1-shared-memory-spaces)
   - [F2: Memory Provenance Tracking (P0, 4h)](#f2-memory-provenance-tracking)
   - [F3: Causal Graph Retrieval (P1, 8h)](#f3-causal-graph-retrieval)
   - [F4: Agent File (.af) Export (P1, 8h)](#f4-agent-file-af-export)
   - [F5: CRDT-Based Conflict Resolution (P2, 16h)](#f5-crdt-based-conflict-resolution)
   - [F6: Memory Encryption at Rest (P1, 6h)](#f6-memory-encryption-at-rest)
   - [F7: Multi-Modal Memory (P2, 8h)](#f7-multi-modal-memory)
   - [F8: Convention Memory (P1, 8h)](#f8-convention-memory)
3. [Data Models](#3-data-models)
4. [Data Flow Diagrams](#4-data-flow-diagrams)
5. [File Structure](#5-file-structure)
6. [Testing Strategy](#6-testing-strategy)

---

## 1. Architecture Overview

### 1.1 Current State

The `@dzipagent/memory` package provides:

- **MemoryService**: namespace-scoped put/get/search with non-fatal error handling, Ebbinghaus decay scoring, sanitization
- **ScopedMemoryService**: per-agent access policies (read/write/read-write/none) with violation tracking
- **TemporalMemoryService**: bi-temporal versioning (4 timestamps, supersede, history)
- **WorkingMemory**: Zod-validated structured state with auto-save
- **FrozenMemorySnapshot**: session-level snapshot for prompt cache stability
- **DualStreamWriter**: fast-path immediate writes + slow-path batched enrichment
- **AdaptiveRetriever**: intent-classified retrieval with weighted RRF fusion across vector/FTS/graph
- **PersistentEntityGraph**: incremental entity index backed by BaseStore
- **Store backends**: `createStore()` producing PostgresStore or InMemoryBaseStore

What is **missing**: cross-agent memory sharing with provenance, causal reasoning over memory, portable agent state, conflict resolution for concurrent writes, encryption, multi-modal attachments, and convention extraction.

### 1.2 Shared Memory Space Model

The sharing model introduces **SharedMemorySpace** as a named, access-controlled region layered on top of existing MemoryService namespaces. A shared space is not a separate store; it is a virtual namespace prefix that multiple agents can opt into, with its own participant list, schema, and conflict resolution strategy.

```
                    BaseStore (Postgres or InMemory)
                    ================================
                    |  namespace tuple: [tenantId, spaceId, "shared", ...]
                    |
    +---------------+-------------------+-------------------+
    |               |                   |                   |
  Agent A         Agent B             Agent C            Space Manager
  (participant)   (participant)       (observer)         (admin)
    |               |                   |                   |
    +-- write ------+-- write ----------+-- read -----------+-- create/config
    |               |                   |                   |
    +-- subscribe --+-- subscribe ------+-- subscribe ------+
                    |
            DzipEventBus (memory:space:*)
```

Key design decisions:

1. **Spaces as namespace prefixes** -- a SharedMemorySpace with id `"planning"` maps to the namespace tuple `[tenantId, spaceId, "shared", "planning", ...]`. This reuses the existing MemoryService infrastructure without new store primitives.

2. **Opt-in participation** -- agents must explicitly join a space. There is no global shared memory. The `ScopedMemoryService` access policy model is extended to cover shared spaces.

3. **Event-driven sync** -- every write to a shared space emits a `memory:space:write` event on `DzipEventBus`. Subscribing agents receive real-time notifications without polling.

4. **Provenance by default** -- every record written through a shared space carries `_provenance` metadata tracking creator, source, confidence, and full lineage chain.

5. **Conflict resolution pluggable** -- spaces declare a `conflictResolution` strategy. Default is LWW (last-writer-wins). CRDT-based resolution is available for P2 use cases.

### 1.3 Provenance Chain Tracking

Every memory record gains an optional `_provenance` field injected automatically on writes through the sharing layer. Provenance tracks:

- **Who** created the record (agent URI)
- **When** (timestamp)
- **From where** (source: user-input, llm-generated, tool-output, shared-space, imported)
- **Confidence** (0.0-1.0)
- **Lineage** (ordered list of agent URIs that touched the record)

Provenance is additive: when Agent B reads a record created by Agent A and writes a derivative, the lineage grows to `[agentA, agentB]`.

### 1.4 Access Control and Isolation

Access control operates at three levels:

| Level | Mechanism | Existing? |
|-------|-----------|-----------|
| **Namespace** | `ScopedMemoryService` checks read/write/none per namespace | Yes |
| **Space** | `MemoryParticipant` permissions within a SharedMemorySpace | New (F1) |
| **Record** | `_provenance.createdBy` for ownership queries, encryption for confidential records | New (F2, F6) |

Isolation guarantee: an agent without a `MemoryParticipant` entry for a space cannot read or write to that space's namespace prefix, even if the agent has `read-write` access to the parent namespace. Space membership is checked before namespace access.

### 1.5 Integration with Existing Components

| Existing Component | Integration Point |
|---|---|
| `MemoryService` | Shared spaces register as special namespaces via `addNamespace()` (new method) |
| `ScopedMemoryService` | Extended to check space participation before namespace access |
| `TemporalMemoryService` | Shared space records can carry `_temporal` metadata for bi-temporal queries |
| `DualStreamWriter` | Fast-path writes to shared spaces emit events; slow-path runs provenance enrichment |
| `AdaptiveRetriever` | Gains a `causal` weight source (F3) alongside vector/FTS/graph |
| `FrozenMemorySnapshot` | Can freeze shared space namespaces for prompt cache |
| `WritePolicy` | New `provenancePolicy` validates provenance integrity on writes |
| `DzipEventBus` | Shared space operations emit typed events for cross-agent sync |

---

## 2. Feature Specifications

### F1: Shared Memory Spaces

**Priority:** P0 | **Effort:** 12h | **Package:** `@dzipagent/memory`

Shared memory spaces allow multiple agents to read and write to a common namespace with controlled access, schema enforcement, and event-driven synchronization.

#### Types

```typescript
/**
 * Unique identifier for agents and resources using the forge:// URI scheme.
 *
 * Format: forge://{tenantId}/{agentType}/{agentId}
 * Examples:
 *   forge://t1/agent/planner
 *   forge://t1/agent/coder
 *   forge://t1/space/planning
 */
type ForgeUri = `forge://${string}`;

/** Permission levels for space participants */
type SpacePermission = 'read' | 'read-write' | 'admin';

/** Strategy for resolving conflicting writes */
type ConflictStrategy = 'lww' | 'manual' | 'crdt';

/** Retention policy for automatic record cleanup */
interface RetentionPolicy {
  /** Maximum age in milliseconds before records are eligible for pruning */
  maxAgeMs: number | null;
  /** Maximum number of records in the space (oldest pruned first) */
  maxRecords: number | null;
  /** Whether expired temporal records count toward maxRecords */
  countExpired: boolean;
}

/** A participant in a shared memory space */
interface MemoryParticipant {
  /** Agent URI (forge:// scheme) */
  agentUri: ForgeUri;
  /** Permission level within this space */
  permission: SpacePermission;
  /** When this agent joined the space */
  joinedAt: number;
  /** When this agent last accessed the space */
  lastAccessAt: number;
}

/**
 * Shared memory space definition.
 *
 * A space is a virtual namespace overlay that multiple agents can participate in.
 * It maps to a BaseStore namespace tuple: [tenantId, spaceId, "shared", spaceName, ...]
 */
interface SharedMemorySpace {
  /** Unique space identifier */
  id: string;
  /** Human-readable space name */
  name: string;
  /** Agent URI of the space creator */
  owner: ForgeUri;
  /** Map of participant agent URIs to their participation records */
  participants: Map<string, MemoryParticipant>;
  /**
   * Optional Zod schema key referencing a registered schema.
   * When set, all writes are validated against this schema before persistence.
   * Null means no schema enforcement (free-form records).
   */
  schemaKey: string | null;
  /** Retention policy for automatic record cleanup */
  retentionPolicy: RetentionPolicy;
  /** Conflict resolution strategy */
  conflictResolution: ConflictStrategy;
  /** Space creation timestamp */
  createdAt: number;
  /** Space metadata (user-defined tags, description, etc.) */
  metadata: Record<string, unknown>;
}

/** Request to share a memory record with a space */
interface MemoryShareRequest {
  /** Source agent URI */
  from: ForgeUri;
  /** Target space ID */
  spaceId: string;
  /** Record key */
  key: string;
  /** Record value */
  value: Record<string, unknown>;
  /**
   * Share mode:
   * - 'push': immediately write to shared space
   * - 'pull-request': propose write, requires admin approval
   * - 'subscribe': register for updates on this key
   */
  mode: 'push' | 'pull-request' | 'subscribe';
}

/** Pending pull-request awaiting approval */
interface PendingShareRequest {
  id: string;
  request: MemoryShareRequest;
  status: 'pending' | 'approved' | 'rejected';
  reviewedBy: ForgeUri | null;
  reviewedAt: number | null;
  createdAt: number;
}

/** Events emitted by shared memory operations */
type SharedMemoryEvent =
  | { type: 'memory:space:created'; space: SharedMemorySpace }
  | { type: 'memory:space:joined'; spaceId: string; participant: MemoryParticipant }
  | { type: 'memory:space:left'; spaceId: string; agentUri: ForgeUri }
  | { type: 'memory:space:write'; spaceId: string; key: string; agentUri: ForgeUri; value: Record<string, unknown> }
  | { type: 'memory:space:delete'; spaceId: string; key: string; agentUri: ForgeUri }
  | { type: 'memory:space:pr:created'; spaceId: string; requestId: string }
  | { type: 'memory:space:pr:resolved'; spaceId: string; requestId: string; status: 'approved' | 'rejected' };
```

#### MemorySpaceManager

```typescript
/**
 * Manages shared memory spaces — creation, participation, sharing, and querying.
 *
 * Shared spaces are persisted as records in a reserved "__spaces" namespace
 * within the underlying MemoryService. Space metadata, participant lists, and
 * pending pull-requests are all stored in the same BaseStore.
 *
 * All operations are non-fatal unless `strict: true` is set.
 *
 * @example
 * ```ts
 * const manager = new MemorySpaceManager({
 *   memoryService,
 *   tenantId: 't1',
 * });
 *
 * // Create a shared space
 * const space = await manager.create({
 *   name: 'planning',
 *   owner: 'forge://t1/agent/planner',
 * });
 *
 * // Another agent joins
 * await manager.join(space.id, {
 *   agentUri: 'forge://t1/agent/coder',
 *   permission: 'read-write',
 * });
 *
 * // Share a memory record
 * await manager.share({
 *   from: 'forge://t1/agent/planner',
 *   spaceId: space.id,
 *   key: 'arch-decision-001',
 *   value: { text: 'Use PostgreSQL for all persistence', type: 'decision' },
 *   mode: 'push',
 * });
 *
 * // Query shared memories
 * const results = await manager.query(space.id, 'forge://t1/agent/coder', {
 *   text: 'database decisions',
 *   limit: 5,
 * });
 *
 * // Subscribe to changes
 * manager.subscribe(space.id, 'forge://t1/agent/coder', (event) => {
 *   console.log('Space change:', event);
 * });
 * ```
 */
interface MemorySpaceManagerConfig {
  /** Underlying memory service for persistence */
  memoryService: MemoryService;
  /** Tenant ID for namespace scoping */
  tenantId: string;
  /** Optional event bus for cross-component notifications */
  eventBus?: DzipEventBus;
  /** Throw on permission violations instead of returning silently (default: false) */
  strict?: boolean;
}

interface CreateSpaceOptions {
  /** Space name (used as namespace suffix) */
  name: string;
  /** Owner agent URI */
  owner: ForgeUri;
  /** Optional schema key for write validation */
  schemaKey?: string;
  /** Retention policy (defaults: no max age, no max records) */
  retentionPolicy?: Partial<RetentionPolicy>;
  /** Conflict resolution strategy (default: 'lww') */
  conflictResolution?: ConflictStrategy;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

interface JoinSpaceOptions {
  agentUri: ForgeUri;
  permission: SpacePermission;
}

interface SpaceQueryOptions {
  /** Semantic search query text */
  text?: string;
  /** Maximum results (default: 10) */
  limit?: number;
  /** Filter by provenance creator */
  createdBy?: ForgeUri;
  /** Temporal query (if records carry _temporal) */
  temporal?: TemporalQuery;
}

declare class MemorySpaceManager {
  constructor(config: MemorySpaceManagerConfig);

  /**
   * Create a new shared memory space.
   * Registers a new namespace in MemoryService and persists the space definition.
   */
  create(options: CreateSpaceOptions): Promise<SharedMemorySpace>;

  /**
   * Join an existing space. Requires the space to exist.
   * The joining agent's permission is recorded in the participant list.
   */
  join(spaceId: string, options: JoinSpaceOptions): Promise<void>;

  /**
   * Leave a space. Removes the agent from the participant list.
   * Does not delete any records the agent wrote.
   */
  leave(spaceId: string, agentUri: ForgeUri): Promise<void>;

  /**
   * Share a memory record with a space.
   *
   * - 'push' mode: write immediately (requires read-write or admin permission)
   * - 'pull-request' mode: create a pending request (requires at least read permission)
   * - 'subscribe' mode: register for updates on this key (requires at least read permission)
   *
   * Automatically injects provenance metadata into the record.
   */
  share(request: MemoryShareRequest): Promise<void>;

  /**
   * Query records in a shared space.
   * Requires read permission for the querying agent.
   * Supports semantic search, provenance filtering, and temporal queries.
   */
  query(
    spaceId: string,
    agentUri: ForgeUri,
    options?: SpaceQueryOptions,
  ): Promise<Record<string, unknown>[]>;

  /**
   * Subscribe to real-time changes in a space.
   * Returns an unsubscribe function.
   * Uses DzipEventBus internally; falls back to polling if no event bus.
   */
  subscribe(
    spaceId: string,
    agentUri: ForgeUri,
    callback: (event: SharedMemoryEvent) => void,
  ): () => void;

  /**
   * Get space definition by ID. Returns null if not found.
   */
  getSpace(spaceId: string): Promise<SharedMemorySpace | null>;

  /**
   * List all spaces the given agent participates in.
   */
  listSpaces(agentUri: ForgeUri): Promise<SharedMemorySpace[]>;

  /**
   * Review a pending pull-request (admin only).
   */
  reviewPullRequest(
    spaceId: string,
    requestId: string,
    reviewerUri: ForgeUri,
    decision: 'approved' | 'rejected',
  ): Promise<void>;

  /**
   * List pending pull-requests for a space (admin only).
   */
  listPendingRequests(
    spaceId: string,
    adminUri: ForgeUri,
  ): Promise<PendingShareRequest[]>;

  /**
   * Run retention policy on a space — prune records exceeding age/count limits.
   * Called manually or on a schedule. Non-fatal.
   */
  enforceRetention(spaceId: string): Promise<{ pruned: number }>;

  /**
   * Dispose of all subscriptions and timers.
   */
  dispose(): void;
}
```

#### Namespace Mapping

Shared spaces map to MemoryService namespaces as follows:

| Logical Concept | Namespace Tuple |
|---|---|
| Space definitions | `[tenantId, "__spaces"]` |
| Space records | `[tenantId, spaceId, "shared", spaceName]` |
| Pending PRs | `[tenantId, spaceId, "shared", spaceName, "__prs"]` |
| Subscriptions | In-memory only (via DzipEventBus); not persisted |

#### MemoryService Extension

```typescript
/**
 * New method on MemoryService to support dynamic namespace registration.
 * Shared spaces call this when created to register their namespace.
 */
declare class MemoryService {
  // ... existing methods ...

  /**
   * Register a new namespace at runtime.
   * Used by MemorySpaceManager to add shared space namespaces.
   * Throws if namespace name conflicts with an existing registration.
   */
  addNamespace(config: NamespaceConfig): void;

  /**
   * Check if a namespace is registered.
   */
  hasNamespace(name: string): boolean;

  /**
   * Remove a namespace registration.
   * Does NOT delete stored records; only removes the runtime mapping.
   */
  removeNamespace(name: string): void;
}
```

---

### F2: Memory Provenance Tracking

**Priority:** P0 | **Effort:** 4h | **Package:** `@dzipagent/memory`

Provenance metadata is automatically injected into every record written through provenance-aware code paths (shared spaces, `ProvenanceWriter`). Provenance enables trust scoring, lineage queries, and audit trails.

#### Types

```typescript
/**
 * Source classification for a memory record.
 *
 * - 'user-input': directly from a human user
 * - 'llm-generated': produced by an LLM call
 * - 'tool-output': returned by a tool invocation
 * - 'shared-space': received from a shared memory space
 * - 'imported': loaded from an Agent File (.af) or external source
 * - 'derived': computed from other memory records
 * - 'consolidated': produced by memory consolidation
 */
type ProvenanceSource =
  | 'user-input'
  | 'llm-generated'
  | 'tool-output'
  | 'shared-space'
  | 'imported'
  | 'derived'
  | 'consolidated';

/**
 * Provenance metadata attached to a memory record as `_provenance`.
 *
 * Stored inline in the record value, requiring no schema changes to BaseStore.
 * Pattern matches existing `_temporal` and `_decay` inline metadata.
 */
interface MemoryProvenance {
  /** Agent URI of the record creator */
  createdBy: ForgeUri;
  /** Timestamp of creation */
  createdAt: number;
  /** How this record was produced */
  source: ProvenanceSource;
  /** Confidence score (0.0 = unverified, 1.0 = ground truth) */
  confidence: number;
  /**
   * Lineage chain: ordered list of agent URIs that touched this record.
   * First entry is the original creator. Last entry is the most recent modifier.
   * Grows when a record is read-modify-written by a different agent.
   */
  lineage: ForgeUri[];
  /**
   * Optional reference to the source record key when this record is derived.
   * For shared-space records, this is the key in the originating agent's namespace.
   */
  derivedFrom?: string;
  /**
   * Optional hash of the record value at creation time.
   * Used by integrity verification (F6) to detect tampering.
   */
  contentHash?: string;
}

/**
 * Options for provenance-aware writes.
 */
interface ProvenanceWriteOptions {
  /** Override source classification (default: 'llm-generated') */
  source?: ProvenanceSource;
  /** Override confidence (default: 0.5) */
  confidence?: number;
  /** Reference to a parent record this one was derived from */
  derivedFrom?: string;
  /** Compute and store content hash (default: false) */
  computeHash?: boolean;
}
```

#### ProvenanceWriter

```typescript
/**
 * Wraps a MemoryService to automatically inject provenance metadata on every write.
 *
 * Provenance is stored as `_provenance` in the record value, following the same
 * inline metadata pattern as `_temporal` and `_decay`.
 *
 * @example
 * ```ts
 * const writer = new ProvenanceWriter({
 *   memoryService,
 *   agentUri: 'forge://t1/agent/planner',
 *   defaultSource: 'llm-generated',
 * });
 *
 * await writer.put('decisions', scope, 'dec-001', {
 *   text: 'Use PostgreSQL for persistence',
 * });
 * // Record stored with _provenance: {
 * //   createdBy: 'forge://t1/agent/planner',
 * //   createdAt: 1711267200000,
 * //   source: 'llm-generated',
 * //   confidence: 0.5,
 * //   lineage: ['forge://t1/agent/planner'],
 * // }
 * ```
 */
interface ProvenanceWriterConfig {
  /** Underlying memory service */
  memoryService: MemoryService;
  /** URI of the agent performing writes */
  agentUri: ForgeUri;
  /** Default source classification for writes (default: 'llm-generated') */
  defaultSource?: ProvenanceSource;
  /** Default confidence for writes (default: 0.5) */
  defaultConfidence?: number;
}

declare class ProvenanceWriter {
  constructor(config: ProvenanceWriterConfig);

  /**
   * Write a record with automatic provenance injection.
   *
   * If the record already has `_provenance` (e.g., received from a shared space),
   * the current agent URI is appended to the lineage chain and the record is
   * re-stamped with the current timestamp.
   */
  put(
    namespace: string,
    scope: Record<string, string>,
    key: string,
    value: Record<string, unknown>,
    options?: ProvenanceWriteOptions,
  ): Promise<void>;

  /**
   * Read records and filter by provenance criteria.
   */
  getByProvenance(
    namespace: string,
    scope: Record<string, string>,
    filter: {
      createdBy?: ForgeUri;
      source?: ProvenanceSource;
      minConfidence?: number;
      lineageIncludes?: ForgeUri;
    },
  ): Promise<Record<string, unknown>[]>;

  /**
   * Get the full lineage chain for a specific record.
   * Returns the `_provenance.lineage` array, or empty if no provenance.
   */
  getLineage(
    namespace: string,
    scope: Record<string, string>,
    key: string,
  ): Promise<ForgeUri[]>;
}

/**
 * Extract provenance from a record value. Returns null if not present.
 * Validates structural integrity before returning.
 */
declare function extractProvenance(
  record: Record<string, unknown>,
): MemoryProvenance | null;

/**
 * Create initial provenance metadata for a new record.
 */
declare function createProvenance(
  agentUri: ForgeUri,
  source: ProvenanceSource,
  confidence?: number,
): MemoryProvenance;

/**
 * Extend an existing provenance chain with a new agent touch.
 * Returns a new MemoryProvenance with the agent appended to lineage.
 */
declare function extendProvenance(
  existing: MemoryProvenance,
  agentUri: ForgeUri,
): MemoryProvenance;
```

#### Prompt Integration

The existing `MemoryService.formatForPrompt()` gains an optional `includeProvenance` flag:

```typescript
interface FormatOptions {
  // ... existing fields ...

  /**
   * Include provenance annotations in formatted output.
   * When true, each record is suffixed with "(source: X, confidence: Y, by: Z)".
   * Default: false.
   */
  includeProvenance?: boolean;
}
```

---

### F3: Causal Graph Retrieval

**Priority:** P1 | **Effort:** 8h | **Package:** `@dzipagent/memory`

Causal graph retrieval enables "why did this happen?" reasoning by maintaining explicit cause-effect relations between memory records and traversing causal chains during search.

#### Types

```typescript
/**
 * A directed causal relation between two memory records.
 *
 * Stored in a dedicated namespace: [tenantId, scope, "__causal"]
 * Key format: `{causeKey}--causes-->{effectKey}`
 */
interface CausalRelation {
  /** Key of the cause record */
  cause: string;
  /** Namespace of the cause record */
  causeNamespace: string;
  /** Key of the effect record */
  effect: string;
  /** Namespace of the effect record */
  effectNamespace: string;
  /** Confidence that this causal link is real (0.0-1.0) */
  confidence: number;
  /** Evidence supporting this causal claim */
  evidence: string;
  /** Timestamp when the relation was established */
  createdAt: number;
  /** Agent URI that established this relation */
  createdBy: ForgeUri;
}

/**
 * A node in the causal graph. Wraps a memory record with its causal connections.
 */
interface CausalNode {
  /** Memory record key */
  key: string;
  /** Memory record namespace */
  namespace: string;
  /** The record value */
  value: Record<string, unknown>;
  /** Direct causes (records that led to this one) */
  causes: CausalRelation[];
  /** Direct effects (records caused by this one) */
  effects: CausalRelation[];
}

/**
 * Result of a causal graph traversal.
 */
interface CausalGraphResult {
  /** The root node the query started from */
  root: CausalNode;
  /** All nodes visited during traversal */
  nodes: CausalNode[];
  /** All edges in the traversed subgraph */
  edges: CausalRelation[];
  /** Maximum depth reached during traversal */
  maxDepth: number;
}

/**
 * Options for causal chain traversal.
 */
interface CausalTraversalOptions {
  /** Direction of traversal */
  direction: 'causes' | 'effects' | 'both';
  /** Maximum hops from the starting node (default: 3) */
  maxDepth?: number;
  /** Minimum confidence threshold for following a causal link (default: 0.3) */
  minConfidence?: number;
  /** Maximum total nodes to return (default: 20) */
  maxNodes?: number;
}
```

#### CausalGraph

```typescript
/**
 * Manages causal relations between memory records.
 *
 * Causal relations are stored in a dedicated "__causal" namespace,
 * persisted through the same BaseStore as all other memory data.
 *
 * The CausalGraph integrates with AdaptiveRetriever to add a causal
 * weight to RRF fusion when the query intent is classified as 'causal'.
 *
 * @example
 * ```ts
 * const causal = new CausalGraph({
 *   memoryService,
 *   tenantId: 't1',
 * });
 *
 * // Record a causal relation
 * await causal.addRelation({
 *   cause: 'outage-001',
 *   causeNamespace: 'incidents',
 *   effect: 'hotfix-002',
 *   effectNamespace: 'decisions',
 *   confidence: 0.9,
 *   evidence: 'Hotfix deployed in response to outage',
 *   createdAt: Date.now(),
 *   createdBy: 'forge://t1/agent/planner',
 * });
 *
 * // Traverse: "why was hotfix-002 deployed?"
 * const chain = await causal.traverse(
 *   'hotfix-002',
 *   'decisions',
 *   { direction: 'causes', maxDepth: 5 },
 * );
 * ```
 */
interface CausalGraphConfig {
  memoryService: MemoryService;
  tenantId: string;
  /** Optional LLM for automatic relation extraction from conversations */
  llm?: BaseChatModel;
}

declare class CausalGraph {
  constructor(config: CausalGraphConfig);

  /**
   * Add a causal relation between two memory records.
   * Idempotent: re-adding the same cause-effect pair updates confidence and evidence.
   */
  addRelation(relation: CausalRelation): Promise<void>;

  /**
   * Remove a causal relation.
   */
  removeRelation(causeKey: string, effectKey: string): Promise<void>;

  /**
   * Get all causal relations for a given record (both causes and effects).
   */
  getRelations(
    key: string,
    namespace: string,
  ): Promise<{ causes: CausalRelation[]; effects: CausalRelation[] }>;

  /**
   * Traverse the causal graph from a starting node.
   *
   * Uses BFS with confidence-weighted pruning. Stops at maxDepth hops
   * or when all reachable nodes above minConfidence have been visited.
   */
  traverse(
    startKey: string,
    startNamespace: string,
    options?: CausalTraversalOptions,
  ): Promise<CausalGraphResult>;

  /**
   * Extract causal relations from a conversation using an LLM.
   *
   * Given a sequence of messages, identifies cause-effect pairs and
   * returns proposed CausalRelation objects. Does NOT persist them
   * automatically; the caller decides which to add.
   *
   * Requires `llm` to be provided in config. Returns empty array if no LLM.
   */
  extractFromConversation(
    messages: Array<{ role: string; content: string }>,
    existingKeys: Array<{ key: string; namespace: string }>,
  ): Promise<CausalRelation[]>;

  /**
   * Search interface compatible with AdaptiveRetriever's provider contract.
   *
   * Returns records reachable via causal relations from the query entities,
   * scored by causal confidence and hop distance.
   */
  search(
    records: Array<{ key: string; value: Record<string, unknown> }>,
    query: string,
    limit: number,
  ): Promise<Array<{ key: string; score: number; value: Record<string, unknown> }>>;
}
```

#### AdaptiveRetriever Integration

The `RetrievalProviders` interface gains an optional `causal` provider:

```typescript
interface RetrievalProviders {
  vector?: { /* existing */ };
  fts?: { /* existing */ };
  graph?: { /* existing */ };
  /** Causal graph provider for cause-effect chain search */
  causal?: {
    search(
      records: Array<{ key: string; value: Record<string, unknown> }>,
      query: string,
      limit: number,
    ): Promise<Array<{ key: string; score: number; value: Record<string, unknown> }>>;
  };
}

interface RetrievalWeights {
  vector: number;
  fts: number;
  graph: number;
  /** Weight for causal graph results in fusion (default: 0) */
  causal?: number;
}
```

When a query is classified as `'causal'` intent, the default strategy applies:

```typescript
{
  intent: 'causal',
  weights: { vector: 0.2, fts: 0.1, graph: 0.3, causal: 0.4 },
  patterns: [ /* existing causal patterns */ ],
}
```

---

### F4: Agent File (.af) Export

**Priority:** P1 | **Effort:** 8h | **Package:** `@dzipagent/memory`

The Agent File format enables portable agent state export and import, compatible with the Letta Agent File concept but tailored to DzipAgent's memory architecture.

#### Format Specification

```typescript
/**
 * Agent File (.af) — portable agent state archive.
 *
 * Serialized as JSON with a well-defined envelope. The file extension is `.af`
 * and the MIME type is `application/vnd.forgeagent.agent-file+json`.
 *
 * Structure:
 * {
 *   "$schema": "https://forgeagent.dev/schemas/agent-file-v1.json",
 *   "version": "1.0.0",
 *   "exportedAt": "2026-03-24T10:00:00Z",
 *   "exportedBy": "forge://t1/agent/planner",
 *   "signature": "sha256:abc123...",  // optional integrity signature
 *   "agent": { ... },
 *   "memory": { ... },
 *   "prompts": { ... },
 *   "state": { ... },
 * }
 */

/** Top-level Agent File envelope */
interface AgentFile {
  /** JSON Schema URI for validation */
  $schema: string;
  /** Format version (semver) */
  version: string;
  /** Export timestamp (ISO 8601) */
  exportedAt: string;
  /** Agent URI that performed the export */
  exportedBy: ForgeUri;
  /** Optional SHA-256 signature of the content sections */
  signature: string | null;
  /** Agent configuration section */
  agent: AgentFileAgentSection;
  /** Memory data section */
  memory: AgentFileMemorySection;
  /** Prompt templates section */
  prompts: AgentFilePromptsSection;
  /** Runtime state section */
  state: AgentFileStateSection;
}

/** Agent configuration */
interface AgentFileAgentSection {
  /** Agent name */
  name: string;
  /** Agent URI */
  uri: ForgeUri;
  /** Model configuration (provider, model name, temperature, etc.) */
  model: Record<string, unknown>;
  /** System prompt (or template key) */
  systemPrompt: string;
  /** Tool names the agent uses */
  tools: string[];
  /** Capability tags */
  capabilities: string[];
  /** Agent metadata */
  metadata: Record<string, unknown>;
}

/** Memory data — all namespaces with their records */
interface AgentFileMemorySection {
  /** Map of namespace name to array of records */
  namespaces: Record<string, AgentFileMemoryRecord[]>;
  /** Working memory state (if any) */
  workingMemory: Record<string, unknown> | null;
  /** Causal relations (if CausalGraph is in use) */
  causalRelations: CausalRelation[];
}

/** Single memory record in an Agent File */
interface AgentFileMemoryRecord {
  key: string;
  value: Record<string, unknown>;
  /** Preserved provenance (if present) */
  provenance: MemoryProvenance | null;
  /** Preserved temporal metadata (if present) */
  temporal: TemporalMetadata | null;
}

/** Prompt templates */
interface AgentFilePromptsSection {
  /** Map of template key to template string */
  templates: Record<string, string>;
  /** Prompt fragment definitions */
  fragments: Record<string, string>;
}

/** Runtime state snapshot */
interface AgentFileStateSection {
  /** Serialized conversation summary (not full history) */
  conversationSummary: string | null;
  /** Last known context window usage */
  contextUsage: { tokens: number; maxTokens: number } | null;
  /** Custom state entries (agent-defined) */
  custom: Record<string, unknown>;
}
```

#### AgentFileExporter / AgentFileImporter

```typescript
interface AgentFileExportOptions {
  /** Agent URI */
  agentUri: ForgeUri;
  /** Agent configuration */
  agentConfig: AgentFileAgentSection;
  /** Memory service to export from */
  memoryService: MemoryService;
  /** Scope for memory reads */
  scope: Record<string, string>;
  /** Namespaces to export (default: all registered) */
  namespaces?: string[];
  /** Working memory instance (optional) */
  workingMemory?: WorkingMemory<z.ZodType>;
  /** Causal graph instance (optional) */
  causalGraph?: CausalGraph;
  /** Prompt templates to include */
  prompts?: AgentFilePromptsSection;
  /** Custom state entries */
  customState?: Record<string, unknown>;
  /** Conversation summary */
  conversationSummary?: string;
  /** Compute and embed an integrity signature (default: false) */
  sign?: boolean;
}

interface AgentFileImportOptions {
  /** Memory service to import into */
  memoryService: MemoryService;
  /** Scope to write imported records into */
  scope: Record<string, string>;
  /** Causal graph to import relations into (optional) */
  causalGraph?: CausalGraph;
  /** Working memory to restore (optional) */
  workingMemory?: WorkingMemory<z.ZodType>;
  /**
   * Conflict handling when importing records with keys that already exist.
   * - 'skip': keep existing, discard imported
   * - 'overwrite': replace existing with imported
   * - 'merge': keep both, suffix imported key with import timestamp
   * Default: 'skip'
   */
  conflictHandling?: 'skip' | 'overwrite' | 'merge';
  /** Verify signature before import (default: true if signature present) */
  verifySignature?: boolean;
}

interface AgentFileImportResult {
  /** Number of records successfully imported */
  imported: number;
  /** Number of records skipped (conflicts) */
  skipped: number;
  /** Number of records that failed to import */
  failed: number;
  /** Namespaces that were imported */
  namespaces: string[];
  /** Whether signature verification passed (null if no signature) */
  signatureValid: boolean | null;
  /** Warnings (e.g., version mismatch, unknown sections) */
  warnings: string[];
}

declare class AgentFileExporter {
  /**
   * Export agent state to an Agent File.
   * Returns the serialized AgentFile object (call JSON.stringify for disk storage).
   */
  static export(options: AgentFileExportOptions): Promise<AgentFile>;
}

declare class AgentFileImporter {
  /**
   * Import agent state from an Agent File.
   *
   * Validates the file format version and optionally verifies the signature.
   * Records are imported with source: 'imported' provenance.
   */
  static import(
    file: AgentFile,
    options: AgentFileImportOptions,
  ): Promise<AgentFileImportResult>;

  /**
   * Validate an Agent File without importing.
   * Checks structure, version compatibility, and optional signature.
   */
  static validate(file: unknown): {
    valid: boolean;
    version: string | null;
    errors: string[];
  };
}
```

---

### F5: CRDT-Based Conflict Resolution

**Priority:** P2 | **Effort:** 16h | **Package:** `@dzipagent/memory`

When multiple agents write to the same shared memory space concurrently, conflicts arise. CRDT (Conflict-free Replicated Data Types) provide mathematically guaranteed convergence without coordination.

#### Types

```typescript
/**
 * A Hybrid Logical Clock (HLC) timestamp for CRDT ordering.
 *
 * Combines wall clock time with a logical counter to handle
 * clock skew between agents while preserving causal ordering.
 */
interface HLCTimestamp {
  /** Wall clock time in milliseconds */
  wallMs: number;
  /** Logical counter (incremented when wall clock is equal) */
  counter: number;
  /** Node identifier (agent URI) for tie-breaking */
  nodeId: string;
}

/**
 * Last-Writer-Wins Register — stores a single value.
 *
 * The value with the highest HLC timestamp wins.
 * Concurrent writes with equal timestamps are broken by nodeId comparison.
 */
interface LWWRegister<T> {
  type: 'lww-register';
  value: T;
  timestamp: HLCTimestamp;
}

/**
 * Observed-Remove Set (OR-Set) — stores a set of elements.
 *
 * Each add operation is tagged with a unique tag. Remove operations
 * remove specific tags, not values. An element is in the set if it
 * has at least one add-tag that has not been removed.
 */
interface ORSet<T> {
  type: 'or-set';
  /** Map of serialized element -> set of add-tags */
  elements: Map<string, Set<string>>;
  /** Set of removed tags */
  tombstones: Set<string>;
}

/**
 * LWW-Element Map — a map where each key is an LWW-Register.
 *
 * Used for memory records: each field in the record is independently
 * resolved via LWW semantics, allowing concurrent updates to different
 * fields to merge without conflict.
 */
interface LWWMap {
  type: 'lww-map';
  /** Map of field name to LWW-Register */
  fields: Map<string, LWWRegister<unknown>>;
}

/**
 * CRDT state vector — tracks the latest known HLC per node.
 * Used for efficient delta synchronization.
 */
type StateVector = Map<string, HLCTimestamp>;

/** Result of merging two CRDT states */
interface MergeResult<T> {
  /** The merged value */
  merged: T;
  /** Whether any conflicts were detected during merge */
  hadConflicts: boolean;
  /** Description of conflicts (for logging/audit) */
  conflicts: string[];
}
```

#### CRDTResolver

```typescript
/**
 * CRDT conflict resolver for shared memory spaces.
 *
 * Provides merge operations for the three CRDT types used in DzipAgent:
 * - LWW-Register: scalar values (strings, numbers, booleans)
 * - OR-Set: arrays/sets of values
 * - LWW-Map: record objects (each field is an independent LWW-Register)
 *
 * The resolver is stateless: it takes two states and returns the merged result.
 * State management (persisting CRDT metadata alongside records) is handled
 * by the SharedMemorySpace integration layer.
 *
 * @example
 * ```ts
 * const resolver = new CRDTResolver('forge://t1/agent/planner');
 *
 * // Create and update a register
 * const reg1 = resolver.createRegister('hello');
 * const reg2 = resolver.createRegister('world');  // concurrent update
 * const merged = resolver.mergeRegisters(reg1, reg2);
 * // merged.value is whichever had a higher HLC timestamp
 * ```
 */
declare class CRDTResolver {
  constructor(nodeId: string);

  /** Get the current HLC timestamp (increments counter) */
  now(): HLCTimestamp;

  /** Receive a remote timestamp and update local HLC */
  receive(remote: HLCTimestamp): void;

  // --- LWW Register ---

  createRegister<T>(value: T): LWWRegister<T>;
  updateRegister<T>(register: LWWRegister<T>, value: T): LWWRegister<T>;
  mergeRegisters<T>(a: LWWRegister<T>, b: LWWRegister<T>): MergeResult<LWWRegister<T>>;

  // --- OR-Set ---

  createSet<T>(): ORSet<T>;
  addToSet<T>(set: ORSet<T>, element: T): ORSet<T>;
  removeFromSet<T>(set: ORSet<T>, element: T): ORSet<T>;
  mergeSets<T>(a: ORSet<T>, b: ORSet<T>): MergeResult<ORSet<T>>;
  setElements<T>(set: ORSet<T>): T[];

  // --- LWW Map ---

  createMap(record: Record<string, unknown>): LWWMap;
  updateField(map: LWWMap, field: string, value: unknown): LWWMap;
  mergeMaps(a: LWWMap, b: LWWMap): MergeResult<LWWMap>;
  mapToRecord(map: LWWMap): Record<string, unknown>;

  // --- State Vectors ---

  createStateVector(): StateVector;
  mergeStateVectors(a: StateVector, b: StateVector): StateVector;

  // --- HLC Comparison ---

  static compare(a: HLCTimestamp, b: HLCTimestamp): number;
}
```

#### Storage Model

CRDT metadata is stored as `_crdt` in the record value:

```typescript
interface CRDTMetadata {
  /** CRDT type used for this record */
  type: 'lww-register' | 'or-set' | 'lww-map';
  /** HLC timestamp of last write */
  hlc: HLCTimestamp;
  /** State vector for delta sync */
  stateVector: Record<string, { wallMs: number; counter: number; nodeId: string }>;
  /**
   * For LWW-Map: per-field timestamps.
   * Key is field name, value is the HLC of the last write to that field.
   */
  fieldTimestamps?: Record<string, { wallMs: number; counter: number; nodeId: string }>;
  /**
   * For OR-Set: serialized tombstone set.
   */
  tombstones?: string[];
}
```

#### Integration with SharedMemorySpace

When a `SharedMemorySpace` has `conflictResolution: 'crdt'`:

1. Every write wraps the value in an `LWWMap` (or `LWWRegister` for scalar values).
2. On write conflict (same key, different agent), the `CRDTResolver.mergeMaps()` is invoked.
3. The merged result is stored, and both agents see the converged state on next read.
4. Merge conflicts are logged as `SharedMemoryEvent` with type `memory:space:conflict`.

---

### F6: Memory Encryption at Rest

**Priority:** P1 | **Effort:** 6h | **Package:** `@dzipagent/memory`

Encrypts sensitive memory records at the application layer before they reach BaseStore, providing defense-in-depth beyond database-level encryption.

#### Types

```typescript
/**
 * Encryption algorithm identifier.
 * Currently only AES-256-GCM is supported.
 */
type EncryptionAlgorithm = 'aes-256-gcm';

/**
 * Encryption key descriptor.
 * Keys are never stored in memory records; only key IDs are referenced.
 */
interface EncryptionKeyDescriptor {
  /** Unique key identifier */
  keyId: string;
  /** Key creation timestamp */
  createdAt: number;
  /** Whether this key is the current active key for new encryptions */
  active: boolean;
  /** Namespace(s) this key is authorized for ('*' = all) */
  namespaces: string[] | '*';
}

/**
 * Encrypted record envelope.
 *
 * When a record is encrypted, its `value` is replaced with this envelope.
 * The original value is encrypted and stored as a base64 ciphertext.
 */
interface EncryptedEnvelope {
  /** Marker field indicating this record is encrypted */
  _encrypted: true;
  /** Algorithm used */
  algorithm: EncryptionAlgorithm;
  /** Key ID used for encryption (for key rotation lookup) */
  keyId: string;
  /** Base64-encoded ciphertext */
  ciphertext: string;
  /** Base64-encoded initialization vector */
  iv: string;
  /** Base64-encoded authentication tag */
  authTag: string;
  /** Encrypted at timestamp */
  encryptedAt: number;
  /**
   * Plaintext fields preserved outside encryption for searchability.
   * Only non-sensitive metadata (e.g., record type tags) should be listed here.
   */
  plaintextFields: Record<string, unknown>;
}

/**
 * Key provider interface — abstracts where encryption keys come from.
 *
 * Implementations:
 * - EnvKeyProvider: reads keys from environment variables
 * - VaultKeyProvider: reads keys from HashiCorp Vault / AWS KMS
 */
interface EncryptionKeyProvider {
  /** Get a key by ID. Returns the raw 256-bit key or null if not found. */
  getKey(keyId: string): Promise<Uint8Array | null>;
  /** Get the currently active key for a namespace. */
  getActiveKey(namespace: string): Promise<{ keyId: string; key: Uint8Array } | null>;
  /** List all key descriptors (without raw key material). */
  listKeys(): Promise<EncryptionKeyDescriptor[]>;
}
```

#### EncryptedMemoryService

```typescript
/**
 * Wraps a MemoryService to provide transparent encryption/decryption.
 *
 * On write: encrypts the record value using AES-256-GCM before passing to inner service.
 * On read: detects encrypted envelopes and decrypts transparently.
 *
 * Non-encrypted records pass through unchanged, enabling gradual migration.
 *
 * @example
 * ```ts
 * const encrypted = new EncryptedMemoryService({
 *   memoryService,
 *   keyProvider: new EnvKeyProvider(),
 *   encryptedNamespaces: ['secrets', 'credentials'],
 * });
 *
 * // Writes to 'secrets' are automatically encrypted
 * await encrypted.put('secrets', scope, 'api-key', { text: 'sk-abc123' });
 *
 * // Reads from 'secrets' are automatically decrypted
 * const records = await encrypted.get('secrets', scope);
 * // records[0].text === 'sk-abc123' (plaintext)
 * ```
 */
interface EncryptedMemoryServiceConfig {
  /** Inner memory service */
  memoryService: MemoryService;
  /** Key provider for encryption/decryption keys */
  keyProvider: EncryptionKeyProvider;
  /** Namespaces to encrypt (writes to other namespaces pass through unencrypted) */
  encryptedNamespaces: string[];
  /**
   * Fields to preserve in plaintext for searchability.
   * These fields are copied out of the record before encryption.
   * Default: ['type', '_tags'] — metadata fields only, never content.
   */
  plaintextFields?: string[];
}

declare class EncryptedMemoryService {
  constructor(config: EncryptedMemoryServiceConfig);

  /** Write with encryption (if namespace is in encryptedNamespaces) */
  put(
    namespace: string,
    scope: Record<string, string>,
    key: string,
    value: Record<string, unknown>,
  ): Promise<void>;

  /** Read with transparent decryption */
  get(
    namespace: string,
    scope: Record<string, string>,
    key?: string,
  ): Promise<Record<string, unknown>[]>;

  /** Search (limited to plaintext fields for encrypted namespaces) */
  search(
    namespace: string,
    scope: Record<string, string>,
    query: string,
    limit?: number,
  ): Promise<Record<string, unknown>[]>;

  /** Format for prompt (decrypts before formatting) */
  formatForPrompt(
    records: Record<string, unknown>[],
    options?: FormatOptions,
  ): string;

  /**
   * Re-encrypt all records in a namespace with a new key.
   * Used for key rotation. Reads with old key, writes with new key.
   * Returns count of re-encrypted records.
   */
  rotateKey(
    namespace: string,
    scope: Record<string, string>,
  ): Promise<{ rotated: number; failed: number }>;
}

/**
 * Environment-variable-based key provider.
 *
 * Reads keys from environment variables named:
 *   DZIP_MEMORY_KEY_{keyId}=hex-encoded-256-bit-key
 *   DZIP_MEMORY_ACTIVE_KEY_{namespace}=keyId
 */
declare class EnvKeyProvider implements EncryptionKeyProvider {
  getKey(keyId: string): Promise<Uint8Array | null>;
  getActiveKey(namespace: string): Promise<{ keyId: string; key: Uint8Array } | null>;
  listKeys(): Promise<EncryptionKeyDescriptor[]>;
}
```

#### Integration with Write Policies

The existing `WritePolicy` system gains a built-in `encryptionPolicy`:

```typescript
/**
 * Write policy that flags records containing sensitive patterns for encryption.
 *
 * When composed with the default policy via composePolicies(), records matching
 * secret/PII patterns are marked 'confirm-required' instead of 'reject',
 * because the EncryptedMemoryService will encrypt them safely.
 */
declare const encryptionWritePolicy: WritePolicy;
```

---

### F7: Multi-Modal Memory

**Priority:** P2 | **Effort:** 8h | **Package:** `@dzipagent/memory`

Stores references to non-text artifacts (images, audio, documents) alongside text memory records, enabling cross-modal retrieval.

#### Types

```typescript
/**
 * Supported attachment types.
 */
type AttachmentType = 'image' | 'audio' | 'video' | 'document' | 'code-snippet' | 'diagram';

/**
 * A reference to a non-text artifact attached to a memory record.
 *
 * Attachments are stored as URIs, not raw binary. The actual artifact
 * lives in object storage (S3, GCS, local filesystem) and is referenced
 * by URI. This keeps BaseStore records lightweight.
 */
interface MemoryAttachment {
  /** Unique attachment identifier */
  id: string;
  /** Attachment type */
  type: AttachmentType;
  /** URI to the artifact (s3://, file://, https://) */
  uri: string;
  /** MIME type (e.g., 'image/png', 'audio/wav') */
  mimeType: string;
  /** Human-readable description (used for text-based search) */
  description: string;
  /** File size in bytes (for budget tracking) */
  sizeBytes: number;
  /**
   * Pre-computed embedding of the description (or visual embedding for images).
   * Stored as a number array for vector search compatibility.
   * Null if embeddings have not been computed yet.
   */
  embedding: number[] | null;
  /** Thumbnail URI for preview (images/video only) */
  thumbnailUri: string | null;
  /** Timestamp when the attachment was created */
  createdAt: number;
  /** Metadata (dimensions, duration, page count, etc.) */
  metadata: Record<string, unknown>;
}

/**
 * A memory record with attachments.
 *
 * Attachments are stored in the record value under `_attachments`.
 * This follows the same inline metadata pattern as `_provenance`, `_temporal`, `_decay`.
 */
interface AttachmentMetadata {
  _attachments: MemoryAttachment[];
}
```

#### MultiModalMemoryService

```typescript
/**
 * Extends MemoryService with attachment management.
 *
 * Text content and attachment descriptions are both indexed for search,
 * enabling queries like "show me the architecture diagram we discussed"
 * to surface image attachments via their description text.
 *
 * @example
 * ```ts
 * const mm = new MultiModalMemoryService({
 *   memoryService,
 *   storageProvider: new S3StorageProvider({ bucket: 'forge-attachments' }),
 * });
 *
 * await mm.putWithAttachment('decisions', scope, 'arch-001', {
 *   text: 'Decided to use event-driven architecture',
 * }, {
 *   type: 'diagram',
 *   uri: 's3://forge-attachments/arch-diagram-001.png',
 *   mimeType: 'image/png',
 *   description: 'Event-driven architecture diagram showing pub-sub flow',
 *   sizeBytes: 245_000,
 * });
 * ```
 */
interface MultiModalMemoryServiceConfig {
  memoryService: MemoryService;
  /**
   * Optional storage provider for uploading new attachments.
   * If not provided, only pre-uploaded URIs can be attached.
   */
  storageProvider?: AttachmentStorageProvider;
}

/**
 * Pluggable storage backend for attachment binary data.
 */
interface AttachmentStorageProvider {
  /** Upload binary data and return the URI */
  upload(
    key: string,
    data: Uint8Array,
    mimeType: string,
  ): Promise<string>;
  /** Generate a pre-signed download URL (time-limited) */
  getDownloadUrl(uri: string, expiresInMs?: number): Promise<string>;
  /** Delete an attachment */
  delete(uri: string): Promise<void>;
}

declare class MultiModalMemoryService {
  constructor(config: MultiModalMemoryServiceConfig);

  /**
   * Store a record with an attachment.
   * The attachment is stored as metadata in the record; binary is at the URI.
   */
  putWithAttachment(
    namespace: string,
    scope: Record<string, string>,
    key: string,
    value: Record<string, unknown>,
    attachment: Omit<MemoryAttachment, 'id' | 'createdAt' | 'embedding'>,
  ): Promise<void>;

  /**
   * Add an attachment to an existing record.
   */
  addAttachment(
    namespace: string,
    scope: Record<string, string>,
    key: string,
    attachment: Omit<MemoryAttachment, 'id' | 'createdAt' | 'embedding'>,
  ): Promise<void>;

  /**
   * Search across both text content and attachment descriptions.
   * Returns records sorted by combined relevance.
   */
  searchWithAttachments(
    namespace: string,
    scope: Record<string, string>,
    query: string,
    limit?: number,
  ): Promise<Array<Record<string, unknown> & AttachmentMetadata>>;

  /**
   * Get all attachments for a record.
   */
  getAttachments(
    namespace: string,
    scope: Record<string, string>,
    key: string,
  ): Promise<MemoryAttachment[]>;

  /**
   * Remove an attachment from a record (does not delete the binary).
   */
  removeAttachment(
    namespace: string,
    scope: Record<string, string>,
    key: string,
    attachmentId: string,
  ): Promise<void>;
}
```

---

### F8: Convention Memory

**Priority:** P1 | **Effort:** 8h | **Package:** `@dzipagent/memory`

Convention memory automatically detects coding patterns and conventions from generated code, stores them, and uses them to enforce consistency in future generations.

#### Types

```typescript
/**
 * A detected coding convention.
 */
interface DetectedConvention {
  /** Unique convention ID */
  id: string;
  /** Convention name (e.g., 'naming:components', 'structure:api-routes') */
  name: string;
  /** Convention category */
  category: ConventionCategory;
  /** Natural language description of the convention */
  description: string;
  /** The pattern or rule (regex, glob, or prose) */
  pattern: string;
  /**
   * Concrete examples from the codebase.
   * Each example is a { file, snippet } pair.
   */
  examples: Array<{ file: string; snippet: string }>;
  /** Confidence that this convention is intentional (0.0-1.0) */
  confidence: number;
  /** Number of occurrences observed */
  occurrences: number;
  /** Tech stack this convention applies to (e.g., 'vue3', 'express', 'all') */
  techStack: string;
  /** When first detected */
  firstSeenAt: number;
  /** When last confirmed (most recent occurrence) */
  lastSeenAt: number;
  /** Whether a human has explicitly confirmed this convention */
  humanConfirmed: boolean;
}

type ConventionCategory =
  | 'naming'        // variable/function/component naming patterns
  | 'structure'     // file/directory structure patterns
  | 'imports'       // import ordering and grouping
  | 'error-handling'// try/catch patterns, error types
  | 'typing'        // TypeScript type patterns
  | 'testing'       // test file naming, assertion patterns
  | 'api'           // API route/response patterns
  | 'database'      // query patterns, migration conventions
  | 'styling'       // CSS/Tailwind patterns
  | 'general';      // catch-all

/**
 * Result of checking code against stored conventions.
 */
interface ConventionCheckResult {
  /** Conventions that the code follows */
  followed: Array<{ convention: DetectedConvention; evidence: string }>;
  /** Conventions that the code violates */
  violated: Array<{ convention: DetectedConvention; violation: string; suggestion: string }>;
  /** Overall conformance score (0.0-1.0) */
  conformanceScore: number;
}
```

#### ConventionExtractor and ConventionMemory

```typescript
/**
 * Extracts coding conventions from generated code using LLM analysis.
 *
 * Operates in two phases:
 * 1. Pattern detection: analyze code for recurring patterns (LLM-based)
 * 2. Convention consolidation: merge similar detections, increase confidence
 *
 * @example
 * ```ts
 * const extractor = new ConventionExtractor({
 *   llm: chatModel,
 *   memoryService,
 *   tenantId: 't1',
 * });
 *
 * // After code generation, extract conventions
 * await extractor.analyzeCode([
 *   { file: 'src/components/UserCard.vue', content: '...' },
 *   { file: 'src/components/ProjectList.vue', content: '...' },
 * ], 'vue3');
 *
 * // Check new code against conventions
 * const result = await extractor.checkConformance(
 *   { file: 'src/components/teamSettings.vue', content: '...' },
 *   'vue3',
 * );
 * // result.violated: [{ convention: naming:components, violation: 'PascalCase expected', ... }]
 * ```
 */
interface ConventionExtractorConfig {
  /** LLM for convention detection and checking */
  llm: BaseChatModel;
  /** Memory service for convention persistence */
  memoryService: MemoryService;
  /** Tenant ID for namespace scoping */
  tenantId: string;
  /** Minimum occurrences before a pattern becomes a convention (default: 2) */
  minOccurrences?: number;
  /** Minimum confidence before a convention is enforced (default: 0.6) */
  minEnforcementConfidence?: number;
}

declare class ConventionExtractor {
  constructor(config: ConventionExtractorConfig);

  /**
   * Analyze code files and extract conventions.
   *
   * Compares detected patterns against existing conventions in memory.
   * New patterns are stored; existing patterns get their confidence
   * and occurrence count updated.
   */
  analyzeCode(
    files: Array<{ file: string; content: string }>,
    techStack: string,
  ): Promise<DetectedConvention[]>;

  /**
   * Check a code file against stored conventions.
   *
   * Returns followed and violated conventions with specific evidence
   * and suggestions for fixing violations.
   */
  checkConformance(
    file: { file: string; content: string },
    techStack: string,
  ): Promise<ConventionCheckResult>;

  /**
   * Get all stored conventions, optionally filtered by category or tech stack.
   */
  getConventions(filter?: {
    category?: ConventionCategory;
    techStack?: string;
    minConfidence?: number;
    humanConfirmedOnly?: boolean;
  }): Promise<DetectedConvention[]>;

  /**
   * Manually confirm or reject a convention.
   * Confirmed conventions get confidence boosted to 1.0.
   * Rejected conventions are soft-deleted (confidence set to 0).
   */
  setHumanVerdict(
    conventionId: string,
    verdict: 'confirmed' | 'rejected',
  ): Promise<void>;

  /**
   * Format conventions as a prompt section for code generation agents.
   *
   * Produces a markdown block listing active conventions with examples,
   * suitable for injection into system prompts.
   */
  formatForPrompt(
    techStack: string,
    maxConventions?: number,
  ): Promise<string>;

  /**
   * Run consolidation: merge similar conventions, prune low-confidence ones.
   * Should be called periodically (e.g., after each generation cycle).
   */
  consolidate(): Promise<{ merged: number; pruned: number }>;
}
```

#### Integration with @dzipagent/codegen

The `ConventionExtractor` integrates with the codegen quality scorer:

```typescript
/**
 * Convention quality dimension for the codegen quality scorer.
 *
 * Scores generated code on conformance to stored conventions.
 * Added as a 7th dimension alongside the existing 6 quality dimensions.
 */
interface ConventionQualityDimension {
  name: 'convention-conformance';
  /** Weight in composite score (suggested: 0.15) */
  weight: number;
  /**
   * Score function: runs ConventionExtractor.checkConformance()
   * and maps the conformanceScore to the 0-1 quality scale.
   */
  score(
    files: Array<{ file: string; content: string }>,
    techStack: string,
  ): Promise<number>;
}
```

---

## 3. Data Models

### 3.1 SharedMemorySpace Storage Schema

Stored in namespace `[tenantId, "__spaces"]` with key = space ID:

```json
{
  "id": "planning-space",
  "name": "Planning Space",
  "owner": "forge://t1/agent/planner",
  "participants": {
    "forge://t1/agent/planner": {
      "agentUri": "forge://t1/agent/planner",
      "permission": "admin",
      "joinedAt": 1711267200000,
      "lastAccessAt": 1711270800000
    },
    "forge://t1/agent/coder": {
      "agentUri": "forge://t1/agent/coder",
      "permission": "read-write",
      "joinedAt": 1711267300000,
      "lastAccessAt": 1711270700000
    }
  },
  "schemaKey": null,
  "retentionPolicy": { "maxAgeMs": null, "maxRecords": 1000, "countExpired": false },
  "conflictResolution": "lww",
  "createdAt": 1711267200000,
  "metadata": { "description": "Shared planning decisions" },
  "text": "SharedMemorySpace: Planning Space (planning-space)"
}
```

### 3.2 Provenance Metadata

Stored inline as `_provenance` on any record:

```json
{
  "text": "Use PostgreSQL for all persistence layers",
  "type": "decision",
  "_provenance": {
    "createdBy": "forge://t1/agent/planner",
    "createdAt": 1711267200000,
    "source": "llm-generated",
    "confidence": 0.85,
    "lineage": [
      "forge://t1/agent/planner",
      "forge://t1/agent/reviewer"
    ],
    "derivedFrom": null,
    "contentHash": "sha256:a1b2c3d4..."
  }
}
```

### 3.3 Causal Relation Storage

Stored in namespace `[tenantId, scopeId, "__causal"]` with key = `{causeKey}--causes-->{effectKey}`:

```json
{
  "cause": "outage-001",
  "causeNamespace": "incidents",
  "effect": "hotfix-002",
  "effectNamespace": "decisions",
  "confidence": 0.9,
  "evidence": "Hotfix deployed in direct response to production outage",
  "createdAt": 1711267200000,
  "createdBy": "forge://t1/agent/planner",
  "text": "outage-001 causes hotfix-002: Hotfix deployed in direct response to production outage"
}
```

### 3.4 Agent File (.af) Format

Complete example:

```json
{
  "$schema": "https://forgeagent.dev/schemas/agent-file-v1.json",
  "version": "1.0.0",
  "exportedAt": "2026-03-24T10:00:00Z",
  "exportedBy": "forge://t1/agent/planner",
  "signature": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "agent": {
    "name": "Planning Agent",
    "uri": "forge://t1/agent/planner",
    "model": { "provider": "anthropic", "model": "claude-sonnet-4-20250514", "temperature": 0.3 },
    "systemPrompt": "You are a planning agent...",
    "tools": ["write_file", "search_memory", "create_task"],
    "capabilities": ["planning", "task-decomposition"],
    "metadata": {}
  },
  "memory": {
    "namespaces": {
      "decisions": [
        {
          "key": "dec-001",
          "value": { "text": "Use PostgreSQL", "type": "decision" },
          "provenance": {
            "createdBy": "forge://t1/agent/planner",
            "createdAt": 1711267200000,
            "source": "llm-generated",
            "confidence": 0.85,
            "lineage": ["forge://t1/agent/planner"]
          },
          "temporal": {
            "systemCreatedAt": 1711267200000,
            "systemExpiredAt": null,
            "validFrom": 1711267200000,
            "validUntil": null
          }
        }
      ],
      "lessons": []
    },
    "workingMemory": { "currentPhase": "implementation", "completedTasks": 5 },
    "causalRelations": []
  },
  "prompts": {
    "templates": { "planning": "Given the following context..." },
    "fragments": {}
  },
  "state": {
    "conversationSummary": "Agent has completed 5 planning tasks...",
    "contextUsage": { "tokens": 45000, "maxTokens": 200000 },
    "custom": {}
  }
}
```

### 3.5 CRDT State Vectors

Stored inline as `_crdt` on shared space records:

```json
{
  "text": "Use PostgreSQL",
  "_crdt": {
    "type": "lww-map",
    "hlc": { "wallMs": 1711267200000, "counter": 3, "nodeId": "forge://t1/agent/planner" },
    "stateVector": {
      "forge://t1/agent/planner": { "wallMs": 1711267200000, "counter": 3, "nodeId": "forge://t1/agent/planner" },
      "forge://t1/agent/coder": { "wallMs": 1711267199000, "counter": 1, "nodeId": "forge://t1/agent/coder" }
    },
    "fieldTimestamps": {
      "text": { "wallMs": 1711267200000, "counter": 3, "nodeId": "forge://t1/agent/planner" },
      "type": { "wallMs": 1711267100000, "counter": 1, "nodeId": "forge://t1/agent/coder" }
    }
  }
}
```

---

## 4. Data Flow Diagrams

### 4.1 Cross-Agent Memory Share Flow

```
Agent A (planner)                  MemorySpaceManager              Agent B (coder)
     |                                     |                            |
     |-- share({mode:'push', ...}) ------->|                            |
     |                                     |-- checkPermission(A, rw) --|
     |                                     |-- injectProvenance(A) -----|
     |                                     |-- resolveConflict(lww) ----|
     |                                     |-- store.put(spaceNS, k, v)|
     |                                     |-- eventBus.emit(          |
     |                                     |     'memory:space:write') |
     |                                     |                            |
     |                                     |-- notify subscribers ----->|
     |                                     |                            |
     |<-- void (success) -----------------|                            |
     |                                     |                    onEvent(write)
     |                                     |                            |
     |                                     |<-- query(spaceId, B) -----|
     |                                     |-- checkPermission(B, r) ---|
     |                                     |-- store.search(spaceNS) ---|
     |                                     |-- results --------------->|
```

### 4.2 Provenance Chain Construction

```
Agent A writes record R1:
  R1._provenance = {
    createdBy: A, lineage: [A], source: 'llm-generated', confidence: 0.7
  }
      |
      v
Agent A shares R1 to SharedSpace S:
  R1._provenance.lineage stays [A]  (no modification, just a copy)
      |
      v
Agent B reads R1 from S, modifies it, writes R2:
  R2._provenance = {
    createdBy: B,
    lineage: [A, B],        <-- A is preserved as originator
    source: 'derived',
    confidence: 0.6,         <-- lower than original (derivative)
    derivedFrom: 'R1'
  }
      |
      v
Agent C reads R2, consolidates with R3, writes R4:
  R4._provenance = {
    createdBy: C,
    lineage: [A, B, C],     <-- full chain preserved
    source: 'consolidated',
    confidence: 0.5,
    derivedFrom: 'R2'
  }
```

### 4.3 Causal Graph Traversal

```
Query: "Why was hotfix-002 deployed?"
Direction: causes (backward traversal)
MaxDepth: 3

Step 1: Start at hotfix-002 (decisions)
         |
         |-- causes? --> outage-001 (incidents) [confidence: 0.9]
                          |
Step 2:                   |-- causes? --> deploy-bad-config (changes) [conf: 0.8]
                                           |
Step 3:                                    |-- causes? --> ticket-789 (tasks) [conf: 0.7]
                                                           |
                                                           (maxDepth reached, stop)

Result:
  root: hotfix-002
  chain: [hotfix-002] <--caused-by-- [outage-001] <--caused-by-- [deploy-bad-config] <--caused-by-- [ticket-789]
  maxDepth: 3
```

### 4.4 Agent File Export/Import Flow

```
EXPORT:
  AgentFileExporter.export(options)
      |
      |-- Read agent config from options
      |-- For each namespace:
      |     |-- memoryService.get(ns, scope)
      |     |-- Serialize records with provenance + temporal metadata
      |-- Serialize workingMemory.get() if present
      |-- Serialize causalGraph relations if present
      |-- Collect prompt templates
      |-- Build AgentFile envelope
      |-- If sign: compute SHA-256 over content sections
      |-- Return AgentFile object
      |
      v
  JSON.stringify(agentFile) --> write to disk as .af file

IMPORT:
  AgentFileImporter.import(file, options)
      |
      |-- Validate file structure and version
      |-- If signature present && verifySignature: verify SHA-256
      |-- For each namespace in file.memory.namespaces:
      |     |-- For each record:
      |     |     |-- Check conflict (key exists?)
      |     |     |-- Apply conflictHandling (skip/overwrite/merge)
      |     |     |-- Inject provenance: source='imported', extend lineage
      |     |     |-- memoryService.put(ns, scope, key, value)
      |-- If causalGraph: import causal relations
      |-- If workingMemory: restore via workingMemory.update()
      |-- Return ImportResult {imported, skipped, failed, warnings}
```

### 4.5 CRDT Merge Operation

```
Agent A writes field "status" = "planning" at HLC(t=100, c=1, node=A)
Agent B writes field "status" = "in-progress" at HLC(t=100, c=1, node=B)
Agent B writes field "priority" = "high" at HLC(t=101, c=0, node=B)

SharedSpace receives both writes:

  Existing record _crdt.fieldTimestamps:
    status: HLC(t=100, c=1, node=A)
    priority: (none)

  Incoming from B:
    status: HLC(t=100, c=1, node=B)
    priority: HLC(t=101, c=0, node=B)

  LWW-Map merge per field:
    status:   compare HLC(t=100,c=1,A) vs HLC(t=100,c=1,B)
              wall equal, counter equal -> nodeId tiebreak: B > A (lexicographic)
              Winner: B's value "in-progress"

    priority: no existing value
              Winner: B's value "high"

  Merged record:
    { status: "in-progress", priority: "high" }
    _crdt.stateVector updated with both A and B HLCs
```

---

## 5. File Structure

### New Files

```
packages/forgeagent-memory/src/
  sharing/
    types.ts                      # ForgeUri, SharedMemorySpace, MemoryParticipant,
                                  #   MemoryShareRequest, SharedMemoryEvent, etc.
    memory-space-manager.ts       # MemorySpaceManager class
    memory-space-manager.test.ts  # Unit tests

  provenance/
    types.ts                      # MemoryProvenance, ProvenanceSource, etc.
    provenance-writer.ts          # ProvenanceWriter class + helper functions
    provenance-writer.test.ts     # Unit tests

  causal/
    types.ts                      # CausalRelation, CausalNode, CausalGraphResult
    causal-graph.ts               # CausalGraph class
    causal-graph.test.ts          # Unit tests

  agent-file/
    types.ts                      # AgentFile, all section interfaces
    exporter.ts                   # AgentFileExporter class
    importer.ts                   # AgentFileImporter class
    agent-file.test.ts            # Round-trip tests

  crdt/
    types.ts                      # HLCTimestamp, LWWRegister, ORSet, LWWMap, StateVector
    hlc.ts                        # Hybrid Logical Clock implementation
    crdt-resolver.ts              # CRDTResolver class
    crdt-resolver.test.ts         # Unit tests

  encryption/
    types.ts                      # EncryptionKeyDescriptor, EncryptedEnvelope, etc.
    encrypted-memory-service.ts   # EncryptedMemoryService class
    env-key-provider.ts           # EnvKeyProvider class
    encryption.test.ts            # Encryption round-trip tests

  multi-modal/
    types.ts                      # MemoryAttachment, AttachmentType, etc.
    multi-modal-memory-service.ts # MultiModalMemoryService class
    multi-modal.test.ts           # Unit tests

  convention/
    types.ts                      # DetectedConvention, ConventionCategory, etc.
    convention-extractor.ts       # ConventionExtractor class
    convention-extractor.test.ts  # Unit tests
```

### Modified Files

```
packages/forgeagent-memory/src/
  memory-service.ts               # Add addNamespace(), hasNamespace(), removeNamespace()
  memory-types.ts                 # Add includeProvenance to FormatOptions
  index.ts                        # Re-export all new modules

packages/forgeagent-memory/src/retrieval/
  adaptive-retriever.ts           # Add optional 'causal' provider and weight
```

### Estimated Total: 24 new files (12 source + 8 test + 4 type modules)

---

## 6. Testing Strategy

### 6.1 Shared Memory Spaces (F1)

| Test Case | Type | Description |
|---|---|---|
| `create-space` | Unit | Create a space, verify it persists in __spaces namespace |
| `join-leave` | Unit | Join a space, verify participant list; leave, verify removal |
| `permission-enforcement` | Unit | Verify read-only participant cannot write; admin can do everything |
| `push-share` | Integration | Agent A pushes record, Agent B reads it from shared space |
| `pull-request-flow` | Integration | Agent creates PR, admin approves, record appears in space |
| `event-emission` | Unit | Verify DzipEventBus receives memory:space:write events |
| `retention-enforcement` | Unit | Add records beyond maxRecords, run enforceRetention, verify pruning |
| `concurrent-join` | Integration | Two agents join simultaneously, both appear in participant list |

### 6.2 Provenance Tracking (F2)

| Test Case | Type | Description |
|---|---|---|
| `auto-inject` | Unit | Write via ProvenanceWriter, verify _provenance is present |
| `lineage-extension` | Unit | Read record from A, modify via B, verify lineage=[A,B] |
| `query-by-creator` | Unit | Write 10 records from 3 agents, query by createdBy, verify filtering |
| `confidence-propagation` | Unit | Derived records have lower confidence than originals |
| `content-hash` | Unit | Write with computeHash:true, verify SHA-256 matches value |
| `format-with-provenance` | Unit | formatForPrompt with includeProvenance:true shows annotations |

### 6.3 Causal Graph (F3)

| Test Case | Type | Description |
|---|---|---|
| `add-relation` | Unit | Add a causal relation, verify it persists |
| `forward-traversal` | Unit | Build A->B->C chain, traverse effects from A, get [B,C] |
| `backward-traversal` | Unit | Build A->B->C chain, traverse causes from C, get [B,A] |
| `depth-limit` | Unit | Build 10-hop chain, traverse with maxDepth=3, verify stops at 3 |
| `confidence-threshold` | Unit | Add relations with varying confidence, verify low-confidence pruned |
| `diamond-pattern` | Unit | A->B, A->C, B->D, C->D: verify no duplicates in traversal |
| `cyclic-graph` | Unit | A->B->C->A: verify traversal terminates (visited set) |
| `retriever-integration` | Integration | Causal provider plugged into AdaptiveRetriever, verify weighted fusion |

### 6.4 Agent File (.af) Round-Trip (F4)

| Test Case | Type | Description |
|---|---|---|
| `export-import-roundtrip` | Integration | Export agent with 3 namespaces, import into fresh store, verify equality |
| `provenance-preserved` | Unit | Export record with provenance, import, verify provenance intact |
| `temporal-preserved` | Unit | Export record with temporal, import, verify temporal intact |
| `conflict-skip` | Unit | Import record with existing key, mode=skip, original preserved |
| `conflict-overwrite` | Unit | Import record with existing key, mode=overwrite, imported wins |
| `conflict-merge` | Unit | Import record with existing key, mode=merge, both exist under different keys |
| `signature-verify` | Unit | Export with sign:true, tamper with content, import with verify:true fails |
| `version-validation` | Unit | Import file with unsupported version, verify error |
| `empty-agent-file` | Unit | Export agent with no memory, import succeeds with 0 records |

### 6.5 CRDT Conflict Resolution (F5)

| Test Case | Type | Description |
|---|---|---|
| `lww-register-merge` | Unit | Two concurrent writes, higher HLC wins |
| `lww-register-tiebreak` | Unit | Equal HLC, nodeId breaks tie deterministically |
| `or-set-add-remove` | Unit | Add element, remove it, re-add: element is present |
| `or-set-concurrent-add-remove` | Unit | A adds, B removes (different tag): element remains |
| `lww-map-field-merge` | Unit | A writes field X, B writes field Y: both fields present |
| `lww-map-same-field` | Unit | A writes field X=1, B writes field X=2: higher HLC wins |
| `hlc-monotonic` | Unit | HLC.now() always returns strictly increasing timestamps |
| `hlc-receive` | Unit | Receive remote HLC ahead of local wall clock, local advances |
| `state-vector-merge` | Unit | Two vectors with different keys, merge contains all |
| `commutativity` | Unit | merge(A,B) === merge(B,A) for all CRDT types |
| `idempotency` | Unit | merge(A,A) === A for all CRDT types |

### 6.6 Encryption (F6)

| Test Case | Type | Description |
|---|---|---|
| `encrypt-decrypt-roundtrip` | Unit | Write to encrypted namespace, read back, values match |
| `non-encrypted-passthrough` | Unit | Write to non-encrypted namespace, no encryption envelope |
| `plaintext-fields` | Unit | Specified fields remain searchable outside encryption |
| `key-rotation` | Integration | Rotate key, verify old records re-encrypted with new key |
| `missing-key` | Unit | Attempt decrypt with missing key, returns error gracefully (non-fatal) |
| `tampered-ciphertext` | Unit | Modify ciphertext, decryption fails with auth tag mismatch |
| `env-key-provider` | Unit | Set env vars, verify keys are loaded correctly |

### 6.7 Multi-Modal Memory (F7)

| Test Case | Type | Description |
|---|---|---|
| `attach-to-record` | Unit | Put record with attachment, verify _attachments array |
| `add-attachment-existing` | Unit | Add attachment to existing record, verify array grows |
| `search-by-description` | Unit | Attach image with description, search by text, find it |
| `remove-attachment` | Unit | Remove attachment by ID, verify it is gone |
| `multiple-attachments` | Unit | Attach 3 items to one record, verify all present |

### 6.8 Convention Memory (F8)

| Test Case | Type | Description |
|---|---|---|
| `extract-naming-convention` | Unit | Feed 5 PascalCase component files, detect naming convention |
| `conformance-pass` | Unit | Check PascalCase file against PascalCase convention: passes |
| `conformance-fail` | Unit | Check camelCase file against PascalCase convention: fails with suggestion |
| `occurrence-tracking` | Unit | Detect same pattern twice, occurrence count increments |
| `human-confirm` | Unit | Confirm convention, confidence becomes 1.0 |
| `human-reject` | Unit | Reject convention, confidence becomes 0 |
| `consolidation` | Unit | Add 3 similar conventions, consolidate merges into 1 |
| `format-for-prompt` | Unit | Format conventions as markdown, verify structure |
| `tech-stack-filter` | Unit | Store vue3 + express conventions, filter by vue3, only vue3 returned |

### Test Infrastructure

All tests use `InMemoryBaseStore` via `createStore({ type: 'memory' })`. No database required for unit/integration tests. LLM-dependent tests (causal extraction, convention extraction) use the `@dzipagent/testing` LLM recorder or mock chat model when available; if not, they are marked as integration tests requiring a real LLM endpoint.

---

## Appendix: Priority and Dependency Summary

```
F2: Provenance (P0, 4h)  ──────────────────────────────┐
                                                         |
F1: Shared Spaces (P0, 12h)  <── depends on F2 ────────┘
    |
    ├── F3: Causal Graph (P1, 8h)  (independent, integrates with F1 optionally)
    |
    ├── F4: Agent File (P1, 8h)  (depends on F2 for provenance export)
    |
    ├── F5: CRDT (P2, 16h)  (plugs into F1 conflictResolution)
    |
    └── F6: Encryption (P1, 6h)  (independent, wraps MemoryService)

F7: Multi-Modal (P2, 8h)  (independent)

F8: Convention (P1, 8h)  (independent, integrates with @dzipagent/codegen)
```

**Recommended implementation order:**

1. F2 (Provenance) -- foundation for all sharing
2. F1 (Shared Spaces) -- core sharing protocol
3. F6 (Encryption) -- security for shared data
4. F8 (Convention) -- immediate value for codegen
5. F3 (Causal Graph) -- advanced retrieval
6. F4 (Agent File) -- portability
7. F5 (CRDT) -- advanced conflict resolution
8. F7 (Multi-Modal) -- extended memory types
