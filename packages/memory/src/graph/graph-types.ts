/**
 * Team Memory Graph — Core type definitions.
 *
 * Provides shared knowledge graph types for multi-agent collaboration
 * with provenance tracking, trust scoring, and conflict resolution.
 */

// ---------------------------------------------------------------------------
// Node & Edge Enumerations
// ---------------------------------------------------------------------------

export type GraphNodeType =
  | 'concept'
  | 'fact'
  | 'decision'
  | 'pattern'
  | 'convention'
  | 'lesson'

export type GraphEdgeType =
  | 'supports'
  | 'contradicts'
  | 'derived_from'
  | 'depends_on'
  | 'specializes'
  | 'supersedes'

export type GraphConflictStrategy =
  | 'trust_vote'
  | 'recency'
  | 'evidence'
  | 'escalation'
  | 'soft_merge'

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export interface GraphNodeProvenance {
  agentId: string
  timestamp: Date
  confidence: number // 0-1
  evidenceRefs: string[]
  domain?: string
}

// ---------------------------------------------------------------------------
// Node & Edge
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: string
  type: GraphNodeType
  label: string
  content: string
  metadata: Record<string, unknown>
  provenance: GraphNodeProvenance
  trustScore: number // computed
  decayRate: number
  namespace: string // team scope
  createdAt: Date
  updatedAt: Date
}

export interface GraphEdge {
  id: string
  type: GraphEdgeType
  sourceId: string
  targetId: string
  weight: number // 0-1
  provenance: GraphNodeProvenance
  metadata: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Trust
// ---------------------------------------------------------------------------

export interface TrustProfile {
  agentId: string
  overallTrust: number // 0-1
  domainTrust: Map<string, number> // domain -> trust score
  contributionCount: number
  successRate: number
  lastActive: Date
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

export interface ConflictRecord {
  id: string
  nodeA: string
  nodeB: string
  edgeId: string // the CONTRADICTS edge
  detectedAt: Date
  resolvedAt?: Date
  resolution?: string
  strategy?: GraphConflictStrategy
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export interface GraphQueryFilter {
  types?: GraphNodeType[]
  namespace?: string
  minConfidence?: number
  agentId?: string
  domain?: string
  since?: Date
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface TeamGraphConfig {
  namespace: string
  conflictStrategy?: GraphConflictStrategy
  decayEnabled?: boolean
  decayInterval?: number // ms
  trustDecayRate?: number // per day
  minTrustThreshold?: number
}
