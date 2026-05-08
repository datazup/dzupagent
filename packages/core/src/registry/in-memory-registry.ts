/**
 * In-memory implementation exports for the AgentRegistry interface.
 *
 * The implementation is split across focused modules:
 *  - `in-memory-registry-core.ts`      — `InMemoryRegistry` lifecycle class
 *  - `in-memory-registry-types.ts`     — internal subscription record shape
 *  - `in-memory-registry-scoring.ts`   — discovery scoring + match weighting
 *  - `in-memory-registry-errors.ts`    — validation and shared ForgeError factories
 *  - `in-memory-registry-events.ts`    — subscription fan-out + event-bus forwarding
 *  - `in-memory-registry-mutations.ts` — pure register/update helpers
 *  - `in-memory-registry-queries.ts`   — pure read-only helpers (discover/stats/eviction)
 *
 * Re-exports keep the public surface unchanged for callers that import from
 * this module path.
 */
export { InMemoryRegistry } from './in-memory-registry-core.js'
export {
  computeMatchScore,
  isUnfilteredQuery,
  scoreAgent,
} from './in-memory-registry-scoring.js'
export { dispatchRegistryEvent, matchesFilter } from './in-memory-registry-events.js'
export {
  applyUpdateChanges,
  buildRegisteredAgent,
} from './in-memory-registry-mutations.js'
export {
  computeRegistryStats,
  discoverAgents,
  findExpiredAgents,
} from './in-memory-registry-queries.js'
export type { UpdateApplicationResult } from './in-memory-registry-mutations.js'
export type { Subscription } from './in-memory-registry-types.js'
