/**
 * MemoryClient — canonical memory transport contract.
 *
 * Defined in `@dzupagent/agent-types` so it is reachable by every layer
 * (agent framework, adapters, applications) without forcing a runtime
 * dependency on `@dzupagent/memory` or `@dzupagent/memory-ipc`.
 *
 * Implementations live alongside their transport:
 *  - `InMemoryMemoryClient` in `@dzupagent/memory`
 *  - `IpcMemoryClient`      in `@dzupagent/memory-ipc`
 *  - `HttpMemoryClient`     in `@dzupagent/memory` (stub)
 *
 * See `docs/dzupagent/adr/ADR-0005-memory-client-interface.md`.
 */

/**
 * Logical scope of a memory record. Every field except `tenantId` is optional
 * to support coarse → fine-grained scoping without forcing callers to fabricate
 * placeholder ids.
 */
export interface MemoryScope {
  tenantId: string
  workspaceId?: string
  projectId?: string
  taskId?: string
}

/** Optional read filters. All fields are advisory; backends may ignore them. */
export interface MemoryQuery {
  /** Maximum number of records to return. */
  limit?: number
  /** Number of records to skip (pagination). */
  offset?: number
  /** Backend-specific structural filter. */
  filter?: Record<string, unknown>
  /** Free-text search query. Backends without FTS may treat as substring. */
  search?: string
}

/** A single record persisted by a memory backend. */
export interface MemoryRecord {
  id: string
  namespace: string
  scope: MemoryScope
  content: string
  metadata?: Record<string, unknown>
  /** Epoch milliseconds. */
  createdAt: number
  /** Epoch milliseconds. */
  updatedAt: number
}

/** Event delivered to subscribers when a record changes. */
export interface MemoryChangeEvent {
  type: 'created' | 'updated' | 'deleted'
  record: MemoryRecord
}

/** Aggregate statistics across the backing store. */
export interface MemoryStats {
  totalRecords: number
  namespaces: string[]
}

/**
 * Minimal structural shape of `AbortSignal`. Declared inline so that
 * `@dzupagent/agent-types` does not pull in `dom` or `@types/node` libs.
 */
export interface CancellationSignal {
  readonly aborted: boolean
  addEventListener?(type: 'abort', listener: () => void): void
  removeEventListener?(type: 'abort', listener: () => void): void
}

/**
 * Read-side context, conceptually equivalent to a `RequestInit` carrier.
 * Used to thread cancellation through long reads.
 */
export interface ReadContext {
  signal?: CancellationSignal
}

/**
 * Write-side context. Separate from `ReadContext` so future write-only
 * concerns (idempotency keys, tenant overrides) can be added without
 * widening the read surface.
 */
export interface WriteContext {
  signal?: CancellationSignal
}

/**
 * Canonical memory transport.
 *
 * - `get`, `put`, and `delete` are required and define CRUD semantics.
 * - `subscribe` and `stats` are optional capabilities; callers MUST guard
 *   their usage with `if (typeof client.subscribe === 'function')`.
 */
export interface MemoryClient {
  get(
    namespace: string,
    scope: MemoryScope,
    query?: MemoryQuery,
    ctx?: ReadContext,
  ): Promise<MemoryRecord[]>

  put(
    namespace: string,
    scope: MemoryScope,
    record: MemoryRecord,
    ctx?: WriteContext,
  ): Promise<void>

  delete(
    namespace: string,
    scope: MemoryScope,
    recordId: string,
  ): Promise<boolean>

  subscribe?(
    namespace: string,
    scope: MemoryScope,
    listener: (event: MemoryChangeEvent) => void,
  ): () => void

  stats?(): Promise<MemoryStats>
}
