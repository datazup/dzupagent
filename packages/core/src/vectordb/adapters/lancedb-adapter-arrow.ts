/**
 * Apache Arrow interop helpers for the LanceDB adapter.
 *
 * apache-arrow is an optional peer dependency -- these helpers use a dynamic
 * import and gracefully degrade when the library is unavailable.
 */

/** Minimal Apache Arrow library shape */
export interface ArrowLib {
  Table: { isTable?: (obj: unknown) => boolean }
  tableToIPC?: (table: unknown) => unknown
}

/** Try to dynamically import apache-arrow */
export async function tryImportArrow(): Promise<ArrowLib | null> {
  try {
    // Using string variable to prevent TypeScript from resolving the module at compile time.
    const moduleName = 'apache-arrow'
    const mod = (await import(/* webpackIgnore: true */ moduleName)) as unknown as ArrowLib
    return mod
  } catch {
    return null
  }
}

/** Check if a value is an Apache Arrow Table */
export function isArrowTable(value: unknown, arrowLib: ArrowLib): boolean {
  const isTableFn = arrowLib.Table?.isTable
  if (typeof isTableFn === 'function') {
    return isTableFn(value)
  }
  // Duck-type check as fallback
  return (
    value !== null &&
    typeof value === 'object' &&
    'schema' in value &&
    'toArray' in value
  )
}

/** Convert an Arrow Table to an array of row objects */
export function arrowTableToRows(
  table: unknown,
  _arrowLib: ArrowLib,
): Record<string, unknown>[] {
  // Arrow Table has a toArray() method or iterable rows
  const t = table as {
    toArray?: () => Record<string, unknown>[]
    [Symbol.iterator]?: () => Iterator<Record<string, unknown>>
  }
  if (typeof t.toArray === 'function') {
    return t.toArray()
  }
  if (t[Symbol.iterator]) {
    return [...(t as Iterable<Record<string, unknown>>)]
  }
  return []
}
