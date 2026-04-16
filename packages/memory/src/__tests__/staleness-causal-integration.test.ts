import { describe, it, expect, vi, beforeEach } from 'vitest'
import { pruneStaleMemories, pruneStaleMemoriesWithGraph, StalenessPruner } from '../staleness-pruner.js'
import { CausalGraph } from '../causal/causal-graph.js'
import type { MemoryEntry } from '../consolidation-types.js'
import type { MemoryService } from '../memory-service.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000
const NOW = Date.now()
const NS = 'decisions'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entry(key: string, text: string, extras?: Partial<MemoryEntry>): MemoryEntry {
  return { key, text, ...extras }
}

type RecordStore = Map<string, Map<string, Record<string, unknown>>>

function createMockMemoryService(): {
  service: MemoryService
  records: RecordStore
} {
  const records: RecordStore = new Map()

  const service = {
    put: vi.fn().mockImplementation(
      (ns: string, scope: Record<string, string>, key: string, value: Record<string, unknown>) => {
        const nsKey = `${ns}:${JSON.stringify(scope)}`
        if (!records.has(nsKey)) records.set(nsKey, new Map())
        records.get(nsKey)!.set(key, value)
        return Promise.resolve()
      },
    ),
    get: vi.fn().mockImplementation(
      (ns: string, scope: Record<string, string>, key?: string) => {
        const nsKey = `${ns}:${JSON.stringify(scope)}`
        const nsRecords = records.get(nsKey)
        if (!nsRecords) return Promise.resolve([])
        if (key) {
          const val = nsRecords.get(key)
          return Promise.resolve(val ? [val] : [])
        }
        return Promise.resolve(Array.from(nsRecords.values()))
      },
    ),
    search: vi.fn().mockResolvedValue([]),
    formatForPrompt: vi.fn().mockReturnValue(''),
  } as unknown as MemoryService

  return { service, records }
}

/** Add a simple causal relation (helper). */
async function addRelation(
  graph: CausalGraph,
  cause: string,
  effect: string,
  confidence = 0.9,
  causeNs = NS,
  effectNs = NS,
): Promise<void> {
  await graph.addRelation({
    cause,
    causeNamespace: causeNs,
    effect,
    effectNamespace: effectNs,
    confidence,
  })
}

// ---------------------------------------------------------------------------
// Integration: StalenessPruner + CausalGraph
// ---------------------------------------------------------------------------

