/**
 * Tests for causal graph wiring in staleness-pruner.ts.
 *
 * Coverage targets:
 *   - pruneStaleMemoriesWithGraph (causal wiring)
 *   - StalenessPruner class (stateful wrapper with causal integration)
 *
 * NOTE: computeStaleness and pruneStaleMemories already have coverage in
 * staleness-pruner.test.ts. CausalGraph methods are covered in
 * causal/__tests__/causal-graph.test.ts.
 * This file tests only the NEW async / wiring surface.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { pruneStaleMemoriesWithGraph, StalenessPruner } from '../staleness-pruner.js'
import type { MemoryEntry } from '../consolidation-types.js'
import type { CausalGraph } from '../causal/causal-graph.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000
const NOW = Date.now()

function entry(key: string, extras?: Partial<MemoryEntry>): MemoryEntry {
  return { key, text: `text for ${key}`, ...extras }
}

/** A stale entry: 60 days old, accessed once → staleness = 60 (above default 30) */
function staleEntry(key: string, extras?: Partial<MemoryEntry>): MemoryEntry {
  return entry(key, {
    createdAt: NOW - 60 * MS_PER_DAY,
    accessCount: 1,
    ...extras,
  })
}

/** A fresh entry: 1 day old, accessed 10 times → staleness = 0.1 (below default 30) */
function freshEntry(key: string, extras?: Partial<MemoryEntry>): MemoryEntry {
  return entry(key, {
    createdAt: NOW - 1 * MS_PER_DAY,
    accessCount: 10,
    ...extras,
  })
}

function makeMockGraph(removeNodeReturnValue = 2): CausalGraph {
  return {
    removeNode: vi.fn().mockResolvedValue(removeNodeReturnValue),
  } as unknown as CausalGraph
}

// ---------------------------------------------------------------------------
// pruneStaleMemoriesWithGraph
// ---------------------------------------------------------------------------

