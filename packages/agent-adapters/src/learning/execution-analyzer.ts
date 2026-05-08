/**
 * ExecutionAnalyzer — statistical analysis and reporting layer over an
 * {@link AdapterLearningLoop}. Generates performance reports, compares
 * providers head-to-head, and computes optimal task→provider allocations.
 */

import type { AdapterProviderId } from '../types.js'
import type {
  AdapterLearningLoopReader,
  ExecutionRecord,
  FailurePattern,
  PerformanceReport,
  ProviderComparison,
  ProviderProfile,
} from './learning-types.js'

export class ExecutionAnalyzer {
  constructor(private readonly learningLoop: AdapterLearningLoopReader) {}

  /** Generate performance report across all providers */
  generateReport(): PerformanceReport {
    const profiles = this.learningLoop.getAllProfiles()
    const totalExecutions = profiles.reduce((s, p) => s + p.totalExecutions, 0)

    const overallSuccessRate = totalExecutions > 0
      ? profiles.reduce((s, p) => s + p.successRate * p.totalExecutions, 0) / totalExecutions
      : 0

    const avgCostPerExecution = totalExecutions > 0
      ? profiles.reduce((s, p) => s + p.avgCostCents * p.totalExecutions, 0) / totalExecutions
      : 0

    // Collect all active failure patterns
    const allPatterns: FailurePattern[] = []
    for (const profile of profiles) {
      const patterns = this.learningLoop.detectFailurePatterns(profile.providerId)
      allPatterns.push(...patterns)
    }

    const recommendations = this.buildRecommendations(profiles, allPatterns)

    return {
      generatedAt: new Date(),
      totalExecutions,
      overallSuccessRate,
      avgCostPerExecution,
      providers: profiles,
      activeFailurePatterns: allPatterns,
      recommendations,
    }
  }

  /** Compare two providers for a specific task type */
  compareProviders(
    providerA: AdapterProviderId,
    providerB: AdapterProviderId,
    taskType?: string,
  ): ProviderComparison {
    const profileA = this.learningLoop.getProfile(providerA)
    const profileB = this.learningLoop.getProfile(providerB)

    // If a task type is specified, compute task-specific stats from exported data
    let statsA = { successRate: profileA.successRate, avgDuration: profileA.avgDurationMs, avgCost: profileA.avgCostCents }
    let statsB = { successRate: profileB.successRate, avgDuration: profileB.avgDurationMs, avgCost: profileB.avgCostCents }

    if (taskType) {
      const data = this.learningLoop.exportData()
      statsA = this.computeTaskStats(data[providerA] ?? [], taskType)
      statsB = this.computeTaskStats(data[providerB] ?? [], taskType)
    }

    // Determine winner: success rate > speed > cost
    let winner: AdapterProviderId | 'tie' = 'tie'
    let reason = 'Both providers perform equally'

    if (statsA.successRate !== statsB.successRate) {
      const diff = Math.abs(statsA.successRate - statsB.successRate)
      if (diff > 0.01) {
        winner = statsA.successRate > statsB.successRate ? providerA : providerB
        reason = `Higher success rate (${(Math.max(statsA.successRate, statsB.successRate) * 100).toFixed(1)}% vs ${(Math.min(statsA.successRate, statsB.successRate) * 100).toFixed(1)}%)`
      }
    }

    if (winner === 'tie' && statsA.avgDuration !== statsB.avgDuration) {
      winner = statsA.avgDuration < statsB.avgDuration ? providerA : providerB
      reason = `Faster average duration (${Math.min(statsA.avgDuration, statsB.avgDuration).toFixed(0)}ms vs ${Math.max(statsA.avgDuration, statsB.avgDuration).toFixed(0)}ms)`
    }

    if (winner === 'tie' && statsA.avgCost !== statsB.avgCost) {
      winner = statsA.avgCost < statsB.avgCost ? providerA : providerB
      reason = `Lower average cost`
    }

    return {
      providerA: { providerId: providerA, ...statsA },
      providerB: { providerId: providerB, ...statsB },
      winner,
      reason,
    }
  }

  /** Identify optimal provider allocation (which provider for which task type) */
  getOptimalAllocation(): Map<string, AdapterProviderId> {
    const allocation = new Map<string, AdapterProviderId>()
    const data = this.learningLoop.exportData()

    // Collect all unique task types across all providers
    const taskTypes = new Set<string>()
    for (const records of Object.values(data)) {
      for (const rec of records) {
        taskTypes.add(rec.taskType)
      }
    }

    const providerIds = Object.keys(data) as AdapterProviderId[]

    for (const taskType of taskTypes) {
      const best = this.learningLoop.getBestProvider(taskType, providerIds)
      if (best) {
        allocation.set(taskType, best)
      }
    }

    return allocation
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private computeTaskStats(
    records: ExecutionRecord[],
    taskType: string,
  ): { successRate: number; avgDuration: number; avgCost: number } {
    const forTask = records.filter((r) => r.taskType === taskType)
    if (forTask.length === 0) {
      return { successRate: 0, avgDuration: 0, avgCost: 0 }
    }

    const successes = forTask.filter((r) => r.success).length
    return {
      successRate: successes / forTask.length,
      avgDuration: forTask.reduce((s, r) => s + r.durationMs, 0) / forTask.length,
      avgCost: forTask.reduce((s, r) => s + r.costCents, 0) / forTask.length,
    }
  }

  private buildRecommendations(profiles: ProviderProfile[], patterns: FailurePattern[]): string[] {
    const recommendations: string[] = []

    // Flag degrading providers
    for (const profile of profiles) {
      if (profile.trend === 'degrading') {
        recommendations.push(
          `Provider "${profile.providerId}" shows degrading performance — consider reducing its routing weight`,
        )
      }
    }

    // Flag providers with low success rate
    for (const profile of profiles) {
      if (profile.totalExecutions >= 10 && profile.successRate < 0.5) {
        recommendations.push(
          `Provider "${profile.providerId}" has a ${(profile.successRate * 100).toFixed(1)}% success rate — consider removing it from the rotation`,
        )
      }
    }

    // Flag active failure patterns
    for (const pattern of patterns) {
      if (pattern.frequency >= 5) {
        recommendations.push(
          `Frequent "${pattern.errorType}" errors on "${pattern.providerId}" (${pattern.frequency}x in window) — ${pattern.suggestedAction.reason}`,
        )
      }
    }

    // Suggest specialization
    for (const profile of profiles) {
      if (profile.specialties.length > 0) {
        recommendations.push(
          `Provider "${profile.providerId}" excels at: ${profile.specialties.join(', ')} — consider prioritizing it for these task types`,
        )
      }
    }

    return recommendations
  }
}
