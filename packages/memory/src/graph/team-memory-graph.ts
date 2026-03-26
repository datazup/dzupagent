/**
 * TeamMemoryGraph — Shared knowledge graph for multi-agent teams.
 *
 * Provides:
 *  - Node & edge CRUD with auto-generated IDs
 *  - Trust-weighted confidence scoring
 *  - Conflict detection & resolution on CONTRADICTS edges
 *  - Fluent query builder (via GraphQuery)
 *  - Snapshot / restore for persistence
 */

import type {
  GraphNode,
  GraphEdge,
  ConflictRecord,
  TeamGraphConfig,
  GraphConflictStrategy,
  GraphNodeType,
} from './graph-types.js'
import { TrustScorer } from './trust-scorer.js'
import { ConflictResolver } from './conflict-resolver.js'
import { GraphQuery } from './graph-query.js'

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFLICT_STRATEGY: GraphConflictStrategy = 'trust_vote'
const DEFAULT_DECAY_INTERVAL = 24 * 60 * 60 * 1000 // 1 day
const DEFAULT_TRUST_DECAY_RATE = 0.01
const DEFAULT_MIN_TRUST = 0.1

// ---------------------------------------------------------------------------
// Required config shape (all fields populated)
// ---------------------------------------------------------------------------

interface ResolvedConfig {
  namespace: string
  conflictStrategy: GraphConflictStrategy
  decayEnabled: boolean
  decayInterval: number
  trustDecayRate: number
  minTrustThreshold: number
}

// ---------------------------------------------------------------------------
// TeamMemoryGraph
// ---------------------------------------------------------------------------

export class TeamMemoryGraph {
  private nodes = new Map<string, GraphNode>()
  private edges = new Map<string, GraphEdge>()
  private readonly trustScorer: TrustScorer
  private readonly conflictResolver: ConflictResolver
  private readonly config: ResolvedConfig
  private nodeCounter = 0
  private edgeCounter = 0

  constructor(config: TeamGraphConfig) {
    this.config = {
      namespace: config.namespace,
      conflictStrategy: config.conflictStrategy ?? DEFAULT_CONFLICT_STRATEGY,
      decayEnabled: config.decayEnabled ?? false,
      decayInterval: config.decayInterval ?? DEFAULT_DECAY_INTERVAL,
      trustDecayRate: config.trustDecayRate ?? DEFAULT_TRUST_DECAY_RATE,
      minTrustThreshold: config.minTrustThreshold ?? DEFAULT_MIN_TRUST,
    }

    this.trustScorer = new TrustScorer()
    this.conflictResolver = new ConflictResolver(
      this.trustScorer,
      this.config.conflictStrategy,
    )
  }

  // -----------------------------------------------------------------------
  // Node operations
  // -----------------------------------------------------------------------

