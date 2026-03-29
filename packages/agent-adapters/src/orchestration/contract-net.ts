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
 * Events emitted (all defined in @dzipagent/core DzipEvent):
 *   protocol:message_sent   — CFP broadcast and award notification
 *   protocol:message_received — bids received from providers
 */

import type { DzipEventBus } from '@dzipagent/core'
import { ForgeError } from '@dzipagent/core'

import type { AdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCompletedEvent,
  AgentEvent,
  AgentFailedEvent,
  AgentInput,
  TaskDescriptor,
} from '../types.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single bid from a provider for a given task. */
export interface Bid {
  providerId: AdapterProviderId
  estimatedCostCents: number
  confidence: number // 0-1
  approach?: string
  estimatedDurationMs?: number
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
  costWeight?: number
  /** Weight for confidence (higher = better). Default 0.5 */
  confidenceWeight?: number
  /** Weight for speed (lower duration = better). Default 0.2 */
  speedWeight?: number
  /** Custom scorer override — higher is better. */
  customScorer?: (bid: Bid) => number
}

/** Options passed to `ContractNetOrchestrator.execute`. */
export interface ContractNetOptions {
  selectionCriteria?: BidSelectionCriteria
  signal?: AbortSignal
}

/** Configuration for the ContractNetOrchestrator. */
export interface ContractNetConfig {
  registry: AdapterRegistry
  eventBus?: DzipEventBus
  /** Max time (ms) to collect bids. Default 5000. */
  bidTimeoutMs?: number
  /** Bid generation strategy. Default: StaticBidStrategy. */
  bidStrategy?: BidStrategy
}

/** Result of a contract-net execution. */
export interface ContractNetResult {
  task: TaskDescriptor
  winningBid: Bid
  allBids: Bid[]
  executionResult: string
  success: boolean
  durationMs: number
  error?: string
}

// ---------------------------------------------------------------------------
// Tag sets (mirrored from TagBasedRouter for confidence scoring)
// ---------------------------------------------------------------------------

const REASONING_TAGS = new Set([
  'reasoning',
  'review',
  'architecture',
  'design',
  'analysis',
  'planning',
  'refactor',
  'explain',
])

const EXECUTION_TAGS = new Set([
  'fix-tests',
  'implement',
  'execute',
  'code',
  'build',
  'debug',
  'test',
  'migrate',
])

const LOCAL_TAGS = new Set([
  'local',
  'offline',
  'private',
  'fast',
  'simple',
  'quick',
])

// ---------------------------------------------------------------------------
// Static cost and speed tables
// ---------------------------------------------------------------------------

/** Approximate cost in cents per estimated 10K tokens. */
const COST_PER_10K_TOKENS: Record<AdapterProviderId, number> = {
  crush: 1,
  qwen: 2,
  gemini: 3,
  codex: 4,
  claude: 5,
}

/** Default estimated duration in ms for a standard task. */
const DEFAULT_DURATION_MS: Record<AdapterProviderId, number> = {
  crush: 2_000,
  qwen: 3_000,
  gemini: 4_000,
  codex: 5_000,
  claude: 5_000,
}

// ---------------------------------------------------------------------------
// StaticBidStrategy
// ---------------------------------------------------------------------------

/**
 * Default bid strategy that generates bids from static heuristics.
 *
 * - Cost: per-provider cost ranking
 * - Confidence: tag matching (reasoning -> claude, execution -> codex,
 *   local -> crush/qwen)
 * - Duration: estimated from static defaults
 */
export class StaticBidStrategy implements BidStrategy {
  readonly name = 'static'

  async generateBids(
    task: TaskDescriptor,
    availableProviders: AdapterProviderId[],
  ): Promise<Bid[]> {
    const tags = task.tags.map((t) => t.toLowerCase())
    const isReasoning =
      task.requiresReasoning === true || tags.some((t) => REASONING_TAGS.has(t))
    const isExecution =
      task.requiresExecution === true || tags.some((t) => EXECUTION_TAGS.has(t))
    const isLocal = tags.some((t) => LOCAL_TAGS.has(t))

    return availableProviders.map((providerId) => {
      const estimatedCostCents = COST_PER_10K_TOKENS[providerId]
      const estimatedDurationMs = DEFAULT_DURATION_MS[providerId]
      const confidence = this.computeConfidence(
        providerId,
        isReasoning,
        isExecution,
        isLocal,
      )

      return {
        providerId,
        estimatedCostCents,
        confidence,
        estimatedDurationMs,
        approach: this.describeApproach(providerId, isReasoning, isExecution),
      }
    })
  }

