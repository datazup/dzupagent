import { describe, it, expect } from 'vitest'
import { pruneStaleMemories, computeStaleness } from '../staleness-pruner.js'
import type { MemoryEntry } from '../consolidation-types.js'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const NOW = Date.now()

function entry(key: string, text: string, extras?: Partial<MemoryEntry>): MemoryEntry {
  return { key, text, ...extras }
}

describe('computeStaleness', () => {
  it('should return 0 for entries without createdAt', () => {
    expect(computeStaleness(entry('a', 'test'), NOW)).toBe(0)
  })

  it('should return 0 for brand-new entries', () => {
    const e = entry('a', 'test', { createdAt: NOW })
    expect(computeStaleness(e, NOW)).toBe(0)
  })

  it('should compute staleness = age_days / access_count', () => {
    const e = entry('a', 'test', {
      createdAt: NOW - 30 * MS_PER_DAY,
      accessCount: 10,
    })
    const staleness = computeStaleness(e, NOW)
    // 30 days / 10 accesses = 3.0
    expect(staleness).toBeCloseTo(3.0, 1)
  })

  it('should treat missing accessCount as 1', () => {
    const e = entry('a', 'test', {
      createdAt: NOW - 10 * MS_PER_DAY,
    })
    const staleness = computeStaleness(e, NOW)
    expect(staleness).toBeCloseTo(10.0, 1)
  })

  it('should use lastAccessedAt as fallback for createdAt', () => {
    const e = entry('a', 'test', {
      lastAccessedAt: NOW - 5 * MS_PER_DAY,
      accessCount: 5,
    })
    const staleness = computeStaleness(e, NOW)
    // 5 days / 5 accesses = 1.0
    expect(staleness).toBeCloseTo(1.0, 1)
  })
})

describe('pruneStaleMemories', () => {
  it('should return empty arrays for empty input', () => {
    const result = pruneStaleMemories([])
    expect(result.pruned).toHaveLength(0)
    expect(result.kept).toHaveLength(0)
    expect(result.prunedCount).toBe(0)
  })

  it('should prune entries above staleness threshold', () => {
    const entries: MemoryEntry[] = [
      entry('old', 'old entry', {
        createdAt: NOW - 60 * MS_PER_DAY,
        accessCount: 1,
      }),
      entry('fresh', 'fresh entry', {
        createdAt: NOW - 1 * MS_PER_DAY,
        accessCount: 10,
      }),
    ]
    const result = pruneStaleMemories(entries, {
      maxStaleness: 30,
      now: NOW,
    })

    // old: 60 days / 1 access = 60 > 30 threshold
    // fresh: 1 day / 10 accesses = 0.1 < 30 threshold
    expect(result.pruned).toHaveLength(1)
    expect(result.pruned[0]!.key).toBe('old')
    expect(result.kept).toHaveLength(1)
    expect(result.kept[0]!.key).toBe('fresh')
  })

  it('should never prune pinned entries', () => {
    const entries: MemoryEntry[] = [
      entry('pinned-old', 'important pinned entry', {
        createdAt: NOW - 365 * MS_PER_DAY,
        accessCount: 1,
        pinned: true,
      }),
    ]
    const result = pruneStaleMemories(entries, {
      maxStaleness: 1,
      now: NOW,
    })

    expect(result.pruned).toHaveLength(0)
    expect(result.kept).toHaveLength(1)
    expect(result.kept[0]!.key).toBe('pinned-old')
  })

  it('should never prune entries with high importance', () => {
    const entries: MemoryEntry[] = [
      entry('important', 'critical entry', {
        createdAt: NOW - 365 * MS_PER_DAY,
        accessCount: 1,
        importance: 0.9,
      }),
    ]
    const result = pruneStaleMemories(entries, {
      maxStaleness: 1,
      importanceThreshold: 0.8,
      now: NOW,
    })

    expect(result.pruned).toHaveLength(0)
    expect(result.kept).toHaveLength(1)
  })

  it('should prune entries exceeding maxAgeDays regardless of access count', () => {
    const entries: MemoryEntry[] = [
      entry('ancient', 'very old but frequently accessed', {
        createdAt: NOW - 100 * MS_PER_DAY,
        accessCount: 1000, // staleness = 100/1000 = 0.1 — below staleness threshold
      }),
    ]
    const result = pruneStaleMemories(entries, {
      maxStaleness: 30,
      maxAgeDays: 90,
      now: NOW,
    })

    // Even though staleness score is low, age exceeds maxAgeDays
    expect(result.pruned).toHaveLength(1)
    expect(result.pruned[0]!.key).toBe('ancient')
  })

  it('should respect maxPruneCount', () => {
    const entries: MemoryEntry[] = [
      entry('a', 'stale a', { createdAt: NOW - 100 * MS_PER_DAY, accessCount: 1 }),
      entry('b', 'stale b', { createdAt: NOW - 80 * MS_PER_DAY, accessCount: 1 }),
      entry('c', 'stale c', { createdAt: NOW - 60 * MS_PER_DAY, accessCount: 1 }),
    ]
    const result = pruneStaleMemories(entries, {
      maxStaleness: 30,
      maxPruneCount: 2,
      now: NOW,
    })

    // All 3 are stale, but we limit to 2
    expect(result.prunedCount).toBe(2)
    expect(result.kept).toHaveLength(1)
  })

  it('should prune stalest entries first when maxPruneCount is limited', () => {
    const entries: MemoryEntry[] = [
      entry('medium', 'medium', { createdAt: NOW - 50 * MS_PER_DAY, accessCount: 1 }),
      entry('ancient', 'ancient', { createdAt: NOW - 200 * MS_PER_DAY, accessCount: 1 }),
      entry('old', 'old', { createdAt: NOW - 80 * MS_PER_DAY, accessCount: 1 }),
    ]
    const result = pruneStaleMemories(entries, {
      maxStaleness: 30,
      maxPruneCount: 2,
      now: NOW,
    })

    expect(result.prunedCount).toBe(2)
    // The two stalest should be pruned (ancient=200, old=80)
    const prunedKeys = result.pruned.map(e => e.key)
    expect(prunedKeys).toContain('ancient')
    expect(prunedKeys).toContain('old')
  })

  it('should keep all entries when none exceed threshold', () => {
    const entries: MemoryEntry[] = [
      entry('a', 'fresh a', { createdAt: NOW - 1 * MS_PER_DAY, accessCount: 5 }),
      entry('b', 'fresh b', { createdAt: NOW - 2 * MS_PER_DAY, accessCount: 10 }),
    ]
    const result = pruneStaleMemories(entries, {
      maxStaleness: 30,
      maxAgeDays: 90,
      now: NOW,
    })

    expect(result.pruned).toHaveLength(0)
    expect(result.kept).toHaveLength(2)
  })

  it('should handle entries without time metadata (staleness = 0)', () => {
    const entries: MemoryEntry[] = [
      entry('no-time', 'no timestamp info'),
    ]
    const result = pruneStaleMemories(entries, {
      maxStaleness: 1,
      now: NOW,
    })

    // Staleness is 0 (no createdAt) — should not be pruned
    expect(result.pruned).toHaveLength(0)
    expect(result.kept).toHaveLength(1)
  })

  it('should use default options when none provided', () => {
    const entries: MemoryEntry[] = [
      entry('a', 'test', { createdAt: NOW - 5 * MS_PER_DAY, accessCount: 1 }),
    ]
    // Should not throw
    const result = pruneStaleMemories(entries)
    expect(result.prunedCount + result.kept.length).toBe(1)
  })
})
