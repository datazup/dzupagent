/**
 * Apache Arrow interop helpers for the LanceDB adapter.
 *
 * apache-arrow is an optional peer dependency -- these helpers use a dynamic
 * import and gracefully degrade when the library is unavailable.
 */

import { logger } from "../../logging/secure-logger.js";

/** Minimal Apache Arrow library shape */
export interface ArrowLib {
  Table: { isTable?: (obj: unknown) => boolean };
  tableToIPC?: (table: unknown) => unknown;
}

let warnedArrowUnavailable = false;

/** Try to dynamically import apache-arrow */
export async function tryImportArrow(): Promise<ArrowLib | null> {
  try {
    // Literal specifier so dependency scanners see this optional-peer edge;
    // laziness is preserved by the dynamic import, and the module shape comes
    // from the local ambient declaration (optional-peer-modules.d.ts).
    const mod = (await import(
      /* webpackIgnore: true */ "apache-arrow"
    )) as unknown as ArrowLib;
    return mod;
  } catch {
    if (!warnedArrowUnavailable) {
      warnedArrowUnavailable = true;
      logger.warn(
        'optional peer "apache-arrow" is unavailable: LanceDB Arrow-table detection degrades to duck-typing and IPC conversion is disabled',
      );
    }
    return null;
  }
}

/** Check if a value is an Apache Arrow Table */
export function isArrowTable(value: unknown, arrowLib: ArrowLib): boolean {
  const isTableFn = arrowLib.Table?.isTable;
  if (typeof isTableFn === "function") {
    return isTableFn(value);
  }
  // Duck-type check as fallback
  return (
    value !== null &&
    typeof value === "object" &&
    "schema" in value &&
    "toArray" in value
  );
}

/** Convert an Arrow Table to an array of row objects */
export function arrowTableToRows(
  table: unknown,
  _arrowLib: ArrowLib,
): Record<string, unknown>[] {
  // Arrow Table has a toArray() method or iterable rows
  const t = table as {
    toArray?: () => Record<string, unknown>[];
    [Symbol.iterator]?: () => Iterator<Record<string, unknown>>;
  };
  if (typeof t.toArray === "function") {
    return t.toArray();
  }
  if (t[Symbol.iterator]) {
    return [...(t as Iterable<Record<string, unknown>>)];
  }
  return [];
}
