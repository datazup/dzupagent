/**
 * Cost-tracking middleware for agent adapters.
 *
 * Wraps an adapter's event stream to accumulate token usage and cost,
 * emit budget warnings via DzipEventBus, and throw when budgets are exceeded.
 */

import { ForgeError } from '@dzipagent/core'
import type { DzipEventBus } from '@dzipagent/core'
import type { AgentEvent, AdapterProviderId, TokenUsage } from '../types.js'

// ---------------------------------------------------------------------------
// Cost estimation tables (cents per 1M tokens)
// ---------------------------------------------------------------------------

interface ProviderRates {
  inputCentsPer1M: number
  outputCentsPer1M: number
}

const PROVIDER_RATES: Record<AdapterProviderId, ProviderRates> = {
  claude: { inputCentsPer1M: 300, outputCentsPer1M: 1500 },
  codex: { inputCentsPer1M: 200, outputCentsPer1M: 800 },
  gemini: { inputCentsPer1M: 125, outputCentsPer1M: 500 },
  qwen: { inputCentsPer1M: 50, outputCentsPer1M: 200 },
  crush: { inputCentsPer1M: 0, outputCentsPer1M: 0 },
}

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface CostTrackingConfig {
  /** Total budget across all providers (in cents). */
  maxBudgetCents?: number
  /** Per-provider budget overrides (in cents). */
  perProviderBudgetCents?: Partial<Record<AdapterProviderId, number>>
  /** Emit a "warn" budget event at this percentage. Default 80. */
  warningThresholdPercent?: number
  /** Emit a "critical" budget event at this percentage. Default 95. */
  criticalThresholdPercent?: number
  /** Event bus for budget notifications. */
  eventBus?: DzipEventBus
}

export interface CostReport {
  totalCostCents: number
  totalTokens: { input: number; output: number; cached: number }
  perProvider: Record<
    string,
    {
      costCents: number
      inputTokens: number
      outputTokens: number
      invocations: number
    }
  >
}

// ---------------------------------------------------------------------------
// Internal per-provider accumulator
// ---------------------------------------------------------------------------

interface ProviderAccumulator {
  costCents: number
  inputTokens: number
  outputTokens: number
  invocations: number
}

function emptyAccumulator(): ProviderAccumulator {
  return { costCents: 0, inputTokens: 0, outputTokens: 0, invocations: 0 }
}

// ---------------------------------------------------------------------------
// CostTrackingMiddleware
// ---------------------------------------------------------------------------

export class CostTrackingMiddleware {
  private readonly maxBudgetCents: number | undefined
  private readonly perProviderBudgetCents: Partial<Record<AdapterProviderId, number>>
  private readonly warningThreshold: number
  private readonly criticalThreshold: number
  private readonly eventBus: DzipEventBus | undefined

  private accumulators = new Map<AdapterProviderId, ProviderAccumulator>()
  private totalCostCents = 0

  /** Tracks whether each threshold has already been emitted to avoid duplicates. */
  private warningEmitted = false
  private criticalEmitted = false

