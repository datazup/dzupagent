import { describe, it, expect } from 'vitest'

import { CostModelRegistry } from '../middleware/cost-models.js'
import type {
  ProviderCostModel,
  TokenRates,
  CostEstimationInput,
} from '../middleware/cost-models.js'
import type { AdapterProviderId, TokenUsage } from '../types.js'

describe('CostModelRegistry', () => {
  it('has built-in models for all 7 providers', () => {
    const registry = new CostModelRegistry()
    const providers = registry.listProviders()
    expect(providers).toContain('claude')
    expect(providers).toContain('codex')
    expect(providers).toContain('gemini')
    expect(providers).toContain('qwen')
    expect(providers).toContain('crush')
    expect(providers).toContain('goose')
    expect(providers).toContain('openrouter')
    expect(providers).toHaveLength(7)
  })

  it('estimateCost returns reasonable estimate', () => {
    const registry = new CostModelRegistry()
    const claude = registry.get('claude')!
    const estimate = claude.estimateCost({ promptLength: 4000 })

    // 4000 chars / 4 = 1000 input tokens, 2000 output tokens (2x default)
    expect(estimate.estimatedInputTokens).toBe(1000)
    expect(estimate.estimatedOutputTokens).toBe(2000)
    expect(estimate.estimatedCostCents).toBeGreaterThan(0)
    expect(estimate.confidence).toBe('low') // no expectedOutputLength
    expect(estimate.providerId).toBe('claude')
    expect(estimate.model).toBe('default')
  })

  it('calculateCost matches expected rates', () => {
    const registry = new CostModelRegistry()
    const claude = registry.get('claude')!
    const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
    const calc = claude.calculateCost(usage)

    // Claude default: 300 cents / 1M input, 1500 cents / 1M output
    expect(calc.inputCostCents).toBe(300)
    expect(calc.outputCostCents).toBe(1500)
    expect(calc.totalCostCents).toBe(1800)
    expect(calc.rates.inputCentsPerMillion).toBe(300)
    expect(calc.rates.outputCentsPerMillion).toBe(1500)
  })

  it('findCheapest returns cheapest provider', () => {
    const registry = new CostModelRegistry()
    const input: CostEstimationInput = { promptLength: 4000 }
    const result = registry.findCheapest(input)

    expect(result).toBeDefined()
    // Crush has 0/0 rates, so it should always be cheapest
    expect(result!.providerId).toBe('crush')
    expect(result!.estimate.estimatedCostCents).toBe(0)
  })

  it('estimateAll returns estimates for all providers', () => {
    const registry = new CostModelRegistry()
    const input: CostEstimationInput = { promptLength: 4000 }
    const all = registry.estimateAll(input)

    expect(all.size).toBe(7)
    expect(all.has('claude')).toBe(true)
    expect(all.has('codex')).toBe(true)
    expect(all.has('gemini')).toBe(true)
    expect(all.has('qwen')).toBe(true)
    expect(all.has('crush')).toBe(true)
    expect(all.has('goose')).toBe(true)
    expect(all.has('openrouter')).toBe(true)

    // Claude should be more expensive than qwen
    const claudeEst = all.get('claude')!
    const qwenEst = all.get('qwen')!
    expect(claudeEst.estimatedCostCents).toBeGreaterThan(qwenEst.estimatedCostCents)
  })

  it('custom model can be registered', () => {
    const registry = new CostModelRegistry()
    const customModel: ProviderCostModel = {
      providerId: 'claude' as AdapterProviderId,
      modelRates: new Map<string, TokenRates>(),
      defaultRates: { inputCentsPerMillion: 999, outputCentsPerMillion: 999 },
      estimateCost(input: CostEstimationInput) {
        return {
          estimatedInputTokens: 0,
          estimatedOutputTokens: 0,
          estimatedCostCents: 42,
          confidence: 'high',
          model: 'custom',
          providerId: 'claude' as AdapterProviderId,
        }
      },
      calculateCost(usage: TokenUsage) {
        return {
          inputCostCents: 0,
          outputCostCents: 0,
          totalCostCents: 42,
          rates: { inputCentsPerMillion: 999, outputCentsPerMillion: 999 },
        }
      },
    }

    registry.register(customModel)
    const retrieved = registry.get('claude')!
    expect(retrieved.defaultRates.inputCentsPerMillion).toBe(999)
    expect(retrieved.calculateCost({ inputTokens: 0, outputTokens: 0 }).totalCostCents).toBe(42)
  })

  it('model-specific rates override defaults', () => {
    const registry = new CostModelRegistry()
    const claude = registry.get('claude')!

    // Use haiku model-specific rates
    const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
    const haikuCalc = claude.calculateCost(usage, 'claude-haiku-3-5-20241022')

    // Haiku: 80 cents / 1M input, 400 cents / 1M output
    expect(haikuCalc.inputCostCents).toBe(80)
    expect(haikuCalc.outputCostCents).toBe(400)
    expect(haikuCalc.totalCostCents).toBe(480)

    // Default (sonnet-like) rates should be different
    const defaultCalc = claude.calculateCost(usage)
    expect(defaultCalc.totalCostCents).toBe(1800)
    expect(defaultCalc.totalCostCents).toBeGreaterThan(haikuCalc.totalCostCents)
  })

  it('listProviders returns all registered', () => {
    const registry = new CostModelRegistry()
    const providers = registry.listProviders()
    expect(providers).toEqual(
      expect.arrayContaining(['claude', 'codex', 'gemini', 'qwen', 'crush', 'goose', 'openrouter']),
    )
    expect(providers).toHaveLength(7)
  })

  it('estimateCost uses expectedOutputLength when provided', () => {
    const registry = new CostModelRegistry()
    const claude = registry.get('claude')!

    const estimate = claude.estimateCost({
      promptLength: 4000,
      expectedOutputLength: 2000,
    })

    // 4000/4 = 1000 input, 2000/4 = 500 output
    expect(estimate.estimatedInputTokens).toBe(1000)
    expect(estimate.estimatedOutputTokens).toBe(500)
    expect(estimate.confidence).toBe('medium')
  })

  it('estimateCost accounts for maxTurns', () => {
    const registry = new CostModelRegistry()
    const claude = registry.get('claude')!

    const single = claude.estimateCost({ promptLength: 4000, maxTurns: 1 })
    const multi = claude.estimateCost({ promptLength: 4000, maxTurns: 3 })

    expect(multi.estimatedCostCents).toBeCloseTo(single.estimatedCostCents * 3, 10)
    expect(multi.estimatedInputTokens).toBe(single.estimatedInputTokens * 3)
    expect(multi.estimatedOutputTokens).toBe(single.estimatedOutputTokens * 3)
  })

  it('estimateCost uses model-specific rates for estimation', () => {
    const registry = new CostModelRegistry()
    const claude = registry.get('claude')!

    const defaultEst = claude.estimateCost({ promptLength: 4000 })
    const haikuEst = claude.estimateCost({
      promptLength: 4000,
      model: 'claude-haiku-3-5-20241022',
    })

    // Haiku is cheaper than default sonnet rates
    expect(haikuEst.estimatedCostCents).toBeLessThan(defaultEst.estimatedCostCents)
  })
})
