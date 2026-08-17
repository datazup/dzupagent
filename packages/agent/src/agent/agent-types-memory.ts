/**
 * Memory-related slices of {@link DzupAgentConfig}.
 *
 * Extracted from the original `agent-types.ts` barrel — see that file for the
 * authoritative re-exports.
 */
import type { FrozenSnapshot } from '@dzupagent/context'
import type { MemoryClient } from '@dzupagent/agent-types'
import type { MemoryService } from '@dzupagent/memory'
import type { MemoryScopeV1 } from '@dzupagent/memory/records'
import type {
  MemoryQueryRewriterPort,
  MemoryRerankerPort,
  MemoryRetrievalProfileV1,
  MemoryRetrieverPort,
} from '@dzupagent/memory/retrieval'
import type { ArrowMemoryConfig } from './arrow-memory-types.js'
import type { MemoryProfile } from './memory-profiles.js'

/** Memory hygiene policy applied by post-run finalizers (MC-02). */
export interface MemoryPolicyConfig {
  /** Set to `false` to disable the {@link MemoryPruner} sweep. */
  pruneFinalizer?: boolean
  /**
   * Cap on namespace size; entries with the lowest decay strength are
   * evicted when the cap is exceeded (default 1000).
   */
  maxEntries?: number
  /**
   * Removes entries older than the TTL before applying the cap
   * (default 7 days). Set to `Infinity` to disable TTL expiry.
   */
  ttlMs?: number
  /**
   * When true, a ConsolidationEngine sweep runs after each write-back,
   * clustering and summarising entries in the agent's namespace.
   * Defaults to false (opt-in) to avoid LLM calls on every run.
   */
  consolidateFinalizer?: boolean
  /**
   * Minimum cluster size for consolidation. Defaults to 3.
   * Clusters with fewer entries are left unchanged.
   */
  consolidateMinCluster?: number
}

/**
 * Per-agent overrides for memory-context-loader budget limits (audit M-08).
 * All fields are optional; omitted fields fall back to the package defaults.
 */
export interface MemoryContextLimitsConfig {
  standardTotalBudget?: number
  standardMaxMemoryFraction?: number
  standardMinResponseReserve?: number
  standardMaxItems?: number
  standardMaxCharsPerItem?: number
  arrowFallbackMaxTokens?: number
}

/**
 * Structural port for the memory service accepted by {@link MemoryConfigSlice.memory}.
 *
 * `MemoryService` is a concrete class holding `private readonly` state, so no
 * object literal can ever satisfy it — every caller wanting a lightweight
 * implementation was forced to write `as unknown as MemoryService`. This port
 * is the exact slice of that class the framework actually calls, derived with
 * `Pick` so a signature here can never drift from the real service.
 *
 * Required members are the ones the framework invokes unguarded:
 * - `get` / `formatForPrompt` — every memory-context load path
 * - `put`                     — post-run write-back (`maybeWriteBackMemory`)
 * - `getKeyed` / `delete`     — the decay sweep (`runMemoryDecay`)
 *
 * Optional members are the ones the framework probes before calling:
 * - `search` / `searchWithStatus` — only reached in `memoryContextMode: 'query'`
 * - `getStore`                    — the pruner / consolidation sweeps skip
 *   silently when a service does not expose a backing store
 *
 * `MemoryService` and `EncryptedMemoryService` remain assignable, so this is a
 * strictly widening change for callers.
 */
export type MemoryServicePort = Pick<
  MemoryService,
  'get' | 'put' | 'getKeyed' | 'delete' | 'formatForPrompt'
> &
  Partial<Pick<MemoryService, 'search' | 'searchWithStatus' | 'getStore'>>

/**
 * Memory wiring slice of {@link DzupAgentConfig}.
 *
 * Covers persistent context: the legacy `memory` service, the
 * ADR-0005 `memoryClient` surface, scope/namespace selection, write-back
 * policy, decay/pruning, frozen snapshots, and Arrow memory budgeting.
 */
