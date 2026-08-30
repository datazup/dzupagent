/**
 * Bid eligibility gates and winner selection for the contract-net protocol.
 *
 * `maxCostCents` and `requiredCapabilities` are HARD pre-ranking gates rather
 * than ranking hints: an over-budget or under-qualified specialist must never
 * be awardable by simply scoring well. Both gates, the ranking, and the award
 * step live here so that policy stays in one place.
 *
 * @module orchestration/contract-net/contract-net-selection
 */
import type { DzupAgent } from "../../agent/dzip-agent.js";
import type { DzupEventBus } from "@dzupagent/core/events";
import { OrchestrationError } from "../orchestration-error.js";
import { createWeightedStrategy } from "./bid-strategies.js";
import type {
  ContractNetConfig,
  ContractBid,
  ContractNetState,
} from "./contract-net-types.js";
import { emitContractEvent } from "./contract-net-bidding.js";

/**
 * Enforce the CFP's `maxCostCents` ceiling on the collected bids.
 *
 * Returns the bids eligible for ranking. When `cfp.maxCostCents` is unset
 * this returns `state.bids` unchanged (identical behaviour to before the
 * ceiling existed — no filtering, no events, same array contents).
 *
 * A bid is eligible when `estimatedCostCents <= maxCostCents`. The
 * comparison is inclusive, so a bid landing exactly on the budget is
 * affordable and stays in the running.
 *
 * `estimatedCostCents` is a required field, but {@link parseBid} coerces a
 * malformed value (e.g. `"cheap"`) to `NaN`. A `NaN` cost fails the `<=`
 * comparison and is therefore ineligible under a budget — an unpriced bid
 * cannot be proven affordable, so it must not be awarded a budgeted
 * contract. (An *omitted* cost coerces to `0`, which is genuinely within
 * any non-negative budget and stays eligible.)
 *
 * Throws {@link OrchestrationError} when a budget is set and no bid fits.
 */
export function filterBidsByBudget(
  state: ContractNetState,
  eventBus: DzupEventBus | undefined
): ContractBid[] {
  const { cfpId, maxCostCents } = state.cfp;
  if (maxCostCents == null) return state.bids;

  const eligible = state.bids.filter(
    (bid) => bid.estimatedCostCents <= maxCostCents
  );
  if (eligible.length > 0) return eligible;

  // Every bid blew the budget: fail rather than award an unaffordable
  // contract. Name the closest miss so the caller can see how far off the
  // field was and raise the budget deliberately.
  const cheapest = cheapestCost(state.bids);
  const reason =
    cheapest == null
      ? `No bid within budget of ${maxCostCents} cents`
      : `No bid within budget: cheapest bid is ${cheapest} cents, budget is ${maxCostCents} cents`;

  state.phase = "failed";
  emitContractEvent(eventBus, {
    type: "contractnet:failed",
    cfpId,
    phase: "bidding",
    reason,
  });
  throw new OrchestrationError(reason, "contract-net", { cfpId });
}

/**
 * Enforce the CFP's `requiredCapabilities` on the collected bids.
 *
 * Returns the bids eligible for ranking. When the CFP names no requirements
 * this returns `bids` unchanged — no filtering, no events, same contents as
 * before capability matching existed.
 *
 * The match semantic is a SUBSET test: a bid qualifies when it declares
 * every required capability. This mirrors `maxCostCents` — a hard,
 * pre-ranking eligibility gate rather than a soft ranking bonus — because a
 * missing capability means the specialist cannot do the work at all, and no
 * amount of being cheap or fast compensates for that. A soft bonus would let
 * an unqualified-but-cheap bidder win, which is the defect this closes.
 *
 * Matching is exact string equality on trimmed tags. Requirements are
 * likewise trimmed so a policy written as `" sql"` still matches `"sql"`.
 *
 * Throws {@link OrchestrationError} when requirements are set and no bid
 * qualifies, rather than awarding the contract to a specialist that cannot
 * perform it.
 */
export function filterBidsByCapabilities(
  state: ContractNetState,
  bids: ContractBid[],
  eventBus: DzupEventBus | undefined
): ContractBid[] {
  const { cfpId, requiredCapabilities } = state.cfp;
  const required = (requiredCapabilities ?? [])
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  if (required.length === 0) return bids;

  const eligible = bids.filter((bid) => {
    const declared = new Set(bid.capabilities ?? []);
    return required.every((c) => declared.has(c));
  });
  if (eligible.length > 0) return eligible;

  // Nobody qualified. Fail rather than award work to a specialist that did
  // not demonstrate the required skills. Name the requirement so the caller
  // can see whether the policy is too strict or the roster is wrong.
  const reason = `No bid met the required capabilities: ${required.join(
    ", "
  )}`;

  state.phase = "failed";
  emitContractEvent(eventBus, {
    type: "contractnet:failed",
    cfpId,
    phase: "bidding",
    reason,
  });
  throw new OrchestrationError(reason, "contract-net", { cfpId });
}

/**
 * Lowest `estimatedCostCents` across `bids`, or `null` when there are no
 * bids or every cost is non-finite (`NaN`), which `Math.min` would otherwise
 * report as `NaN`.
 */
function cheapestCost(bids: ContractBid[]): number | null {
  const costs = bids
    .map((bid) => bid.estimatedCostCents)
    .filter((cost) => Number.isFinite(cost));
  return costs.length > 0 ? Math.min(...costs) : null;
}

/**
 * Phases 3–4: evaluate/rank the collected bids, award to the top bid, and
 * resolve the winning specialist agent. Mutates `state` and throws
 * {@link OrchestrationError} when no winner can be determined.
 */
export function selectWinner(
  state: ContractNetState,
  config: ContractNetConfig
): { winningBid: ContractBid; winner: DzupAgent } {
  const { specialists, eventBus } = config;
  const strategy = config.strategy ?? createWeightedStrategy({});
  const cfpId = state.cfp.cfpId;

  // Phase 3: Evaluate. `maxCostCents` is a HARD ceiling, not a hint: bids
  // above it are removed before ranking so an over-budget specialist can
  // never be awarded (and therefore never spends). When no budget is
  // configured this is a pass-through and ranking is unchanged.
  //
  // `requiredCapabilities` is enforced the same way and for the same reason:
  // a specialist that cannot do the work must not win it by underbidding.
  // Budget runs first so that when both gates would reject the field, the
  // error names the affordability problem — the one the caller controls by
  // raising a number rather than by changing the roster.
  state.phase = "evaluating";
  const affordableBids = filterBidsByBudget(
    state,
    eventBus
  );
  const eligibleBids = filterBidsByCapabilities(
    state,
    affordableBids,
    eventBus
  );
  const rankedBids = strategy.evaluate(eligibleBids);
  const winningBid = rankedBids[0];

  if (!winningBid) {
    state.phase = "failed";
    throw new OrchestrationError(
      "Bid evaluation returned no results",
      "contract-net",
      { cfpId }
    );
  }

  // Phase 4: Award
  state.phase = "awarding";
  state.award = {
    cfpId,
    winnerId: winningBid.agentId,
    bid: winningBid,
  };
  emitContractEvent(eventBus, {
    type: "contractnet:awarded",
    cfpId,
    winnerId: winningBid.agentId,
  });

  const winner = specialists.find((s) => s.id === winningBid.agentId);
  if (!winner) {
    state.phase = "failed";
    throw new OrchestrationError(
      `Winning agent "${winningBid.agentId}" not found in specialists`,
      "contract-net",
      { cfpId }
    );
  }

  return { winningBid, winner };
}
