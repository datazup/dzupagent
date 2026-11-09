/**
 * Segment-exact namespace matching for items returned by `BaseStore.search`.
 *
 * `PostgresStore.search(prefix)` (without a vector index) binds
 * `namespace_path LIKE '<prefix joined by ":">%'`. That is a string prefix,
 * not a segment prefix: the query `['memories', 't1']` also returns rows
 * stored under `['memories', 't10']`. Every caller that reads or deletes by a
 * namespace prefix must therefore check each returned item's own `namespace`
 * segment by segment. These two predicates are the single place that check
 * lives (MEMCTX-PG-RETENTION-20261108-R1, MC-05b).
 *
 * Fail closed: an item that carries no `namespace` array matches neither
 * predicate. Callers drop it from reads and never delete it.
 *
 * Limit: the guarantee holds only for labels without `:`. Postgres stores the
 * labels joined by `:` and rebuilds a returned namespace with `split(":")`, so
 * `['memories', 't1:u1']` and `['memories', 't1', 'u1']` share one stored path
 * and come back identical. No check on a returned namespace can tell them
 * apart.
 */

/** The minimal shape the predicates read: an optional `namespace` array. */
export interface NamespacedItem {
  namespace?: readonly string[] | undefined
}

function itemNamespace(item: NamespacedItem | null | undefined): readonly string[] | undefined {
  if (item == null) return undefined
  const ns = (item as { namespace?: unknown }).namespace
  if (!Array.isArray(ns)) return undefined
  return ns as readonly string[]
}

/**
 * `true` when `item.namespace` equals `tuple` exactly, segment by segment.
 * An item without a `namespace` array never matches.
 */
export function namespaceEquals<T extends NamespacedItem>(
  item: T | null | undefined,
  tuple: readonly string[],
): item is T & { namespace: string[] } {
  const ns = itemNamespace(item)
  if (ns === undefined) return false
  if (ns.length !== tuple.length) return false
  for (let i = 0; i < tuple.length; i++) {
    if (ns[i] !== tuple[i]) return false
  }
  return true
}

/**
 * `true` when `item.namespace` is `prefix` itself or any descendant of it,
 * compared segment by segment (`['t1']` is not under `['t10']`). An item
 * without a `namespace` array never matches.
 */
export function namespaceUnder<T extends NamespacedItem>(
  item: T | null | undefined,
  prefix: readonly string[],
): item is T & { namespace: string[] } {
  const ns = itemNamespace(item)
  if (ns === undefined) return false
  if (ns.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (ns[i] !== prefix[i]) return false
  }
  return true
}
