/**
 * Public types for the A/B testing framework.
 *
 * Extracted from `ab-test-runner.ts` to keep the runner focused on
 * orchestration logic. See `ab-test-runner.ts` for execution flow and
 * `ab-test-stats.ts` for statistical helpers.
 */

import type { DzupEventBus } from '@dzupagent/core/events'

import type {
  AdapterConfig,
  AdapterProviderId,
  AgentInput,
} from '../types.js'
import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'

export interface ABTestConfig {
  registry: ProviderAdapterRegistry
  eventBus?: DzupEventBus
}

export interface ABTestCase {
  /** Unique test case ID */
  id: string
  /** Input prompt to test */
  input: AgentInput
  /** Optional expected output for scoring */
  expectedOutput?: string
  /** Tags for categorization */
  tags?: string[]
}

export interface ABTestVariant {
  /** Variant name (e.g., 'control', 'treatment-a') */
  name: string
  /** Which provider to use */
  providerId: AdapterProviderId
  /** Optional config overrides for this variant */
  configOverrides?: Partial<AdapterConfig>
}

export interface ABTestScorer {
  readonly name: string
  /** Score a result from 0 to 1. Higher is better. */
  score(result: string, testCase: ABTestCase): Promise<number>
}

export interface ABTestPlan {
  /** Test plan name */
  name: string
  /** Variants to compare */
  variants: ABTestVariant[]
  /** Test cases to run */
  testCases: ABTestCase[]
  /** Scorers to evaluate results */
  scorers: ABTestScorer[]
  /** Number of repetitions per test case per variant. Default 1 */
  repetitions?: number
  /** Max concurrency across all variants. Default 2 */
  maxConcurrency?: number
  /** Abort signal */
  signal?: AbortSignal
}

export interface VariantResult {
  variantName: string
  providerId: AdapterProviderId
  testCaseId: string
  repetition: number
  result: string
  success: boolean
  durationMs: number
  scores: Record<string, number>
  error?: string
}

export interface ABTestReport {
  planName: string
  startedAt: Date
  completedAt: Date
  totalDurationMs: number
  variants: ABVariantSummary[]
  winner: ABVariantSummary | undefined
  /** Statistical comparison between variants */
  comparison: ABComparison[]
  /** Raw results */
  rawResults: VariantResult[]
}

export interface ABVariantSummary {
  variantName: string
  providerId: AdapterProviderId
  totalRuns: number
  successRate: number
  avgDurationMs: number
  avgScores: Record<string, number>
  totalCostEstimateCents: number
}

export interface ABComparison {
  variantA: string
  variantB: string
  scorerName: string
  /** Mean difference (A - B) */
  meanDiff: number
  /** Whether the difference is statistically significant (p < 0.05) */
  significant: boolean
  /** p-value from two-sample t-test approximation */
  pValue: number
  /** Which variant is better for this scorer */
  winner: string | 'tie'
}

/** Internal job descriptor used by the runner. */
export interface ABJob {
  testCase: ABTestCase
  variant: ABTestVariant
  repetition: number
}
