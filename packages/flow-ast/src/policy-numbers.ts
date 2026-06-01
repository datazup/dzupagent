/**
 * Shared numeric policy guards (DZUPAGENT-CODE-M-06).
 *
 * Neutral module consumed by BOTH the parser (`parse/agent.ts`) and the
 * validator (`validate/agent.ts`) so they cannot drift on what counts as a
 * valid agent budget/policy number. Previously parse and validate disagreed on
 * `0` for `stop.maxToolCalls` and `policy.maxToolCalls` in opposite directions.
 *
 * This file deliberately imports nothing from `parse/` or `validate/` to keep
 * those two sibling layers decoupled.
 */

/**
 * True when `value` is a strictly positive, finite integer — the rule for
 * agent budget/policy numbers like `stop.maxToolCalls` and
 * `policy.maxToolCalls`. Rejects `0`, negatives, non-finite (NaN/Infinity),
 * non-integers, and non-numbers uniformly.
 */
export function isPositiveFinitePolicyNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
  );
}

/**
 * Normalising form of {@link isPositiveFinitePolicyNumber}. Returns the value
 * when valid, otherwise `{ ok: false }` so callers can raise their own
 * diagnostic in their native error shape.
 */
export function normalizePositiveFinitePolicyNumber(
  value: unknown
): { ok: true; value: number } | { ok: false } {
  return isPositiveFinitePolicyNumber(value)
    ? { ok: true, value }
    : { ok: false };
}