export interface MemoryConfigSlice {
  /**
   * Memory service for persistent context.
   *
   * Typed as the structural {@link MemoryServicePort}, not the concrete
   * `MemoryService` class, so any value with the right shape is accepted.
   * A real `MemoryService` instance still satisfies it.
   *
   * @deprecated Prefer `memoryClient` (ADR-0005) for new integrations.
   * The `memory` field continues to work for backwards compatibility and
   * still drives the existing decay / write-back pipeline.
   */
  memory?: MemoryServicePort
  /**
   * MemoryClient for persistent context (ADR-0005).
   *
   * Decoupled from any specific transport. Implementations:
   * - `InMemoryMemoryClient` (`@dzupagent/memory`)  — dev / tests
   * - `IpcMemoryClient`      (`@dzupagent/memory-ipc`) — Arrow IPC
   * - `HttpMemoryClient`     (`@dzupagent/memory`) — future remote
   *
   * Backwards compat: wrap an existing `MemoryService` with
   * `memoryServiceToClient(svc)` from `@dzupagent/memory`.
   */
  memoryClient?: MemoryClient
  /** Memory scope for get/put operations */
  memoryScope?: Record<string, string>
  /** Memory namespace to use */
  memoryNamespace?: string
  /** Namespace (default), query with legacy fallback, or strict lifecycle retrieval. */
  memoryContextMode?: 'namespace' | 'query' | 'lifecycle'
  /** Host-owned scope, clock, profile, and ports for strict lifecycle reads. */
  lifecycleMemoryRetrieval?: {
    readonly scope: MemoryScopeV1
    readonly profile: MemoryRetrievalProfileV1
    readonly retriever: MemoryRetrieverPort
    readonly queryRewriter?: MemoryQueryRewriterPort
    readonly reranker?: MemoryRerankerPort
    readonly asOf: () => string
  }
  /**
   * Character cap on the query derived in `memoryContextMode: 'query'`.
   * Defaults to 512.
   */
  memoryQueryMaxChars?: number
  /**
   * When true (default), the agent's response content is persisted to
   * MemoryService after each successful run. Set to false to disable
   * automatic write-back.
   */
  memoryWriteBack?: boolean
  /**
   * Optional TTL for written-back memory records, in milliseconds.
   *
   * When set, `maybeWriteBackMemory()` stamps each persisted record with an
   * `expiresAt = Date.now() + ttlMs` marker so consumers can filter out
   * stale entries without a separate sweeper. When unset, records never
   * expire.
   */
  ttlMs?: number

  /**
   * Arrow-based memory configuration (optional, enables token budgeting).
   */
  arrowMemory?: ArrowMemoryConfig

  /**
   * Arrow runtime loader (ADR-0005).
   *
   * The agent no longer dynamically imports `@dzupagent/memory-ipc`. When
   * `arrowMemory` or `memoryProfile` is configured, callers MUST inject this
   * loader so the dependency surface is explicit at the call site. Typical
   * value: `() => import('@dzupagent/memory-ipc')`.
   */
  loadArrowRuntime?: () => Promise<unknown>

  /**
   * Memory budget profile preset.
   *
   * - `'minimal'`      — 32 K budget, 10 % memory, 8 K reserve (cost-constrained)
   * - `'balanced'`     — 128 K budget, 30 % memory, 4 K reserve (default)
   * - `'memory-heavy'` — 200 K budget, 50 % memory, 4 K reserve (knowledge-intensive)
   */
  memoryProfile?: MemoryProfile

  /**
   * Optional frozen memory snapshot.
   *
   * When set, the agent's memory context loader uses this pre-built snapshot
   * on subsequent calls instead of reloading from the memory service.
   */
  frozenSnapshot?: FrozenSnapshot

  /**
   * Memory decay pruning threshold (RF-10 / AG-07).
   *
   * After each successful memory write-back, the agent checks whether the
   * namespace exceeds this record count. When it does, weak memories are
   * pruned in a fire-and-forget background sweep.
   *
   * Default: 200. Set to 0 or Infinity to disable automatic pruning.
   */
  memoryDecayThreshold?: number

  /** Memory hygiene policy applied by post-run finalizers (MC-02). */
  memoryPolicy?: MemoryPolicyConfig

  /** Optional per-agent overrides for memory-context-loader budget limits. */
  memoryContextLimits?: MemoryContextLimitsConfig
}
