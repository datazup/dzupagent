/**
 * ArrowBlackboard — Arrow-based blackboard for pipeline coordination.
 *
 * Provides a shared data space where designated writer agents append records
 * to named tables, and any agent can read. Uses in-memory Map storage.
 *
 * Each table has a single designated writer (by agent URI). Write attempts
 * from non-designated writers are rejected with an error.
 */

import { type Table, tableFromArrays } from 'apache-arrow'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Definition for a single blackboard table. */
export interface BlackboardTableDef {
  /** Agent URI that has exclusive write access to this table. */
  writer: string
}

/** Configuration for the blackboard. */
export interface BlackboardConfig {
  /** Table definitions: name to writer mapping. */
  tables: Record<string, BlackboardTableDef>
}

/** Snapshot of a blackboard table's current state. */
export interface BlackboardSnapshot {
  table: Table
  writeSeq: number
  lastWriteAt: number
}

/** Internal storage entry for a blackboard table. */
interface TableEntry {
  table: Table
  writeSeq: number
  lastWriteAt: number
}

// ---------------------------------------------------------------------------
// ArrowBlackboard
// ---------------------------------------------------------------------------

/**
 * Arrow-based blackboard for inter-agent pipeline coordination.
 *
 * Usage:
 * ```ts
 * const bb = new ArrowBlackboard({
 *   tables: {
 *     'plan': { writer: 'agent://planner' },
 *     'results': { writer: 'agent://executor' },
 *   },
 * })
 *
 * // Planner writes to 'plan'
 * bb.append('plan', 'agent://planner', planTable)
 *
 * // Executor reads 'plan', writes to 'results'
 * const plan = bb.read('plan')
 * bb.append('results', 'agent://executor', resultTable)
 * ```
 */
export class ArrowBlackboard {
  private readonly config: BlackboardConfig
  private readonly tableData = new Map<string, TableEntry>()

  constructor(config: BlackboardConfig) {
    this.config = config
  }

  /**
   * Append records to a blackboard table.
   *
   * Only the designated writer (as defined in config) can call this.
   * If the table already has data, the new records are concatenated
   * with the existing ones.
   *
   * @param tableName Name of the blackboard table
   * @param writerUri URI of the agent attempting to write
   * @param records Arrow Table containing records to append
   * @throws Error if writerUri does not match the configured writer
   * @throws Error if tableName is not defined in config
   */
  append(tableName: string, writerUri: string, records: Table): void {
    const def = this.config.tables[tableName]
    if (!def) {
      throw new Error(
        `Blackboard table "${tableName}" is not defined in config`,
      )
    }

    if (def.writer !== writerUri) {
      throw new Error(
        `Writer "${writerUri}" is not authorized to write to table "${tableName}" (expected "${def.writer}")`,
      )
    }

    const existing = this.tableData.get(tableName)

    if (!existing) {
      // First write: store directly
      this.tableData.set(tableName, {
        table: records,
        writeSeq: 1,
        lastWriteAt: Date.now(),
      })
      return
    }

    // Concatenate existing table with new records
    const merged = concatTables(existing.table, records)
    this.tableData.set(tableName, {
      table: merged,
      writeSeq: existing.writeSeq + 1,
      lastWriteAt: Date.now(),
    })
  }

  /**
   * Read a table. Any agent can read.
   *
   * @param tableName Name of the blackboard table
   * @returns Snapshot of the table, or null if not written yet
   */
  read(tableName: string): BlackboardSnapshot | null {
    const entry = this.tableData.get(tableName)
    if (!entry) return null

    return {
      table: entry.table,
      writeSeq: entry.writeSeq,
      lastWriteAt: entry.lastWriteAt,
    }
  }

  /**
   * Check if there is new data since the given sequence number.
   *
   * @param tableName Name of the blackboard table
   * @param lastSeenSeq The last sequence number the caller observed
   * @returns true if the table's writeSeq is greater than lastSeenSeq
   */
  hasUpdates(tableName: string, lastSeenSeq: number): boolean {
    const entry = this.tableData.get(tableName)
    if (!entry) return false
    return entry.writeSeq > lastSeenSeq
  }

  /**
   * Get the current write sequence for a table.
   *
   * @param tableName Name of the blackboard table
   * @returns Current write sequence, or 0 if not written yet
   */
  getWriteSeq(tableName: string): number {
    const entry = this.tableData.get(tableName)
    return entry?.writeSeq ?? 0
  }

  /**
   * Dispose all stored data and clear the blackboard.
   */
  dispose(): void {
    this.tableData.clear()
  }
}

// ---------------------------------------------------------------------------
// Internal: table concatenation
// ---------------------------------------------------------------------------

/**
 * Concatenate two Arrow Tables by column. Both tables must have compatible
 * schemas (same column names). Columns from table B are appended after table A.
 */
function concatTables(a: Table, b: Table): Table {
  if (a.numRows === 0) return b
  if (b.numRows === 0) return a

  const columns: Record<string, unknown[]> = {}

  // Use table A's schema as the base
  for (const field of a.schema.fields) {
    const colA = a.getChild(field.name)
    const colB = b.getChild(field.name)
    const values: unknown[] = []

    // Copy from A
    if (colA) {
      for (let i = 0; i < a.numRows; i++) {
        values.push(colA.get(i) as unknown)
      }
    } else {
      for (let i = 0; i < a.numRows; i++) {
        values.push(null)
      }
    }

    // Copy from B
    if (colB) {
      for (let i = 0; i < b.numRows; i++) {
        values.push(colB.get(i) as unknown)
      }
    } else {
      for (let i = 0; i < b.numRows; i++) {
        values.push(null)
      }
    }

    columns[field.name] = values
  }

  // Also include any columns in B that are not in A
  for (const field of b.schema.fields) {
    if (columns[field.name] !== undefined) continue
    const colB = b.getChild(field.name)
    const values: unknown[] = []

    // Nulls for A's rows
    for (let i = 0; i < a.numRows; i++) {
      values.push(null)
    }

    // Copy from B
    if (colB) {
      for (let i = 0; i < b.numRows; i++) {
        values.push(colB.get(i) as unknown)
      }
    } else {
      for (let i = 0; i < b.numRows; i++) {
        values.push(null)
      }
    }

    columns[field.name] = values
  }

  return tableFromArrays(columns)
}
