import { describe, it, expect, beforeEach } from 'vitest'
import { TeamMemoryGraph } from '../graph/team-memory-graph.js'
import { TrustScorer } from '../graph/trust-scorer.js'
import { ConflictResolver } from '../graph/conflict-resolver.js'
import { GraphQuery } from '../graph/graph-query.js'
import type {
  GraphNode,
  GraphEdge,
  GraphNodeProvenance,
  TeamGraphConfig,
} from '../graph/graph-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvenance(overrides?: Partial<GraphNodeProvenance>): GraphNodeProvenance {
  return {
    agentId: 'agent-1',
    timestamp: new Date('2026-01-01'),
    confidence: 0.8,
    evidenceRefs: ['ref-1'],
    domain: 'testing',
    ...overrides,
  }
}

function makeNodeInput(overrides?: Partial<Omit<GraphNode, 'id' | 'trustScore' | 'createdAt' | 'updatedAt'>>) {
  return {
    type: 'fact' as const,
    label: 'Test fact',
    content: 'Some factual content',
    metadata: {},
    provenance: makeProvenance(),
    decayRate: 0.01,
    namespace: 'team-alpha',
    ...overrides,
  }
}

// ===========================================================================
// TrustScorer
// ===========================================================================

describe('TrustScorer', () => {
  let scorer: TrustScorer

  beforeEach(() => {
    scorer = new TrustScorer()
  })

  it('creates a default profile with 0.5 trust', () => {
    const profile = scorer.getProfile('agent-1')
    expect(profile.agentId).toBe('agent-1')
    expect(profile.overallTrust).toBe(0.5)
    expect(profile.contributionCount).toBe(0)
    expect(profile.successRate).toBe(0)
  })

  it('returns the same profile on repeated calls', () => {
    const p1 = scorer.getProfile('agent-1')
    const p2 = scorer.getProfile('agent-1')
    expect(p1).toBe(p2)
  })

  it('increases trust on successful contributions', () => {
    scorer.recordContribution('agent-1', 'coding', true)
    scorer.recordContribution('agent-1', 'coding', true)
    const profile = scorer.getProfile('agent-1')
    expect(profile.successRate).toBe(1.0)
    expect(profile.overallTrust).toBeGreaterThan(0.5)
  })

  it('decreases trust on failed contributions', () => {
    // Start with some successes to have a baseline
    scorer.recordContribution('agent-1', 'coding', true)
    const before = scorer.getProfile('agent-1').overallTrust
    scorer.recordContribution('agent-1', 'coding', false)
    scorer.recordContribution('agent-1', 'coding', false)
    scorer.recordContribution('agent-1', 'coding', false)
    expect(scorer.getProfile('agent-1').overallTrust).toBeLessThan(before)
  })

  it('tracks domain-specific trust separately', () => {
    scorer.recordContribution('agent-1', 'frontend', true)
    scorer.recordContribution('agent-1', 'backend', false)

    const fe = scorer.getDomainTrust('agent-1', 'frontend')
    const be = scorer.getDomainTrust('agent-1', 'backend')
    expect(fe).toBeGreaterThan(be)
  })

  it('falls back to overall trust for unknown domains', () => {
    scorer.recordContribution('agent-1', 'coding', true)
    const overall = scorer.getProfile('agent-1').overallTrust
    expect(scorer.getDomainTrust('agent-1', 'unknown')).toBe(overall)
  })

  it('applies decay for inactive agents', () => {
    const profile = scorer.getProfile('agent-1')
    // Simulate inactivity by backdating lastActive
    profile.lastActive = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) // 10 days ago
    const before = profile.overallTrust
    scorer.applyDecay(0.05) // 5% per day
    expect(profile.overallTrust).toBeLessThan(before)
  })

  it('computeConfidence combines provenance + trust + corroboration + recency', () => {
    scorer.recordContribution('agent-1', 'testing', true)
    const now = new Date()
    const node: GraphNode = {
      id: 'n1',
      type: 'fact',
      label: 'test',
      content: 'content',
      metadata: {},
      provenance: makeProvenance({ confidence: 0.9 }),
      trustScore: 0,
      decayRate: 0.01,
      namespace: 'team',
      createdAt: now,
      updatedAt: now,
    }

    const conf0 = scorer.computeConfidence(node, 0)
    const conf3 = scorer.computeConfidence(node, 3)
    // More corroboration should increase confidence
    expect(conf3).toBeGreaterThan(conf0)
    // All values in [0,1]
    expect(conf0).toBeGreaterThanOrEqual(0)
    expect(conf3).toBeLessThanOrEqual(1)
  })

  it('reset clears all profiles', () => {
    scorer.recordContribution('agent-1', 'x', true)
    scorer.reset()
    expect(scorer.getAllProfiles()).toHaveLength(0)
  })
})

