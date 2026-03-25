/**
 * Causal graph — tracks and traverses cause-effect relationships between memory records.
 *
 * Relations are stored in the `__causal` namespace of the MemoryService with composite
 * keys like `causeNs:causeKey->effectNs:effectKey`. The value contains the full
 * CausalRelation object.
 *
 * Traversal uses BFS with a visited set to handle cycles and a confidence threshold
 * for pruning low-confidence edges.
 */
import type { MemoryService } from '../memory-service.js'
import type {
  CausalRelation,
  CausalNode,
  CausalTraversalOptions,
  CausalGraphResult,
} from './types.js'

/** Namespace used to store causal relations in the memory service */
const CAUSAL_NAMESPACE = '__causal'

/** Scope used for all causal relations (flat, no multi-tenancy at this level) */
const CAUSAL_SCOPE: Record<string, string> = { partition: '__causal' }

/** Build a deterministic composite key for a relation */
function relationKey(
  causeNs: string,
  cause: string,
  effectNs: string,
  effect: string,
): string {
  return `${causeNs}:${cause}->${effectNs}:${effect}`
}

/** Build a node identity string for the visited set */
function nodeId(namespace: string, key: string): string {
  return `${namespace}:${key}`
}

export class CausalGraph {
  constructor(private readonly memoryService: MemoryService) {}

  /**
   * Add a causal relation. Idempotent: re-adding the same cause-effect pair
   * updates confidence and evidence.
   */
  async addRelation(
    relation: Omit<CausalRelation, 'createdAt'>,
  ): Promise<void> {
    const key = relationKey(
      relation.causeNamespace,
      relation.cause,
      relation.effectNamespace,
      relation.effect,
    )

    const full: CausalRelation = {
      ...relation,
      confidence: Math.max(0, Math.min(1, relation.confidence)),
      createdAt: new Date().toISOString(),
    }

    await this.memoryService.put(CAUSAL_NAMESPACE, CAUSAL_SCOPE, key, {
      text: `causal: ${relation.causeNamespace}:${relation.cause} -> ${relation.effectNamespace}:${relation.effect}`,
      ...full,
    })
  }

  /**
   * Remove a causal relation.
   */
  async removeRelation(
    cause: string,
    causeNamespace: string,
    effect: string,
    effectNamespace: string,
  ): Promise<void> {
    const key = relationKey(causeNamespace, cause, effectNamespace, effect)

    // MemoryService does not expose delete directly; write a tombstone value.
    // We use a special `_deleted` flag so getRelations can filter it out.
    await this.memoryService.put(CAUSAL_NAMESPACE, CAUSAL_SCOPE, key, {
      text: '',
      _deleted: true,
    })
  }

  /**
   * Get all causal relations for a record (both as cause and as effect).
   */
  async getRelations(key: string, namespace: string): Promise<CausalNode> {
    const allRecords = await this.memoryService.get(
      CAUSAL_NAMESPACE,
      CAUSAL_SCOPE,
    )

    const causes: CausalRelation[] = []
    const effects: CausalRelation[] = []

    for (const record of allRecords) {
      if (record['_deleted'] === true) continue

      const rel = this.recordToRelation(record)
      if (!rel) continue

      // This node is the effect (incoming edge)
      if (rel.effect === key && rel.effectNamespace === namespace) {
        causes.push(rel)
      }
      // This node is the cause (outgoing edge)
      if (rel.cause === key && rel.causeNamespace === namespace) {
        effects.push(rel)
      }
    }

    return { key, namespace, causes, effects }
  }

