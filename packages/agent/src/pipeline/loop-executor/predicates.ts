/**
 * Built-in continue-predicate factories for {@link executeLoop}.
 *
 * @module pipeline/loop-executor/predicates
 */

/**
 * Creates a predicate that returns true when the given state field is truthy.
 */
export function stateFieldTruthy(
  field: string
): (state: Record<string, unknown>) => boolean {
  return (state) => Boolean(state[field]);
}

/**
 * Creates a predicate that returns true when the given numeric state field
 * is below the threshold (i.e., quality not yet reached — keep looping).
 */
export function qualityBelow(
  field: string,
  threshold: number
): (state: Record<string, unknown>) => boolean {
  return (state) => {
    const value = state[field];
    if (typeof value !== "number") return true;
    return value < threshold;
  };
}

/**
 * Creates a predicate that returns true when the given state field
 * is an array with at least one element (errors still present — keep looping).
 */
export function hasErrors(
  field: string
): (state: Record<string, unknown>) => boolean {
  return (state) => {
    const value = state[field];
    if (!Array.isArray(value)) return false;
    return value.length > 0;
  };
}
