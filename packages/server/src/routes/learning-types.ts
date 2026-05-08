import type { MemoryServiceLike } from '@dzupagent/memory-ipc'

export interface LearningRouteConfig {
  memoryService: MemoryServiceLike
  /** Default tenant ID when no auth middleware sets one. */
  defaultTenantId?: string
  /**
   * Minimum pattern confidence accepted by `POST /ingest`. Patterns below this
   * threshold are skipped. Defaults to `0.5`.
   */
  ingestConfidenceThreshold?: number
  /**
   * Default TTL (ms) applied to stored patterns. Persisted as `decay.ttlMs`
   * metadata on each memory item so downstream decay jobs can prune stale
   * entries. Defaults to 30 days.
   */
  ingestDefaultTtlMs?: number
}
