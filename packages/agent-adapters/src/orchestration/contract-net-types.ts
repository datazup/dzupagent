/**
 * Public types for ContractNetOrchestrator.
 *
 * Split out from `contract-net.ts` so strategy implementations and
 * the orchestrator class can share these definitions without circular
 * imports.
 */

import type { DzupEventBus } from '@dzupagent/core/events'
import type { BaseContractNetContract } from '@dzupagent/agent-types'
import type { AgentCLIAdapter } from '@dzupagent/adapter-types'

import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type { AdapterProviderId, TaskDescriptor } from '../types.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single bid from a provider for a given task. */
export interface Bid {
  providerId: AdapterProviderId
  estimatedCostCents: number
  confidence: number // 0-1
  approach?: string | undefined
  estimatedDurationMs?: number | undefined
}

/** Strategy that generates bids for a set of providers. */
export interface BidStrategy {
  readonly name: string
  generateBids(
    task: TaskDescriptor,
    availableProviders: AdapterProviderId[],
  ): Promise<Bid[]>
}

/** Criteria for scoring and selecting the winning bid. */
export interface BidSelectionCriteria {
  /** Weight for cost (lower cost = better). Default 0.3 */
  costWeight?: number | undefined
  /** Weight for confidence (higher = better). Default 0.5 */
  confidenceWeight?: number | undefined
  /** Weight for speed (lower duration = better). Default 0.2 */
  speedWeight?: number | undefined
  /** Custom scorer override — higher is better. */
  customScorer?: (bid: Bid) => number
}

/** Options passed to `ContractNetOrchestrator.execute`. */
export interface ContractNetOptions {
  selectionCriteria?: BidSelectionCriteria | undefined
  signal?: AbortSignal | undefined
}

/** Configuration for the ContractNetOrchestrator. */
export interface ContractNetConfig extends BaseContractNetContract<AgentCLIAdapter> {
  registry: ProviderAdapterRegistry
  eventBus?: DzupEventBus | undefined
  /** Max time (ms) to collect bids. Default 5000. */
  bidTimeoutMs?: number | undefined
  /** Bid generation strategy. Default: StaticBidStrategy. */
  bidStrategy?: BidStrategy | undefined
}

/** Result of a contract-net execution. */
export interface ContractNetResult {
  task: TaskDescriptor
  winningBid: Bid | null
  allBids: Bid[]
  executionResult: string
  success: boolean
  durationMs: number
  error?: string | undefined
  cancelled?: true | undefined
}
