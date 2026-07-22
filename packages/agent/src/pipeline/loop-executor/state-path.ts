/**
 * JSON-path state read/write utilities shared by the loop executors.
 *
 * Supports `$.a.b`, `$a.b`, and bare `a.b` path notation. Reads report
 * whether the leaf was found; writes create intermediate object segments
 * as needed (replacing non-object/array segments).
 *
 * @module pipeline/loop-executor/state-path
 */

export interface ResolvedStateValue {
  found: boolean;
  value: unknown;
}

function normalizePath(source: string): string {
  return source.startsWith("$.")
    ? source.slice(2)
    : source.startsWith("$")
    ? source.slice(1)
    : source;
}

export function resolveStatePath(
  state: Record<string, unknown>,
  source: string
): ResolvedStateValue {
  const path = normalizePath(source);
  if (path.length === 0) {
    return { found: true, value: state };
  }

  let cursor: unknown = state;
  for (const segment of path.split(".").filter(Boolean)) {
    if (
      typeof cursor !== "object" ||
      cursor === null ||
      !Object.prototype.hasOwnProperty.call(cursor, segment)
    ) {
      return { found: false, value: undefined };
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return { found: true, value: cursor };
}

export function setStatePath(
  state: Record<string, unknown>,
  source: string,
  value: unknown
): void {
  const path = normalizePath(source);
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) return;

  let cursor: Record<string, unknown> = state;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      const replacement: Record<string, unknown> = {};
      cursor[segment] = replacement;
      cursor = replacement;
      continue;
    }
    cursor = next as Record<string, unknown>;
  }

  cursor[segments[segments.length - 1]!] = value;
}
