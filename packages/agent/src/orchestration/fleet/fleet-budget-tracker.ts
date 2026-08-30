/**
 * Per-run budget enforcement for a fleet run.
 *
 * Both predicates return `false` ("keep going") when the corresponding budget
 * field is unset, which is what makes budget enforcement fully inert for specs
 * that declare none. `maxTokens` has no tracker at all — see its doc comment in
 * `fleet-types.ts` for why it is deliberately unenforceable here.
 *
 * @module orchestration/fleet/fleet-budget-tracker
 */
import type { FleetRunSpec, RepoAgentResult } from "@dzupagent/agent-types/fleet";

/** Per-run budget state for `FleetBudgets`. */
export interface BudgetTracker {
  /** True once `wallclockMs` has elapsed since the run started. */
  deadlinePassed(): boolean;
  /**
   * Accumulates the `tool_call` events in `results` into the run total and
   * returns true when that total now exceeds `maxToolCalls`.
   */
  recordAndCheckToolCalls(results: RepoAgentResult[]): boolean;
}

/**
 * Build the tracker for one run. `now` is injectable so tests can drive the
 * deadline deterministically instead of sleeping.
 */
export function createBudgetTracker(
  spec: FleetRunSpec,
  now: () => number
): BudgetTracker {
  const wallclockMs = spec.budgets?.wallclockMs;
  const maxToolCalls = spec.budgets?.maxToolCalls;
  // Snapshot the start instant once so every later check compares against the
  // same origin (an injected clock may advance on every read).
  const startedAt = now();
  let toolCalls = 0;

  return {
    deadlinePassed(): boolean {
      if (wallclockMs === undefined) return false;
      return now() - startedAt > wallclockMs;
    },
    recordAndCheckToolCalls(results: RepoAgentResult[]): boolean {
      // Always accumulate, even when no cap is set: the count is cheap and
      // keeping it unconditional avoids a second code path.
      for (const result of results) {
        for (const event of result.events) {
          if (event.kind === "tool_call") toolCalls += 1;
        }
      }
      if (maxToolCalls === undefined) return false;
      return toolCalls > maxToolCalls;
    },
  };
}
