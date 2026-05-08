/**
 * Retention + tombstone-compaction wrappers for {@link MemorySpaceManager}.
 *
 * Thin orchestration around the work in `space-retention.ts`. Returns
 * structured results so the coordinator can keep counter state and
 * emit metric events.
 */
import type { MemoryService } from '../memory-service.js'
import type { SharedMemorySpace, TombstoneCompactionMetrics } from './types.js'
import {
  compactTombstonesForSpace,
  enforceRetentionForSpace,
} from './space-retention.js'

export interface CompactionResult {
  spaceId: string
  tombstonesFound: number
  tombstonesCompacted: number
  tombstonesSkipped: number
  durationMs: number
}

/** Build a fresh, zeroed metrics struct. Used by the coordinator at construction. */
export function emptyTombstoneCompactionMetrics(): TombstoneCompactionMetrics {
  return {
    runs: 0,
    tombstonesFound: 0,
    tombstonesCompacted: 0,
    tombstonesSkipped: 0,
    totalDurationMs: 0,
    lastDurationMs: null,
  }
}

/**
 * Enforce retention on a single space. When the space cannot be loaded,
 * returns `{ pruned: 0 }` to keep the call non-fatal.
 */
export async function enforceRetention(
  memoryService: MemoryService,
  space: SharedMemorySpace | null,
): Promise<{ pruned: number }> {
  if (!space) return { pruned: 0 }
  return enforceRetentionForSpace(memoryService, space)
}

/**
 * Run tombstone compaction on a single space and update the manager-level
 * metrics struct in place. The caller (coordinator) uses the returned
 * result to emit a `tombstones_compacted` event.
 */
export async function compactTombstones(
  memoryService: MemoryService,
  metrics: TombstoneCompactionMetrics,
  space: SharedMemorySpace | null,
  spaceId: string,
  startedAt: number,
): Promise<CompactionResult> {
  if (!space) {
    return {
      spaceId,
      tombstonesFound: 0,
      tombstonesCompacted: 0,
      tombstonesSkipped: 0,
      durationMs: Date.now() - startedAt,
    }
  }

  const result = await compactTombstonesForSpace(memoryService, space, startedAt)

  metrics.runs++
  metrics.tombstonesFound += result.tombstonesFound
  metrics.tombstonesCompacted += result.tombstonesCompacted
  metrics.tombstonesSkipped += result.tombstonesSkipped
  metrics.totalDurationMs += result.durationMs
  metrics.lastDurationMs = result.durationMs

  return result
}