describe('pruneStaleMemoriesWithGraph', () => {
  describe('when no causalGraph is provided', () => {
    it('should behave like pruneStaleMemories and return causalRelationsRemoved === 0', async () => {
      const memories = [staleEntry('old'), freshEntry('new')]
      const result = await pruneStaleMemoriesWithGraph(memories, {
        maxStaleness: 30,
        now: NOW,
      })

      expect(result.prunedCount).toBe(1)
      expect(result.pruned[0]!.key).toBe('old')
      expect(result.kept[0]!.key).toBe('new')
      expect(result.causalRelationsRemoved).toBe(0)
    })

    it('should return causalRelationsRemoved === 0 even when no entries are pruned', async () => {
      const memories = [freshEntry('a'), freshEntry('b')]
      const result = await pruneStaleMemoriesWithGraph(memories, {
        maxStaleness: 30,
        now: NOW,
      })

      expect(result.prunedCount).toBe(0)
      expect(result.causalRelationsRemoved).toBe(0)
    })

    it('should return causalRelationsRemoved === 0 for an empty input', async () => {
      const result = await pruneStaleMemoriesWithGraph([], { now: NOW })
      expect(result.pruned).toHaveLength(0)
      expect(result.kept).toHaveLength(0)
      expect(result.causalRelationsRemoved).toBe(0)
    })
  })

  describe('when causalGraph is provided and nothing is pruned', () => {
    it('should never call removeNode when no entries qualify for pruning', async () => {
      const mockGraph = makeMockGraph(3)
      const memories = [freshEntry('a'), freshEntry('b')]

      const result = await pruneStaleMemoriesWithGraph(memories, {
        maxStaleness: 30,
        now: NOW,
        causalGraph: mockGraph,
        causalNamespace: 'decisions',
      })

      expect(mockGraph.removeNode).not.toHaveBeenCalled()
      expect(result.causalRelationsRemoved).toBe(0)
    })
  })

  describe('when causalGraph is provided and entries are pruned', () => {
    it('should call removeNode once per pruned entry', async () => {
      const mockGraph = makeMockGraph(1)
      const memories = [staleEntry('x'), staleEntry('y'), freshEntry('z')]

      const result = await pruneStaleMemoriesWithGraph(memories, {
        maxStaleness: 30,
        now: NOW,
        causalGraph: mockGraph,
        causalNamespace: 'decisions',
      })

      expect(result.prunedCount).toBe(2)
      expect(mockGraph.removeNode).toHaveBeenCalledTimes(2)
    })

    it('should pass entry.key and causalNamespace to removeNode', async () => {
      const mockGraph = makeMockGraph(0)
      const memories = [staleEntry('mem-key-1')]

      await pruneStaleMemoriesWithGraph(memories, {
        maxStaleness: 30,
        now: NOW,
        causalGraph: mockGraph,
        causalNamespace: 'facts',
      })

      expect(mockGraph.removeNode).toHaveBeenCalledWith('mem-key-1', 'facts')
    })

    it('should sum removeNode return values into causalRelationsRemoved', async () => {
      // removeNode returns 3 for each call; 2 stale entries → 6 total
      const mockGraph = makeMockGraph(3)
      const memories = [staleEntry('a'), staleEntry('b'), freshEntry('c')]

      const result = await pruneStaleMemoriesWithGraph(memories, {
        maxStaleness: 30,
        now: NOW,
        causalGraph: mockGraph,
        causalNamespace: 'ns',
      })

      expect(result.causalRelationsRemoved).toBe(6)
    })

    it('should use empty string as namespace when causalNamespace is not provided', async () => {
      const mockGraph = makeMockGraph(1)
      const memories = [staleEntry('node-a')]

      await pruneStaleMemoriesWithGraph(memories, {
        maxStaleness: 30,
        now: NOW,
        causalGraph: mockGraph,
        // causalNamespace intentionally omitted
      })

      expect(mockGraph.removeNode).toHaveBeenCalledWith('node-a', '')
    })

    it('should call removeNode for each pruned key in order', async () => {
      const mockGraph = makeMockGraph(0)
      // Both are stale; staleness determines sort order but both get pruned
      const memories = [
        staleEntry('first', { createdAt: NOW - 60 * MS_PER_DAY }),
        staleEntry('second', { createdAt: NOW - 80 * MS_PER_DAY }),
      ]

      await pruneStaleMemoriesWithGraph(memories, {
        maxStaleness: 30,
        now: NOW,
        causalGraph: mockGraph,
        causalNamespace: 'test',
      })

      const calledKeys = (mockGraph.removeNode as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0],
      )
      expect(calledKeys).toContain('first')
      expect(calledKeys).toContain('second')
    })

    it('should include both standard pruning fields and causalRelationsRemoved in result', async () => {
      const mockGraph = makeMockGraph(2)
      const memories = [staleEntry('s1'), freshEntry('f1')]

      const result = await pruneStaleMemoriesWithGraph(memories, {
        maxStaleness: 30,
        now: NOW,
        causalGraph: mockGraph,
        causalNamespace: 'ns',
      })

      // Standard fields
      expect(result).toHaveProperty('pruned')
      expect(result).toHaveProperty('kept')
      expect(result).toHaveProperty('prunedCount')
      // Extended field
      expect(result).toHaveProperty('causalRelationsRemoved', 2)
    })
  })

  describe('removeNode returning 0 relations', () => {
    it('should accumulate 0 relations removed when removeNode returns 0', async () => {
      const mockGraph = makeMockGraph(0)
      const memories = [staleEntry('orphan')]

      const result = await pruneStaleMemoriesWithGraph(memories, {
        maxStaleness: 30,
        now: NOW,
        causalGraph: mockGraph,
        causalNamespace: 'lone',
      })

      expect(result.prunedCount).toBe(1)
      expect(result.causalRelationsRemoved).toBe(0)
    })
  })
})

// ---------------------------------------------------------------------------
// StalenessPruner class
// ---------------------------------------------------------------------------

