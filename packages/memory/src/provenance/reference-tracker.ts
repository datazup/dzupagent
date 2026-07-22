/**
 * ReferenceTracker — records which memory entries were cited/used by which
 * agent runs, enabling bidirectional queries:
 *
 *   - "What memory informed run X?" → getReferencesForRun(runId)
 *   - "Where has memory Y been used?" → getRunsCitingMemory(entryId)
 *
 * Storage model (when backed by a CacheBackend with sorted-set support):
 *   - Sorted set per run:    {prefix}:run:{runId}     score=timestamp, member=`{entryId}@{ts}`
 *   - Sorted set per entry:  {prefix}:entry:{entryId} score=timestamp, member=`{runId}@{ts}`
 *   - Context value per pair: {prefix}:ctx:{runId}:{entryId}@{ts} → JSON(retrievalContext)
 *
 * The tracker is *fire-and-forget* from the caller's perspective — it exposes
 * `trackReference` as an async method but the memory-service hook invokes it
 * without awaiting, and it swallows its own errors internally. Memory read
 * paths MUST NOT be blocked by reference tracking.
 *
 * Two backends are provided:
 *   - InMemoryReferenceStore: default, zero-config, suitable for tests/dev.
 *   - RedisReferenceStore: accepts a `@dzupagent/cache` CacheBackend. Pass a
 *     RedisCacheBackend (or any other CacheBackend implementation) — the
 *     memory package does not depend on ioredis directly, only on the cache
 *     contract.
 *
 * This module is the thin composition root: the public type surface, the two
 * store backends, and the `deriveMemoryEntryId` helper live in per-concern
 * leaf modules under `./reference-tracker/` and are re-exported here so the
 * `./provenance/reference-tracker.js` import path is unchanged for consumers.
 */

import { InMemoryReferenceStore } from "./reference-tracker/in-memory-store.js";
import type {
  ReferenceQueryOptions,
  ReferenceRecord,
  ReferenceStore,
  RetrievalContext,
} from "./reference-tracker/types.js";

// ---------------------------------------------------------------------------
// Re-exported public surface (types, stores, helpers)
// ---------------------------------------------------------------------------

export type {
  ReferenceQueryOptions,
  ReferenceRecord,
  ReferenceStore,
  RetrievalContext,
} from "./reference-tracker/types.js";
export { InMemoryReferenceStore } from "./reference-tracker/in-memory-store.js";
export {
  RedisReferenceStore,
  type RedisReferenceStoreOptions,
} from "./reference-tracker/redis-store.js";
export { deriveMemoryEntryId } from "./reference-tracker/derive-entry-id.js";

// ---------------------------------------------------------------------------
// ReferenceTracker — public facade
// ---------------------------------------------------------------------------

export interface ReferenceTrackerOptions {
  /** Storage backend (default: InMemoryReferenceStore). */
  store?: ReferenceStore;
  /**
   * Optional clock for deterministic tests. Must return epoch ms.
   * Default: Date.now.
   */
  now?: () => number;
  /**
   * Optional logger for tracker-internal errors. Tracker never throws to
   * callers; logging is best-effort.
   */
  onError?: (operation: string, err: unknown) => void;
}

/**
 * Facade over a ReferenceStore. Provides the three public methods described
 * in the architecture spec: trackReference / getReferencesForRun /
 * getRunsCitingMemory. Safe to invoke from fire-and-forget contexts — all
 * methods swallow errors internally.
 */
export class ReferenceTracker {
  private readonly store: ReferenceStore;
  private readonly now: () => number;
  private readonly onError: (operation: string, err: unknown) => void;

  constructor(options?: ReferenceTrackerOptions) {
    this.store = options?.store ?? new InMemoryReferenceStore();
    this.now = options?.now ?? (() => Date.now());
    this.onError =
      options?.onError ??
      (() => {
        /* swallow */
      });
  }

  /**
   * Record that `runId` cited `entryId`. Never throws.
   */
  async trackReference(
    runId: string,
    entryId: string,
    ctx: RetrievalContext = {}
  ): Promise<void> {
    if (!runId || !entryId) {
      // No-op: empty identifiers are meaningless but must not crash the caller.
      return;
    }
    try {
      await this.store.record({
        runId,
        memoryEntryId: entryId,
        retrievedAt: this.now(),
        retrievalContext: ctx,
      });
    } catch (err) {
      this.onError("trackReference", err);
    }
  }

  /**
   * Record a batch of references for a single run. More efficient than
   * looping on the caller side because backends can parallelize.
   */
  async trackReferences(
    runId: string,
    entries: Array<{ entryId: string; ctx?: RetrievalContext }>
  ): Promise<void> {
    if (!runId || entries.length === 0) return;
    const ts = this.now();
    try {
      await Promise.all(
        entries
          .filter((e) => !!e.entryId)
          .map((e) =>
            this.store.record({
              runId,
              memoryEntryId: e.entryId,
              retrievedAt: ts,
              retrievalContext: e.ctx ?? {},
            })
          )
      );
    } catch (err) {
      this.onError("trackReferences", err);
    }
  }

  /**
   * List memory entries cited by `runId`, most recent first.
   */
  async getReferencesForRun(
    runId: string,
    options?: ReferenceQueryOptions
  ): Promise<ReferenceRecord[]> {
    try {
      return await this.store.listByRun(runId, options);
    } catch (err) {
      this.onError("getReferencesForRun", err);
      return [];
    }
  }

  /**
   * List runs that cited `entryId`, most recent first.
   */
  async getRunsCitingMemory(
    entryId: string,
    options?: ReferenceQueryOptions
  ): Promise<ReferenceRecord[]> {
    try {
      return await this.store.listByEntry(entryId, options);
    } catch (err) {
      this.onError("getRunsCitingMemory", err);
      return [];
    }
  }

  /**
   * Remove all references for a run.
   */
  async clearRun(runId: string): Promise<void> {
    try {
      await this.store.clearRun(runId);
    } catch (err) {
      this.onError("clearRun", err);
    }
  }
}
