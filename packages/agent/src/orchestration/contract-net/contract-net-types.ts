/**
 * Types for the contract-net negotiation protocol.
 *
 * The contract-net protocol follows this lifecycle:
 * 1. A Call For Proposals (CFP) is announced
 * 2. Specialists submit bids
 * 3. Bids are evaluated using a pluggable strategy
 * 4. The contract is awarded to the best bidder
 * 5. Winner executes the task
 * 6. Result is returned
 */
import type { DzupAgent } from "../../agent/dzip-agent.js";
import type { DzupEventBus } from "@dzupagent/core/events";
import type { BaseContractNetContract } from "@dzupagent/agent-types";

export type ContractNetPhase =
  | "announcing"
  | "bidding"
  | "evaluating"
  | "awarding"
  | "executing"
  | "completed"
  | "failed";

export interface CallForProposals {
  cfpId: string;
  task: string;
  /**
   * Capabilities a bidder must hold to be eligible. ENFORCED, not advisory:
   * announced in the CFP prompt AND applied as a filter on the returned bids.
   *
   * The match is a subset test against {@link ContractBid.capabilities} — a
   * bid qualifies when it declares every required capability. Comparison is
   * exact string equality, so tags must agree on spelling and case.
   *
   * A bid that declares no capabilities is only filtered when requirements
   * exist; see {@link ContractBid.capabilities} for why an undeclared bid is
   * treated as unqualified rather than universally qualified.
   *
   * Omit (or pass an empty array) for no capability requirement, which leaves
   * every bid eligible and ranking untouched.
   */
  requiredCapabilities?: string[];
  /**
   * Hard cost ceiling for the contract, in cents. ENFORCED, not advisory:
   * bids with `estimatedCostCents` above this are filtered out before
   * ranking and can never win. If no bid fits, the negotiation fails with an
   * {@link OrchestrationError} rather than awarding an over-budget contract.
   * The bound is inclusive — a bid exactly at the budget is eligible.
   * Omit for no ceiling.
   */
  maxCostCents?: number;
  bidDeadlineMs: number;
  metadata?: Record<string, unknown>;
}

export interface ContractBid {
  agentId: string;
  cfpId: string;
  estimatedCostCents: number;
  estimatedDurationMs: number;
  qualityEstimate: number; // 0.0 - 1.0
  confidence: number; // 0.0 - 1.0
  approach: string;
  /**
   * Capabilities the bidder claims, self-reported in its bid JSON.
   *
   * Only meaningful when the CFP sets `requiredCapabilities`; otherwise it is
   * carried for observability and consulted by nothing.
   *
   * Absent (rather than empty) when the bidder omitted the field, which
   * distinguishes "declared none" from "did not answer". Both fail a non-empty
   * requirement: eligibility must be affirmatively demonstrated, mirroring how
   * an unpriced (`NaN`) bid cannot be proven affordable under a budget. A
   * bidder that cannot name the skill does not get the contract by silence.
   */
  capabilities?: string[];
}

export interface ContractAward {
  cfpId: string;
  winnerId: string;
  bid: ContractBid;
}

export interface ContractResult {
  cfpId: string;
  agentId: string;
  success: boolean;
  result?: string;
  actualCostCents?: number;
  actualDurationMs?: number;
  error?: string;
}

export interface ContractNetState {
  phase: ContractNetPhase;
  cfp: CallForProposals;
  bids: ContractBid[];
  award?: ContractAward;
  result?: ContractResult;
}

export interface BidEvaluationStrategy {
  evaluate(bids: ContractBid[]): ContractBid[];
}

export interface ContractNetConfig extends BaseContractNetContract<DzupAgent> {
  specialists: DzupAgent[];
  task: string;
  strategy?: BidEvaluationStrategy;
  bidDeadlineMs?: number;
  /**
   * Hard cost ceiling for the contract, in cents. ENFORCED, not advisory:
   * it is announced to specialists in the CFP prompt AND applied as a filter
   * on the returned bids — a specialist that bids above it cannot win, so the
   * run cannot spend over budget. If every bid exceeds the ceiling the
   * negotiation throws an {@link OrchestrationError} naming the cheapest bid.
   * The bound is inclusive — a bid exactly at the budget is eligible.
   * Omit for no ceiling.
   */
  maxCostCents?: number;
  /**
   * Capabilities a specialist must declare to be eligible. ENFORCED, not
   * advisory: announced in the CFP prompt AND applied as a subset filter on
   * the returned bids, so a specialist that does not declare every required
   * capability cannot win however cheap or confident its bid.
   *
   * If no bid qualifies the negotiation throws an {@link OrchestrationError}
   * naming the requirement, rather than awarding work to a specialist that
   * cannot perform it. Omit for no capability requirement.
   */
  requiredCapabilities?: string[];
  retryOnNoBids?: boolean;
  signal?: AbortSignal;
  eventBus?: DzupEventBus;
}
