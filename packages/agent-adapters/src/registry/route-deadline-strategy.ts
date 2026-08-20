import type {
  ExecutionRouteCandidate,
  ExecutionRoutePolicy,
} from "@dzupagent/runtime-contracts";

/**
 * Explicit strategy deadline and deterministic deadline fallback.
 *
 * `ExecutionRoutePolicy.maxSelectionLatencyMs` has always been a *declared*
 * budget that nothing enforced. This module enforces it — without giving up the
 * property the rest of the selection path is built on: selection is a pure
 * function of its recorded inputs.
 *
 * ## Why there is no clock here
 *
 * A deadline is a temporal concept and reading a clock is the obvious way to
 * implement one — and the obvious way to destroy replayability, because the
 * second run reads a different clock and can reach a different decision. So the
 * elapsed time is *not measured here*: the host measures its own selection work
 * and passes the result in as `options.strategyElapsedMs`, exactly as it
 * already passes `decidedAt`, `seed`, `routingKey` and `roundRobinCursor`.
 *
 * There is therefore no `Date.now()`, no `performance.now()`, no timer, no
 * `AbortSignal` and no module- or instance-level state in this module or on the
 * selection path. The elapsed value is an input, the verdict is a pure function
 * of (elapsed, budget), and both the input and the verdict are recorded in the
 * selection receipt. Replaying a receipt reproduces the identical decision with
 * no clock available at all.
 *
 * ## Verdicts
 *
 * - `not-evaluated` — the host declared no elapsed time. The deadline is not
 *   enforced and the receipt says so explicitly rather than recording a
 *   `within` verdict it did not earn. This keeps the deadline strictly
 *   additive: callers that predate it are unaffected and are not silently
 *   reported as having met a budget nobody measured.
 * - `within` — `elapsed <= budget`. The budget is inclusive: a "maximum
 *   selection latency" of 25ms is met by a selection that took exactly 25ms.
 * - `exceeded` — `elapsed > budget`. The strategy blew its declared budget, so
 *   its pick is discarded and the deadline fallback decides instead.
 *
 * ## The deterministic fallback rule
 *
 * On `exceeded` the strategy's own draw is *not* consulted: the strategy is
 * precisely what missed its budget, so honouring a late seeded/rotating pick
 * would be honouring the thing that failed. The pick is re-derived from the
 * policy's declared fallback instead:
 *
 * - `fallback: "ordered-compatible"` selects the **head of the ordered
 *   compatible chain** — the eligible candidate with the lowest
 *   `preferenceOrder` rank, ties broken by canonical id order. This is a
 *   defined ordering rule over the policy, never the input array order, so
 *   re-declaring the candidates in a different order cannot move the fallback.
 * - `fallback: "none"` selects nothing. A breached deadline with no declared
 *   fallback is fail-closed: the decision records `selectedCandidateId: null`
 *   rather than throwing, so the breach itself stays auditable and replayable
 *   instead of vanishing into an exception.
 * - Any other `fallback` value is undeclared and fails closed as an admission
 *   error — it is never treated as "none by default".
 *
 * Like the seeded and round-robin strategy modules, nothing here throws: each
 * guard returns a typed failure so the selector keeps sole ownership of the
 * admission-error vocabulary.
 */

export type RouteDeadlineFailureCode =
  | "ROUTE_DEADLINE_INVALID_ELAPSED"
  | "ROUTE_DEADLINE_NEGATIVE_ELAPSED"
  | "ROUTE_DEADLINE_INVALID_BUDGET"
  | "ROUTE_DEADLINE_UNDECLARED_FALLBACK";

/**
 * JSON-ish location of the rejected value, matching the `ROUTE_POLICY_*`
 * admission convention in `route-policy-admission.ts`: every deadline code
 * carries the path of the input that caused it.
 */
export interface RouteDeadlineFailure {
  readonly code: RouteDeadlineFailureCode;
  readonly path: string;
  readonly message: string;
}

export type RouteDeadlineResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: RouteDeadlineFailure };

/** Verdict of the declared strategy deadline, recorded in the receipt. */
export type RouteSelectionDeadlineOutcome =
  | "not-evaluated"
  | "within"
  | "exceeded";

/** What decides the pick once the deadline verdict is known. */
export type RouteDeadlineDisposition =
  /** Deadline met (or unmeasured): the strategy's own pick stands. */
  | { readonly kind: "strategy" }
  /** Deadline breached: the ordered-compatible chain head is selected. */
  | { readonly kind: "ordered-compatible-head" }
  /** Deadline breached and no fallback declared: nothing is selected. */
  | { readonly kind: "denied" };

/** The deadline inputs and verdict that the decision consumed. */
export type AdmittedRouteDeadline =
  | {
      readonly outcome: "not-evaluated";
      readonly elapsedMs: null;
      readonly budgetMs: null;
      readonly disposition: { readonly kind: "strategy" };
    }
  | {
      readonly outcome: "within" | "exceeded";
      readonly elapsedMs: number;
      readonly budgetMs: number;
      readonly disposition: RouteDeadlineDisposition;
    };