  constructor(config: CostTrackingConfig) {
    this.maxBudgetCents = config.maxBudgetCents
    this.perProviderBudgetCents = config.perProviderBudgetCents ?? {}
    this.warningThreshold = config.warningThresholdPercent ?? 80
    this.criticalThreshold = config.criticalThresholdPercent ?? 95
    this.eventBus = config.eventBus
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Wrap an adapter event stream to track costs.
   *
   * All events are yielded unchanged. On `adapter:completed` events that
   * carry `usage`, cost is accumulated and budget checks are performed.
   */
  async *wrap(source: AsyncGenerator<AgentEvent>): AsyncGenerator<AgentEvent> {
    for await (const event of source) {
      if (event.type === 'adapter:completed' && event.usage) {
        this.recordUsage(event.providerId, event.usage)
      }

      yield event
    }
  }

  /** Return a snapshot of accumulated costs. */
  getUsage(): CostReport {
    const totalTokens = { input: 0, output: 0, cached: 0 }
    const perProvider: CostReport['perProvider'] = {}

    for (const [providerId, acc] of this.accumulators) {
      totalTokens.input += acc.inputTokens
      totalTokens.output += acc.outputTokens
      perProvider[providerId] = {
        costCents: acc.costCents,
        inputTokens: acc.inputTokens,
        outputTokens: acc.outputTokens,
        invocations: acc.invocations,
      }
    }

    return {
      totalCostCents: this.totalCostCents,
      totalTokens,
      perProvider,
    }
  }

  /** Reset all accumulated costs and thresholds. */
  reset(): void {
    this.accumulators.clear()
    this.totalCostCents = 0
    this.warningEmitted = false
    this.criticalEmitted = false
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private getAccumulator(providerId: AdapterProviderId): ProviderAccumulator {
    let acc = this.accumulators.get(providerId)
    if (!acc) {
      acc = emptyAccumulator()
      this.accumulators.set(providerId, acc)
    }
    return acc
  }

  private recordUsage(providerId: AdapterProviderId, usage: TokenUsage): void {
    const acc = this.getAccumulator(providerId)

    acc.inputTokens += usage.inputTokens
    acc.outputTokens += usage.outputTokens
    acc.invocations += 1

    const costCents = usage.costCents ?? this.estimateCost(providerId, usage)
    acc.costCents += costCents
    this.totalCostCents += costCents

    // Check per-provider budget first
    const providerLimit = this.perProviderBudgetCents[providerId]
    if (providerLimit !== undefined && acc.costCents > providerLimit) {
      throw new ForgeError({
        code: 'BUDGET_EXCEEDED',
        message: `Provider "${providerId}" budget exceeded: ${acc.costCents.toFixed(2)}c / ${providerLimit}c`,
        recoverable: false,
        context: { providerId, costCents: acc.costCents, limitCents: providerLimit },
      })
    }

    // Check global budget
    if (this.maxBudgetCents !== undefined) {
      const percent = (this.totalCostCents / this.maxBudgetCents) * 100

      if (this.totalCostCents > this.maxBudgetCents) {
        const budgetUsage = this.buildBudgetUsage(percent)
        this.eventBus?.emit({
          type: 'budget:exceeded',
          reason: `Total budget exceeded: ${this.totalCostCents.toFixed(2)}c / ${this.maxBudgetCents}c`,
          usage: budgetUsage,
        })
        throw new ForgeError({
          code: 'BUDGET_EXCEEDED',
          message: `Total budget exceeded: ${this.totalCostCents.toFixed(2)}c / ${this.maxBudgetCents}c`,
          recoverable: false,
          context: { totalCostCents: this.totalCostCents, limitCents: this.maxBudgetCents },
        })
      }

      if (!this.criticalEmitted && percent >= this.criticalThreshold) {
        this.criticalEmitted = true
        this.warningEmitted = true // skip warn if we jump straight to critical
        this.eventBus?.emit({
          type: 'budget:warning',
          level: 'critical',
          usage: this.buildBudgetUsage(percent),
        })
      } else if (!this.warningEmitted && percent >= this.warningThreshold) {
        this.warningEmitted = true
        this.eventBus?.emit({
          type: 'budget:warning',
          level: 'warn',
          usage: this.buildBudgetUsage(percent),
        })
      }
    }
  }

  private estimateCost(providerId: AdapterProviderId, usage: TokenUsage): number {
    const rates = PROVIDER_RATES[providerId]
    const inputCost = (usage.inputTokens * rates.inputCentsPer1M) / 1_000_000
    const outputCost = (usage.outputTokens * rates.outputCentsPer1M) / 1_000_000
    return inputCost + outputCost
  }

  private buildBudgetUsage(percent: number) {
    const totalTokens = this.getTotalTokenCount()
    return {
      tokensUsed: totalTokens,
      tokensLimit: 0, // token limit is not tracked by this middleware
      costCents: this.totalCostCents,
      costLimitCents: this.maxBudgetCents ?? 0,
      iterations: this.getTotalInvocations(),
      iterationsLimit: 0,
      percent,
    }
  }

  private getTotalTokenCount(): number {
    let total = 0
    for (const acc of this.accumulators.values()) {
      total += acc.inputTokens + acc.outputTokens
    }
    return total
  }

  private getTotalInvocations(): number {
    let total = 0
    for (const acc of this.accumulators.values()) {
      total += acc.invocations
    }
    return total
  }
}