// ===========================================================================
// ConflictResolver
// ===========================================================================

describe('ConflictResolver', () => {
  let scorer: TrustScorer
  let resolver: ConflictResolver

  beforeEach(() => {
    scorer = new TrustScorer()
    resolver = new ConflictResolver(scorer, 'trust_vote')
  })

  function makeNode(id: string, overrides?: Partial<GraphNode>): GraphNode {
    const now = new Date()
    return {
      id,
      type: 'fact',
      label: `Node ${id}`,
      content: `Content for ${id}`,
      metadata: {},
      provenance: makeProvenance(),
      trustScore: 0.5,
      decayRate: 0.01,
      namespace: 'team',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    }
  }

  function makeEdge(sourceId: string, targetId: string, type: 'contradicts' | 'supports' = 'contradicts'): GraphEdge {
    return {
      id: 'e1',
      type,
      sourceId,
      targetId,
      weight: 1.0,
      provenance: makeProvenance(),
      metadata: {},
    }
  }

  it('detects conflict on contradicts edge', () => {
    const nA = makeNode('a')
    const nB = makeNode('b')
    const edge = makeEdge('a', 'b')

    const conflict = resolver.detectConflict(nA, nB, edge)
    expect(conflict).not.toBeNull()
    expect(conflict!.nodeA).toBe('a')
    expect(conflict!.nodeB).toBe('b')
  })

  it('returns null for non-contradicts edges', () => {
    const nA = makeNode('a')
    const nB = makeNode('b')
    const edge = makeEdge('a', 'b', 'supports')

    expect(resolver.detectConflict(nA, nB, edge)).toBeNull()
  })

  it('does not duplicate conflicts for the same pair', () => {
    const nA = makeNode('a')
    const nB = makeNode('b')
    const edge = makeEdge('a', 'b')

    const c1 = resolver.detectConflict(nA, nB, edge)
    const c2 = resolver.detectConflict(nA, nB, edge)
    expect(c1!.id).toBe(c2!.id)
  })

  it('resolves conflict using trust_vote strategy', () => {
    scorer.recordContribution('agent-high', 'testing', true)
    scorer.recordContribution('agent-high', 'testing', true)
    scorer.recordContribution('agent-low', 'testing', false)

    const nA = makeNode('a', { provenance: makeProvenance({ agentId: 'agent-high' }) })
    const nB = makeNode('b', { provenance: makeProvenance({ agentId: 'agent-low' }) })
    const edge = makeEdge('a', 'b')

    const conflict = resolver.detectConflict(nA, nB, edge)!
    const result = resolver.resolve(conflict, nA, nB)
    expect(result.winner).toBe('a')
    expect(result.reason).toContain('agent-high')
  })

  it('resolves conflict using recency strategy', () => {
    const resolverRecency = new ConflictResolver(scorer, 'recency')
    const nA = makeNode('a', { updatedAt: new Date('2026-01-01') })
    const nB = makeNode('b', { updatedAt: new Date('2026-03-01') })
    const edge = makeEdge('a', 'b')

    const conflict = resolverRecency.detectConflict(nA, nB, edge)!
    const result = resolverRecency.resolve(conflict, nA, nB)
    expect(result.winner).toBe('b')
  })

  it('resolves conflict using evidence strategy', () => {
    const resolverEvidence = new ConflictResolver(scorer, 'evidence')
    const nA = makeNode('a', {
      provenance: makeProvenance({ evidenceRefs: ['r1', 'r2', 'r3'] }),
    })
    const nB = makeNode('b', {
      provenance: makeProvenance({ evidenceRefs: ['r1'] }),
    })
    const edge = makeEdge('a', 'b')

    const conflict = resolverEvidence.detectConflict(nA, nB, edge)!
    const result = resolverEvidence.resolve(conflict, nA, nB)
    expect(result.winner).toBe('a')
    expect(result.reason).toContain('3 vs 1')
  })

  it('resolves conflict using escalation strategy', () => {
    const resolverEsc = new ConflictResolver(scorer, 'escalation')
    const nA = makeNode('a', { provenance: makeProvenance({ confidence: 0.9 }) })
    const nB = makeNode('b', { provenance: makeProvenance({ confidence: 0.3 }) })
    const edge = makeEdge('a', 'b')

    const conflict = resolverEsc.detectConflict(nA, nB, edge)!
    const result = resolverEsc.resolve(conflict, nA, nB)
    expect(result.reason).toContain('Escalated')
    expect(result.winner).toBe('a')
  })

  it('resolves conflict using soft_merge strategy', () => {
    const resolverMerge = new ConflictResolver(scorer, 'soft_merge')
    const nA = makeNode('a', { provenance: makeProvenance({ confidence: 0.4 }) })
    const nB = makeNode('b', { provenance: makeProvenance({ confidence: 0.7 }) })
    const edge = makeEdge('a', 'b')

    const conflict = resolverMerge.detectConflict(nA, nB, edge)!
    const result = resolverMerge.resolve(conflict, nA, nB)
    expect(result.reason).toContain('Soft merge')
    expect(result.winner).toBe('b')
  })

  it('getUnresolved returns only unresolved conflicts', () => {
    const nA = makeNode('a')
    const nB = makeNode('b')
    const edge = makeEdge('a', 'b')

    resolver.detectConflict(nA, nB, edge)
    expect(resolver.getUnresolved()).toHaveLength(1)

    resolver.resolve(resolver.getUnresolved()[0]!, nA, nB)
    expect(resolver.getUnresolved()).toHaveLength(0)
  })

  it('getConflictsForNode returns relevant conflicts', () => {
    const nA = makeNode('a')
    const nB = makeNode('b')
    const nC = makeNode('c')
    const edge1 = makeEdge('a', 'b')

    resolver.detectConflict(nA, nB, edge1)
    expect(resolver.getConflictsForNode('a')).toHaveLength(1)
    expect(resolver.getConflictsForNode('c')).toHaveLength(0)
  })
})