  private computeConfidence(
    providerId: AdapterProviderId,
    isReasoning: boolean,
    isExecution: boolean,
    isLocal: boolean,
  ): number {
    // Base confidence
    let confidence = 0.5

    if (isReasoning) {
      if (providerId === 'claude') confidence = 0.95
      else if (providerId === 'gemini') confidence = 0.75
      else if (providerId === 'codex') confidence = 0.6
      else confidence = 0.4
    } else if (isExecution) {
      if (providerId === 'codex') confidence = 0.9
      else if (providerId === 'claude') confidence = 0.8
      else if (providerId === 'gemini') confidence = 0.7
      else confidence = 0.5
    } else if (isLocal) {
      if (providerId === 'crush') confidence = 0.85
      else if (providerId === 'qwen') confidence = 0.8
      else confidence = 0.5
    }

    return confidence
  }

  private describeApproach(
    providerId: AdapterProviderId,
    isReasoning: boolean,
    isExecution: boolean,
  ): string {
    if (isReasoning) {
      return `${providerId}: deep reasoning and analysis approach`
    }
    if (isExecution) {
      return `${providerId}: direct implementation approach`
    }
    return `${providerId}: general-purpose approach`
  }
}

// ---------------------------------------------------------------------------
// Bid scoring
// ---------------------------------------------------------------------------

/**
 * Score a bid using the given criteria. Higher score is better.
 *
 * The score is a weighted sum of:
 * - Cost score: inversely proportional to estimated cost
 * - Confidence score: the bid's confidence value directly
 * - Speed score: inversely proportional to estimated duration
 */
function scoreBid(bid: Bid, criteria: BidSelectionCriteria): number {
  if (criteria.customScorer) {
    return criteria.customScorer(bid)
  }

  const costWeight = criteria.costWeight ?? 0.3
  const confidenceWeight = criteria.confidenceWeight ?? 0.5
  const speedWeight = criteria.speedWeight ?? 0.2

  // Cost score: invert so lower cost = higher score. +1 to avoid div/0.
  const costScore = 1 / (bid.estimatedCostCents + 1)

  // Confidence score is already 0-1
  const confidenceScore = bid.confidence

  // Speed score: invert so lower duration = higher score. +1 to avoid div/0.
  const durationMs = bid.estimatedDurationMs ?? 5_000
  const speedScore = 1_000 / (durationMs + 1)

  return (
    costScore * costWeight +
    confidenceScore * confidenceWeight +
    speedScore * speedWeight
  )
}

// ---------------------------------------------------------------------------
// ContractNetOrchestrator
// ---------------------------------------------------------------------------

export class ContractNetOrchestrator {
  private readonly registry: AdapterRegistry
  private readonly eventBus: DzipEventBus | undefined
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

    this.throwIfAborted(options?.signal)

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
    this.emitProtocol('message_sent', {
      protocol: 'contract-net',
      to: availableProviders.join(','),
      messageType: 'cfp',
    })

    // 3. Collect bids (with timeout)
    const bids = await this.collectBids(task, availableProviders, options?.signal)

    if (bids.length === 0) {
      throw new ForgeError({
        code: 'ALL_ADAPTERS_EXHAUSTED',
        message: 'No bids received from any adapter',
        recoverable: false,
      })
    }

    // Emit received bids
    for (const bid of bids) {
      this.emitProtocol('message_received', {
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
    const result = await this.executeWithFallback(
      ranked,
      bids,
      task,
      input,
      options?.signal,
    )

    return {
      ...result,
      durationMs: Date.now() - overallStart,
    }
  }

  // -------------------------------------------------------------------------
  // Private — bid collection
  // -------------------------------------------------------------------------

  private async collectBids(
    task: TaskDescriptor,
    availableProviders: AdapterProviderId[],
    signal?: AbortSignal,
  ): Promise<Bid[]> {
    // Race bid generation against timeout
    const bidPromise = this.bidStrategy.generateBids(task, availableProviders)

    const timeoutPromise = new Promise<Bid[]>((_resolve, reject) => {
      const handle = setTimeout(() => {
        reject(
          new ForgeError({
            code: 'BUDGET_EXCEEDED',
            message: `Bid collection timed out after ${String(this.bidTimeoutMs)}ms`,
            recoverable: true,
          }),
        )
      }, this.bidTimeoutMs)

      // If externally aborted, clear timeout and reject
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(handle)
          reject(
            new ForgeError({
              code: 'BUDGET_EXCEEDED',
              message: 'Bid collection aborted',
              recoverable: false,
            }),
          )
        },
        { once: true },
      )

      // Clean up timeout if bid promise resolves first
      void bidPromise.then(() => { clearTimeout(handle) })
    })

    try {
      return await Promise.race([bidPromise, timeoutPromise])
    } catch (err) {
      // If the bid strategy itself fails, the timeout promise may still
      // be pending. For static strategies this is unlikely, but we handle
      // it defensively by returning an empty array.
      if (err instanceof ForgeError && err.code === 'BUDGET_EXCEEDED') {
        // Timeout or abort — return whatever bids we have (none in this case)
        return []
      }
      throw err
    }
  }

