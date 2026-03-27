/**
 * GraphQuery — Fluent query builder for the team memory graph.
 *
 * Provides filtering, traversal, and aggregation over in-memory
 * node and edge collections.
 */

import type {
  GraphNode,
  GraphEdge,
  GraphNodeType,
  GraphEdgeType,
} from './graph-types.js'

// ---------------------------------------------------------------------------
// GraphQuery
// ---------------------------------------------------------------------------

export class GraphQuery {
  private filters: Array<(node: GraphNode) => boolean> = []

  constructor(
    private readonly nodes: Map<string, GraphNode>,
    private readonly edges: Map<string, GraphEdge>,
  ) {}

  // -----------------------------------------------------------------------
  // Filters (chainable)
  // -----------------------------------------------------------------------

  ofType(...types: GraphNodeType[]): GraphQuery {
    this.filters.push((n) => types.includes(n.type))
    return this
  }

  inNamespace(ns: string): GraphQuery {
    this.filters.push((n) => n.namespace === ns)
    return this
  }

  withMinConfidence(min: number): GraphQuery {
    this.filters.push((n) => n.provenance.confidence >= min)
    return this
  }

  byAgent(agentId: string): GraphQuery {
    this.filters.push((n) => n.provenance.agentId === agentId)
    return this
  }

  inDomain(domain: string): GraphQuery {
    this.filters.push((n) => n.provenance.domain === domain)
    return this
  }

  since(date: Date): GraphQuery {
    const ts = date.getTime()
    this.filters.push((n) => n.updatedAt.getTime() >= ts)
    return this
  }

  // -----------------------------------------------------------------------
  // Traversal
  // -----------------------------------------------------------------------

  /**
   * Get direct neighbors of a node, optionally filtered by edge types.
   */
  neighbors(nodeId: string, edgeTypes?: GraphEdgeType[]): GraphNode[] {
    const neighborIds = new Set<string>()

    for (const edge of this.edges.values()) {
      if (edgeTypes && !edgeTypes.includes(edge.type)) continue

      if (edge.sourceId === nodeId) {
        neighborIds.add(edge.targetId)
      } else if (edge.targetId === nodeId) {
        neighborIds.add(edge.sourceId)
      }
    }

    const result: GraphNode[] = []
    for (const id of neighborIds) {
      const node = this.nodes.get(id)
      if (node) result.push(node)
    }
    return result
  }

  /**
   * Find a path between two nodes using BFS.
   * Returns the node sequence or null if no path exists.
   */
  path(fromId: string, toId: string): GraphNode[] | null {
    if (fromId === toId) {
      const node = this.nodes.get(fromId)
      return node ? [node] : null
    }

    // Build adjacency list
    const adj = new Map<string, Set<string>>()
    for (const edge of this.edges.values()) {
      if (!adj.has(edge.sourceId)) adj.set(edge.sourceId, new Set())
      if (!adj.has(edge.targetId)) adj.set(edge.targetId, new Set())
      adj.get(edge.sourceId)!.add(edge.targetId)
      adj.get(edge.targetId)!.add(edge.sourceId)
    }

    // BFS
    const visited = new Set<string>([fromId])
    const parent = new Map<string, string>()
    const queue: string[] = [fromId]

    while (queue.length > 0) {
      const current = queue.shift()!
      const neighbours = adj.get(current)
      if (!neighbours) continue

      for (const next of neighbours) {
        if (visited.has(next)) continue
        visited.add(next)
        parent.set(next, current)

        if (next === toId) {
          // Reconstruct path
          const pathIds: string[] = [toId]
          let cursor = toId
          while (parent.has(cursor)) {
            cursor = parent.get(cursor)!
            pathIds.unshift(cursor)
          }
          return pathIds
            .map((id) => this.nodes.get(id))
            .filter((n): n is GraphNode => n !== undefined)
        }

        queue.push(next)
      }
    }

    return null
  }

  /**
   * Extract a subgraph rooted at `rootId` up to `depth` hops.
   */
  subgraph(
    rootId: string,
    depth: number,
  ): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const visitedNodes = new Set<string>()
    const resultEdges: GraphEdge[] = []
    let frontier = new Set<string>([rootId])

    for (let d = 0; d <= depth && frontier.size > 0; d++) {
      const nextFrontier = new Set<string>()
      for (const nodeId of frontier) {
        visitedNodes.add(nodeId)
      }

      if (d === depth) break

      for (const edge of this.edges.values()) {
        if (frontier.has(edge.sourceId) && !visitedNodes.has(edge.targetId)) {
          nextFrontier.add(edge.targetId)
          resultEdges.push(edge)
        }
        if (frontier.has(edge.targetId) && !visitedNodes.has(edge.sourceId)) {
          nextFrontier.add(edge.sourceId)
          resultEdges.push(edge)
        }
      }

      frontier = nextFrontier
    }

    // Also add edges between already-visited nodes in the subgraph
    for (const nodeId of frontier) {
      visitedNodes.add(nodeId)
    }

    // Collect edges that connect any two visited nodes
    const subEdges: GraphEdge[] = []
    const edgeSeen = new Set<string>()
    for (const edge of this.edges.values()) {
      if (
        visitedNodes.has(edge.sourceId) &&
        visitedNodes.has(edge.targetId) &&
        !edgeSeen.has(edge.id)
      ) {
        subEdges.push(edge)
        edgeSeen.add(edge.id)
      }
    }

    const subNodes: GraphNode[] = []
    for (const id of visitedNodes) {
      const node = this.nodes.get(id)
      if (node) subNodes.push(node)
    }

    return { nodes: subNodes, edges: subEdges }
  }

  // -----------------------------------------------------------------------
  // Aggregation
  // -----------------------------------------------------------------------

  /**
   * Return nodes sorted by provenance confidence, descending.
   */
  topByConfidence(limit: number): GraphNode[] {
    return this.execute()
      .sort((a, b) => b.provenance.confidence - a.provenance.confidence)
      .slice(0, limit)
  }

  /**
   * Find all contradicting node pairs.
   */
  contradictions(): Array<{ nodeA: GraphNode; nodeB: GraphNode; edge: GraphEdge }> {
    const results: Array<{ nodeA: GraphNode; nodeB: GraphNode; edge: GraphEdge }> = []

    for (const edge of this.edges.values()) {
      if (edge.type !== 'contradicts') continue
      const nodeA = this.nodes.get(edge.sourceId)
      const nodeB = this.nodes.get(edge.targetId)
      if (nodeA && nodeB) {
        results.push({ nodeA, nodeB, edge })
      }
    }

    return results
  }

  /**
   * Return high-confidence convention nodes.
   */
  conventions(): GraphNode[] {
    return this.execute()
      .filter((n) => n.type === 'convention')
      .sort((a, b) => b.provenance.confidence - a.provenance.confidence)
  }

  // -----------------------------------------------------------------------
  // Terminal
  // -----------------------------------------------------------------------

  /**
   * Execute the query and return all matching nodes.
   */
  execute(): GraphNode[] {
    let results = [...this.nodes.values()]
    for (const filter of this.filters) {
      results = results.filter(filter)
    }
    return results
  }

  /**
   * Count of matching nodes.
   */
  count(): number {
    return this.execute().length
  }
}
