/**
 * Strict-shape check: true when `value` has exactly the own enumerable keys in
 * `expected` (order-insensitive). Keys are compared element-wise, so a key
 * containing a separator character (for example `'a|b'`) never matches two
 * separate expected keys.
 */
export function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}
