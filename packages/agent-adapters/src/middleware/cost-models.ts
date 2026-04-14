/**
 * Externalized provider cost models.
 *
 * Provides configurable per-provider, per-model token rates, pre-execution
 * cost estimation, and a registry for looking up the cheapest provider.
 */

import type { AdapterProviderId, TokenUsage } from '../types.js'

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Per-model token rates */
export interface TokenRates {
  /** Cost per 1M input tokens in cents */
  inputCentsPerMillion: number
  /** Cost per 1M output tokens in cents */
  outputCentsPerMillion: number
  /** Cost per 1M cached input tokens (if applicable) */
  cachedInputCentsPerMillion?: number
}

/** Input for cost estimation before execution */
export interface CostEstimationInput {
  promptLength: number
  expectedOutputLength?: number
  model?: string
  maxTurns?: number
}

/** Pre-execution cost estimate */
export interface CostEstimate {
  estimatedInputTokens: number
  estimatedOutputTokens: number
  estimatedCostCents: number
  confidence: 'high' | 'medium' | 'low'
  model: string
  providerId: AdapterProviderId
}

/** Actual cost calculation result */
export interface CostCalculation {
  inputCostCents: number
  outputCostCents: number
  totalCostCents: number
  rates: TokenRates
}

/** Cost model for a specific provider */
export interface ProviderCostModel {
  providerId: AdapterProviderId
  modelRates: Map<string, TokenRates>
  defaultRates: TokenRates

  /** Estimate cost before execution */
  estimateCost(input: CostEstimationInput): CostEstimate

  /** Calculate actual cost from token usage */
  calculateCost(usage: TokenUsage, model?: string): CostCalculation
}

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

function createProviderCostModel(
  providerId: AdapterProviderId,
  defaultRates: TokenRates,
  modelRates?: Map<string, TokenRates>,
): ProviderCostModel {
  const rates = modelRates ?? new Map<string, TokenRates>()
  return {
    providerId,
    modelRates: rates,
    defaultRates,

    estimateCost(input: CostEstimationInput): CostEstimate {
      const ratesForModel =
        (input.model ? rates.get(input.model) : undefined) ?? defaultRates
      // Rough estimate: ~4 chars per token
      const estimatedInputTokens = Math.ceil(input.promptLength / 4)
      const estimatedOutputTokens = input.expectedOutputLength
        ? Math.ceil(input.expectedOutputLength / 4)
        : estimatedInputTokens * 2 // Assume 2x output when unknown
      const turns = input.maxTurns ?? 1
      const inputCost =
        (estimatedInputTokens * turns * ratesForModel.inputCentsPerMillion) /
        1_000_000
      const outputCost =
        (estimatedOutputTokens * turns * ratesForModel.outputCentsPerMillion) /
        1_000_000
      return {
        estimatedInputTokens: estimatedInputTokens * turns,
        estimatedOutputTokens: estimatedOutputTokens * turns,
        estimatedCostCents: inputCost + outputCost,
        confidence: input.expectedOutputLength ? 'medium' : 'low',
        model: input.model ?? 'default',
        providerId,
      }
    },

    calculateCost(usage: TokenUsage, model?: string): CostCalculation {
      const r = (model ? rates.get(model) : undefined) ?? defaultRates
      const inputCost =
        (usage.inputTokens * r.inputCentsPerMillion) / 1_000_000
      const outputCost =
        (usage.outputTokens * r.outputCentsPerMillion) / 1_000_000
      return {
        inputCostCents: inputCost,
        outputCostCents: outputCost,
        totalCostCents: inputCost + outputCost,
        rates: r,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Built-in provider cost model factories
// ---------------------------------------------------------------------------

function createClaudeCostModel(): ProviderCostModel {
  return createProviderCostModel(
    'claude',
    { inputCentsPerMillion: 300, outputCentsPerMillion: 1500 },
    new Map([
      [
        'claude-sonnet-4-5-20250514',
        { inputCentsPerMillion: 300, outputCentsPerMillion: 1500 },
      ],
      [
        'claude-haiku-3-5-20241022',
        { inputCentsPerMillion: 80, outputCentsPerMillion: 400 },
      ],
    ]),
  )
}

function createCodexCostModel(): ProviderCostModel {
  return createProviderCostModel('codex', {
    inputCentsPerMillion: 200,
    outputCentsPerMillion: 800,
  })
}

function createGeminiCostModel(): ProviderCostModel {
  return createProviderCostModel('gemini', {
    inputCentsPerMillion: 125,
    outputCentsPerMillion: 500,
  })
}

function createQwenCostModel(): ProviderCostModel {
  return createProviderCostModel('qwen', {
    inputCentsPerMillion: 50,
    outputCentsPerMillion: 200,
  })
}

function createCrushCostModel(): ProviderCostModel {
  return createProviderCostModel('crush', {
    inputCentsPerMillion: 0,
    outputCentsPerMillion: 0,
  })
}

// ---------------------------------------------------------------------------
// CostModelRegistry
// ---------------------------------------------------------------------------

/** Registry of provider cost models */
export class CostModelRegistry {
  private readonly models = new Map<string, ProviderCostModel>()

  constructor() {
    // Register built-in defaults
    this.register(createClaudeCostModel())
    this.register(createCodexCostModel())
    this.register(createGeminiCostModel())
    this.register(createQwenCostModel())
    this.register(createCrushCostModel())
    this.register(createProviderCostModel('goose', { inputCentsPerMillion: 0, outputCentsPerMillion: 0 }))
    this.register(createProviderCostModel('openrouter', { inputCentsPerMillion: 300, outputCentsPerMillion: 1500 }))
  }

  register(model: ProviderCostModel): void {
    this.models.set(model.providerId, model)
  }

  get(providerId: string): ProviderCostModel | undefined {
    return this.models.get(providerId)
  }

  /** Estimate cost across all providers */
  estimateAll(
    input: CostEstimationInput,
  ): Map<string, CostEstimate> {
    const results = new Map<string, CostEstimate>()
    for (const [id, model] of this.models) {
      results.set(id, model.estimateCost(input))
    }
    return results
  }

  /** Find cheapest provider for a workload */
  findCheapest(
    input: CostEstimationInput,
  ): { providerId: string; estimate: CostEstimate } | undefined {
    let cheapest: { providerId: string; estimate: CostEstimate } | undefined
    for (const [id, model] of this.models) {
      const est = model.estimateCost(input)
      if (
        !cheapest ||
        est.estimatedCostCents < cheapest.estimate.estimatedCostCents
      ) {
        cheapest = { providerId: id, estimate: est }
      }
    }
    return cheapest
  }

  /** List registered provider IDs */
  listProviders(): string[] {
    return [...this.models.keys()]
  }
}
