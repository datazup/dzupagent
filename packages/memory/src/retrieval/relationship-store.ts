/**
 * Typed Relationship Edges (F27) — transforms flat memory into a true
 * knowledge graph with explicit typed relationship edges stored in BaseStore.
 *
 * Storage layout:
 *   [...baseNamespace, "__edges"]  → forward key  "${from}::${type}::${to}"
 *   [...baseNamespace, "__edges"]  → reverse key  "rev::${to}::${type}::${from}"
 */
import type { BaseStore } from '@langchain/langgraph'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RelationshipType =
  // Causal
  | 'causes'
  | 'prevents'
  | 'triggers'
  // Solution
  | 'solves'
  | 'alternative_to'
  | 'improves'
  // Learning
  | 'builds_on'
  | 'contradicts'
  | 'confirms'
  | 'supersedes'
  // Workflow
  | 'depends_on'
  | 'enables'
  | 'blocks'
  | 'follows'
  // Quality
  | 'preferred_over'
  | 'deprecated_by'

export interface EdgeMetadata {
  scope?: string
  conditions?: string
  evidence?: string
  confidence: number
}

export interface RelationshipEdge {
  fromKey: string
  toKey: string
  type: RelationshipType
  createdAt: number
  metadata?: EdgeMetadata
}

export interface TraversalResult {
  /** Memory key */
  key: string
  /** How this memory was reached */
  path: RelationshipEdge[]
  /** Hop distance from start */
  hops: number
  /** Memory value (loaded from store) */
  value: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

function forwardKey(from: string, type: RelationshipType, to: string): string {
  return `${from}::${type}::${to}`
}

function reverseKey(to: string, type: RelationshipType, from: string): string {
  return `rev::${to}::${type}::${from}`
}

function edgeToValue(edge: RelationshipEdge, direction: 'outgoing' | 'incoming'): Record<string, unknown> {
  return {
    text: `${edge.fromKey} ${edge.type} ${edge.toKey}`,
    fromKey: edge.fromKey,
    toKey: edge.toKey,
    type: edge.type,
    createdAt: edge.createdAt,
    metadata: edge.metadata ?? {},
    _direction: direction,
  }
}

function valueToEdge(value: Record<string, unknown>): RelationshipEdge | undefined {
  const fromKey = value['fromKey']
  const toKey = value['toKey']
  const type = value['type']
  const createdAt = value['createdAt']
  if (
    typeof fromKey !== 'string' ||
    typeof toKey !== 'string' ||
    typeof type !== 'string' ||
    typeof createdAt !== 'number'
  ) {
    return undefined
  }
  const raw = value['metadata']
  const metadata =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as EdgeMetadata)
      : undefined
  return { fromKey, toKey, type: type as RelationshipType, createdAt, metadata }
}

const CAUSAL_TYPES: RelationshipType[] = ['causes', 'triggers', 'prevents']

// ---------------------------------------------------------------------------
// RelationshipStore
// ---------------------------------------------------------------------------

export class RelationshipStore {
  constructor(
    private readonly store: BaseStore,
    private readonly baseNamespace: string[],
  ) {}

  private get edgeNamespace(): string[] {
    return [...this.baseNamespace, '__edges']
  }

  // -----------------------------------------------------------------------
  // Mutations
  // -----------------------------------------------------------------------

  /** Add a directed relationship edge (stores forward + reverse entries). */
  async addEdge(edge: RelationshipEdge): Promise<void> {
    try {
      const fk = forwardKey(edge.fromKey, edge.type, edge.toKey)
      const rk = reverseKey(edge.toKey, edge.type, edge.fromKey)
      await this.store.put(this.edgeNamespace, fk, edgeToValue(edge, 'outgoing'))
      await this.store.put(this.edgeNamespace, rk, edgeToValue(edge, 'incoming'))
    } catch {
      // Non-fatal
    }
  }

  /** Remove a specific edge (both forward and reverse). */
  async removeEdge(fromKey: string, type: RelationshipType, toKey: string): Promise<void> {
    try {
      await this.store.delete(this.edgeNamespace, forwardKey(fromKey, type, toKey))
      await this.store.delete(this.edgeNamespace, reverseKey(toKey, type, fromKey))
    } catch {
      // Non-fatal
    }
  }

