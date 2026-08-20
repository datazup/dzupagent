import type {
  ExecutionRouteCandidate,
  ExecutionRoutePolicy,
} from "@dzupagent/runtime-contracts";

/**
 * Deterministic round-robin route-strategy primitives.
 *
 * Round-robin here is a pure function of (policy, eligible candidates, cursor):
 * there is deliberately NO module-level or instance-level rotation state. The
 * cursor travels in the selection receipt — the host passes the previous
 * decision's `selectedCandidateId` back in as the next call's cursor — so
 * replaying a receipt reproduces its pick exactly and two calls with the same
 * inputs always agree.
 *
 * Cursor semantics (the single source of truth for the rotation rule):
 *
 * - The cursor is the candidate id selected by the previous round-robin
 *   decision for this policy. An absent cursor means "first selection".
 * - Candidates are rotated in canonical id order (`localeCompare`), never in
 *   input or preference order, so declaration order cannot steer the rotation.
 * - The next pick is the first *eligible* candidate whose id is strictly
 *   greater than the cursor in canonical order, wrapping to the first eligible
 *   candidate when none is greater.
 * - Eligibility changes between calls are re-derived by that successor rule:
 *   the cursor's candidate does not need to be eligible now — only declared —
 *   so a candidate dropping out of (or back into) eligibility shifts the
 *   rotation deterministically instead of failing it.
 * - A cursor that names no *declared* candidate fails closed: it belongs to a
 *   different policy's rotation (or a stale candidate set) and must not
 *   silently steer this one. Restarting the rotation is an explicit act —
 *   pass no cursor.
 *
 * Like the seeded-strategy module, nothing here throws: each guard returns a
 * typed failure so the selector owns the single admission-error vocabulary.
 */

export type RoundRobinRouteStrategyFailureCode =
  | "ROUND_ROBIN_STRATEGY_INVALID_CURSOR"
  | "ROUND_ROBIN_STRATEGY_UNKNOWN_CURSOR_CANDIDATE";

export interface RoundRobinRouteStrategyFailure {
  readonly code: RoundRobinRouteStrategyFailureCode;
  readonly message: string;
}

export type RoundRobinRouteStrategyResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: RoundRobinRouteStrategyFailure };

/**
 * Admits the receipt-carried cursor for a round-robin policy.
 *
 * `undefined` admits as `null` (first selection). An empty cursor is a
 * *present* input and is denied separately, exactly like an empty seed: a
 * guard that only checked for absence would let a blank cursor silently pin
 * the rotation to its first candidate. A cursor naming no declared candidate
 * fails closed rather than being coerced into a fresh rotation.
 */
export function requireRoundRobinCursor(
  policy: ExecutionRoutePolicy,
  cursor: string | undefined,
): RoundRobinRouteStrategyResult<string | null> {
  if (cursor === undefined) {
    return { ok: true, value: null };
  }
  if (cursor.length === 0) {
    return failure(
      "ROUND_ROBIN_STRATEGY_INVALID_CURSOR",
      'Route strategy "round-robin" requires the cursor to be a non-empty candidate id or absent for the first selection',
    );
  }
  if (!policy.candidates.some((candidate) => candidate.id === cursor)) {
    return failure(
      "ROUND_ROBIN_STRATEGY_UNKNOWN_CURSOR_CANDIDATE",
      `Round-robin cursor "${cursor}" names no declared candidate; a cursor from another policy or a stale candidate set must not steer this rotation`,
    );
  }
  return { ok: true, value: cursor };
}

/**
 * Pure round-robin pick over the eligible candidates.
 *
 * The rotation runs over candidates sorted by id, so neither input order nor
 * the preference order — which is `rule` vocabulary — can shift the pick. With
 * a null cursor the first canonical candidate is selected; otherwise the first
 * candidate whose id is strictly greater than the cursor wins, wrapping to the
 * start when the cursor is at (or past) the canonical end.
 */
export function drawRoundRobinCandidate(
  eligible: readonly ExecutionRouteCandidate[],
  cursor: string | null,
): ExecutionRouteCandidate | undefined {
  const ordered = [...eligible].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  if (ordered.length === 0) return undefined;
  if (cursor === null) return ordered[0];

  const successor = ordered.find(
    (candidate) => candidate.id.localeCompare(cursor) > 0,
  );
  return successor ?? ordered[0];
}

function failure(
  code: RoundRobinRouteStrategyFailureCode,
  message: string,
): RoundRobinRouteStrategyResult<never> {
  return { ok: false, failure: { code, message } };
}
