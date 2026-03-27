/**
 * CRDTResolver — Conflict-free resolution for distributed memory writes.
 *
 * Provides three CRDT data types:
 * - LWW Register: last-writer-wins by HLC timestamp
 * - OR-Set (Observed-Remove Set): add-wins semantics for concurrent add/remove
 * - LWW-Map: per-field LWW registers for structured data
 *
 * All merge operations satisfy:
 * - Commutativity: merge(A, B) === merge(B, A)
 * - Idempotency: merge(A, A) === A
 * - Associativity: merge(merge(A, B), C) === merge(A, merge(B, C))
 */

import { randomUUID } from 'node:crypto'
import { HLC } from './hlc.js'
import type { LWWRegister, ORSet, ORSetEntry, LWWMap, MergeResult } from './types.js'

export class CRDTResolver {
  constructor(private readonly hlc: HLC) {}

  // ---------------------------------------------------------------------------
  // LWW Register
  // ---------------------------------------------------------------------------

  /** Create a new LWW register with the given value and a fresh timestamp. */
  createRegister<T>(value: T): LWWRegister<T> {
    return { value, timestamp: this.hlc.now() }
  }

  /** Update a register with a new value and a fresh timestamp. */
  updateRegister<T>(_register: LWWRegister<T>, value: T): LWWRegister<T> {
    return { value, timestamp: this.hlc.now() }
  }

  /**
   * Merge two registers: the one with the later HLC timestamp wins.
   * On exact tie (same wallMs, counter, nodeId), `a` is returned.
   */
  mergeRegisters<T>(a: LWWRegister<T>, b: LWWRegister<T>): MergeResult<LWWRegister<T>> {
    const cmp = HLC.compare(a.timestamp, b.timestamp)
    if (cmp >= 0) {
      // a is later or equal — a wins
      const conflictsResolved = cmp === 0 ? 0 : 1
      return { merged: a, conflictsResolved }
    }
    // b is later
    return { merged: b, conflictsResolved: 1 }
  }

  // ---------------------------------------------------------------------------
  // OR-Set (Observed-Remove Set)
  // ---------------------------------------------------------------------------

  /** Create an empty OR-Set. */
  createSet(): ORSet {
    return { entries: {} }
  }

  /** Add a value to the set. Creates a new unique add-tag for this operation. */
  addToSet(set: ORSet, value: string): ORSet {
    const tag = randomUUID()
    const entry: ORSetEntry = { value, addTag: tag, removed: false }
    const existing = set.entries[value] ?? []
    return {
      entries: {
        ...set.entries,
        [value]: [...existing, entry],
      },
    }
  }

  /** Remove a value from the set. Marks all current entries for this value as removed. */
  removeFromSet(set: ORSet, value: string): ORSet {
    const existing = set.entries[value]
    if (!existing || existing.length === 0) return set

    return {
      entries: {
        ...set.entries,
        [value]: existing.map(e => ({ ...e, removed: true })),
      },
    }
  }

  /**
   * Merge two OR-Sets.
   *
   * For each value present in either set, union all entries by addTag.
   * An entry is removed only if it is removed in BOTH sets (add-wins semantics
   * for concurrent operations).
   */
  mergeSets(a: ORSet, b: ORSet): MergeResult<ORSet> {
    const allValues = new Set([...Object.keys(a.entries), ...Object.keys(b.entries)])
    const merged: Record<string, ORSetEntry[]> = {}
    let conflictsResolved = 0

    for (const value of allValues) {
      const aEntries = a.entries[value] ?? []
      const bEntries = b.entries[value] ?? []

      // Build a map by addTag for deduplication
      const byTag = new Map<string, ORSetEntry>()

      for (const entry of aEntries) {
        byTag.set(entry.addTag, entry)
      }

      for (const entry of bEntries) {
        const existing = byTag.get(entry.addTag)
        if (existing) {
          // Same tag in both sets: removed only if removed in BOTH (add-wins)
          const wasConflict = existing.removed !== entry.removed
          if (wasConflict) conflictsResolved++
          byTag.set(entry.addTag, {
            ...entry,
            removed: existing.removed && entry.removed,
          })
        } else {
          byTag.set(entry.addTag, entry)
        }
      }

      const entries = Array.from(byTag.values())
      if (entries.length > 0) {
        merged[value] = entries
      }
    }

    return { merged: { entries: merged }, conflictsResolved }
  }

  /** Get all active (non-removed) values from the set. */
  getSetValues(set: ORSet): string[] {
    const values: string[] = []
    for (const [value, entries] of Object.entries(set.entries)) {
      // A value is active if it has at least one non-removed entry
      const hasActive = entries.some(e => !e.removed)
      if (hasActive) {
        values.push(value)
      }
    }
    return values.sort()
  }

  // ---------------------------------------------------------------------------
  // LWW-Map (per-field LWW registers)
  // ---------------------------------------------------------------------------

  /** Create a new LWW-Map, optionally initializing from a plain object. */
  createMap(fields?: Record<string, unknown>): LWWMap {
    const result: Record<string, LWWRegister> = {}
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        result[key] = this.createRegister(value)
      }
    }
    return { fields: result }
  }

  /** Update a single field in the map with a new value and fresh timestamp. */
  updateField(map: LWWMap, field: string, value: unknown): LWWMap {
    return {
      fields: {
        ...map.fields,
        [field]: this.createRegister(value),
      },
    }
  }

  /**
   * Merge two LWW-Maps. For each field present in either map,
   * the register with the later HLC timestamp wins.
   */
  mergeMaps(a: LWWMap, b: LWWMap): MergeResult<LWWMap> {
    const allFields = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])
    const merged: Record<string, LWWRegister> = {}
    let conflictsResolved = 0

    for (const field of allFields) {
      const aReg = a.fields[field]
      const bReg = b.fields[field]

      if (aReg && bReg) {
        const result = this.mergeRegisters(aReg, bReg)
        merged[field] = result.merged
        conflictsResolved += result.conflictsResolved
      } else if (aReg) {
        merged[field] = aReg
      } else if (bReg) {
        merged[field] = bReg
      }
    }

    return { merged: { fields: merged }, conflictsResolved }
  }

  /** Extract a plain object from an LWW-Map (stripping timestamps). */
  toObject(map: LWWMap): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const [key, register] of Object.entries(map.fields)) {
      result[key] = register.value
    }
    return result
  }
}