  /** Remove all edges involving a memory key (both directions). */
  async removeAllEdges(key: string): Promise<void> {
    try {
      const allEdges = await this.getEdges(key, 'both')
      for (const edge of allEdges) {
        await this.removeEdge(edge.fromKey, edge.type, edge.toKey)
      }
    } catch {
      // Non-fatal
    }
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /** Get edges for a memory key, optionally filtered by direction and types. */
  async getEdges(
    key: string,
    direction: 'outgoing' | 'incoming' | 'both' = 'both',
    types?: RelationshipType[],
  ): Promise<RelationshipEdge[]> {
    try {
      const results: RelationshipEdge[] = []

      if (direction === 'outgoing' || direction === 'both') {
        const entries = await this.store.search(this.edgeNamespace, {
          filter: { fromKey: key, _direction: 'outgoing' },
          limit: 1000,
        })
        for (const entry of entries) {
          const edge = valueToEdge(entry.value as Record<string, unknown>)
          if (!edge) continue
          if (types && !types.includes(edge.type)) continue
          results.push(edge)
        }
      }

      if (direction === 'incoming' || direction === 'both') {
        const entries = await this.store.search(this.edgeNamespace, {
          filter: { toKey: key, _direction: 'incoming' },
          limit: 1000,
        })
        for (const entry of entries) {
          const edge = valueToEdge(entry.value as Record<string, unknown>)
          if (!edge) continue
          if (types && !types.includes(edge.type)) continue
          results.push(edge)
        }
      }

      return results
    } catch {
      return []
    }
  }

  /**
   * Traverse the graph from a starting key following specific edge types.
   * BFS traversal up to maxHops. Returns all reachable memories with paths.
   */
  async traverse(
    startKey: string,
    types: RelationshipType[],
    maxHops: number,
    limit: number = 100,
  ): Promise<TraversalResult[]> {
    try {
      const results: TraversalResult[] = []
      const visited = new Set<string>()
      visited.add(startKey)

      interface QueueItem {
        key: string
        path: RelationshipEdge[]
        hops: number
      }

      const queue: QueueItem[] = [{ key: startKey, path: [], hops: 0 }]

      while (queue.length > 0 && results.length < limit) {
        const item = queue.shift()!

        if (item.hops > maxHops) continue

        // Get outgoing edges filtered by types
        const edges = await this.getEdges(item.key, 'outgoing', types)

        for (const edge of edges) {
          if (visited.has(edge.toKey)) continue
          if (results.length >= limit) break

          visited.add(edge.toKey)

          const newPath = [...item.path, edge]
          const newHops = item.hops + 1

          // Load the target memory value from base namespace
          const record = await this.store.get(this.baseNamespace, edge.toKey)
          const value = record
            ? (record.value as Record<string, unknown>)
            : {}

          results.push({ key: edge.toKey, path: newPath, hops: newHops, value })

          if (newHops < maxHops) {
            queue.push({ key: edge.toKey, path: newPath, hops: newHops })
          }
        }
      }

      return results
    } catch {
      return []
    }
  }

  /**
   * Find the shortest causal chain between two memory keys.
   * Uses BFS through causal edge types (causes, triggers, prevents).
   * Returns null if no path exists.
   */
  async findCausalChain(
    fromKey: string,
    toKey: string,
    maxHops: number = 5,
  ): Promise<RelationshipEdge[] | null> {
    try {
      const visited = new Set<string>()
      visited.add(fromKey)

      interface QueueItem {
        key: string
        path: RelationshipEdge[]
      }

      const queue: QueueItem[] = [{ key: fromKey, path: [] }]

      while (queue.length > 0) {
        const item = queue.shift()!

        if (item.path.length >= maxHops) continue

        const edges = await this.getEdges(item.key, 'outgoing', CAUSAL_TYPES)

        for (const edge of edges) {
          const newPath = [...item.path, edge]

          if (edge.toKey === toKey) {
            return newPath
          }

          if (!visited.has(edge.toKey)) {
            visited.add(edge.toKey)
            queue.push({ key: edge.toKey, path: newPath })
          }
        }
      }

      return null
    } catch {
      return null
    }
  }

  /** Get all edges in the store (for stats/debugging). */
  async getAllEdges(limit: number = 1000): Promise<RelationshipEdge[]> {
    try {
      const entries = await this.store.search(this.edgeNamespace, {
        filter: { _direction: 'outgoing' },
        limit,
      })

      const edges: RelationshipEdge[] = []
      for (const entry of entries) {
        const edge = valueToEdge(entry.value as Record<string, unknown>)
        if (edge) edges.push(edge)
      }
      return edges
    } catch {
      return []
    }
  }

  /** Build an adjacency map from stored edges (for PPR/community detection). */
  async buildAdjacency(
    types?: RelationshipType[],
  ): Promise<Map<string, string[]>> {
    try {
      const allEdges = await this.getAllEdges(10000)
      const adjacency = new Map<string, string[]>()

      for (const edge of allEdges) {
        if (types && !types.includes(edge.type)) continue

        const existing = adjacency.get(edge.fromKey)
        if (existing) {
          existing.push(edge.toKey)
        } else {
          adjacency.set(edge.fromKey, [edge.toKey])
        }
      }

      return adjacency
    } catch {
      return new Map()
    }
  }
}
