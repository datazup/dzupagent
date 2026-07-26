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
  requiredCapabilities?: string[];
  retryOnNoBids?: boolean;
  signal?: AbortSignal;
  eventBus?: DzupEventBus;
}