describe('Staleness Pruner + Causal Graph Integration', () => {
  let mock: ReturnType<typeof createMockMemoryService>
  let graph: CausalGraph

  beforeEach(() => {
    mock = createMockMemoryService()
    graph = new CausalGraph(mock.service)
  })

  // ─── CausalGraph.removeNode ──────────────────────────────────────────────

  describe('CausalGraph.removeNode', () => {
    it('removes all relations where node is a cause', async () => {
      await addRelation(graph, 'A', 'B')
      await addRelation(graph, 'A', 'C')

      const removed = await graph.removeNode('A', NS)
      expect(removed).toBe(2)

      const nodeA = await graph.getRelations('A', NS)
      expect(nodeA.effects).toHaveLength(0)
    })

    it('removes all relations where node is an effect', async () => {
      await addRelation(graph, 'B', 'A')
      await addRelation(graph, 'C', 'A')

      const removed = await graph.removeNode('A', NS)
      expect(removed).toBe(2)

      const nodeA = await graph.getRelations('A', NS)
      expect(nodeA.causes).toHaveLength(0)
    })

    it('removes both cause and effect relations', async () => {
      // B -> A -> C
      await addRelation(graph, 'B', 'A')
      await addRelation(graph, 'A', 'C')

      const removed = await graph.removeNode('A', NS)
      expect(removed).toBe(2)

      const nodeA = await graph.getRelations('A', NS)
      expect(nodeA.causes).toHaveLength(0)
      expect(nodeA.effects).toHaveLength(0)
    })

    it('returns 0 for isolated node with no relations', async () => {
      const removed = await graph.removeNode('lonely', NS)
      expect(removed).toBe(0)
    })

    it('does not affect unrelated relations', async () => {
      await addRelation(graph, 'A', 'B')
      await addRelation(graph, 'C', 'D')

      await graph.removeNode('A', NS)

      // C -> D should still exist
      const nodeC = await graph.getRelations('C', NS)
      expect(nodeC.effects).toHaveLength(1)
      expect(nodeC.effects[0]!.effect).toBe('D')
    })

    it('respects namespace when removing', async () => {
      await addRelation(graph, 'A', 'B', 0.9, 'ns1', 'ns1')
      await addRelation(graph, 'A', 'C', 0.9, 'ns2', 'ns2')

      await graph.removeNode('A', 'ns1')

      // ns2 relation should still exist
      const nodeA_ns2 = await graph.getRelations('A', 'ns2')
      expect(nodeA_ns2.effects).toHaveLength(1)
    })

    it('handles cross-namespace relations', async () => {
      await addRelation(graph, 'A', 'B', 0.9, 'ns1', 'ns2')

      const removed = await graph.removeNode('A', 'ns1')
      expect(removed).toBe(1)

      const nodeB = await graph.getRelations('B', 'ns2')
      expect(nodeB.causes).toHaveLength(0)
    })
  })

  // ─── pruneStaleMemoriesWithGraph ─────────────────────────────────────────

  describe('pruneStaleMemoriesWithGraph', () => {
    it('prunes entries and removes their nodes from the causal graph', async () => {
      // A -> B -> C in causal graph; A is stale
      await addRelation(graph, 'A', 'B')
      await addRelation(graph, 'B', 'C')

      const entries: MemoryEntry[] = [
        entry('A', 'stale entry', { createdAt: NOW - 100 * MS_PER_DAY, accessCount: 1 }),
        entry('B', 'fresh entry', { createdAt: NOW - 1 * MS_PER_DAY, accessCount: 10 }),
        entry('C', 'fresh entry', { createdAt: NOW - 2 * MS_PER_DAY, accessCount: 5 }),
      ]

      const result = await pruneStaleMemoriesWithGraph(entries, {
        maxStaleness: 30,
        now: NOW,
        causalGraph: graph,
        causalNamespace: NS,
      })

      expect(result.prunedCount).toBe(1)
      expect(result.pruned[0]!.key).toBe('A')
      expect(result.causalRelationsRemoved).toBe(1) // A->B edge

      // A should have no relations left
      const nodeA = await graph.getRelations('A', NS)
      expect(nodeA.effects).toHaveLength(0)

      // B->C should remain
      const nodeB = await graph.getRelations('B', NS)
      expect(nodeB.effects).toHaveLength(1)
      expect(nodeB.effects[0]!.effect).toBe('C')
    })

    it('works without causalGraph (backward-compatible)', async () => {
      const entries: MemoryEntry[] = [
        entry('old', 'stale', { createdAt: NOW - 100 * MS_PER_DAY, accessCount: 1 }),
        entry('new', 'fresh', { createdAt: NOW - 1 * MS_PER_DAY, accessCount: 10 }),
      ]

      const result = await pruneStaleMemoriesWithGraph(entries, {
        maxStaleness: 30,
        now: NOW,
      })

      expect(result.prunedCount).toBe(1)
      expect(result.causalRelationsRemoved).toBe(0)
    })

    it('returns 0 causal removals when nothing is pruned', async () => {
      await addRelation(graph, 'A', 'B')

      const entries: MemoryEntry[] = [
        entry('A', 'fresh', { createdAt: NOW - 1 * MS_PER_DAY, accessCount: 10 }),
      ]

      const result = await pruneStaleMemoriesWithGraph(entries, {
        maxStaleness: 30,
        now: NOW,
        causalGraph: graph,
        causalNamespace: NS,
      })

      expect(result.prunedCount).toBe(0)
      expect(result.causalRelationsRemoved).toBe(0)

      // Relation should still exist
      const nodeA = await graph.getRelations('A', NS)
      expect(nodeA.effects).toHaveLength(1)
    })

    it('removes multiple pruned nodes from the graph', async () => {
      await addRelation(graph, 'A', 'B')
      await addRelation(graph, 'B', 'C')
      await addRelation(graph, 'C', 'D')

      const entries: MemoryEntry[] = [
        entry('A', 'stale', { createdAt: NOW - 100 * MS_PER_DAY, accessCount: 1 }),
        entry('B', 'stale', { createdAt: NOW - 80 * MS_PER_DAY, accessCount: 1 }),
        entry('C', 'fresh', { createdAt: NOW - 1 * MS_PER_DAY, accessCount: 10 }),
        entry('D', 'fresh', { createdAt: NOW - 2 * MS_PER_DAY, accessCount: 5 }),
      ]

      const result = await pruneStaleMemoriesWithGraph(entries, {
        maxStaleness: 30,
        now: NOW,
        causalGraph: graph,
        causalNamespace: NS,
      })

      expect(result.prunedCount).toBe(2)
      expect(result.causalRelationsRemoved).toBeGreaterThanOrEqual(2)

      // A and B should have no relations
      const nodeA = await graph.getRelations('A', NS)
      expect(nodeA.effects).toHaveLength(0)
      expect(nodeA.causes).toHaveLength(0)

      const nodeB = await graph.getRelations('B', NS)
      expect(nodeB.effects).toHaveLength(0)
      expect(nodeB.causes).toHaveLength(0)
    })

    it('preserves graph for pinned entries that are not pruned', async () => {
      await addRelation(graph, 'A', 'B')

      const entries: MemoryEntry[] = [
        entry('A', 'pinned stale', {
          createdAt: NOW - 365 * MS_PER_DAY,
          accessCount: 1,
          pinned: true,
        }),
      ]

      const result = await pruneStaleMemoriesWithGraph(entries, {
        maxStaleness: 1,
        now: NOW,
        causalGraph: graph,
        causalNamespace: NS,
      })

      expect(result.prunedCount).toBe(0)
      expect(result.causalRelationsRemoved).toBe(0)

      const nodeA = await graph.getRelations('A', NS)
      expect(nodeA.effects).toHaveLength(1)
    })

    it('preserves graph for high-importance entries', async () => {
      await addRelation(graph, 'A', 'B')

      const entries: MemoryEntry[] = [
        entry('A', 'important stale', {
          createdAt: NOW - 365 * MS_PER_DAY,
          accessCount: 1,
          importance: 0.95,
        }),
      ]

      const result = await pruneStaleMemoriesWithGraph(entries, {
        maxStaleness: 1,
        importanceThreshold: 0.8,
        now: NOW,
        causalGraph: graph,
        causalNamespace: NS,
      })

      expect(result.prunedCount).toBe(0)
      expect(result.causalRelationsRemoved).toBe(0)

      const nodeA = await graph.getRelations('A', NS)
      expect(nodeA.effects).toHaveLength(1)
    })

    it('handles pruned entry with no causal relations gracefully', async () => {
      // No relations for 'lonely' in the graph
      const entries: MemoryEntry[] = [
        entry('lonely', 'stale no relations', {
          createdAt: NOW - 100 * MS_PER_DAY,
          accessCount: 1,
        }),
      ]

      const result = await pruneStaleMemoriesWithGraph(entries, {
        maxStaleness: 30,
        now: NOW,
        causalGraph: graph,
        causalNamespace: NS,
      })

      expect(result.prunedCount).toBe(1)
      expect(result.causalRelationsRemoved).toBe(0)
    })

    it('respects maxPruneCount for causal cleanup', async () => {
      await addRelation(graph, 'A', 'X')
      await addRelation(graph, 'B', 'X')
      await addRelation(graph, 'C', 'X')

      const entries: MemoryEntry[] = [
        entry('A', 'stale', { createdAt: NOW - 200 * MS_PER_DAY, accessCount: 1 }),
        entry('B', 'stale', { createdAt: NOW - 100 * MS_PER_DAY, accessCount: 1 }),
        entry('C', 'stale', { createdAt: NOW - 80 * MS_PER_DAY, accessCount: 1 }),
      ]

      const result = await pruneStaleMemoriesWithGraph(entries, {
        maxStaleness: 30,
        maxPruneCount: 2,
        now: NOW,
        causalGraph: graph,
        causalNamespace: NS,
      })

      // Only 2 pruned, so only 2 nodes cleaned from graph
      expect(result.prunedCount).toBe(2)
      expect(result.causalRelationsRemoved).toBe(2)
    })

    it('cleans up diamond pattern edges when central node is pruned', async () => {
      // X -> A, Y -> A, A -> Z
      await addRelation(graph, 'X', 'A')
      await addRelation(graph, 'Y', 'A')
      await addRelation(graph, 'A', 'Z')

      const entries: MemoryEntry[] = [
        entry('A', 'stale central', { createdAt: NOW - 100 * MS_PER_DAY, accessCount: 1 }),
      ]

      const result = await pruneStaleMemoriesWithGraph(entries, {
        maxStaleness: 30,
        now: NOW,
        causalGraph: graph,
        causalNamespace: NS,
      })

      expect(result.prunedCount).toBe(1)
      expect(result.causalRelationsRemoved).toBe(3) // X->A, Y->A, A->Z

      // X and Y should have no outgoing edges to A
      const nodeX = await graph.getRelations('X', NS)
      expect(nodeX.effects).toHaveLength(0)

      const nodeY = await graph.getRelations('Y', NS)
      expect(nodeY.effects).toHaveLength(0)

      // Z should have no incoming edges from A
      const nodeZ = await graph.getRelations('Z', NS)
      expect(nodeZ.causes).toHaveLength(0)
    })

    it('uses empty string as default causalNamespace', async () => {
      await addRelation(graph, 'A', 'B', 0.9, '', '')

      const entries: MemoryEntry[] = [
        entry('A', 'stale', { createdAt: NOW - 100 * MS_PER_DAY, accessCount: 1 }),
      ]

      const result = await pruneStaleMemoriesWithGraph(entries, {
        maxStaleness: 30,
        now: NOW,
        causalGraph: graph,
        // causalNamespace omitted, defaults to ''
      })

      expect(result.prunedCount).toBe(1)
      expect(result.causalRelationsRemoved).toBe(1)
    })
  })

  // ─── StalenessPruner class ───────────────────────────────────────────────

  describe('StalenessPruner class', () => {
    it('prunes and cleans causal graph via prune() method', async () => {
      await addRelation(graph, 'A', 'B')

      const pruner = new StalenessPruner({
        maxStaleness: 30,
        causalGraph: graph,
        causalNamespace: NS,
      })

      const entries: MemoryEntry[] = [
        entry('A', 'stale', { createdAt: NOW - 100 * MS_PER_DAY, accessCount: 1 }),
        entry('B', 'fresh', { createdAt: NOW - 1 * MS_PER_DAY, accessCount: 10 }),
      ]

      const result = await pruner.prune(entries, NOW)
      expect(result.prunedCount).toBe(1)
      expect(result.pruned[0]!.key).toBe('A')
      expect(result.causalRelationsRemoved).toBe(1)
    })

    it('works without causalGraph', async () => {
      const pruner = new StalenessPruner({ maxStaleness: 30 })

      const entries: MemoryEntry[] = [
        entry('A', 'stale', { createdAt: NOW - 100 * MS_PER_DAY, accessCount: 1 }),
      ]

      const result = await pruner.prune(entries, NOW)
      expect(result.prunedCount).toBe(1)
      expect(result.causalRelationsRemoved).toBe(0)
    })

    it('respects all config options', async () => {
      await addRelation(graph, 'A', 'B')
      await addRelation(graph, 'B', 'C')

      const pruner = new StalenessPruner({
        maxStaleness: 30,
        maxAgeDays: 90,
        importanceThreshold: 0.8,
        maxPruneCount: 1,
        causalGraph: graph,
        causalNamespace: NS,
      })

      const entries: MemoryEntry[] = [
        entry('A', 'stalest', { createdAt: NOW - 200 * MS_PER_DAY, accessCount: 1 }),
        entry('B', 'stale', { createdAt: NOW - 100 * MS_PER_DAY, accessCount: 1 }),
      ]

      const result = await pruner.prune(entries, NOW)
      // maxPruneCount=1, so only the stalest (A) is pruned
      expect(result.prunedCount).toBe(1)
      expect(result.pruned[0]!.key).toBe('A')
    })

    it('can be constructed with empty config (all defaults)', async () => {
      const pruner = new StalenessPruner()

      const entries: MemoryEntry[] = [
        entry('A', 'test', { createdAt: NOW - 5 * MS_PER_DAY, accessCount: 1 }),
      ]

      const result = await pruner.prune(entries, NOW)
      expect(result.prunedCount + result.kept.length).toBe(1)
      expect(result.causalRelationsRemoved).toBe(0)
    })

    it('handles repeated prune calls on same graph', async () => {
      await addRelation(graph, 'A', 'B')
      await addRelation(graph, 'B', 'C')

      const pruner = new StalenessPruner({
        maxStaleness: 30,
        causalGraph: graph,
        causalNamespace: NS,
      })

      // First prune: A is stale
      const result1 = await pruner.prune(
        [entry('A', 'stale', { createdAt: NOW - 100 * MS_PER_DAY, accessCount: 1 })],
        NOW,
      )
      expect(result1.prunedCount).toBe(1)
      expect(result1.causalRelationsRemoved).toBe(1) // A->B

      // Second prune: B becomes stale
      const result2 = await pruner.prune(
        [entry('B', 'now stale', { createdAt: NOW - 100 * MS_PER_DAY, accessCount: 1 })],
        NOW,
      )
      expect(result2.prunedCount).toBe(1)
      // B->C should be removed; B's incoming (A->B) was already tombstoned
      expect(result2.causalRelationsRemoved).toBe(1) // B->C
    })
  })

  // ─── Backward compatibility ──────────────────────────────────────────────

  describe('backward compatibility', () => {
    it('sync pruneStaleMemories is unaffected by new options', () => {
      const entries: MemoryEntry[] = [
        entry('A', 'stale', { createdAt: NOW - 100 * MS_PER_DAY, accessCount: 1 }),
        entry('B', 'fresh', { createdAt: NOW - 1 * MS_PER_DAY, accessCount: 10 }),
      ]

      // causalGraph in options is just ignored by the sync version
      const result = pruneStaleMemories(entries, {
        maxStaleness: 30,
        now: NOW,
        causalGraph: graph,
        causalNamespace: NS,
      })

      expect(result.prunedCount).toBe(1)
      expect(result.pruned[0]!.key).toBe('A')
      // No causalRelationsRemoved field on sync result
      expect('causalRelationsRemoved' in result).toBe(false)
    })

    it('pruneStaleMemoriesWithGraph result extends StalenessPruneResult', async () => {
      const entries: MemoryEntry[] = [
        entry('A', 'stale', { createdAt: NOW - 100 * MS_PER_DAY, accessCount: 1 }),
      ]

      const result = await pruneStaleMemoriesWithGraph(entries, {
        maxStaleness: 30,
        now: NOW,
      })

      // Has all fields from StalenessPruneResult
      expect(Array.isArray(result.pruned)).toBe(true)
      expect(Array.isArray(result.kept)).toBe(true)
      expect(typeof result.prunedCount).toBe('number')
      // Plus the new field
      expect(typeof result.causalRelationsRemoved).toBe('number')
    })

    it('empty memories array produces zero causal removals', async () => {
      const result = await pruneStaleMemoriesWithGraph([], {
        causalGraph: graph,
        causalNamespace: NS,
      })

      expect(result.prunedCount).toBe(0)
      expect(result.causalRelationsRemoved).toBe(0)
    })
  })

  // ─── Edge cases ──────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('pruned entry with self-referencing causal relation', async () => {
      // A -> A (self-loop)
      await addRelation(graph, 'A', 'A')

      const entries: MemoryEntry[] = [
        entry('A', 'self-ref stale', { createdAt: NOW - 100 * MS_PER_DAY, accessCount: 1 }),
      ]

      const result = await pruneStaleMemoriesWithGraph(entries, {
        maxStaleness: 30,
        now: NOW,
        causalGraph: graph,
        causalNamespace: NS,
      })

      expect(result.prunedCount).toBe(1)
      // Self-loop appears in both causes and effects, but it is the same relation
      // removeNode will call removeRelation twice for the same key (cause side + effect side)
      // but the second call just re-tombstones an already-tombstoned entry
      expect(result.causalRelationsRemoved).toBe(2)

      const nodeA = await graph.getRelations('A', NS)
      expect(nodeA.causes).toHaveLength(0)
      expect(nodeA.effects).toHaveLength(0)
    })

    it('pruning does not touch causal graph when graph has unrelated entries only', async () => {
      await addRelation(graph, 'X', 'Y')

      const entries: MemoryEntry[] = [
        entry('A', 'stale unrelated', { createdAt: NOW - 100 * MS_PER_DAY, accessCount: 1 }),
      ]

      const result = await pruneStaleMemoriesWithGraph(entries, {
        maxStaleness: 30,
        now: NOW,
        causalGraph: graph,
        causalNamespace: NS,
      })

      expect(result.prunedCount).toBe(1)
      expect(result.causalRelationsRemoved).toBe(0)

      // X -> Y should be untouched
      const nodeX = await graph.getRelations('X', NS)
      expect(nodeX.effects).toHaveLength(1)
    })

    it('handles entries pruned by maxAgeDays with causal cleanup', async () => {
      await addRelation(graph, 'ancient', 'B')

      const entries: MemoryEntry[] = [
        entry('ancient', 'very old frequent access', {
          createdAt: NOW - 100 * MS_PER_DAY,
          accessCount: 1000, // staleness = 0.1, below threshold
        }),
      ]

      const result = await pruneStaleMemoriesWithGraph(entries, {
        maxStaleness: 30,
        maxAgeDays: 90,
        now: NOW,
        causalGraph: graph,
        causalNamespace: NS,
      })

      // Pruned by maxAgeDays, not staleness
      expect(result.prunedCount).toBe(1)
      expect(result.causalRelationsRemoved).toBe(1)
    })

    it('causal graph removal is idempotent (prune same entry twice)', async () => {
      await addRelation(graph, 'A', 'B')

      const entries: MemoryEntry[] = [
        entry('A', 'stale', { createdAt: NOW - 100 * MS_PER_DAY, accessCount: 1 }),
      ]

      const result1 = await pruneStaleMemoriesWithGraph(entries, {
        maxStaleness: 30,
        now: NOW,
        causalGraph: graph,
        causalNamespace: NS,
      })
      expect(result1.causalRelationsRemoved).toBe(1)

      // Prune same entries again -- relation already tombstoned
      const result2 = await pruneStaleMemoriesWithGraph(entries, {
        maxStaleness: 30,
        now: NOW,
        causalGraph: graph,
        causalNamespace: NS,
      })
      // The relation is already tombstoned, so getRelations returns empty
      expect(result2.causalRelationsRemoved).toBe(0)
    })
  })
})
