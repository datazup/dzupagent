/**
 * Generic memory service for LangGraph agents.
 *
 * Wraps a BaseStore with namespace-aware put/get/search operations and
 * a prompt-formatting helper. All operations are non-fatal — errors are
 * swallowed so that memory failures never break the agent pipeline.
 *
 * This file is the coordinator: it owns the `MemoryService` class state
 * (namespace map, capabilities, options) and delegates the actual work
 * to focused sibling modules:
 *
 *   - `memory-service-types`   — public type aliases and option shapes
 *   - `memory-service-store`   — put / get / delete primitives
 *   - `memory-service-search`  — semantic search + decay re-rank + RRF
 *   - `memory-service-prompt`  — prompt-ready formatting
 *
 * Usage:
 *   const svc = new MemoryService(store, [
 *     { name: 'decisions', scopeKeys: ['projectId', 'decisions'], searchable: false },
 *     { name: 'lessons',   scopeKeys: ['tenantId', 'lessons'],   searchable: true },
 *   ])
 *   await svc.put('decisions', { projectId: 'p1' }, 'feat-1', { ... })
 *   const records = await svc.get('decisions', { projectId: 'p1' })
 */
import type { BaseStore } from '@langchain/langgraph'
import type {
  NamespaceConfig,
  FormatOptions,
  SemanticStoreAdapter,
} from './memory-types.js'
import {
  ConsolidationEngine,
  type ConsolidationResult,
  type ConsolidationStore,
} from './consolidation-engine.js'
import {
  getMemoryStoreCapabilities,
  type MemoryStoreCapabilities,
} from './store-capabilities.js'
import type { ReferenceTracker } from './provenance/reference-tracker.js'
import {
  type MemoryEventBus,
  type MemoryPIIResult,
  type MemoryServiceOptions,
  type ReadContext,
} from './memory-service-types.js'
import {
  buildNamespaceTuple,
  deleteMemoryRecord,
  getMemoryRecords,
  getNamespace,
  putMemoryRecord,
} from './memory-service-store.js'
import { searchMemory } from './memory-service-search.js'
import { formatMemoryForPrompt } from './memory-service-prompt.js'

// Re-export public types so existing callers continue to import from
// `./memory-service.js` without code changes.
export type {
  MemoryEventBus,
  MemoryPIIResult,
  MemoryServiceOptions,
  ReadContext,
}

export class MemoryService {
  private readonly nsMap: Map<string, NamespaceConfig>
  private readonly rejectUnsafe: boolean
  private readonly semanticStore: SemanticStoreAdapter | undefined
  private readonly storeCapabilities: MemoryStoreCapabilities
  private readonly referenceTracker: ReferenceTracker | undefined
  private readonly options: MemoryServiceOptions | undefined
  private readonly eventBus: MemoryEventBus | undefined
  private readonly agentId: string | undefined

  constructor(
    private readonly store: BaseStore,
    namespaces: NamespaceConfig[],
    options?: MemoryServiceOptions,
  ) {
    this.nsMap = new Map(namespaces.map(ns => [ns.name, ns]))
    this.rejectUnsafe = options?.rejectUnsafe ?? true
    this.semanticStore = options?.semanticStore
    this.referenceTracker = options?.referenceTracker
    this.storeCapabilities = getMemoryStoreCapabilities(store)
    this.options = options
    this.eventBus = options?.eventBus
    this.agentId = options?.agentId
  }

  // ---------- Write -----------------------------------------------------------

  /**
   * Store a value under [namespace + scope] → key.
   *
   * When `rejectUnsafe` is true (default), values containing prompt-injection,
   * exfiltration commands, or invisible Unicode are silently rejected.
   * Non-fatal: errors are silently caught.
   */
  async put(
    namespace: string,
    scope: Record<string, string>,
    key: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    const ns = getNamespace(this.nsMap, namespace)
    await putMemoryRecord(ns, scope, key, value, {
      store: this.store,
      semanticStore: this.semanticStore,
      rejectUnsafe: this.rejectUnsafe,
      options: this.options,
      eventBus: this.eventBus,
      agentId: this.agentId,
    })
  }

  // ---------- Read ------------------------------------------------------------

