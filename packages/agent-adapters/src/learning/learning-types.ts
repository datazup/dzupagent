/**
 * Public types for the adapter learning plane.
 *
 * Shared between {@link AdapterLearningLoop} and {@link ExecutionAnalyzer}.
 */

import type { DzupEventBus } from '@dzupagent/core/events'
import type { AdapterProviderId } from '../types.js'

export interface ExecutionRecord {
  tenantId?: string | null
  providerId: AdapterProviderId
  taskType: string
  tags: string[]
  success: boolean
  durationMs: number
  inputTokens: number
  outputTokens: number
  costCents: number
  errorType?: string
  qualityScore?: number
  timestamp: number
}

export interface ProviderProfile {
  tenantId?: string | null
  providerId: AdapterProviderId
  totalExecutions: number
  successRate: number
  avgDurationMs: number
  avgCostCents: number
  avgQualityScore: number
  /** Task types this provider excels at (success rate > 0.8 with > 5 samples) */
  specialties: string[]
  /** Task types this provider struggles with (success rate < 0.5 with > 5 samples) */
  weaknesses: string[]
  /** Recent trend: improving, stable, degrading */
  trend: 'improving' | 'stable' | 'degrading'
}

export interface FailurePattern {
  patternId: string
  tenantId?: string | null
  providerId: AdapterProviderId
  errorType: string
  frequency: number
  firstSeen: Date
  lastSeen: Date
  suggestedAction: RecoverySuggestion
}

export type RecoverySuggestion =
  | { action: 'switch-provider'; targetProvider: AdapterProviderId; reason: string }
  | { action: 'increase-budget'; multiplier: number; reason: string }
  | { action: 'simplify-task'; reason: string }
  | { action: 'retry'; backoffMs: number; reason: string }

export interface LearningConfig {
  /** Max records to keep per provider. Default 500 */
  maxRecordsPerProvider?: number
  /** Window for failure pattern detection in ms. Default 3600_000 (1 hour) */
  failureWindowMs?: number
  /** Min records before provider profile is considered reliable. Default 10 */
  minSampleSize?: number
  /** Event bus */
  eventBus?: DzupEventBus
}

export interface PerformanceReport {
  generatedAt: Date
  totalExecutions: number
  overallSuccessRate: number
  avgCostPerExecution: number
  providers: ProviderProfile[]
  activeFailurePatterns: FailurePattern[]
  recommendations: string[]
}

export interface ProviderComparison {
  providerA: { providerId: AdapterProviderId; successRate: number; avgDuration: number; avgCost: number }
  providerB: { providerId: AdapterProviderId; successRate: number; avgDuration: number; avgCost: number }
  winner: AdapterProviderId | 'tie'
  reason: string
}

/**
 * Read-only surface consumed by {@link ExecutionAnalyzer}.
 *
 * Keeping the analyzer on this structural interface avoids a concrete import
 * from `execution-analyzer.ts` back to `adapter-learning-loop.ts`.
 */
export interface AdapterLearningLoopReader {
  getAllProfiles(tenantId?: string): ProviderProfile[]
  getProfile(providerId: AdapterProviderId, tenantId?: string): ProviderProfile
  detectFailurePatterns(providerId: AdapterProviderId, tenantId?: string): FailurePattern[]
  getBestProvider(
    taskType: string,
    available: AdapterProviderId[],
    tenantId?: string,
  ): AdapterProviderId | undefined
  exportData(tenantId?: string): Record<string, ExecutionRecord[]>
}
