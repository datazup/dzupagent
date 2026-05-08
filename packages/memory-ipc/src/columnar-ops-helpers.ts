/**
 * Internal helpers for columnar Arrow Table operations.
 *
 * - Safe numeric/string readers that handle BigInt (Int64) and null/undefined
 * - Row-selection that reconstructs a Table from arbitrary row indices
 *
 * All functions are pure and tolerate empty tables / missing columns.
 */

import { type Table, tableFromArrays } from 'apache-arrow'

/**
 * Safely read a numeric value from a column at a given row index.
 * Handles BigInt (Int64) by converting to Number, and returns the
 * provided default if the value is null/undefined.
 */
export function readNum(
  table: Table,
  columnName: string,
  row: number,
  defaultValue: number,
): number {
  const col = table.getChild(columnName)
  if (!col) return defaultValue
  const raw: unknown = col.get(row)
  if (raw === null || raw === undefined) return defaultValue
  return typeof raw === 'bigint' ? Number(raw) : (raw as number)
}

/**
 * Safely read a string value from a column at a given row index.
 * Returns the provided default if the value is null/undefined.
 */
export function readStr(
  table: Table,
  columnName: string,
  row: number,
  defaultValue: string | null = null,
): string | null {
  const col = table.getChild(columnName)
  if (!col) return defaultValue
  const raw: unknown = col.get(row)
  if (raw === null || raw === undefined) return defaultValue
  return String(raw)
}

/**
 * Build a new Table by selecting specific row indices from the source table.
 * Iterates each column, extracts values at the given indices, and reconstructs
 * the table via `tableFromArrays`.
 */
export function takeRows(table: Table, indices: number[]): Table {
  if (indices.length === 0 || table.numRows === 0) {
    // Return an empty table preserving column names
    const empty: Record<string, unknown[]> = {}
    for (const field of table.schema.fields) {
      empty[field.name] = []
    }
    return tableFromArrays(empty)
  }

  const data: Record<string, unknown[]> = {}
  for (const field of table.schema.fields) {
    const col = table.getChild(field.name)
    if (!col) {
      data[field.name] = indices.map(() => null)
      continue
    }
    data[field.name] = indices.map((i) => col.get(i) as unknown)
  }

  return tableFromArrays(data)
}
