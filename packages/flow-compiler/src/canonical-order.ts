/**
 * @dzupagent/flow-compiler — host-independent ordering for digested arrays
 * (internal).
 *
 * `@dzupagent/canonical-json` canonicalizes object *key* order with a UTF-16
 * code-unit comparator and documents why: `localeCompare` varies with the
 * host ICU locale (the bug fixed by ARCH27-T-01). It cannot canonicalize
 * array *element* order, though — that is whatever order the producer emitted.
 *
 * Any array that feeds a persisted digest, or whose order a validator
 * re-checks on admission, must therefore be ordered by this comparator and
 * never by `localeCompare`. The difference is observable with plain ASCII
 * identifiers: `["ab","aa","Ax","ax"]` collates to `["aa","ab","ax","Ax"]`
 * under en_US and to `["ab","Ax","ax","aa"]` under da_DK.
 */

/** UTF-16 code-unit comparison; deliberately not `localeCompare`. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Compare two `[key, value]` entries by their key in code-unit order. */
export function compareEntryKeys(
  left: readonly [string, unknown],
  right: readonly [string, unknown],
): number {
  return compareCodeUnits(left[0], right[0]);
}
