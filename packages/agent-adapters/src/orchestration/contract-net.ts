/**
 * ContractNetOrchestrator -- FIPA Contract-Net protocol for competitive
 * bidding between AI agent adapters.
 *
 * Protocol phases:
 *   1. Call for Proposals (CFP) — broadcast task to available adapters
 *   2. Bid Collection — each adapter produces a bid (cost, confidence, speed)
 *   3. Award — select the best bid using configurable scoring criteria
 *   4. Execution — winning adapter executes the task
 *   5. Fallback — if the winner fails, try the next-best bidder
 *
 * Since adapters are AI agents (not bid-aware services), bidding is simulated
 * via pluggable BidStrategy implementations. The default StaticBidStrategy
 * uses known cost rates and tag-based confidence scoring.
 *
 * Events emitted (all defined in @dzupagent/core DzupEvent):
 *   protocol:message_sent   — CFP broadcast and award notification
 *   protocol:message_received — bids received from providers
 */

import type { DzupEventBus } from '@dzupagent/core/events'
import { ForgeError } from '@dzupagent/core/events'

import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type { AgentInput, TaskDescriptor } from '../types.js'

import type {
  Bid,
  BidStrategy,
  ContractNetConfig,
  ContractNetOptions,
  ContractNetResult,
} from './contract-net-types.js'
import { scoreBid, StaticBidStrategy } from './contract-net-strategies.js'
import { buildCancelledResult, emitProtocol } from './contract-net-helpers.js'
import { collectBids, executeWithFallback } from './contract-net-runner.js'

// Re-export public types and strategies so existing imports of
// `./contract-net.js` continue to work.
export type {
  Bid,
  BidStrategy,
  BidSelectionCriteria,
  ContractNetConfig,
  ContractNetOptions,
  ContractNetResult,
} from './contract-net-types.js'
export { StaticBidStrategy } from './contract-net-strategies.js'

// ---------------------------------------------------------------------------
// ContractNetOrchestrator
// ---------------------------------------------------------------------------

export class ContractNetOrchestrator {
  private readonly registry: ProviderAdapterRegistry
  private readonly eventBus: DzupEventBus | undefined
  private readonly bidTimeoutMs: number
  private readonly bidStrategy: BidStrategy

  constructor(config: ContractNetConfig) {
    this.registry = config.registry
    this.eventBus = config.eventBus
    this.bidTimeoutMs = config.bidTimeoutMs ?? 5_000
    this.bidStrategy = config.bidStrategy ?? new StaticBidStrategy()
  }

  /**
   * Execute a task using the Contract-Net bidding protocol.
   *
   * 1. Discover healthy providers
   * 2. Broadcast CFP and collect bids
   * 3. Score, rank, and select winner
   * 4. Execute on winner (with fallback to next-best on failure)
   */
  async execute(
    task: TaskDescriptor,
    input: AgentInput,
    options?: ContractNetOptions,
  ): Promise<ContractNetResult> {
    const overallStart = Date.now()

    if (options?.signal?.aborted) {
      return buildCancelledResult(task, [], null, overallStart, 'Contract-Net execution was aborted')
    }

    // 1. Discover healthy providers
    const availableProviders = this.registry
      .listAdapters()
      .filter((id) => this.registry.getHealthy(id) !== undefined)

    if (availableProviders.length === 0) {
      throw new ForgeError({
        code: 'ALL_ADAPTERS_EXHAUSTED',
        message: 'No healthy adapters available for Contract-Net bidding',
        recoverable: false,
        suggestion: 'Wait for circuit breakers to reset or register additional adapters',
      })
    }

    // 2. Broadcast CFP
    emitProtocol(this.eventBus, 'message_sent', {
      protocol: 'contract-net',
      to: availableProviders.join(','),
      messageType: 'cfp',
    })

    // 3. Collect bids (with timeout)
    let bids: Bid[]
    try {
      bids = await collectBids(
        task,
        availableProviders,
        this.bidStrategy,
        this.bidTimeoutMs,
        options?.signal,
      )
    } catch (err) {
      if (ForgeError.is(err) && err.code === 'AGENT_ABORTED') {
        return buildCancelledResult(task, [], null, overallStart, err.message)
      }
      throw err
    }

    if (options?.signal?.aborted) {
      return buildCancelledResult(task, bids, null, overallStart, 'Contract-Net execution was aborted')
    }

    if (bids.length === 0) {
      throw new ForgeError({
        code: 'ALL_ADAPTERS_EXHAUSTED',
        message: 'No bids received from any adapter',
        recoverable: false,
      })
    }

    // Emit received bids
    for (const bid of bids) {
      emitProtocol(this.eventBus, 'message_received', {
        protocol: 'contract-net',
        from: bid.providerId,
        messageType: 'propose',
      })
    }

    // 4. Score and rank bids
    const criteria = options?.selectionCriteria ?? {}
    const ranked = [...bids].sort(
      (a, b) => scoreBid(b, criteria) - scoreBid(a, criteria),
    )

    // 5. Execute on winner, falling back to next-best on failure
    const result = await executeWithFallback(
      ranked,
      bids,
      task,
      input,
      this.registry,
      this.eventBus,
      options?.signal,
    )

    return { ...result, durationMs: Date.now() - overallStart }
  }
}
