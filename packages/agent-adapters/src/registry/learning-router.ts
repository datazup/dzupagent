import type { AdapterProviderId, RoutingDecision, TaskDescriptor, TaskRoutingStrategy } from '../types.js'
import type { AdapterLearningLoop } from '../learning/adapter-learning-loop.js'

export interface LearningRouterConfig {
  /** Minimum samples before trusting learning data. Default: 5 */
  minSamples?: number
  /** Weight for success rate in scoring. Default: 0.5 */
  successWeight?: number
  /** Weight for speed. Default: 0.2 */
  speedWeight?: number
  /** Weight for cost. Default: 0.3 */
  costWeight?: number
}

/**
 * Routes tasks based on historical provider performance data from the learning loop.
 * Falls back to round-robin when insufficient data exists.
 */
export class LearningRouter implements TaskRoutingStrategy {
  readonly name = 'learning-router'
  private roundRobinIndex = 0

  constructor(
    private readonly learningLoop: AdapterLearningLoop,
    private readonly config: LearningRouterConfig = {},
  ) {}

  route(task: TaskDescriptor, availableProviders: AdapterProviderId[]): RoutingDecision {
    if (availableProviders.length === 0) {
      return { provider: 'auto', reason: 'No providers available', confidence: 0, fallbackProviders: [] }
    }

    const minSamples = this.config.minSamples ?? 5
    const successWeight = this.config.successWeight ?? 0.5
    const speedWeight = this.config.speedWeight ?? 0.2
    const costWeight = this.config.costWeight ?? 0.3

    // Score each provider
    const scored: Array<{ providerId: AdapterProviderId; score: number; reason: string }> = []

    for (const providerId of availableProviders) {
      const profile = this.learningLoop.getProfile(providerId)

      // Not enough data — skip scoring, will use round-robin fallback
      if (!profile || profile.totalExecutions < minSamples) continue

      let score = profile.successRate * successWeight

      // Speed scoring (normalize: faster = higher score)
      if (profile.avgDurationMs > 0) {
        const speedScore = 1 / (1 + profile.avgDurationMs / 10000)
        score += speedScore * speedWeight
      }

      // Cost scoring (lower cost = higher score)
      if (profile.avgCostCents !== undefined && profile.avgCostCents > 0) {
        const costScore = 1 / (1 + profile.avgCostCents)
        score += costScore * costWeight
      } else {
        score += costWeight // Free provider gets full cost score
      }

      // Specialty bonus
      if (task.tags.some(t => profile.specialties.includes(t))) {
        score += 0.1
      }

      // Weakness penalty
      if (task.tags.some(t => profile.weaknesses.includes(t))) {
        score -= 0.2
      }

      // Trend adjustment
      if (profile.trend === 'improving') score += 0.05
      if (profile.trend === 'degrading') score -= 0.1

      // Budget constraint
      if (task.budgetConstraint === 'low' && profile.avgCostCents) {
        score -= profile.avgCostCents / 100
      }

      scored.push({
        providerId,
        score: Math.max(0, Math.min(1, score)),
        reason: `Learning score: ${score.toFixed(3)} (success: ${profile.successRate.toFixed(2)}, trend: ${profile.trend})`,
      })
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score)

    if (scored.length > 0) {
      return {
        provider: scored[0]!.providerId,
        reason: scored[0]!.reason,
        confidence: scored[0]!.score,
        fallbackProviders: scored.slice(1).map(s => s.providerId),
      }
    }

    // Fallback: round-robin when no learning data
    const idx = this.roundRobinIndex % availableProviders.length
    this.roundRobinIndex++
    return {
      provider: availableProviders[idx]!,
      reason: 'Insufficient learning data, using round-robin',
      confidence: 0.3,
      fallbackProviders: availableProviders.filter((_, i) => i !== idx),
    }
  }
}