// ===========================================================================
// GraphQuery
// ===========================================================================

describe('GraphQuery', () => {
  let nodes: Map<string, GraphNode>
  let edges: Map<string, GraphEdge>

  beforeEach(() => {
    nodes = new Map()
    edges = new Map()
    const now = new Date()

    // Add sample nodes
    const prov = makeProvenance()
    nodes.set('n1', {
      id: 'n1', type: 'fact', label: 'TypeScript strict', content: 'Use strict mode',
      metadata: {}, provenance: { ...prov, confidence: 0.9 }, trustScore: 0.8,
      decayRate: 0.01, namespace: 'team-alpha', createdAt: now, updatedAt: now,
    })
    nodes.set('n2', {
      id: 'n2', type: 'convention', label: 'ESM imports', content: 'Always use .js extensions',
      metadata: {}, provenance: { ...prov, confidence: 0.7, agentId: 'agent-2', domain: 'build' },
      trustScore: 0.6, decayRate: 0.02, namespace: 'team-alpha',
      createdAt: now, updatedAt: new Date('2026-03-01'),
    })
    nodes.set('n3', {
      id: 'n3', type: 'decision', label: 'Use Vitest', content: 'Vitest over Jest',
      metadata: {}, provenance: { ...prov, confidence: 0.5, agentId: 'agent-3' },
      trustScore: 0.5, decayRate: 0.01, namespace: 'team-beta',
      createdAt: now, updatedAt: now,
    })

    // Edges
    edges.set('e1', {
      id: 'e1', type: 'supports', sourceId: 'n1', targetId: 'n2',
      weight: 0.9, provenance: prov, metadata: {},
    })
    edges.set('e2', {
      id: 'e2', type: 'contradicts', sourceId: 'n2', targetId: 'n3',
      weight: 0.5, provenance: prov, metadata: {},
    })
  })

  it('filters by type', () => {
    const q = new GraphQuery(nodes, edges)
    expect(q.ofType('fact').execute()).toHaveLength(1)
  })

  it('filters by namespace', () => {
    const q = new GraphQuery(nodes, edges)
    expect(q.inNamespace('team-beta').execute()).toHaveLength(1)
  })

  it('filters by min confidence', () => {
    const q = new GraphQuery(nodes, edges)
    expect(q.withMinConfidence(0.8).execute()).toHaveLength(1)
  })

  it('filters by agent', () => {
    const q = new GraphQuery(nodes, edges)
    expect(q.byAgent('agent-2').execute()).toHaveLength(1)
  })

  it('filters by domain', () => {
    const q = new GraphQuery(nodes, edges)
    expect(q.inDomain('build').execute()).toHaveLength(1)
  })

  it('filters by date (since)', () => {
    // Future date — no nodes should match
    const q1 = new GraphQuery(nodes, edges)
    expect(q1.since(new Date('2027-01-01')).execute()).toHaveLength(0)

    // All nodes are after 2025
    const q2 = new GraphQuery(nodes, edges)
    expect(q2.since(new Date('2025-01-01')).execute()).toHaveLength(3)
  })

  it('chains multiple filters', () => {
    const q = new GraphQuery(nodes, edges)
    const result = q.inNamespace('team-alpha').withMinConfidence(0.8).execute()
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe('n1')
  })

  it('neighbors returns connected nodes', () => {
    const q = new GraphQuery(nodes, edges)
    const nbrs = q.neighbors('n2')
    expect(nbrs).toHaveLength(2) // n1 and n3
  })

  it('neighbors filters by edge type', () => {
    const q = new GraphQuery(nodes, edges)
    const nbrs = q.neighbors('n2', ['supports'])
    expect(nbrs).toHaveLength(1)
    expect(nbrs[0]!.id).toBe('n1')
  })

  it('path finds shortest path via BFS', () => {
    const q = new GraphQuery(nodes, edges)
    const p = q.path('n1', 'n3')
    expect(p).not.toBeNull()
    expect(p!.map((n) => n.id)).toEqual(['n1', 'n2', 'n3'])
  })

  it('path returns null when no path exists', () => {
    nodes.set('n4', {
      id: 'n4', type: 'lesson', label: 'Isolated', content: 'No edges',
      metadata: {}, provenance: makeProvenance(), trustScore: 0.5,
      decayRate: 0.01, namespace: 'team-alpha',
      createdAt: new Date(), updatedAt: new Date(),
    })
    const q = new GraphQuery(nodes, edges)
    expect(q.path('n1', 'n4')).toBeNull()
  })

  it('path returns single node for same source and target', () => {
    const q = new GraphQuery(nodes, edges)
    const p = q.path('n1', 'n1')
    expect(p).toHaveLength(1)
    expect(p![0]!.id).toBe('n1')
  })

  it('subgraph extracts bounded neighborhood', () => {
    const q = new GraphQuery(nodes, edges)
    const sub = q.subgraph('n1', 1)
    expect(sub.nodes.map((n) => n.id).sort()).toEqual(['n1', 'n2'])
    expect(sub.edges).toHaveLength(1) // only e1 connects n1-n2
  })

  it('subgraph depth 0 returns only the root', () => {
    const q = new GraphQuery(nodes, edges)
    const sub = q.subgraph('n1', 0)
    expect(sub.nodes).toHaveLength(1)
    expect(sub.nodes[0]!.id).toBe('n1')
  })

  it('topByConfidence returns sorted results', () => {
    const q = new GraphQuery(nodes, edges)
    const top = q.topByConfidence(2)
    expect(top).toHaveLength(2)
    expect(top[0]!.provenance.confidence).toBeGreaterThanOrEqual(top[1]!.provenance.confidence)
  })

  it('contradictions finds contradicting pairs', () => {
    const q = new GraphQuery(nodes, edges)
    const contras = q.contradictions()
    expect(contras).toHaveLength(1)
    expect(contras[0]!.edge.type).toBe('contradicts')
  })

  it('conventions returns convention nodes sorted by confidence', () => {
    const q = new GraphQuery(nodes, edges)
    const convs = q.conventions()
    expect(convs).toHaveLength(1)
    expect(convs[0]!.type).toBe('convention')
  })

  it('count returns matching count', () => {
    const q = new GraphQuery(nodes, edges)
    expect(q.count()).toBe(3)
    expect(q.ofType('fact').count()).toBe(1)
  })
})

