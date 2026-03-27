/**
 * Built-in condition functions for pipeline phase execution.
 *
 * Each factory returns a predicate `(state) => boolean` suitable for
 * use as the `condition` field on a PhaseConfig.
 */

type StatePredicate = (state: Record<string, unknown>) => boolean

/** Run only if state has a specific key with a truthy value. */
export function hasKey(key: string): StatePredicate {
  return (state) => key in state && state[key] !== undefined && state[key] !== null
}

/** Run only if a previous phase succeeded (was completed, not skipped/failed). */
export function previousSucceeded(phaseId: string): StatePredicate {
  return (state) => state[`__phase_${phaseId}_completed`] === true
}

/** Run only if a state value strictly equals the given value. */
export function stateEquals(key: string, value: unknown): StatePredicate {
  return (state) => state[key] === value
}

/** Run only if `files` (string[]) in state has at least one entry matching the pattern. */
export function hasFilesMatching(pattern: RegExp): StatePredicate {
  return (state) => {
    const files = state['files']
    if (!Array.isArray(files)) return false
    return files.some(
      (f: unknown) => typeof f === 'string' && pattern.test(f),
    )
  }
}

/** Combine conditions with AND -- all must be true. */
export function allOf(...conditions: StatePredicate[]): StatePredicate {
  return (state) => conditions.every((c) => c(state))
}

/** Combine conditions with OR -- at least one must be true. */
export function anyOf(...conditions: StatePredicate[]): StatePredicate {
  return (state) => conditions.some((c) => c(state))
}