  // -------------------------------------------------------------------------
  // Private — execution with fallback
  // -------------------------------------------------------------------------

  private async executeWithFallback(
    rankedBids: Bid[],
    allBids: Bid[],
    task: TaskDescriptor,
    input: AgentInput,
    signal?: AbortSignal,
  ): Promise<Omit<ContractNetResult, 'durationMs'>> {
    let lastError: string | undefined

    for (const bid of rankedBids) {
      this.throwIfAborted(signal)

      // Emit award
      this.emitProtocol('message_sent', {
        protocol: 'contract-net',
        to: bid.providerId,
        messageType: 'accept-proposal',
      })

      const adapter = this.registry.getHealthy(bid.providerId)
      if (!adapter) {
        lastError = `Adapter "${bid.providerId}" became unhealthy before execution`
        // Emit rejection and try next
        this.emitProtocol('message_sent', {
          protocol: 'contract-net',
          to: bid.providerId,
          messageType: 'reject-proposal',
        })
        continue
      }

      try {
        const mergedInput: AgentInput = { ...input, signal }
        const result = await this.consumeAdapterEvents(
          adapter.execute(mergedInput),
          bid.providerId,
          signal,
        )

        if (result.success) {
          return {
            task,
            winningBid: bid,
            allBids,
            executionResult: result.text,
            success: true,
          }
        }

        // Adapter completed but without a successful result
        lastError = result.error ?? 'Adapter completed without producing a result'
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        lastError = error.message

        // Record failure in the registry so circuit breaker is updated
        this.registry.recordFailure(bid.providerId, error)
      }
    }

    // All ranked bids exhausted
    const failedBid = rankedBids[0]
    if (!failedBid) {
      throw new ForgeError({
        code: 'ALL_ADAPTERS_EXHAUSTED',
        message: 'No bids to execute',
        recoverable: false,
      })
    }

    return {
      task,
      winningBid: failedBid,
      allBids,
      executionResult: '',
      success: false,
      error: lastError ?? 'All bidders failed',
    }
  }

  // -------------------------------------------------------------------------
  // Private — adapter event consumption
  // -------------------------------------------------------------------------

  private async consumeAdapterEvents(
    gen: AsyncGenerator<AgentEvent, void, undefined>,
    providerId: AdapterProviderId,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; text: string; error?: string }> {
    let resultText = ''
    let success = false
    let errorMessage: string | undefined

    for await (const event of gen) {
      this.throwIfAborted(signal)

      if (this.isCompletedEvent(event)) {
        resultText = event.result
        success = true
      } else if (this.isFailedEvent(event)) {
        errorMessage = event.error
      }
    }

    if (success) {
      this.registry.recordSuccess(providerId)
    }

    return { success, text: resultText, error: errorMessage }
  }

  // -------------------------------------------------------------------------
  // Private — helpers
  // -------------------------------------------------------------------------

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new ForgeError({
        code: 'BUDGET_EXCEEDED',
        message: 'Contract-Net execution was aborted',
        recoverable: false,
      })
    }
  }

  private isCompletedEvent(event: AgentEvent): event is AgentCompletedEvent {
    return event.type === 'adapter:completed'
  }

  private isFailedEvent(event: AgentEvent): event is AgentFailedEvent {
    return event.type === 'adapter:failed'
  }

  private emitProtocol(
    type: 'message_sent' | 'message_received',
    detail: {
      protocol: string
      to?: string
      from?: string
      messageType: string
    },
  ): void {
    if (!this.eventBus) return

    if (type === 'message_sent') {
      this.eventBus.emit({
        type: 'protocol:message_sent',
        protocol: detail.protocol,
        to: detail.to ?? '',
        messageType: detail.messageType,
      } as Parameters<DzipEventBus['emit']>[0])
    } else {
      this.eventBus.emit({
        type: 'protocol:message_received',
        protocol: detail.protocol,
        from: detail.from ?? '',
        messageType: detail.messageType,
      } as Parameters<DzipEventBus['emit']>[0])
    }
  }
}
