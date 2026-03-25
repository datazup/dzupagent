/**
 * CRDT (Conflict-Free Replicated Data Types) — barrel exports.
 */
export { HLC } from './hlc.js'
export { CRDTResolver } from './crdt-resolver.js'

export type {
  HLCTimestamp,
  LWWRegister,
  ORSetEntry,
  ORSet,
  LWWMap,
  MergeResult,
} from './types.js'
