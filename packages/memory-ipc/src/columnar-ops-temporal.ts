/**
 * Temporal and partitioning operations over Arrow Tables.
 *
 * - temporalMask: bitmask for asOf / validAt queries
 * - applyMask: filter a Table by a Uint8Array mask
 * - partitionByNamespace: group rows by `namespace` column into per-namespace Tables
 */

import { type Table } from 'apache-arrow'

import { readNum, takeRows } from './columnar-ops-helpers.js'

/**
 * Create a bitmask for records matching a temporal query.
 *
 * - `asOf`: system time point. Record matches if system_created_at <= asOf
 *   AND (system_expired_at IS NULL OR system_expired_at > asOf).
 * - `validAt`: validity time point. Record matches if valid_from <= validAt
 *   AND (valid_until IS NULL OR valid_until > validAt).
 *
 * If both are provided, BOTH conditions must be satisfied.
 * If neither is provided, all records match.
 *
 * @returns Uint8Array bitmask (1=matches, 0=filtered)
 */
export function temporalMask(
  table: Table,
  query: { asOf?: number; validAt?: number },
): Uint8Array {
  const len = table.numRows
  const mask = new Uint8Array(len)

  try {
    mask.fill(1)

    if (query.asOf !== undefined) {
      const asOf = query.asOf
      for (let i = 0; i < len; i++) {
        if (mask[i] === 0) continue
        const created = readNum(table, 'system_created_at', i, 0)
        if (created > asOf) {
          mask[i] = 0
          continue
        }
        const expiredCol = table.getChild('system_expired_at')
        if (expiredCol) {
          const raw: unknown = expiredCol.get(i)
          if (raw !== null && raw !== undefined) {
            const expired = typeof raw === 'bigint' ? Number(raw) : (raw as number)
            if (expired <= asOf) {
              mask[i] = 0
            }
          }
        }
      }
    }

    if (query.validAt !== undefined) {
      const validAt = query.validAt
      for (let i = 0; i < len; i++) {
        if (mask[i] === 0) continue
        const validFrom = readNum(table, 'valid_from', i, 0)
        if (validFrom > validAt) {
          mask[i] = 0
          continue
        }
        const validUntilCol = table.getChild('valid_until')
        if (validUntilCol) {
          const raw: unknown = validUntilCol.get(i)
          if (raw !== null && raw !== undefined) {
            const until = typeof raw === 'bigint' ? Number(raw) : (raw as number)
            if (until <= validAt) {
              mask[i] = 0
            }
          }
        }
      }
    }
  } catch {
    mask.fill(0)
  }

  return mask
}

/**
 * Filter a Table using a bitmask. Returns a new Table containing only
 * the rows where mask[i] === 1.
 *
 * @param table Source Arrow Table
 * @param mask Uint8Array bitmask (1=keep, 0=filter)
 * @returns New Table with only matching rows
 */
export function applyMask(table: Table, mask: Uint8Array): Table {
  try {
    const indices: number[] = []
    const limit = Math.min(mask.length, table.numRows)
    for (let i = 0; i < limit; i++) {
      if (mask[i]) {
        indices.push(i)
      }
    }
    return takeRows(table, indices)
  } catch {
    return takeRows(table, [])
  }
}

/**
 * Group rows by the `namespace` column into separate Tables.
 *
 * @returns Map from namespace string to Table containing only rows with that namespace
 */
export function partitionByNamespace(table: Table): Map<string, Table> {
  const result = new Map<string, Table>()

  try {
    const col = table.getChild('namespace')
    if (!col || table.numRows === 0) return result

    const groups = new Map<string, number[]>()
    for (let i = 0; i < table.numRows; i++) {
      const ns = String(col.get(i) ?? 'unknown')
      let group = groups.get(ns)
      if (!group) {
        group = []
        groups.set(ns, group)
      }
      group.push(i)
    }

    for (const [ns, indices] of groups) {
      result.set(ns, takeRows(table, indices))
    }
  } catch {
    // Return empty map on error
  }

  return result
}
