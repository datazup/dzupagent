/**
 * Retention and tombstone-compaction logic for shared memory spaces.
 *
 * These functions are pure with respect to the manager — they receive the
 * space metadata (already loaded) and the underlying MemoryService, and
 * return structured reports. The manager is responsible for loading the
 * space, threading metrics, and emitting events.
 */

import type { MemoryService } from '../memory-service.js'
import type { SharedMemorySpace } from './types.js'
import {
  extractCreatedAt,
  extractDeletedAt,
  isTombstoneRecord,
  keyFromValue,
  spaceNamespace,
  spaceScope,
} from './space-helpers.js'

export interface EnforceRetentionResult {
  pruned: number
}

export interface CompactTombstonesResult {
  spaceId: string
  tombstonesFound: number
  tombstonesCompacted: number
  tombstonesSkipped: number
  durationMs: number
}

/**
 * Enforce retention policy on a loaded space, pruning records that exceed
 * `maxAgeMs` or `maxRecords`. Pruned entries are written back as tombstones;
 * tombstone reclamation is handled separately by `compactTombstones`.
 *
 * Returns `{ pruned: 0 }` if the space has no retention policy.
 */
export async function enforceRetentionForSpace(
  memoryService: MemoryService,
  space: SharedMemorySpace,
): Promise<EnforceRetentionResult> {
  if (!space.retentionPolicy) {
    return { pruned: 0 }
  }

  const scope = spaceScope(space.id)
  const ns = spaceNamespace(space.id)
  const records = await memoryService.get(ns, scope)

  let pruned = 0
  const now = Date.now()
  const policy = space.retentionPolicy

  // Sort by creation time (newest first) for maxRecords enforcement
  const withTime = records.map((r, i) => {
    const createdAt = extractCreatedAt(r)
    return { record: r, index: i, createdAt }
  })
  withTime.sort((a, b) => b.createdAt - a.createdAt)

  const toPrune = new Set<number>()

  // Prune by age
  if (policy.maxAgeMs != null) {
    for (const item of withTime) {
      if (item.createdAt > 0 && (now - item.createdAt) > policy.maxAgeMs) {
        toPrune.add(item.index)
      }
    }
  }

  // Prune by count (keep newest)
  if (policy.maxRecords != null) {
    for (let i = policy.maxRecords; i < withTime.length; i++) {
      const item = withTime[i]
      if (item) {
        toPrune.add(item.index)
      }
    }
  }

  // Execute pruning by writing tombstone markers in place of the original record.
  for (const idx of toPrune) {
    const record = records[idx]
    if (!record) continue
    const key = keyFromValue(record, idx)
    await memoryService.put(
      ns,
      scope,
      key,
      { _tombstone: true, _deletedAt: new Date().toISOString() },
    )
    pruned++
  }

  return { pruned }
}

/**
 * Compact tombstones for a loaded space when the backing store supports
 * delete. Returns counts and timing for the manager to fold into its
 * metrics snapshot and to emit as an event.
 */
export async function compactTombstonesForSpace(
  memoryService: MemoryService,
  space: SharedMemorySpace,
  startedAt: number,
): Promise<CompactTombstonesResult> {
  const scope = spaceScope(space.id)
  const ns = spaceNamespace(space.id)
  const records = await memoryService.get(ns, scope)
  const tombstones = records
    .map((record, index) => ({ record, index, deletedAt: extractDeletedAt(record) }))
    .filter(item => isTombstoneRecord(item.record))
    .sort((a, b) => a.deletedAt - b.deletedAt)

  const policy = space.retentionPolicy
  const now = Date.now()
  let candidates = tombstones

  if (policy?.maxAgeMs != null) {
    candidates = candidates.filter(item => item.deletedAt > 0 && (now - item.deletedAt) > policy.maxAgeMs!)
  }

  if (policy?.maxRecords != null && candidates.length > policy.maxRecords) {
    candidates = candidates.slice(0, candidates.length - policy.maxRecords)
  }

  const capabilities = memoryService.getStoreCapabilities()
  let compacted = 0
  let skipped = 0

  if (capabilities.supportsDelete) {
    for (const candidate of candidates) {
      const record = records[candidate.index]
      if (!record) continue
      const key = keyFromValue(record, candidate.index)
      const deleted = await memoryService.delete(ns, scope, key)
      if (deleted) {
        compacted++
      } else {
        skipped++
      }
    }
  } else {
    skipped = candidates.length
  }

  return {
    spaceId: space.id,
    tombstonesFound: tombstones.length,
    tombstonesCompacted: compacted,
    tombstonesSkipped: skipped,
    durationMs: Date.now() - startedAt,
  }
}
