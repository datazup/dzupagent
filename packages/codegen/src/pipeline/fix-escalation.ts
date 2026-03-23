/**
 * Fix escalation strategy for code generation pipelines.
 * Extracted from feature-generator.graph.ts fix() node logic.
 *
 * Three escalation levels:
 * - targeted: fix only failing files with default model
 * - expanded: full VFS listing + original plan context
 * - escalated: strongest model, consider full layer rewrite
 */
import type { ModelTier } from '@forgeagent/core'

export interface EscalationStrategy {
  name: 'targeted' | 'expanded' | 'escalated'
  modelTier?: ModelTier
  includeFullVfs?: boolean
  includePlan?: boolean
  promptSuffix?: string
}

export interface EscalationConfig {
  maxAttempts: number
  strategies: EscalationStrategy[]
}

export const DEFAULT_ESCALATION: EscalationConfig = {
  maxAttempts: 3,
  strategies: [
    { name: 'targeted' },
    {
      name: 'expanded',
      includeFullVfs: true,
      includePlan: true,
      promptSuffix: 'Previous targeted fix failed. Expand your analysis to consider the full file set and the original plan.',
    },
    {
      name: 'escalated',
      modelTier: 'reasoning',
      includeFullVfs: true,
      includePlan: true,
      promptSuffix: 'Two previous fix attempts failed. Consider regenerating the entire failing layer from scratch.',
    },
  ],
}

/**
 * Get the escalation strategy for a given attempt number.
 * Attempt 0 = first try (targeted), attempt 1 = expanded, attempt 2+ = escalated.
 */
export function getEscalationStrategy(
  attempt: number,
  config: EscalationConfig = DEFAULT_ESCALATION,
): EscalationStrategy {
  const idx = Math.min(attempt, config.strategies.length - 1)
  return config.strategies[idx] ?? config.strategies[config.strategies.length - 1]!
}