/**
 * Admits the declared deadline and resolves its verdict plus disposition.
 *
 * An absent elapsed time admits as `not-evaluated`. A *present* elapsed time is
 * validated strictly — a non-integer, `NaN`, `Infinity` or negative value is an
 * undeclared measurement and fails closed rather than being coerced, exactly
 * like an empty seed or an empty cursor. The budget is validated only once the
 * deadline is actually being evaluated, which keeps the guard additive: callers
 * that declare no elapsed time behave precisely as they did before the deadline
 * existed.
 */
export function admitRouteSelectionDeadline(
  policy: ExecutionRoutePolicy,
  strategyElapsedMs: number | undefined,
): RouteDeadlineResult<AdmittedRouteDeadline> {
  if (strategyElapsedMs === undefined) {
    return {
      ok: true,
      value: {
        outcome: "not-evaluated",
        elapsedMs: null,
        budgetMs: null,
        disposition: { kind: "strategy" },
      },
    };
  }

  if (!Number.isSafeInteger(strategyElapsedMs)) {
    return failure(
      "ROUTE_DEADLINE_INVALID_ELAPSED",
      "options.strategyElapsedMs",
      `Strategy elapsed time must be a safe integer count of milliseconds so the deadline verdict is replayable; received ${describe(strategyElapsedMs)}`,
    );
  }
  if (strategyElapsedMs < 0) {
    return failure(
      "ROUTE_DEADLINE_NEGATIVE_ELAPSED",
      "options.strategyElapsedMs",
      `Strategy elapsed time must not be negative; received ${strategyElapsedMs}`,
    );
  }

  const budgetMs = policy.maxSelectionLatencyMs;
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1) {
    return failure(
      "ROUTE_DEADLINE_INVALID_BUDGET",
      "policy.maxSelectionLatencyMs",
      `Route policy must declare maxSelectionLatencyMs as a safe positive integer to evaluate a strategy deadline; received ${describe(budgetMs)}`,
    );
  }

  // Inclusive budget: exactly at the limit is within it.
  const outcome = strategyElapsedMs > budgetMs ? "exceeded" : "within";
  if (outcome === "within") {
    return {
      ok: true,
      value: {
        outcome,
        elapsedMs: strategyElapsedMs,
        budgetMs,
        disposition: { kind: "strategy" },
      },
    };
  }

  const disposition = resolveBreachDisposition(policy);
  if (!disposition.ok) return disposition;
  return {
    ok: true,
    value: {
      outcome,
      elapsedMs: strategyElapsedMs,
      budgetMs,
      disposition: disposition.value,
    },
  };
}

/**
 * Maps the policy's declared fallback onto a breach disposition, fail-closed.
 *
 * The two declared values are matched exhaustively and anything else is
 * rejected: an unrecognized fallback must never degrade into "none", because a
 * host that meant to declare a fallback would then silently lose every request
 * whose strategy ran long.
 */
function resolveBreachDisposition(
  policy: ExecutionRoutePolicy,
): RouteDeadlineResult<RouteDeadlineDisposition> {
  if (policy.fallback === "ordered-compatible") {
    return { ok: true, value: { kind: "ordered-compatible-head" } };
  }
  if (policy.fallback === "none") {
    return { ok: true, value: { kind: "denied" } };
  }
  return failure(
    "ROUTE_DEADLINE_UNDECLARED_FALLBACK",
    "policy.fallback",
    `Route policy declares fallback ${describe(policy.fallback)}, which is not a declared fallback; a breached selection deadline must not fall back to an undeclared rule`,
  );
}

/**
 * Picks the deadline fallback candidate from the ordered eligible chain.
 *
 * `orderedEligible` is the selector's canonically ordered eligible set —
 * `preferenceOrder` rank ascending, canonical id ascending on ties — so the
 * head is the ordered-compatible chain head by construction. The strategy's own
 * pick is deliberately not an argument here: on a breach it is not consulted at
 * all.
 */
export function drawDeadlineFallbackCandidate(
  orderedEligible: readonly ExecutionRouteCandidate[],
  disposition: RouteDeadlineDisposition,
): ExecutionRouteCandidate | undefined {
  switch (disposition.kind) {
    case "ordered-compatible-head":
      return orderedEligible[0];
    case "denied":
      return undefined;
    case "strategy":
      return undefined;
  }
}

/** Human-readable deadline clause for the decision's reasoning summary. */
export function describeDeadlineBreach(
  deadline: AdmittedRouteDeadline,
): string | null {
  if (deadline.outcome !== "exceeded") return null;
  return `exceeded its ${deadline.budgetMs}ms selection deadline at ${deadline.elapsedMs}ms`;
}

function describe(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function failure(
  code: RouteDeadlineFailureCode,
  path: string,
  message: string,
): RouteDeadlineResult<never> {
  return { ok: false, failure: { code, path, message } };
}
