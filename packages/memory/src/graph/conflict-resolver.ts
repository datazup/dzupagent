/**
 * ConflictResolver — Detects and resolves contradictions in the team
 * memory graph using configurable resolution strategies.
 */

import type {
  GraphNode,
  GraphEdge,
  ConflictRecord,
  GraphConflictStrategy,
} from './graph-types.js'
import type { TrustScorer } from './trust-scorer.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let conflictCounter = 0

function nextConflictId(): string {
  return `conflict_${++conflictCounter}`
}

// ---------------------------------------------------------------------------
// ConflictResolver
// ---------------------------------------------------------------------------

export class ConflictResolver {
  private conflicts = new Map<string, ConflictRecord>()

  constructor(
    private readonly trustScorer: TrustScorer,
    private readonly defaultStrategy: GraphConflictStrategy,
  ) {}

  /**
   * Detect a conflict when a CONTRADICTS edge links two nodes.
   * Returns null if the edge is not of type 'contradicts'.
   */
  detectConflict(
    nodeA: GraphNode,
    nodeB: GraphNode,
    edge: GraphEdge,
  ): ConflictRecord | null {
    if (edge.type !== 'contradicts') return null

    // Avoid duplicate conflict records for the same pair
    for (const existing of this.conflicts.values()) {
      if (existing.resolvedAt) continue
      const samePair =
        (existing.nodeA === nodeA.id && existing.nodeB === nodeB.id) ||
        (existing.nodeA === nodeB.id && existing.nodeB === nodeA.id)
      if (samePair) return existing
    }

    const record: ConflictRecord = {
      id: nextConflictId(),
      nodeA: nodeA.id,
      nodeB: nodeB.id,
      edgeId: edge.id,
      detectedAt: new Date(),
    }
    this.conflicts.set(record.id, record)
    return record
  }

  /**
   * Resolve a conflict using the specified (or default) strategy.
   */
  resolve(
    conflict: ConflictRecord,
    nodeA: GraphNode,
    nodeB: GraphNode,
  ): { winner: string; reason: string } {
    const strategy = conflict.strategy ?? this.defaultStrategy
    const result = this.applyStrategy(strategy, nodeA, nodeB)

    conflict.resolvedAt = new Date()
    conflict.resolution = result.reason
    conflict.strategy = strategy

    return result
  }

  /**
   * Resolve a conflict by ID.
   */
  resolveById(
    conflictId: string,
    nodeA: GraphNode,
    nodeB: GraphNode,
  ): { winner: string; reason: string } | null {
    const conflict = this.conflicts.get(conflictId)
    if (!conflict) return null
    return this.resolve(conflict, nodeA, nodeB)
  }

  /**
   * Get all unresolved conflicts.
   */
  getUnresolved(): ConflictRecord[] {
    return [...this.conflicts.values()].filter((c) => !c.resolvedAt)
  }

  /**
   * Get all conflicts referencing a specific node.
   */
  getConflictsForNode(nodeId: string): ConflictRecord[] {
    return [...this.conflicts.values()].filter(
      (c) => c.nodeA === nodeId || c.nodeB === nodeId,
    )
  }

  /**
   * Get a conflict by ID.
   */
  getConflict(id: string): ConflictRecord | undefined {
    return this.conflicts.get(id)
  }

  /**
   * Total conflict count (including resolved).
   */
  get totalCount(): number {
    return this.conflicts.size
  }

  /**
   * Reset all conflicts.
   */
  reset(): void {
    this.conflicts.clear()
    conflictCounter = 0
  }

  // -----------------------------------------------------------------------
  // Strategy implementations
  // -----------------------------------------------------------------------

  private applyStrategy(
    strategy: GraphConflictStrategy,
    nodeA: GraphNode,
    nodeB: GraphNode,
  ): { winner: string; reason: string } {
    switch (strategy) {
      case 'trust_vote':
        return this.trustVote(nodeA, nodeB)
      case 'recency':
        return this.recency(nodeA, nodeB)
      case 'evidence':
        return this.evidence(nodeA, nodeB)
      case 'escalation':
        return this.escalation(nodeA, nodeB)
      case 'soft_merge':
        return this.softMerge(nodeA, nodeB)
    }
  }

  /**
   * Trust vote: pick the node whose author has the highest trust score.
   */
  private trustVote(
    nodeA: GraphNode,
    nodeB: GraphNode,
  ): { winner: string; reason: string } {
    const trustA = this.trustScorer.getProfile(nodeA.provenance.agentId).overallTrust
    const trustB = this.trustScorer.getProfile(nodeB.provenance.agentId).overallTrust

    if (trustA >= trustB) {
      return {
        winner: nodeA.id,
        reason: `Agent ${nodeA.provenance.agentId} has higher trust (${trustA.toFixed(3)} vs ${trustB.toFixed(3)})`,
      }
    }
    return {
      winner: nodeB.id,
      reason: `Agent ${nodeB.provenance.agentId} has higher trust (${trustB.toFixed(3)} vs ${trustA.toFixed(3)})`,
    }
  }

  /**
   * Recency: pick the most recently updated node.
   */
  private recency(
    nodeA: GraphNode,
    nodeB: GraphNode,
  ): { winner: string; reason: string } {
    if (nodeA.updatedAt.getTime() >= nodeB.updatedAt.getTime()) {
      return {
        winner: nodeA.id,
        reason: `Node ${nodeA.id} is more recent (${nodeA.updatedAt.toISOString()})`,
      }
    }
    return {
      winner: nodeB.id,
      reason: `Node ${nodeB.id} is more recent (${nodeB.updatedAt.toISOString()})`,
    }
  }

  /**
   * Evidence: pick the node with more evidence references.
   */
  private evidence(
    nodeA: GraphNode,
    nodeB: GraphNode,
  ): { winner: string; reason: string } {
    const eA = nodeA.provenance.evidenceRefs.length
    const eB = nodeB.provenance.evidenceRefs.length

    if (eA >= eB) {
      return {
        winner: nodeA.id,
        reason: `Node ${nodeA.id} has more evidence (${eA} vs ${eB} references)`,
      }
    }
    return {
      winner: nodeB.id,
      reason: `Node ${nodeB.id} has more evidence (${eB} vs ${eA} references)`,
    }
  }

  /**
   * Escalation: neither node wins — flag for human review.
   * By convention, returns the node with higher confidence as a suggestion.
   */
  private escalation(
    nodeA: GraphNode,
    nodeB: GraphNode,
  ): { winner: string; reason: string } {
    const suggested =
      nodeA.provenance.confidence >= nodeB.provenance.confidence ? nodeA.id : nodeB.id
    return {
      winner: suggested,
      reason: `Escalated for human review. Suggested: ${suggested} (higher confidence)`,
    }
  }

  /**
   * Soft merge: both nodes are retained; the one with higher confidence
   * is marked as the primary.
   */
  private softMerge(
    nodeA: GraphNode,
    nodeB: GraphNode,
  ): { winner: string; reason: string } {
    const primary =
      nodeA.provenance.confidence >= nodeB.provenance.confidence ? nodeA.id : nodeB.id
    return {
      winner: primary,
      reason: `Soft merge — both retained. Primary: ${primary} (higher confidence)`,
    }
  }
}
