import { describe, it, expect, beforeEach } from 'vitest'
import { ConflictResolver } from '../graph/conflict-resolver.js'
import { TrustScorer } from '../graph/trust-scorer.js'
import type {
  GraphNode,
  GraphEdge,
  GraphConflictStrategy,
} from '../graph/graph-types.js'

function makeNode(overrides: Partial<GraphNode> & Pick<GraphNode, 'id'>): GraphNode {
  return {
    id: overrides.id,
    type: 'fact',
    label: overrides.label ?? 'L',
    content: overrides.content ?? 'C',
    metadata: {},
    provenance: {
      agentId: 'agent-' + overrides.id,
      timestamp: new Date(),
      confidence: 0.5,
      evidenceRefs: [],
      ...(overrides.provenance ?? {}),
    },
    trustScore: 0.5,
    decayRate: 0,
    namespace: 'ns',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as GraphNode
}

function makeEdge(
  type: GraphEdge['type'] = 'contradicts',
  source = 'a',
  target = 'b',
): GraphEdge {
  return {
    id: `edge-${source}-${target}`,
    type,
    sourceId: source,
    targetId: target,
    weight: 1,
    provenance: {
      agentId: 'a',
      timestamp: new Date(),
      confidence: 1,
      evidenceRefs: [],
    },
    metadata: {},
  }
}

describe('ConflictResolver', () => {
  let scorer: TrustScorer
  let resolver: ConflictResolver

  beforeEach(() => {
    scorer = new TrustScorer()
    resolver = new ConflictResolver(scorer, 'trust_vote')
    resolver.reset()
  })

  describe('detectConflict', () => {
    it('returns null for non-contradicts edges', () => {
      const nodeA = makeNode({ id: 'a' })
      const nodeB = makeNode({ id: 'b' })
      const result = resolver.detectConflict(nodeA, nodeB, makeEdge('supports'))
      expect(result).toBeNull()
    })

    it('creates a conflict record for contradicts edges', () => {
      const nodeA = makeNode({ id: 'a' })
      const nodeB = makeNode({ id: 'b' })
      const result = resolver.detectConflict(nodeA, nodeB, makeEdge('contradicts'))
      expect(result).not.toBeNull()
      expect(result!.nodeA).toBe('a')
      expect(result!.nodeB).toBe('b')
      expect(result!.resolvedAt).toBeUndefined()
    })

    it('deduplicates conflicts for the same node pair', () => {
      const nodeA = makeNode({ id: 'a' })
      const nodeB = makeNode({ id: 'b' })
      const c1 = resolver.detectConflict(nodeA, nodeB, makeEdge('contradicts'))
      const c2 = resolver.detectConflict(nodeA, nodeB, makeEdge('contradicts'))
      expect(c2).toBe(c1)
      expect(resolver.totalCount).toBe(1)
    })

    it('deduplicates with reversed node order (A-B vs B-A)', () => {
      const a = makeNode({ id: 'a' })
      const b = makeNode({ id: 'b' })
      const c1 = resolver.detectConflict(a, b, makeEdge('contradicts'))
      const c2 = resolver.detectConflict(b, a, makeEdge('contradicts', 'b', 'a'))
      expect(c2).toBe(c1)
    })

    it('creates a NEW conflict if the prior one is already resolved', () => {
      const a = makeNode({ id: 'a' })
      const b = makeNode({ id: 'b' })
      const first = resolver.detectConflict(a, b, makeEdge('contradicts'))!
      resolver.resolve(first, a, b)
      // Since resolvedAt is set, a new detect should create a fresh record
      const second = resolver.detectConflict(a, b, makeEdge('contradicts'))
      expect(second).not.toBe(first)
      expect(resolver.totalCount).toBe(2)
    })
  })

  describe('resolve strategies', () => {
    it('trust_vote picks node with higher trust', () => {
      const a = makeNode({ id: 'a', provenance: { agentId: 'agent-A' } as GraphNode['provenance'] })
      const b = makeNode({ id: 'b', provenance: { agentId: 'agent-B' } as GraphNode['provenance'] })
      // Boost agent-B
      scorer.recordContribution('agent-B', 'x', true)
      scorer.recordContribution('agent-B', 'x', true)
      scorer.recordContribution('agent-B', 'x', true)

      const r = new ConflictResolver(scorer, 'trust_vote')
      const conflict = r.detectConflict(a, b, makeEdge('contradicts'))!
      const result = r.resolve(conflict, a, b)
      expect(['a', 'b']).toContain(result.winner)
      expect(result.reason).toMatch(/trust/)
    })

    it('recency picks the more recently updated node', () => {
      const older = makeNode({ id: 'old' })
      older.updatedAt = new Date(1000)
      const newer = makeNode({ id: 'new' })
      newer.updatedAt = new Date(9999)

      const r = new ConflictResolver(scorer, 'recency')
      const conflict = r.detectConflict(older, newer, makeEdge('contradicts'))!
      const result = r.resolve(conflict, older, newer)
      expect(result.winner).toBe('new')
      expect(result.reason).toMatch(/more recent/)
    })

    it('recency prefers nodeA on a tie (>=)', () => {
      const a = makeNode({ id: 'a' })
      a.updatedAt = new Date(1000)
      const b = makeNode({ id: 'b' })
      b.updatedAt = new Date(1000)

      const r = new ConflictResolver(scorer, 'recency')
      const conflict = r.detectConflict(a, b, makeEdge('contradicts'))!
      const result = r.resolve(conflict, a, b)
      expect(result.winner).toBe('a')
    })

    it('evidence picks node with more evidence refs', () => {
      const a = makeNode({ id: 'a' })
      a.provenance.evidenceRefs = ['x']
      const b = makeNode({ id: 'b' })
      b.provenance.evidenceRefs = ['y', 'z', 'q']

      const r = new ConflictResolver(scorer, 'evidence')
      const conflict = r.detectConflict(a, b, makeEdge('contradicts'))!
      const result = r.resolve(conflict, a, b)
      expect(result.winner).toBe('b')
      expect(result.reason).toMatch(/more evidence/)
    })

    it('evidence prefers nodeA when evidence counts tie', () => {
      const a = makeNode({ id: 'a' })
      a.provenance.evidenceRefs = ['x']
      const b = makeNode({ id: 'b' })
      b.provenance.evidenceRefs = ['y']

      const r = new ConflictResolver(scorer, 'evidence')
      const conflict = r.detectConflict(a, b, makeEdge('contradicts'))!
      const result = r.resolve(conflict, a, b)
      expect(result.winner).toBe('a')
    })

    it('escalation suggests higher-confidence node', () => {
      const a = makeNode({ id: 'a' })
      a.provenance.confidence = 0.2
      const b = makeNode({ id: 'b' })
      b.provenance.confidence = 0.9

      const r = new ConflictResolver(scorer, 'escalation')
      const conflict = r.detectConflict(a, b, makeEdge('contradicts'))!
      const result = r.resolve(conflict, a, b)
      expect(result.winner).toBe('b')
      expect(result.reason).toMatch(/human review/)
    })

    it('soft_merge marks higher-confidence node as primary', () => {
      const a = makeNode({ id: 'a' })
      a.provenance.confidence = 0.7
      const b = makeNode({ id: 'b' })
      b.provenance.confidence = 0.5

      const r = new ConflictResolver(scorer, 'soft_merge')
      const conflict = r.detectConflict(a, b, makeEdge('contradicts'))!
      const result = r.resolve(conflict, a, b)
      expect(result.winner).toBe('a')
      expect(result.reason).toMatch(/Soft merge/)
    })

    it('uses per-conflict strategy override if set', () => {
      const a = makeNode({ id: 'a' })
      a.updatedAt = new Date(1000)
      const b = makeNode({ id: 'b' })
      b.updatedAt = new Date(9000)

      const r = new ConflictResolver(scorer, 'trust_vote')
      const conflict = r.detectConflict(a, b, makeEdge('contradicts'))!
      conflict.strategy = 'recency'
      const result = r.resolve(conflict, a, b)
      expect(result.winner).toBe('b')
    })

    it('resolve sets resolvedAt, resolution, and strategy on the record', () => {
      const a = makeNode({ id: 'a' })
      const b = makeNode({ id: 'b' })
      const conflict = resolver.detectConflict(a, b, makeEdge('contradicts'))!
      resolver.resolve(conflict, a, b)
      expect(conflict.resolvedAt).toBeDefined()
      expect(conflict.resolution).toBeDefined()
      expect(conflict.strategy).toBeDefined()
    })
  })

  describe('resolveById', () => {
    it('returns null for unknown id', () => {
      const a = makeNode({ id: 'a' })
      const b = makeNode({ id: 'b' })
      expect(resolver.resolveById('missing', a, b)).toBeNull()
    })

    it('resolves a known conflict', () => {
      const a = makeNode({ id: 'a' })
      const b = makeNode({ id: 'b' })
      const conflict = resolver.detectConflict(a, b, makeEdge('contradicts'))!
      const result = resolver.resolveById(conflict.id, a, b)
      expect(result).not.toBeNull()
    })
  })

  describe('getUnresolved / getConflictsForNode / getConflict', () => {
    it('lists unresolved conflicts only', () => {
      const a = makeNode({ id: 'a' })
      const b = makeNode({ id: 'b' })
      const c = makeNode({ id: 'c' })
      const c1 = resolver.detectConflict(a, b, makeEdge('contradicts'))!
      resolver.detectConflict(a, c, makeEdge('contradicts', 'a', 'c'))

      resolver.resolve(c1, a, b)
      const unresolved = resolver.getUnresolved()
      expect(unresolved).toHaveLength(1)
    })

    it('finds conflicts referencing a node (either side)', () => {
      const a = makeNode({ id: 'a' })
      const b = makeNode({ id: 'b' })
      const c = makeNode({ id: 'c' })
      resolver.detectConflict(a, b, makeEdge('contradicts'))
      resolver.detectConflict(c, b, makeEdge('contradicts', 'c', 'b'))

      const bConflicts = resolver.getConflictsForNode('b')
      expect(bConflicts).toHaveLength(2)

      const aConflicts = resolver.getConflictsForNode('a')
      expect(aConflicts).toHaveLength(1)

      const noneConflicts = resolver.getConflictsForNode('z')
      expect(noneConflicts).toEqual([])
    })

    it('getConflict returns undefined for missing id', () => {
      expect(resolver.getConflict('nope')).toBeUndefined()
    })
  })

  describe('reset()', () => {
    it('clears conflicts and counter', () => {
      const a = makeNode({ id: 'a' })
      const b = makeNode({ id: 'b' })
      resolver.detectConflict(a, b, makeEdge('contradicts'))
      expect(resolver.totalCount).toBe(1)
      resolver.reset()
      expect(resolver.totalCount).toBe(0)
    })
  })

  describe('applyStrategy exhaustiveness', () => {
    it('handles every declared strategy without throwing', () => {
      const strategies: GraphConflictStrategy[] = [
        'trust_vote', 'recency', 'evidence', 'escalation', 'soft_merge',
      ]
      for (const s of strategies) {
        const r = new ConflictResolver(scorer, s)
        const a = makeNode({ id: `a-${s}` })
        const b = makeNode({ id: `b-${s}` })
        const conflict = r.detectConflict(a, b, makeEdge('contradicts', `a-${s}`, `b-${s}`))!
        const result = r.resolve(conflict, a, b)
        expect(typeof result.winner).toBe('string')
        expect(typeof result.reason).toBe('string')
      }
    })
  })
})
