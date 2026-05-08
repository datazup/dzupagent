/**
 * Lesson-based confidence adjustments for recovery strategies.
 *
 * Boosts or penalizes a strategy's confidence based on past recovery
 * lessons retrieved from the {@link RecoveryFeedback} store.
 *
 * @module recovery/lesson-boosts
 */

import type { RecoveryLesson } from '../self-correction/recovery-feedback.js'
import type { RecoveryStrategy } from './recovery-types.js'

/**
 * Boost or penalize strategy confidence based on past recovery lessons.
 *
 * - Strategies that previously succeeded for the same error type get a boost.
 * - Strategies that previously failed get a penalty.
 * - The magnitude of the adjustment scales with how many past data points exist.
 */
export function applyLessonBoosts(
  strategies: RecoveryStrategy[],
  lessons: RecoveryLesson[],
): RecoveryStrategy[] {
  // Build a success/failure tally per strategy name
  const tally = new Map<string, { successes: number; failures: number }>()

  for (const lesson of lessons) {
    const existing = tally.get(lesson.strategy)
    if (existing) {
      if (lesson.outcome === 'success') existing.successes++
      else existing.failures++
    } else {
      tally.set(lesson.strategy, {
        successes: lesson.outcome === 'success' ? 1 : 0,
        failures: lesson.outcome === 'failure' ? 1 : 0,
      })
    }
  }

  for (const strategy of strategies) {
    const stats = tally.get(strategy.name)
    if (!stats) continue

    const total = stats.successes + stats.failures
    if (total === 0) continue

    const successRate = stats.successes / total

    if (successRate > 0.5) {
      // Boost: previously successful strategy
      const boost = 0.15 * successRate
      strategy.confidence = Math.min(strategy.confidence + boost, 1.0)
    } else if (successRate < 0.5 && stats.failures > 0) {
      // Penalize: previously failed strategy
      const penalty = 0.15 * (1 - successRate)
      strategy.confidence = Math.max(strategy.confidence - penalty, 0.05)
    }
  }

  return strategies
}
