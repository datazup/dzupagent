/**
 * Iteration budget tracker — accumulates per-node cost contributions and
 * decides whether a budget threshold warning event should be emitted.
 *
 * This is extracted as a small invariant-preserving seam so the runtime's
 * budget logic can be tested in isolation. The runtime owns event emission
 * and state mutation; this helper owns the accounting and threshold rules.
 *
 * Invariants (preserved from the original `if/else if` block in the runtime):
 *   - At most ONE warning fires per call.
 *   - The 90% warning fires at most once across the run, on the first
 *     call where cumulative cost reaches >=90% AND `warn_90` has not yet
 *     fired.
 *   - The 70% warning fires at most once across the run, on the first
 *     call where (a) cumulative cost reaches >=70%, (b) `warn_70` has
 *     not yet fired, AND (c) the same call did not already fire `warn_90`.
 *     Concretely: if a single contribution jumps from <70% to >=90%,
 *     `warn_90` fires and `warn_70` stays unset (so a later sub-90%
 *     step could still fire `warn_70` — this matches the existing
 *     runtime behaviour and is intentionally preserved).
 *   - Zero or negative cost contributions never advance the cumulative
 *     total and never trigger a warning.
 *
 * @module pipeline/pipeline-runtime/iteration-budget-tracker
 */

/** Mutable state owned by the caller (runtime) and updated by `applyCost`. */
export interface BudgetTrackerState {
  /** Total cost in cents accumulated across the run so far. */
  cumulativeCostCents: number
  /** Whether each one-shot warning has already fired. */
  warnings: { warn70: boolean; warn90: boolean }
}

/** Outcome of accounting a single cost contribution. */
export interface BudgetThresholdDecision {
  /** Updated cumulative cost (also written back into the supplied state). */
  cumulativeCostCents: number
  /** Threshold that just crossed, if any. */
  warning: 'warn_70' | 'warn_90' | undefined
}

/** Build a fresh tracker state with zero cost and no warnings emitted. */
export function createBudgetTrackerState(): BudgetTrackerState {
  return { cumulativeCostCents: 0, warnings: { warn70: false, warn90: false } }
}

/**
 * Accumulate `costCents` into `state` and decide whether a single warning
 * threshold has just been crossed.
 *
 * The function MUTATES `state` to keep the runtime's existing semantics:
 * the runtime stores cumulative cost and warning flags as fields on its
 * own instance, so this helper writes directly through.
 *
 * @param state      Mutable tracker state
 * @param costCents  Cost contribution from the just-completed node
 * @param maxCostCents Total budget in cents (positive)
 * @returns          Updated cost and (at most) one warning level
 */
export function applyCost(
  state: BudgetTrackerState,
  costCents: number,
  maxCostCents: number,
): BudgetThresholdDecision {
  // Match the runtime's gating behaviour: zero-or-negative contributions
  // never advance the budget or fire a warning.
  if (costCents <= 0) {
    return { cumulativeCostCents: state.cumulativeCostCents, warning: undefined }
  }

  // Guard against a non-positive budget. Returning early keeps the helper
  // total and avoids divide-by-zero / negative-percentage anomalies.
  if (maxCostCents <= 0) {
    state.cumulativeCostCents += costCents
    return { cumulativeCostCents: state.cumulativeCostCents, warning: undefined }
  }

  state.cumulativeCostCents += costCents
  const pct = state.cumulativeCostCents / maxCostCents

  // Order matches the runtime's original `if/else if`: 90% wins over 70%
  // when both thresholds cross in the same step.
  if (pct >= 0.9 && !state.warnings.warn90) {
    state.warnings.warn90 = true
    return { cumulativeCostCents: state.cumulativeCostCents, warning: 'warn_90' }
  }

  if (pct >= 0.7 && !state.warnings.warn70) {
    state.warnings.warn70 = true
    return { cumulativeCostCents: state.cumulativeCostCents, warning: 'warn_70' }
  }

  return { cumulativeCostCents: state.cumulativeCostCents, warning: undefined }
}