  /**
   * Retrieve records from a namespace.
   * If `key` is provided, fetches that single item; otherwise lists all via search.
   * Non-fatal: returns [] on error.
   *
   * When `readContext` is provided and a ReferenceTracker is configured, each
   * returned entry is cited fire-and-forget — the read path is never blocked.
   */
  async get(
    namespace: string,
    scope: Record<string, string>,
    key?: string,
    readContext?: ReadContext,
  ): Promise<Record<string, unknown>[]> {
    const ns = getNamespace(this.nsMap, namespace)
    return getMemoryRecords(ns, scope, key, readContext, {
      store: this.store,
      referenceTracker: this.referenceTracker,
    })
  }

  /**
   * Delete a single record from the backing store.
   *
   * When the backing store does not support deletes, this is a no-op so
   * callers can branch on capabilities and choose a tombstone fallback.
   *
   * Returns `true` when the underlying delete completed without error and
   * `false` when delete is unsupported or the store rejected the operation.
   */
  async delete(
    namespace: string,
    scope: Record<string, string>,
    key: string,
  ): Promise<boolean> {
    const ns = getNamespace(this.nsMap, namespace)
    return deleteMemoryRecord(ns, scope, key, this.store, this.storeCapabilities)
  }

  /**
   * Semantic search within a searchable namespace.
   * Falls back to plain `get()` if the namespace is not marked searchable.
   * Non-fatal: returns [] on error.
   *
   * When `readContext` is provided and a ReferenceTracker is configured, each
   * returned entry is cited fire-and-forget — the search path is never blocked.
   */
  async search(
    namespace: string,
    scope: Record<string, string>,
    query: string,
    limit = 5,
    readContext?: ReadContext,
  ): Promise<Record<string, unknown>[]> {
    const ns = getNamespace(this.nsMap, namespace)
    if (!ns.searchable) {
      return this.get(namespace, scope)
    }
    // Validate scope eagerly so callers get the same "missing key" error
    // surface they had with the inlined implementation.
    buildNamespaceTuple(ns, scope)
    return searchMemory(ns, scope, query, limit, readContext, {
      store: this.store,
      semanticStore: this.semanticStore,
      capabilities: this.storeCapabilities,
      referenceTracker: this.referenceTracker,
    })
  }

  /** Snapshot the capabilities exposed by the backing store. */
  getStoreCapabilities(): MemoryStoreCapabilities {
    return { ...this.storeCapabilities }
  }

  /**
   * Return the underlying `BaseStore`. Exposed so post-run hygiene tasks
   * (consolidation engine, memory pruner) can operate directly on the
   * store without re-wrapping it. Treat as read-only for hygiene
   * pipelines — direct writes bypass sanitization, decay metadata
   * population, and PII redaction.
   */
  getStore(): BaseStore {
    return this.store
  }

  /**
   * Run a best-effort consolidation pass after an agent run completes.
   *
   * This is intentionally non-fatal: callers can invoke it from run-finally
   * hooks without risking the primary agent result. The underlying
   * ConsolidationEngine handles empty/unsupported stores gracefully; this
   * wrapper adds namespace validation and telemetry.
   */
  async consolidateAfterRun(
    runId: string,
    scope: string,
    namespace: string,
  ): Promise<ConsolidationResult> {
    const startedAt = Date.now()

    try {
      getNamespace(this.nsMap, namespace)
      const engine = new ConsolidationEngine(this.options?.consolidation)
      const result = await engine.consolidate(
        scope,
        namespace,
        this.store as unknown as ConsolidationStore,
      )

      this.eventBus?.emit({
        type: 'memory:consolidated',
        agentId: this.agentId ?? 'unknown',
        runId,
        namespace,
        scope,
        summarized: result.summarized,
        summaries: result.summaries,
        durationMs: result.durationMs,
      })

      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.eventBus?.emit({
        type: 'memory:error',
        agentId: this.agentId ?? 'unknown',
        runId,
        namespace,
        scope,
        error: message,
      })
      return {
        summarized: 0,
        summaries: [],
        provenance: {},
        durationMs: Date.now() - startedAt,
      }
    }
  }

  // ---------- Formatting ------------------------------------------------------

  /**
   * Format an array of memory records into a prompt-ready string.
   * Returns '' if records is empty.
   */
  formatForPrompt(
    records: Record<string, unknown>[],
    options?: FormatOptions,
  ): string {
    return formatMemoryForPrompt(records, options)
  }
}