describe('StalenessPruner', () => {
  let mockGraph: CausalGraph

  beforeEach(() => {
    mockGraph = makeMockGraph(2)
  })

  describe('prune — basic delegation', () => {
    it('should return pruned, kept, prunedCount, and causalRelationsRemoved', async () => {
      const pruner = new StalenessPruner({
        maxStaleness: 30,
        causalGraph: mockGraph,
        causalNamespace: 'decisions',
      })

      const memories = [staleEntry('old'), freshEntry('new')]
      const result = await pruner.prune(memories, NOW)

      expect(result.prunedCount).toBe(1)
      expect(result.pruned[0]!.key).toBe('old')
      expect(result.kept[0]!.key).toBe('new')
      expect(result.causalRelationsRemoved).toBe(2)
    })

    it('should call removeNode with correct arguments', async () => {
      const pruner = new StalenessPruner({
        maxStaleness: 30,
        causalGraph: mockGraph,
        causalNamespace: 'facts',
      })

      await pruner.prune([staleEntry('target')], NOW)

      expect(mockGraph.removeNode).toHaveBeenCalledOnce()
      expect(mockGraph.removeNode).toHaveBeenCalledWith('target', 'facts')
    })

    it('should not call removeNode when nothing is pruned', async () => {
      const pruner = new StalenessPruner({
        maxStaleness: 30,
        causalGraph: mockGraph,
        causalNamespace: 'ns',
      })

      await pruner.prune([freshEntry('safe')], NOW)

      expect(mockGraph.removeNode).not.toHaveBeenCalled()
    })
  })

  describe('prune — now override', () => {
    it('should compute staleness relative to the provided now', async () => {
      const pruner = new StalenessPruner({
        maxStaleness: 30,
        causalGraph: mockGraph,
        causalNamespace: 'ns',
      })

      // Entry was created 60 days before the custom now
      const customNow = NOW + 60 * MS_PER_DAY
      const memories = [entry('time-sensitive', { createdAt: NOW, accessCount: 1 })]

      const result = await pruner.prune(memories, customNow)

      // staleness = 60 days / 1 access = 60 > threshold 30 → should be pruned
      expect(result.prunedCount).toBe(1)
      expect(mockGraph.removeNode).toHaveBeenCalledWith('time-sensitive', 'ns')
    })

    it('should NOT prune when entry is fresh relative to the now override', async () => {
      const pruner = new StalenessPruner({
        maxStaleness: 30,
        causalGraph: mockGraph,
        causalNamespace: 'ns',
      })

      // Entry was created just 1 day before the custom now
      const customNow = NOW + 1 * MS_PER_DAY
      const memories = [entry('new-enough', { createdAt: NOW, accessCount: 1 })]

      const result = await pruner.prune(memories, customNow)

      // staleness = 1 day / 1 access = 1 < threshold 30 → kept
      expect(result.prunedCount).toBe(0)
      expect(mockGraph.removeNode).not.toHaveBeenCalled()
    })
  })

  describe('prune — pinned entries', () => {
    it('should never call removeNode for pinned entries', async () => {
      const pruner = new StalenessPruner({
        maxStaleness: 1,
        causalGraph: mockGraph,
        causalNamespace: 'ns',
      })

      const memories = [
        staleEntry('pinned-old', { pinned: true }),
        staleEntry('unpinned-old'),
      ]

      const result = await pruner.prune(memories, NOW)

      // Only unpinned-old should be pruned
      expect(result.prunedCount).toBe(1)
      expect(result.pruned[0]!.key).toBe('unpinned-old')
      expect(result.kept.some(e => e.key === 'pinned-old')).toBe(true)

      // removeNode called only for the unpinned entry
      expect(mockGraph.removeNode).toHaveBeenCalledOnce()
      expect(mockGraph.removeNode).toHaveBeenCalledWith('unpinned-old', 'ns')
    })

    it('should never call removeNode for high-importance entries', async () => {
      const pruner = new StalenessPruner({
        maxStaleness: 1,
        importanceThreshold: 0.8,
        causalGraph: mockGraph,
        causalNamespace: 'ns',
      })

      const memories = [
        staleEntry('important', { importance: 0.9 }),
      ]

      await pruner.prune(memories, NOW)

      expect(mockGraph.removeNode).not.toHaveBeenCalled()
    })
  })

  describe('prune — without causal graph', () => {
    it('should return causalRelationsRemoved === 0 when no causalGraph is configured', async () => {
      const pruner = new StalenessPruner({
        maxStaleness: 30,
        // no causalGraph
      })

      const result = await pruner.prune([staleEntry('s1'), freshEntry('f1')], NOW)

      expect(result.prunedCount).toBe(1)
      expect(result.causalRelationsRemoved).toBe(0)
    })
  })

  describe('prune — maxPruneCount respected', () => {
    it('should only call removeNode up to maxPruneCount times', async () => {
      const pruner = new StalenessPruner({
        maxStaleness: 30,
        maxPruneCount: 1,
        causalGraph: mockGraph,
        causalNamespace: 'ns',
      })

      const memories = [staleEntry('a'), staleEntry('b'), staleEntry('c')]

      const result = await pruner.prune(memories, NOW)

      expect(result.prunedCount).toBe(1)
      expect(mockGraph.removeNode).toHaveBeenCalledOnce()
    })
  })

  describe('prune — empty input', () => {
    it('should handle an empty memories array gracefully', async () => {
      const pruner = new StalenessPruner({
        causalGraph: mockGraph,
        causalNamespace: 'ns',
      })

      const result = await pruner.prune([], NOW)

      expect(result.pruned).toHaveLength(0)
      expect(result.kept).toHaveLength(0)
      expect(result.prunedCount).toBe(0)
      expect(result.causalRelationsRemoved).toBe(0)
      expect(mockGraph.removeNode).not.toHaveBeenCalled()
    })
  })

  describe('prune — causal relations accumulation', () => {
    it('should sum causalRelationsRemoved across multiple pruned entries', async () => {
      // Each removeNode call returns 4
      const graphWith4 = makeMockGraph(4)
      const pruner = new StalenessPruner({
        maxStaleness: 30,
        causalGraph: graphWith4,
        causalNamespace: 'ns',
      })

      // 3 stale entries → 3 removeNode calls → 12 total
      const memories = [staleEntry('a'), staleEntry('b'), staleEntry('c')]
      const result = await pruner.prune(memories, NOW)

      expect(result.prunedCount).toBe(3)
      expect(result.causalRelationsRemoved).toBe(12)
    })
  })
})
