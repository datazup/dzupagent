/**
 * Team Memory Graph — barrel exports.
 */

// --- Types ---
export type {
  GraphNodeType,
  GraphEdgeType,
  GraphConflictStrategy,
  GraphNodeProvenance,
  GraphNode,
  GraphEdge,
  TrustProfile,
  ConflictRecord,
  GraphQueryFilter,
  TeamGraphConfig,
} from './graph-types.js'

// --- Classes ---
export { TrustScorer } from './trust-scorer.js'
export { ConflictResolver } from './conflict-resolver.js'
export { GraphQuery } from './graph-query.js'
export { TeamMemoryGraph } from './team-memory-graph.js'
