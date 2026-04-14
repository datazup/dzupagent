/**
 * Causal graph types for tracking cause-effect relationships between memory records.
 *
 * A causal relation represents a directed edge from a "cause" record to an "effect" record,
 * with a confidence score indicating how reliable the causal link is.
 */

/** A directed causal relation between two memory records. */
export interface CausalRelation {
  /** Key of the cause record */
  cause: string
  /** Namespace of the cause */
  causeNamespace: string
  /** Key of the effect record */
  effect: string
  /** Namespace of the effect */
  effectNamespace: string
  /** Confidence that this causal link is real (0.0-1.0) */
  confidence: number
  /** Evidence supporting this causal link */
  evidence?: string | undefined
  /** When this relation was established (ISO 8601) */
  createdAt: string
}

/** A node in the causal graph with its incoming (causes) and outgoing (effects) edges. */
export interface CausalNode {
  key: string
  namespace: string
  /** Relations where this node is the effect (incoming edges) */
  causes: CausalRelation[]
  /** Relations where this node is the cause (outgoing edges) */
  effects: CausalRelation[]
}

/** Options for BFS traversal of the causal graph. */
export interface CausalTraversalOptions {
  /** Direction to traverse */
  direction: 'causes' | 'effects' | 'both'
  /** Maximum depth (default: 5) */
  maxDepth?: number | undefined
  /** Minimum confidence threshold (default: 0.0) */
  minConfidence?: number | undefined
}

/** Result of a causal graph traversal. */
export interface CausalGraphResult {
  /** Starting node */
  root: { key: string; namespace: string }
  /** All discovered nodes (excluding root) */
  nodes: CausalNode[]
  /** All traversed relations */
  relations: CausalRelation[]
  /** Maximum depth reached */
  depth: number
}
