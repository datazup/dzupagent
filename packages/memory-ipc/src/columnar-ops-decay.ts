/**
 * Decay-related columnar operations.
 *
 * - findWeakIndices: locate rows whose `decay_strength` falls below threshold
 * - batchDecayUpdate: apply Ebbinghaus forgetting curve to compute new strengths
 * - applyHubDampeningBatch: logarithmic attenuation for over-accessed records
 */

import { type Table } from 'apache-arrow'

import { readNum } from './columnar-ops-helpers.js'

/**
 * Scan the `decay_strength` column and return row indices where the value
 * is below the given threshold. Null values are treated as NOT weak (they
 * indicate records without decay tracking).
 *
 * @param table Arrow Table conforming to MEMORY_FRAME_SCHEMA
 * @param threshold Strength threshold (default 0.1)
 * @returns Int32Array of row indices where decay_strength < threshold
 */
export function findWeakIndices(table: Table, threshold = 0.1): Int32Array {
  try {
    const col = table.getChild('decay_strength')
    if (!col) return new Int32Array(0)

    const results: number[] = []
    for (let i = 0; i < table.numRows; i++) {
      const val: unknown = col.get(i)
      if (val === null || val === undefined) continue
      const num = typeof val === 'bigint' ? Number(val) : (val as number)
      if (num < threshold) {
        results.push(i)
      }
    }
    return new Int32Array(results)
  } catch {
    return new Int32Array(0)
  }
}

/**
 * Compute updated decay strengths using the Ebbinghaus forgetting curve:
 *   strength = e^(-elapsed / halfLifeMs)
 * where elapsed = now - lastAccessedAt.
 *
 * Null `decay_half_life_ms` defaults to 86400000 (24h).
 * Null `decay_last_accessed_at` defaults to now (=> strength 1.0).
 * Missing columns => all strengths 1.0.
 *
 * @param table Arrow Table conforming to MEMORY_FRAME_SCHEMA
 * @param now Current timestamp in epoch milliseconds
 * @returns Float64Array of new strength values per row
 */
export function batchDecayUpdate(table: Table, now: number): Float64Array {
  const len = table.numRows
  const result = new Float64Array(len)

  try {
    const DEFAULT_HALF_LIFE = 86400000 // 24h in ms

    for (let i = 0; i < len; i++) {
      const halfLife = readNum(table, 'decay_half_life_ms', i, DEFAULT_HALF_LIFE)
      const lastAccess = readNum(table, 'decay_last_accessed_at', i, now)
      const elapsed = now - lastAccess
      if (elapsed <= 0 || halfLife <= 0) {
        result[i] = 1.0
      } else {
        result[i] = Math.exp(-elapsed / halfLife)
      }
    }
  } catch {
    result.fill(1.0)
  }

  return result
}

/**
 * Logarithmic attenuation for over-accessed records (hub dampening).
 *
 *   dampened = score * (1 / (1 + log(1 + accessCount / threshold)))
 *
 * Reads `decay_access_count` from the table. Null access count treated as 0.
 *
 * @param table Arrow Table conforming to MEMORY_FRAME_SCHEMA
 * @param scores Base scores to dampen
 * @param config Hub dampening configuration
 * @returns Float64Array of dampened scores
 */
export function applyHubDampeningBatch(
  table: Table,
  scores: Float64Array,
  config?: { accessThreshold?: number },
): Float64Array {
  const len = table.numRows
  const dampened = new Float64Array(len)

  try {
    const threshold = config?.accessThreshold ?? 10

    for (let i = 0; i < len; i++) {
      const accessCount = readNum(table, 'decay_access_count', i, 0)
      const score = i < scores.length ? (scores[i] ?? 0) : 0
      const dampeningFactor = 1 / (1 + Math.log(1 + accessCount / threshold))
      dampened[i] = score * dampeningFactor
    }
  } catch {
    // Return zeros on error
  }

  return dampened
}