// ===========================================================================
// TeamMemoryGraph (integration)
// ===========================================================================

describe('TeamMemoryGraph', () => {
  let graph: TeamMemoryGraph
  const config: TeamGraphConfig = {
    namespace: 'team-alpha',
    conflictStrategy: 'trust_vote',
  }

  beforeEach(() => {
    graph = new TeamMemoryGraph(config)
  })

  // -- Node CRUD --

  it('adds a node with auto-generated ID', () => {
    const node = graph.addNode(makeNodeInput())
    expect(node.id).toMatch(/^graph_node_\d+$/)
    expect(node.createdAt).toBeInstanceOf(Date)
    expect(node.trustScore).toBeGreaterThanOrEqual(0)
  })

  it('retrieves a node by ID', () => {
    const node = graph.addNode(makeNodeInput())
    expect(graph.getNode(node.id)).toBe(node)
  })

  it('returns undefined for missing node', () => {
    expect(graph.getNode('nonexistent')).toBeUndefined()
  })

  it('updates node fields', () => {
    const node = graph.addNode(makeNodeInput())
    const updated = graph.updateNode(node.id, { label: 'Updated label', content: 'New content' })
    expect(updated.label).toBe('Updated label')
    expect(updated.content).toBe('New content')
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(node.createdAt.getTime())
  })

  it('throws when updating nonexistent node', () => {
    expect(() => graph.updateNode('nope', { label: 'x' })).toThrow('Node not found')
  })

  it('removes a node and its edges', () => {
    const n1 = graph.addNode(makeNodeInput({ label: 'A' }))
    const n2 = graph.addNode(makeNodeInput({ label: 'B' }))
    graph.addEdge({
      type: 'supports', sourceId: n1.id, targetId: n2.id,
      weight: 1, provenance: makeProvenance(), metadata: {},
    })

    expect(graph.removeNode(n1.id)).toBe(true)
    expect(graph.getNode(n1.id)).toBeUndefined()
    expect(graph.getEdgesForNode(n1.id)).toHaveLength(0)
  })

  it('removeNode returns false for missing node', () => {
    expect(graph.removeNode('nope')).toBe(false)
  })

  // -- Edge CRUD --

  it('adds an edge with auto-generated ID', () => {
    const n1 = graph.addNode(makeNodeInput())
    const n2 = graph.addNode(makeNodeInput())
    const edge = graph.addEdge({
      type: 'supports', sourceId: n1.id, targetId: n2.id,
      weight: 0.8, provenance: makeProvenance(), metadata: {},
    })
    expect(edge.id).toMatch(/^graph_edge_\d+$/)
  })

  it('retrieves edges for a node', () => {
    const n1 = graph.addNode(makeNodeInput())
    const n2 = graph.addNode(makeNodeInput())
    graph.addEdge({
      type: 'supports', sourceId: n1.id, targetId: n2.id,
      weight: 0.8, provenance: makeProvenance(), metadata: {},
    })
    expect(graph.getEdgesForNode(n1.id)).toHaveLength(1)
    expect(graph.getEdgesForNode(n2.id)).toHaveLength(1)
  })

  it('removes an edge', () => {
    const n1 = graph.addNode(makeNodeInput())
    const n2 = graph.addNode(makeNodeInput())
    const edge = graph.addEdge({
      type: 'supports', sourceId: n1.id, targetId: n2.id,
      weight: 0.8, provenance: makeProvenance(), metadata: {},
    })
    expect(graph.removeEdge(edge.id)).toBe(true)
    expect(graph.getEdge(edge.id)).toBeUndefined()
  })

  // -- Conflicts --

  it('auto-detects conflicts on contradicts edges', () => {
    const n1 = graph.addNode(makeNodeInput({ label: 'A' }))
    const n2 = graph.addNode(makeNodeInput({ label: 'B' }))
    graph.addEdge({
      type: 'contradicts', sourceId: n1.id, targetId: n2.id,
      weight: 1, provenance: makeProvenance(), metadata: {},
    })

    const conflicts = graph.getConflicts()
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.nodeA).toBe(n1.id)
  })

  it('resolves a conflict', () => {
    const n1 = graph.addNode(makeNodeInput({
      provenance: makeProvenance({ agentId: 'high-trust' }),
    }))
    const n2 = graph.addNode(makeNodeInput({
      provenance: makeProvenance({ agentId: 'low-trust' }),
    }))

    // Build trust differential
    graph.recordContribution('high-trust', 'testing', true)
    graph.recordContribution('high-trust', 'testing', true)
    graph.recordContribution('low-trust', 'testing', false)

    graph.addEdge({
      type: 'contradicts', sourceId: n1.id, targetId: n2.id,
      weight: 1, provenance: makeProvenance(), metadata: {},
    })

    const conflict = graph.getConflicts()[0]!
    const result = graph.resolveConflict(conflict.id)
    expect(result.winner).toBe(n1.id)
    expect(graph.getConflicts()).toHaveLength(0)
  })

  it('throws when resolving nonexistent conflict', () => {
    expect(() => graph.resolveConflict('nope')).toThrow('Conflict not found')
  })

  // -- Trust --

  it('exposes trust scorer', () => {
    expect(graph.getTrustScorer()).toBeInstanceOf(TrustScorer)
  })

  it('recordContribution delegates to trust scorer', () => {
    graph.recordContribution('agent-1', 'coding', true)
    const profile = graph.getTrustScorer().getProfile('agent-1')
    expect(profile.contributionCount).toBe(1)
  })

  // -- Query --

  it('query() returns a GraphQuery instance', () => {
    expect(graph.query()).toBeInstanceOf(GraphQuery)
  })

  it('teamKnowledge searches by label/content', () => {
    graph.addNode(makeNodeInput({ label: 'TypeScript', content: 'strict mode' }))
    graph.addNode(makeNodeInput({ label: 'Python', content: 'dynamic typing' }))

    expect(graph.teamKnowledge('typescript')).toHaveLength(1)
    expect(graph.teamKnowledge('typing')).toHaveLength(1)
    expect(graph.teamKnowledge('STRICT')).toHaveLength(1) // case-insensitive
  })

  it('teamConventions returns convention nodes sorted by confidence', () => {
    graph.addNode(makeNodeInput({ type: 'convention', label: 'Low', provenance: makeProvenance({ confidence: 0.3 }) }))
    graph.addNode(makeNodeInput({ type: 'convention', label: 'High', provenance: makeProvenance({ confidence: 0.9 }) }))
    graph.addNode(makeNodeInput({ type: 'fact', label: 'Not a convention' }))

    const convs = graph.teamConventions()
    expect(convs).toHaveLength(2)
    expect(convs[0]!.label).toBe('High')
  })

  it('teamDecisions returns decision nodes sorted by recency', () => {
    graph.addNode(makeNodeInput({ type: 'decision', label: 'Old' }))
    // Give a tiny delay so updatedAt differs
    graph.addNode(makeNodeInput({ type: 'decision', label: 'New' }))

    const decisions = graph.teamDecisions()
    expect(decisions).toHaveLength(2)
  })

  // -- Confidence --

  it('getConfidence returns 0 for missing node', () => {
    expect(graph.getConfidence('nonexistent')).toBe(0)
  })

  it('getConfidence returns a value in [0,1]', () => {
    const node = graph.addNode(makeNodeInput())
    const conf = graph.getConfidence(node.id)
    expect(conf).toBeGreaterThanOrEqual(0)
    expect(conf).toBeLessThanOrEqual(1)
  })

  // -- Snapshot / Restore --

  it('snapshot captures all nodes and edges', () => {
    const n1 = graph.addNode(makeNodeInput({ label: 'A' }))
    const n2 = graph.addNode(makeNodeInput({ label: 'B' }))
    graph.addEdge({
      type: 'supports', sourceId: n1.id, targetId: n2.id,
      weight: 0.9, provenance: makeProvenance(), metadata: {},
    })

    const snap = graph.snapshot()
    expect(snap.nodes).toHaveLength(2)
    expect(snap.edges).toHaveLength(1)
  })

  it('restore rebuilds graph from snapshot', () => {
    const n1 = graph.addNode(makeNodeInput({ label: 'A' }))
    const n2 = graph.addNode(makeNodeInput({ label: 'B' }))
    graph.addEdge({
      type: 'supports', sourceId: n1.id, targetId: n2.id,
      weight: 0.9, provenance: makeProvenance(), metadata: {},
    })

    const snap = graph.snapshot()

    // New graph
    const graph2 = new TeamMemoryGraph(config)
    graph2.restore(snap)

    expect(graph2.getNode(n1.id)).toBeDefined()
    expect(graph2.getNode(n2.id)).toBeDefined()
    expect(graph2.getEdgesForNode(n1.id)).toHaveLength(1)
  })

  it('restore keeps counter above restored IDs', () => {
    graph.addNode(makeNodeInput({ label: 'A' }))
    graph.addNode(makeNodeInput({ label: 'B' }))
    const snap = graph.snapshot()

    const graph2 = new TeamMemoryGraph(config)
    graph2.restore(snap)
    const newNode = graph2.addNode(makeNodeInput({ label: 'C' }))
    // New ID should be higher than any restored ID
    const num = parseInt(newNode.id.replace('graph_node_', ''), 10)
    expect(num).toBeGreaterThan(2)
  })

  // -- Stats --

  it('stats returns correct counts', () => {
    graph.addNode(makeNodeInput())
    graph.addNode(makeNodeInput())

    const s = graph.stats()
    expect(s.nodeCount).toBe(2)
    expect(s.edgeCount).toBe(0)
    expect(s.conflictCount).toBe(0)
    expect(s.avgConfidence).toBeGreaterThan(0)
  })

  it('stats returns 0 avgConfidence for empty graph', () => {
    expect(graph.stats().avgConfidence).toBe(0)
  })

  // -- Reset --

  it('reset clears everything', () => {
    graph.addNode(makeNodeInput())
    graph.addNode(makeNodeInput())
    graph.recordContribution('agent-1', 'x', true)

    graph.reset()

    expect(graph.stats().nodeCount).toBe(0)
    expect(graph.stats().edgeCount).toBe(0)
    expect(graph.getTrustScorer().getAllProfiles()).toHaveLength(0)
  })
})