  /**
   * BFS traversal with confidence-weighted pruning.
   * Handles cycles via visited set.
   */
  async traverse(
    key: string,
    namespace: string,
    options?: CausalTraversalOptions,
  ): Promise<CausalGraphResult> {
    const direction = options?.direction ?? 'both'
    const maxDepth = options?.maxDepth ?? 5
    const minConfidence = options?.minConfidence ?? 0.0

    // Pre-load all relations once to avoid repeated fetches
    const allRelations = await this.loadAllRelations(minConfidence)

    const visited = new Set<string>()
    visited.add(nodeId(namespace, key))

    const discoveredNodes: CausalNode[] = []
    const discoveredRelations: CausalRelation[] = []

    // BFS queue: [nodeKey, nodeNamespace, currentDepth]
    let queue: Array<{ key: string; namespace: string; depth: number }> = [
      { key, namespace, depth: 0 },
    ]

    let maxReachedDepth = 0

    while (queue.length > 0) {
      const nextQueue: Array<{
        key: string
        namespace: string
        depth: number
      }> = []

      for (const current of queue) {
        if (current.depth >= maxDepth) continue

        const neighbors = this.findNeighbors(
          current.key,
          current.namespace,
          direction,
          allRelations,
        )

        for (const { neighborKey, neighborNs, relation } of neighbors) {
          const nid = nodeId(neighborNs, neighborKey)
          discoveredRelations.push(relation)

          if (visited.has(nid)) continue
          visited.add(nid)

          const neighborDepth = current.depth + 1
          if (neighborDepth > maxReachedDepth) {
            maxReachedDepth = neighborDepth
          }

          // Build node lazily — we already have relations, so collect them
          const neighborNode = this.buildNodeFromRelations(
            neighborKey,
            neighborNs,
            allRelations,
          )
          discoveredNodes.push(neighborNode)

          nextQueue.push({
            key: neighborKey,
            namespace: neighborNs,
            depth: neighborDepth,
          })
        }
      }

      queue = nextQueue
    }

    // Deduplicate relations by composite key
    const uniqueRelations = this.deduplicateRelations(discoveredRelations)

    return {
      root: { key, namespace },
      nodes: discoveredNodes,
      relations: uniqueRelations,
      depth: maxReachedDepth,
    }
  }

