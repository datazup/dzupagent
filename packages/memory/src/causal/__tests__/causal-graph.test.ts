import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CausalGraph } from '../causal-graph.js'
import type { CausalRelation } from '../types.js'
import type { MemoryService } from '../../memory-service.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PutCall {
  ns: string
  scope: Record<string, string>
  key: string
  value: Record<string, unknown>
}

type RecordStore = Map<string, Map<string, Record<string, unknown>>>

function createMockMemoryService(): {
  service: MemoryService
  putCalls: PutCall[]
  records: RecordStore
} {
  const putCalls: PutCall[] = []
  const records: RecordStore = new Map()

  const service = {
    put: vi.fn().mockImplementation(
      (ns: string, scope: Record<string, string>, key: string, value: Record<string, unknown>) => {
        putCalls.push({ ns, scope, key, value })
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

  return { service, putCalls, records }
}

const NS = 'decisions'

// ---------------------------------------------------------------------------
// addRelation
// ---------------------------------------------------------------------------

describe('CausalGraph', () => {
  let mock: ReturnType<typeof createMockMemoryService>
  let graph: CausalGraph

  beforeEach(() => {
    mock = createMockMemoryService()
    graph = new CausalGraph(mock.service)
  })

  describe('addRelation', () => {
    it('persists a relation to the __causal namespace', async () => {
      await graph.addRelation({
        cause: 'A',
        causeNamespace: NS,
        effect: 'B',
        effectNamespace: NS,
        confidence: 0.9,
        evidence: 'A caused B',
      })

      expect(mock.putCalls).toHaveLength(1)
      const call = mock.putCalls[0]!
      expect(call.ns).toBe('__causal')
      expect(call.value['cause']).toBe('A')
      expect(call.value['effect']).toBe('B')
      expect(call.value['confidence']).toBe(0.9)
      expect(call.value['evidence']).toBe('A caused B')
      expect(typeof call.value['createdAt']).toBe('string')
    })

    it('is idempotent: re-adding same cause-effect updates confidence', async () => {
      await graph.addRelation({
        cause: 'A',
        causeNamespace: NS,
        effect: 'B',
        effectNamespace: NS,
        confidence: 0.5,
      })

      await graph.addRelation({
        cause: 'A',
        causeNamespace: NS,
        effect: 'B',
        effectNamespace: NS,
        confidence: 0.9,
      })

      expect(mock.putCalls).toHaveLength(2)
      // Both use the same composite key
      expect(mock.putCalls[0]!.key).toBe(mock.putCalls[1]!.key)
      // The second call overwrites with the new confidence
      expect(mock.putCalls[1]!.value['confidence']).toBe(0.9)
    })

    it('clamps confidence to [0, 1]', async () => {
      await graph.addRelation({
        cause: 'X',
        causeNamespace: NS,
        effect: 'Y',
        effectNamespace: NS,
        confidence: 1.5,
      })

      expect(mock.putCalls[0]!.value['confidence']).toBe(1.0)

      await graph.addRelation({
        cause: 'X',
        causeNamespace: NS,
        effect: 'Z',
        effectNamespace: NS,
        confidence: -0.3,
      })

      expect(mock.putCalls[1]!.value['confidence']).toBe(0)
    })
  })

  // ---------------------------------------------------------------------------
  // removeRelation
  // ---------------------------------------------------------------------------

  describe('removeRelation', () => {
    it('writes a tombstone for the relation', async () => {
      await graph.addRelation({
        cause: 'A',
        causeNamespace: NS,
        effect: 'B',
        effectNamespace: NS,
        confidence: 0.9,
      })

      await graph.removeRelation('A', NS, 'B', NS)

      expect(mock.putCalls).toHaveLength(2)
      const tombstone = mock.putCalls[1]!
      expect(tombstone.value['_deleted']).toBe(true)
    })

    it('removed relation is excluded from getRelations', async () => {
      await graph.addRelation({
        cause: 'A',
        causeNamespace: NS,
        effect: 'B',
        effectNamespace: NS,
        confidence: 0.9,
      })

      await graph.removeRelation('A', NS, 'B', NS)

      const node = await graph.getRelations('A', NS)
      expect(node.effects).toHaveLength(0)
    })
  })

  // ---------------------------------------------------------------------------
  // getRelations
  // ---------------------------------------------------------------------------

  describe('getRelations', () => {
    it('returns causes and effects for a node', async () => {
      // A -> B -> C
      await graph.addRelation({
        cause: 'A',
        causeNamespace: NS,
        effect: 'B',
        effectNamespace: NS,
        confidence: 0.9,
      })
      await graph.addRelation({
        cause: 'B',
        causeNamespace: NS,
        effect: 'C',
        effectNamespace: NS,
        confidence: 0.8,
      })

      const nodeB = await graph.getRelations('B', NS)
      expect(nodeB.key).toBe('B')
      expect(nodeB.namespace).toBe(NS)
      expect(nodeB.causes).toHaveLength(1)
      expect(nodeB.causes[0]!.cause).toBe('A')
      expect(nodeB.effects).toHaveLength(1)
      expect(nodeB.effects[0]!.effect).toBe('C')
    })

    it('returns empty causes/effects for isolated node', async () => {
      const node = await graph.getRelations('lonely', NS)
      expect(node.causes).toHaveLength(0)
      expect(node.effects).toHaveLength(0)
    })
  })

  // ---------------------------------------------------------------------------
  // traverse
  // ---------------------------------------------------------------------------

  describe('traverse', () => {
    it('forward (effects): A->B->C returns B and C', async () => {
      await graph.addRelation({
        cause: 'A', causeNamespace: NS,
        effect: 'B', effectNamespace: NS,
        confidence: 0.9,
      })
      await graph.addRelation({
        cause: 'B', causeNamespace: NS,
        effect: 'C', effectNamespace: NS,
        confidence: 0.8,
      })

      const result = await graph.traverse('A', NS, { direction: 'effects' })
      const nodeKeys = result.nodes.map(n => n.key).sort()
      expect(nodeKeys).toEqual(['B', 'C'])
      expect(result.depth).toBe(2)
      expect(result.root).toEqual({ key: 'A', namespace: NS })
    })

    it('backward (causes): C has causes B, A', async () => {
      await graph.addRelation({
        cause: 'A', causeNamespace: NS,
        effect: 'B', effectNamespace: NS,
        confidence: 0.9,
      })
      await graph.addRelation({
        cause: 'B', causeNamespace: NS,
        effect: 'C', effectNamespace: NS,
        confidence: 0.8,
      })

      const result = await graph.traverse('C', NS, { direction: 'causes' })
      const nodeKeys = result.nodes.map(n => n.key).sort()
      expect(nodeKeys).toEqual(['A', 'B'])
      expect(result.depth).toBe(2)
    })

    it('both directions', async () => {
      // A -> B -> C
      await graph.addRelation({
        cause: 'A', causeNamespace: NS,
        effect: 'B', effectNamespace: NS,
        confidence: 0.9,
      })
      await graph.addRelation({
        cause: 'B', causeNamespace: NS,
        effect: 'C', effectNamespace: NS,
        confidence: 0.8,
      })

      const result = await graph.traverse('B', NS, { direction: 'both' })
      const nodeKeys = result.nodes.map(n => n.key).sort()
      expect(nodeKeys).toEqual(['A', 'C'])
    })

    it('depth limit: maxDepth=1 stops at immediate neighbors', async () => {
      // A -> B -> C -> D
      await graph.addRelation({
        cause: 'A', causeNamespace: NS,
        effect: 'B', effectNamespace: NS,
        confidence: 0.9,
      })
      await graph.addRelation({
        cause: 'B', causeNamespace: NS,
        effect: 'C', effectNamespace: NS,
        confidence: 0.8,
      })
      await graph.addRelation({
        cause: 'C', causeNamespace: NS,
        effect: 'D', effectNamespace: NS,
        confidence: 0.7,
      })

      const result = await graph.traverse('A', NS, {
        direction: 'effects',
        maxDepth: 1,
      })
      const nodeKeys = result.nodes.map(n => n.key)
      expect(nodeKeys).toEqual(['B'])
      expect(result.depth).toBe(1)
    })

    it('confidence threshold: filters low-confidence edges', async () => {
      await graph.addRelation({
        cause: 'A', causeNamespace: NS,
        effect: 'B', effectNamespace: NS,
        confidence: 0.9,
      })
      await graph.addRelation({
        cause: 'A', causeNamespace: NS,
        effect: 'C', effectNamespace: NS,
        confidence: 0.2,
      })

      const result = await graph.traverse('A', NS, {
        direction: 'effects',
        minConfidence: 0.5,
      })
      const nodeKeys = result.nodes.map(n => n.key)
      expect(nodeKeys).toEqual(['B'])
    })

    it('handles cycles: A->B->A does not loop forever', async () => {
      await graph.addRelation({
        cause: 'A', causeNamespace: NS,
        effect: 'B', effectNamespace: NS,
        confidence: 0.9,
      })
      await graph.addRelation({
        cause: 'B', causeNamespace: NS,
        effect: 'A', effectNamespace: NS,
        confidence: 0.8,
      })

      const result = await graph.traverse('A', NS, { direction: 'effects' })
      // Should discover B but not re-visit A
      const nodeKeys = result.nodes.map(n => n.key)
      expect(nodeKeys).toEqual(['B'])
    })

    it('diamond pattern: A->B, A->C, B->D, C->D returns D once', async () => {
      await graph.addRelation({
        cause: 'A', causeNamespace: NS,
        effect: 'B', effectNamespace: NS,
        confidence: 0.9,
      })
      await graph.addRelation({
        cause: 'A', causeNamespace: NS,
        effect: 'C', effectNamespace: NS,
        confidence: 0.9,
      })
      await graph.addRelation({
        cause: 'B', causeNamespace: NS,
        effect: 'D', effectNamespace: NS,
        confidence: 0.8,
      })
      await graph.addRelation({
        cause: 'C', causeNamespace: NS,
        effect: 'D', effectNamespace: NS,
        confidence: 0.8,
      })

      const result = await graph.traverse('A', NS, { direction: 'effects' })
      const nodeKeys = result.nodes.map(n => n.key).sort()
      expect(nodeKeys).toEqual(['B', 'C', 'D'])
      // D should appear exactly once
      expect(result.nodes.filter(n => n.key === 'D')).toHaveLength(1)
    })

    it('returns empty nodes for isolated root', async () => {
      const result = await graph.traverse('lonely', NS, { direction: 'both' })
      expect(result.nodes).toHaveLength(0)
      expect(result.relations).toHaveLength(0)
      expect(result.depth).toBe(0)
    })

    it('works across different namespaces', async () => {
      await graph.addRelation({
        cause: 'A', causeNamespace: 'ns1',
        effect: 'B', effectNamespace: 'ns2',
        confidence: 0.9,
      })

      const result = await graph.traverse('A', 'ns1', { direction: 'effects' })
      expect(result.nodes).toHaveLength(1)
      expect(result.nodes[0]!.key).toBe('B')
      expect(result.nodes[0]!.namespace).toBe('ns2')
    })
  })

  // ---------------------------------------------------------------------------
  // search
  // ---------------------------------------------------------------------------

  describe('search', () => {
    it('returns scored results', async () => {
      await graph.addRelation({
        cause: 'A', causeNamespace: NS,
        effect: 'B', effectNamespace: NS,
        confidence: 0.9,
      })
      await graph.addRelation({
        cause: 'B', causeNamespace: NS,
        effect: 'C', effectNamespace: NS,
        confidence: 0.8,
      })

      const results = await graph.search('A', NS)
      expect(results.length).toBeGreaterThan(0)
      for (const r of results) {
        expect(r.score).toBeGreaterThan(0)
        expect(typeof r.key).toBe('string')
        expect(typeof r.namespace).toBe('string')
      }
    })

    it('closer nodes score higher', async () => {
      // A -> B -> C
      await graph.addRelation({
        cause: 'A', causeNamespace: NS,
        effect: 'B', effectNamespace: NS,
        confidence: 0.9,
      })
      await graph.addRelation({
        cause: 'B', causeNamespace: NS,
        effect: 'C', effectNamespace: NS,
        confidence: 0.9,
      })

      const results = await graph.search('A', NS)
      expect(results.length).toBe(2)
      // B is closer (depth 1), C is farther (depth 2)
      const bResult = results.find(r => r.key === 'B')
      const cResult = results.find(r => r.key === 'C')
      expect(bResult).toBeDefined()
      expect(cResult).toBeDefined()
      expect(bResult!.score).toBeGreaterThan(cResult!.score)
    })

    it('respects limit parameter', async () => {
      await graph.addRelation({
        cause: 'A', causeNamespace: NS,
        effect: 'B', effectNamespace: NS,
        confidence: 0.9,
      })
      await graph.addRelation({
        cause: 'A', causeNamespace: NS,
        effect: 'C', effectNamespace: NS,
        confidence: 0.8,
      })
      await graph.addRelation({
        cause: 'A', causeNamespace: NS,
        effect: 'D', effectNamespace: NS,
        confidence: 0.7,
      })

      const results = await graph.search('A', NS, 2)
      expect(results).toHaveLength(2)
    })

    it('returns empty for isolated node', async () => {
      const results = await graph.search('lonely', NS)
      expect(results).toHaveLength(0)
    })
  })
})
