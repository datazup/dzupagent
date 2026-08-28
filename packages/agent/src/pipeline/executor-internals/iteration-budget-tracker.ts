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
 *   - Reaching >=100% of the budget reports `exceeded`, which takes
 *     precedence over both warnings and — unlike them — is NOT one-shot:
 *     it is re-reported on every subsequent call. The caller aborts the
 *     run on this signal.
 *   - A non-positive `maxCostCents` means "no budget configured" and can
 *     never report `exceeded`.
 *
 * @module pipeline/executor-internals/iteration-budget-tracker
 */

/** Mutable state owned by the caller (runtime) and updated by `applyCost`. */
export interface BudgetTrackerState {
  /** Total cost in cents accumulated across the run so far. */
  cumulativeCostCents: number;
  /** Whether each one-shot warning has already fired. */
  warnings: { warn70: boolean; warn90: boolean };
}

/** Outcome of accounting a single cost contribution. */
export interface BudgetThresholdDecision {
  /** Updated cumulative cost (also written back into the supplied state). */
  cumulativeCostCents: number;
  /** Threshold that just crossed, if any. */
  warning: "warn_70" | "warn_90" | "exceeded" | undefined;
  /**
   * True when cumulative cost has reached or passed 100% of the budget.
   * Unlike the advisory warnings this is NOT one-shot: it stays true for
   * every subsequent call so a caller can never lose the signal by
   * checking late. The caller is responsible for aborting the run.
   */
  exceeded: boolean;
}

/** Build a fresh tracker state with zero cost and no warnings emitted. */
export function createBudgetTrackerState(): BudgetTrackerState {
  return { cumulativeCostCents: 0, warnings: { warn70: false, warn90: false } };
}

/**
 * Restore the cost accumulator from a durable checkpoint.
 *
 * Warning flags are derived from the restored percentage so a resumed run
 * never re-emits advisory thresholds that were already crossed before the
 * checkpoint. The canonical checkpoint stores the cumulative cost, not the
 * runtime-only one-shot flags.
 */
export function restoreBudgetTrackerState(
  cumulativeCostCents: number,
  maxCostCents: number
): BudgetTrackerState {
  if (!Number.isFinite(cumulativeCostCents) || cumulativeCostCents < 0) {
    throw new Error(
      `Cannot restore iteration budget: costCents must be a finite non-negative number, received ${String(cumulativeCostCents)}`
    );
  }

  const percentage =
    maxCostCents > 0 ? cumulativeCostCents / maxCostCents : 0;
  return {
    cumulativeCostCents,
    warnings: {
      warn70: percentage >= 0.7,
      warn90: percentage >= 0.9,
    },
  };
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
  maxCostCents: number
): BudgetThresholdDecision {
  // Match the runtime's gating behaviour: zero-or-negative contributions
  // never advance the budget or fire a warning.
  if (costCents <= 0) {
    return {
      cumulativeCostCents: state.cumulativeCostCents,
      warning: undefined,
      exceeded: false,
    };
  }

  // Guard against a non-positive budget. Returning early keeps the helper
  // total and avoids divide-by-zero / negative-percentage anomalies.
  //
  // NOTE: a non-positive budget means "no budget configured", NOT "budget
  // instantly exhausted". Reporting `exceeded` here would abort every
  // pipeline in a deployment that leaves `maxCostCents` unset.
  if (maxCostCents <= 0) {
    state.cumulativeCostCents += costCents;
    return {
      cumulativeCostCents: state.cumulativeCostCents,
      warning: undefined,
      exceeded: false,
    };
  }

  state.cumulativeCostCents += costCents;
  const pct = state.cumulativeCostCents / maxCostCents;

  // Checked BEFORE the 0.9 branch so a single contribution that jumps
  // straight past 100% reports `exceeded` rather than `warn_90`.
  //
  // Deliberately NOT one-shot and not gated on a `warnings` flag: once the
  // budget is blown every subsequent call keeps reporting it, so a caller
  // that starts checking late still sees the breach.
  if (pct >= 1) {
    // Mark the advisory flags as spent — the run is aborting, and a
    // later sub-90% step must not emit a stale "warning" after the
    // budget has already been reported as exceeded.
    state.warnings.warn90 = true;
    state.warnings.warn70 = true;
    return {
      cumulativeCostCents: state.cumulativeCostCents,
      warning: "exceeded",
      exceeded: true,
    };
  }

  // Order matches the runtime's original `if/else if`: 90% wins over 70%
  // when both thresholds cross in the same step.
  if (pct >= 0.9 && !state.warnings.warn90) {
    state.warnings.warn90 = true;
    return {
      cumulativeCostCents: state.cumulativeCostCents,
      warning: "warn_90",
      exceeded: false,
    };
  }

  if (pct >= 0.7 && !state.warnings.warn70) {
    state.warnings.warn70 = true;
    return {
      cumulativeCostCents: state.cumulativeCostCents,
      warning: "warn_70",
      exceeded: false,
    };
  }

  return {
    cumulativeCostCents: state.cumulativeCostCents,
    warning: undefined,
    exceeded: false,
  };
}