  /**
   * Search function compatible with AdaptiveRetriever provider contract.
   * Given a query key+namespace, traverses the causal graph and returns related records.
   */
  async search(
    query: string,
    namespace: string,
    limit?: number,
  ): Promise<Array<{ key: string; namespace: string; score: number }>> {
    const effectiveLimit = limit ?? 10

    const result = await this.traverse(query, namespace, {
      direction: 'both',
      maxDepth: 3,
      minConfidence: 0.1,
    })

    // Score by inverse depth: closer nodes score higher
    // We need to compute depth per node
    const nodeDepths = this.computeNodeDepths(result)

    const scored = result.nodes.map((node) => {
      const depth = nodeDepths.get(nodeId(node.namespace, node.key)) ?? 1
      // Depth 1 -> 1.0, depth 2 -> 0.5, depth 3 -> 0.333...
      const depthScore = 1 / depth
      // Average confidence of relations connecting to this node
      const avgConfidence = this.averageConfidenceForNode(node)
      // Combine depth and confidence
      const score = depthScore * avgConfidence
      return { key: node.key, namespace: node.namespace, score }
    })

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, effectiveLimit)
  }

  // ─── Internal Helpers ──────────────────────────────────────────────────────

  /** Convert a raw record to a CausalRelation, or null if invalid/deleted. */
  private recordToRelation(
    record: Record<string, unknown>,
  ): CausalRelation | null {
    if (record['_deleted'] === true) return null
    if (
      typeof record['cause'] !== 'string' ||
      typeof record['causeNamespace'] !== 'string' ||
      typeof record['effect'] !== 'string' ||
      typeof record['effectNamespace'] !== 'string' ||
      typeof record['confidence'] !== 'number' ||
      typeof record['createdAt'] !== 'string'
    ) {
      return null
    }

    return {
      cause: record['cause'] as string,
      causeNamespace: record['causeNamespace'] as string,
      effect: record['effect'] as string,
      effectNamespace: record['effectNamespace'] as string,
      confidence: record['confidence'] as number,
      evidence:
        typeof record['evidence'] === 'string'
          ? (record['evidence'] as string)
          : undefined,
      createdAt: record['createdAt'] as string,
    }
  }

  /** Load all valid relations from the causal namespace, pre-filtered by confidence. */
  private async loadAllRelations(
    minConfidence: number,
  ): Promise<CausalRelation[]> {
    const allRecords = await this.memoryService.get(
      CAUSAL_NAMESPACE,
      CAUSAL_SCOPE,
    )

    const relations: CausalRelation[] = []
    for (const record of allRecords) {
      const rel = this.recordToRelation(record)
      if (rel && rel.confidence >= minConfidence) {
        relations.push(rel)
      }
    }
    return relations
  }

  /** Find neighboring nodes for BFS given a direction. */
  private findNeighbors(
    key: string,
    namespace: string,
    direction: 'causes' | 'effects' | 'both',
    relations: CausalRelation[],
  ): Array<{ neighborKey: string; neighborNs: string; relation: CausalRelation }> {
    const neighbors: Array<{
      neighborKey: string
      neighborNs: string
      relation: CausalRelation
    }> = []

    for (const rel of relations) {
      // Follow effects: this node is the cause, neighbor is the effect
      if (
        (direction === 'effects' || direction === 'both') &&
        rel.cause === key &&
        rel.causeNamespace === namespace
      ) {
        neighbors.push({
          neighborKey: rel.effect,
          neighborNs: rel.effectNamespace,
          relation: rel,
        })
      }
      // Follow causes: this node is the effect, neighbor is the cause
      if (
        (direction === 'causes' || direction === 'both') &&
        rel.effect === key &&
        rel.effectNamespace === namespace
      ) {
        neighbors.push({
          neighborKey: rel.cause,
          neighborNs: rel.causeNamespace,
          relation: rel,
        })
      }
    }

    return neighbors
  }

  /** Build a CausalNode from pre-loaded relations. */
  private buildNodeFromRelations(
    key: string,
    namespace: string,
    relations: CausalRelation[],
  ): CausalNode {
    const causes: CausalRelation[] = []
    const effects: CausalRelation[] = []

    for (const rel of relations) {
      if (rel.effect === key && rel.effectNamespace === namespace) {
        causes.push(rel)
      }
      if (rel.cause === key && rel.causeNamespace === namespace) {
        effects.push(rel)
      }
    }

    return { key, namespace, causes, effects }
  }

  /** Deduplicate relations by composite key. */
  private deduplicateRelations(
    relations: CausalRelation[],
  ): CausalRelation[] {
    const seen = new Set<string>()
    const unique: CausalRelation[] = []
    for (const rel of relations) {
      const rk = relationKey(
        rel.causeNamespace,
        rel.cause,
        rel.effectNamespace,
        rel.effect,
      )
      if (!seen.has(rk)) {
        seen.add(rk)
        unique.push(rel)
      }
    }
    return unique
  }

  /** Compute BFS depth for each node in a traversal result. */
  private computeNodeDepths(
    result: CausalGraphResult,
  ): Map<string, number> {
    // Re-run a quick BFS just to compute depths from root
    const depths = new Map<string, number>()
    const rootId = nodeId(result.root.namespace, result.root.key)
    depths.set(rootId, 0)

    // Build adjacency from relations
    const adjacency = new Map<string, Set<string>>()
    for (const rel of result.relations) {
      const causeId = nodeId(rel.causeNamespace, rel.cause)
      const effectId = nodeId(rel.effectNamespace, rel.effect)

      if (!adjacency.has(causeId)) adjacency.set(causeId, new Set())
      adjacency.get(causeId)!.add(effectId)

      if (!adjacency.has(effectId)) adjacency.set(effectId, new Set())
      adjacency.get(effectId)!.add(causeId)
    }

    const visited = new Set<string>([rootId])
    let queue = [rootId]
    let currentDepth = 0

    while (queue.length > 0) {
      currentDepth++
      const nextQueue: string[] = []
      for (const nid of queue) {
        const neighbors = adjacency.get(nid)
        if (!neighbors) continue
        for (const neighbor of neighbors) {
          if (visited.has(neighbor)) continue
          visited.add(neighbor)
          depths.set(neighbor, currentDepth)
          nextQueue.push(neighbor)
        }
      }
      queue = nextQueue
    }

    return depths
  }

  /** Compute the average confidence of all relations touching a node. */
  private averageConfidenceForNode(node: CausalNode): number {
    const allRels = [...node.causes, ...node.effects]
    if (allRels.length === 0) return 0.5
    const sum = allRels.reduce((acc, rel) => acc + rel.confidence, 0)
    return sum / allRels.length
  }
}
