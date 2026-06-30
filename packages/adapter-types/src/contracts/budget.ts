/**
 * MPCO P8a — per-run budget accumulator + cap check (spec §5.4, T15).
 *
 * The published Anthropic multi-agent architecture has NO budget cap; MPCO adds
 * one. This module is PURE: accrueUsage/checkBudget take all state as arguments
 * and return new values — no I/O, no clock — so enforcement is deterministic.
 *
 * There is no pre-existing cross-call usage accumulator (only a per-call
 * TokenUsage shape and per-run RunRecord.tokenUsage); this introduces the small
 * tally MPCO governance needs.
 */
import type { TokenUsage } from "./token-usage.js";

/** Per-run caps. An unset limit is not enforced. */
export interface BudgetLimits {
  maxTokens?: number | undefined;
  maxCostCents?: number | undefined;
}

/** Running tally accrued across proposer/critic calls in one MPCO run. */
export interface BudgetTally {
  /** Observed provider tokens, including cache read/write telemetry. */
  totalTokens: number;
  /** Tokens enforced by maxTokens: provider input + output only. */
  budgetTokens: number;
  totalCostCents: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  /** Number of accrued adapter calls (a call with no usage still counts). */
  calls: number;
}

/** Which cap was breached, with the offending numbers (for the typed failure). */
export interface BudgetBreach {
  breachedLimit: "tokens" | "cost";
  limit: number;
  actual: number;
  observedTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
}

/** A fresh zeroed tally. */
export function emptyTally(): BudgetTally {
  return {
    totalTokens: 0,
    budgetTokens: 0,
    totalCostCents: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    calls: 0,
  };
}

/**
 * Accrue one call's usage. Returns a NEW tally (pure). Token caps use
 * input+output tokens only; cache-read and cache-write tokens stay visible in
 * totalTokens and cache-specific fields for billing/telemetry. A call with no
 * usage still increments `calls`.
 */
export function accrueUsage(
  tally: BudgetTally,
  usage?: TokenUsage,
): BudgetTally {
  const u = usage;
  const budgetTokens = u ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0) : 0;
  const cachedInputTokens = u?.cachedInputTokens ?? 0;
  const cacheWriteTokens = u?.cacheWriteTokens ?? 0;
  const tokens = budgetTokens + cachedInputTokens + cacheWriteTokens;
  const cost = u?.costCents ?? 0;
  return {
    totalTokens: tally.totalTokens + tokens,
    budgetTokens: tally.budgetTokens + budgetTokens,
    totalCostCents: tally.totalCostCents + cost,
    cachedInputTokens: tally.cachedInputTokens + cachedInputTokens,
    cacheWriteTokens: tally.cacheWriteTokens + cacheWriteTokens,
    calls: tally.calls + 1,
  };
}

/**
 * Check the tally against the caps. Token cap is checked first (cheaper/most
 * common), then cost. An unset limit is skipped. Returns `{ exceeded }` plus a
 * typed breach when exceeded.
 */
export function checkBudget(
  tally: BudgetTally,
  limits: BudgetLimits,
): { exceeded: boolean; breach?: BudgetBreach } {
  if (limits.maxTokens !== undefined && tally.budgetTokens > limits.maxTokens) {
    return {
      exceeded: true,
      breach: {
        breachedLimit: "tokens",
        limit: limits.maxTokens,
        actual: tally.budgetTokens,
        observedTokens: tally.totalTokens,
        cachedInputTokens: tally.cachedInputTokens,
        cacheWriteTokens: tally.cacheWriteTokens,
      },
    };
  }
  if (
    limits.maxCostCents !== undefined &&
    tally.totalCostCents > limits.maxCostCents
  ) {
    return {
      exceeded: true,
      breach: {
        breachedLimit: "cost",
        limit: limits.maxCostCents,
        actual: tally.totalCostCents,
      },
    };
  }
  return { exceeded: false };
}