  addNode(
    input: Omit<GraphNode, 'id' | 'trustScore' | 'createdAt' | 'updatedAt'>,
  ): GraphNode {
    const now = new Date()
    const id = `graph_node_${++this.nodeCounter}`

    const trustScore = this.trustScorer.computeConfidence(
      { ...input, id, trustScore: 0, createdAt: now, updatedAt: now },
      0,
    )

    const node: GraphNode = {
      ...input,
      id,
      trustScore,
      createdAt: now,
      updatedAt: now,
    }

    this.nodes.set(id, node)
    return node
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id)
  }

  updateNode(
    id: string,
    updates: Partial<Pick<GraphNode, 'content' | 'metadata' | 'label'>>,
  ): GraphNode {
    const existing = this.nodes.get(id)
    if (!existing) {
      throw new Error(`Node not found: ${id}`)
    }

    const updated: GraphNode = {
      ...existing,
      ...updates,
      updatedAt: new Date(),
    }

    // Recompute trust score
    const corroboration = this.countCorroboration(id)
    updated.trustScore = this.trustScorer.computeConfidence(updated, corroboration)

    this.nodes.set(id, updated)
    return updated
  }

  removeNode(id: string): boolean {
    if (!this.nodes.has(id)) return false
    this.nodes.delete(id)

    // Remove all edges connected to this node
    for (const [edgeId, edge] of this.edges) {
      if (edge.sourceId === id || edge.targetId === id) {
        this.edges.delete(edgeId)
      }
    }
    return true
  }

  // -----------------------------------------------------------------------
  // Edge operations
  // -----------------------------------------------------------------------

  addEdge(input: Omit<GraphEdge, 'id'>): GraphEdge {
    const id = `graph_edge_${++this.edgeCounter}`
    const edge: GraphEdge = { ...input, id }
    this.edges.set(id, edge)

    // If this is a CONTRADICTS edge, detect a conflict
    if (edge.type === 'contradicts') {
      const nodeA = this.nodes.get(edge.sourceId)
      const nodeB = this.nodes.get(edge.targetId)
      if (nodeA && nodeB) {
        this.conflictResolver.detectConflict(nodeA, nodeB, edge)
      }
    }

    return edge
  }

  getEdge(id: string): GraphEdge | undefined {
    return this.edges.get(id)
  }

  removeEdge(id: string): boolean {
    return this.edges.delete(id)
  }

  getEdgesForNode(nodeId: string): GraphEdge[] {
    const result: GraphEdge[] = []
    for (const edge of this.edges.values()) {
      if (edge.sourceId === nodeId || edge.targetId === nodeId) {
        result.push(edge)
      }
    }
    return result
  }

  // -----------------------------------------------------------------------
  // Trust
  // -----------------------------------------------------------------------

  getTrustScorer(): TrustScorer {
    return this.trustScorer
  }

  recordContribution(agentId: string, domain: string, success: boolean): void {
    this.trustScorer.recordContribution(agentId, domain, success)
  }

  // -----------------------------------------------------------------------
  // Conflicts
  // -----------------------------------------------------------------------

  getConflicts(): ConflictRecord[] {
    return this.conflictResolver.getUnresolved()
  }

  resolveConflict(conflictId: string): { winner: string; reason: string } {
    const conflict = this.conflictResolver.getConflict(conflictId)
    if (!conflict) {
      throw new Error(`Conflict not found: ${conflictId}`)
    }

    const nodeA = this.nodes.get(conflict.nodeA)
    const nodeB = this.nodes.get(conflict.nodeB)
    if (!nodeA || !nodeB) {
      throw new Error(`Conflict references missing node(s): ${conflict.nodeA}, ${conflict.nodeB}`)
    }

    return this.conflictResolver.resolve(conflict, nodeA, nodeB)
  }

  // -----------------------------------------------------------------------
  // Querying
  // -----------------------------------------------------------------------

  query(): GraphQuery {
    return new GraphQuery(this.nodes, this.edges)
  }

  /**
   * Search nodes whose label or content includes the topic string (case-insensitive).
   */
  teamKnowledge(topic: string): GraphNode[] {
    const lower = topic.toLowerCase()
    return [...this.nodes.values()].filter(
      (n) =>
        n.label.toLowerCase().includes(lower) ||
        n.content.toLowerCase().includes(lower),
    )
  }

  /**
   * All convention-type nodes, sorted by confidence descending.
   */
  teamConventions(): GraphNode[] {
    return this.nodesOfType('convention').sort(
      (a, b) => b.provenance.confidence - a.provenance.confidence,
    )
  }

  /**
   * All decision-type nodes, sorted by recency descending.
   */
  teamDecisions(): GraphNode[] {
    return this.nodesOfType('decision').sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
    )
  }

  // -----------------------------------------------------------------------
  // Confidence
  // -----------------------------------------------------------------------

  getConfidence(nodeId: string): number {
    const node = this.nodes.get(nodeId)
    if (!node) return 0
    const corroboration = this.countCorroboration(nodeId)
    return this.trustScorer.computeConfidence(node, corroboration)
  }

  // -----------------------------------------------------------------------
  // Snapshot / Restore
  // -----------------------------------------------------------------------

  snapshot(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    return {
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
    }
  }

  restore(data: { nodes: GraphNode[]; edges: GraphEdge[] }): void {
    this.nodes.clear()
    this.edges.clear()

    for (const node of data.nodes) {
      this.nodes.set(node.id, node)
      // Keep counter above all restored IDs
      const num = parseInt(node.id.replace('graph_node_', ''), 10)
      if (!isNaN(num) && num > this.nodeCounter) this.nodeCounter = num
    }

    for (const edge of data.edges) {
      this.edges.set(edge.id, edge)
      const num = parseInt(edge.id.replace('graph_edge_', ''), 10)
      if (!isNaN(num) && num > this.edgeCounter) this.edgeCounter = num
    }
  }

  // -----------------------------------------------------------------------
  // Stats
  // -----------------------------------------------------------------------

  stats(): {
    nodeCount: number
    edgeCount: number
    conflictCount: number
    avgConfidence: number
  } {
    const nodes = [...this.nodes.values()]
    const avgConfidence =
      nodes.length > 0
        ? nodes.reduce((sum, n) => sum + n.provenance.confidence, 0) / nodes.length
        : 0

    return {
      nodeCount: this.nodes.size,
      edgeCount: this.edges.size,
      conflictCount: this.conflictResolver.getUnresolved().length,
      avgConfidence: Math.round(avgConfidence * 1000) / 1000,
    }
  }

  // -----------------------------------------------------------------------
  // Reset
  // -----------------------------------------------------------------------

  reset(): void {
    this.nodes.clear()
    this.edges.clear()
    this.trustScorer.reset()
    this.conflictResolver.reset()
    this.nodeCounter = 0
    this.edgeCounter = 0
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private nodesOfType(type: GraphNodeType): GraphNode[] {
    return [...this.nodes.values()].filter((n) => n.type === type)
  }

  /**
   * Count how many SUPPORTS edges point to a node from different agents.
   */
  private countCorroboration(nodeId: string): number {
    const agents = new Set<string>()
    for (const edge of this.edges.values()) {
      if (edge.type === 'supports' && edge.targetId === nodeId) {
        agents.add(edge.provenance.agentId)
      }
    }
    return agents.size
  }
}
