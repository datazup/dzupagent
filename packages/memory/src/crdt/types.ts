/**
 * CRDT data types for conflict-free replicated memory.
 *
 * Provides Hybrid Logical Clock timestamps, Last-Writer-Wins registers,
 * Observed-Remove sets, and LWW-Map (per-field LWW register map).
 */

/** Hybrid Logical Clock timestamp for causal ordering. */
export interface HLCTimestamp {
  /** Wall clock time in milliseconds */
  wallMs: number
  /** Logical counter for same-ms disambiguation */
  counter: number
  /** Node identifier for total ordering tiebreak */
  nodeId: string
}

/** Last-Writer-Wins register: a value paired with a causal timestamp. */
export interface LWWRegister<T = unknown> {
  value: T
  timestamp: HLCTimestamp
}

/** A single entry in an Observed-Remove set. */
export interface ORSetEntry {
  /** The value stored */
  value: string
  /** Unique tag for the add operation (used to distinguish concurrent adds) */
  addTag: string
  /** Whether this entry has been removed */
  removed: boolean
}

/** Observed-Remove set: tracks add/remove with unique tags to resolve concurrent ops. */
export interface ORSet {
  /** Map from value to its list of add-operation entries */
  entries: Record<string, ORSetEntry[]>
}

/** Per-field Last-Writer-Wins map: each field is an independent LWW register. */
export interface LWWMap {
  fields: Record<string, LWWRegister>
}

/** Result of merging two CRDT values. */
export interface MergeResult<T> {
  merged: T
  conflictsResolved: number
}
