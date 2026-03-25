/**
 * Types for the contract-net negotiation protocol.
 *
 * The contract-net protocol follows this lifecycle:
 * 1. Manager announces a Call For Proposals (CFP)
 * 2. Specialists submit bids
 * 3. Manager evaluates bids using a pluggable strategy
 * 4. Manager awards the contract to the best bidder
 * 5. Winner executes the task
 * 6. Result is returned
 */
import type { ForgeAgent } from '../../agent/forge-agent.js'
import type { ForgeEventBus } from '@forgeagent/core'

export type ContractNetPhase =
  | 'announcing'
  | 'bidding'
  | 'evaluating'
  | 'awarding'
  | 'executing'
  | 'completed'
  | 'failed'

export interface CallForProposals {
  cfpId: string
  task: string
  requiredCapabilities?: string[]
  maxCostCents?: number
  bidDeadlineMs: number
  metadata?: Record<string, unknown>
}

export interface ContractBid {
  agentId: string
  cfpId: string
  estimatedCostCents: number
  estimatedDurationMs: number
  qualityEstimate: number  // 0.0 - 1.0
  confidence: number       // 0.0 - 1.0
  approach: string
}

export interface ContractAward {
  cfpId: string
  winnerId: string
  bid: ContractBid
}

export interface ContractResult {
  cfpId: string
  agentId: string
  success: boolean
  result?: string
  actualCostCents?: number
  actualDurationMs?: number
  error?: string
}

export interface ContractNetState {
  phase: ContractNetPhase
  cfp: CallForProposals
  bids: ContractBid[]
  award?: ContractAward
  result?: ContractResult
}

export interface BidEvaluationStrategy {
  evaluate(bids: ContractBid[]): ContractBid[]
}

export interface ContractNetConfig {
  manager: ForgeAgent
  specialists: ForgeAgent[]
  task: string
  strategy?: BidEvaluationStrategy
  bidDeadlineMs?: number
  maxCostCents?: number
  requiredCapabilities?: string[]
  retryOnNoBids?: boolean
  signal?: AbortSignal
  eventBus?: ForgeEventBus
}
