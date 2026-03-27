/**
 * Cost tracking middleware — tracks LLM token usage per call.
 * The CostTracker interface is implemented by consumers (e.g., PrismaCostTracker).
 */
import type { TokenUsage } from '../llm/invoke.js'

/** Approximate costs per 1M tokens (in cents) */
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 80, output: 400 },
  'claude-sonnet-4-6': { input: 300, output: 1500 },
  'claude-opus-4-6': { input: 1500, output: 7500 },
  'gpt-5-mini': { input: 15, output: 60 },
  'gpt-5': { input: 250, output: 1000 },
  default: { input: 200, output: 1000 },
}

/** Abstract cost tracker — implemented by consumers */
export interface CostTracker {
  trackUsage(params: {
    tenantId: string
    userId: string
    usage: TokenUsage
    context: string
  }): Promise<void>
}

/**
 * Calculate cost in cents for a given token usage.
 */
export function calculateCostCents(usage: TokenUsage): number {
  const costs = MODEL_COSTS[usage.model] ?? MODEL_COSTS['default']!
  const inputCost = (usage.inputTokens / 1_000_000) * costs.input
  const outputCost = (usage.outputTokens / 1_000_000) * costs.output
  return Math.ceil(inputCost + outputCost)
}

/**
 * Get known model pricing. Returns null for unknown models.
 */
export function getModelCosts(modelName: string): { input: number; output: number } | null {
  return MODEL_COSTS[modelName] ?? null
}
