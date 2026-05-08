/**
 * Columnar batch operations over Apache Arrow Tables conforming to MEMORY_FRAME_SCHEMA.
 *
 * All functions are pure, non-fatal (catch errors, return empty/default),
 * and handle empty tables gracefully.
 *
 * This module is a thin coordinator: implementations live in focused siblings
 * (`columnar-ops-helpers`, `columnar-ops-decay`, `columnar-ops-temporal`,
 * `columnar-ops-scoring`, `columnar-ops-graph`). Callers continue to import
 * from this barrel — the public API surface is unchanged.
 */

// Helpers (row selection)
export { takeRows } from './columnar-ops-helpers.js'

// Decay operations
export {
  applyHubDampeningBatch,
  batchDecayUpdate,
  findWeakIndices,
} from './columnar-ops-decay.js'

// Temporal / partitioning operations
export {
  applyMask,
  partitionByNamespace,
  temporalMask,
} from './columnar-ops-temporal.js'

// Scoring and token-budget operations
export {
  batchTokenEstimate,
  computeCompositeScore,
  selectByTokenBudget,
} from './columnar-ops-scoring.js'

// Graph and similarity operations
export {
  batchCosineSimilarity,
  rankByPageRank,
} from './columnar-ops-graph.js'
