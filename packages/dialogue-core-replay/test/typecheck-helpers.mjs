/**
 * Returns an array or object as an intentionally mutable record for hostile
 * boundary-input construction. The production decoder still receives it as
 * untrusted input.
 *
 * @param {unknown} value
 * @returns {Record<PropertyKey, unknown>}
 */
export function mutableRecord(value) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    throw new TypeError("Expected a mutable object-like test value.");
  }
  return /** @type {Record<PropertyKey, unknown>} */ (value);
}

/**
 * Narrows setup data that is known to exist while retaining a useful runtime
 * failure if a fixture builder changes.
 *
 * @template T
 * @param {T | null | undefined} value
 * @param {string} [label]
 * @returns {T}
 */
export function required(value, label = "test value") {
  if (value === undefined || value === null) {
    throw new TypeError(`Missing required ${label}.`);
  }
  return value;
}
