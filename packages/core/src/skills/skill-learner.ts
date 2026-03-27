/**
 * Skill self-improvement system — tracks execution metrics and identifies
 * skills that need review or are eligible for prompt optimization.
 *
 * Zero external dependencies. All state is held in-memory; callers are
 * responsible for persisting snapshots if needed.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillMetrics {
  name: string
  executionCount: number
  successCount: number
  failureCount: number
  avgTokens: number
  avgLatencyMs: number
  lastExecutedAt: number
  successRate: number
}

export interface SkillExecutionResult {
  success: boolean
  tokens: number
  latencyMs: number
}

export interface SkillLearnerConfig {
  /** Min executions before optimization is considered (default: 5) */
  minExecutionsForOptimization: number
  /** Success rate threshold for flagging review (default: 0.5) */
  reviewThreshold: number
  /** Success rate threshold for auto-optimization (default: 0.8) */
  optimizationThreshold: number
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: SkillLearnerConfig = {
  minExecutionsForOptimization: 5,
  reviewThreshold: 0.5,
  optimizationThreshold: 0.8,
}

// ---------------------------------------------------------------------------
// SkillLearner
// ---------------------------------------------------------------------------

export class SkillLearner {
  private readonly metrics: Map<string, SkillMetrics> = new Map()
  private readonly config: SkillLearnerConfig

  constructor(config?: Partial<SkillLearnerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /** Record a skill execution result and update running averages. */
  recordExecution(name: string, result: SkillExecutionResult): void {
    const existing = this.metrics.get(name)

    if (!existing) {
      this.metrics.set(name, {
        name,
        executionCount: 1,
        successCount: result.success ? 1 : 0,
        failureCount: result.success ? 0 : 1,
        avgTokens: result.tokens,
        avgLatencyMs: result.latencyMs,
        lastExecutedAt: Date.now(),
        successRate: result.success ? 1 : 0,
      })
      return
    }

    existing.executionCount += 1
    existing.successCount += result.success ? 1 : 0
    existing.failureCount += result.success ? 0 : 1
    existing.lastExecutedAt = Date.now()

    // Incremental average: avg' = avg + (new - avg) / n
    const n = existing.executionCount
    existing.avgTokens += (result.tokens - existing.avgTokens) / n
    existing.avgLatencyMs += (result.latencyMs - existing.avgLatencyMs) / n
    existing.successRate = existing.successCount / n
  }

  /** Get metrics for a single skill. */
  getMetrics(name: string): SkillMetrics | undefined {
    return this.metrics.get(name)
  }

  /** Get all tracked skill metrics (snapshot copies). */
  getAllMetrics(): SkillMetrics[] {
    return Array.from(this.metrics.values())
  }

  /**
   * Skills with a success rate below `reviewThreshold` that have been
   * executed at least `minExecutionsForOptimization` times.
   * These likely need human attention (broken tool, bad prompt, etc.).
   */
  getSkillsNeedingReview(): SkillMetrics[] {
    const { minExecutionsForOptimization, reviewThreshold } = this.config
    return this.getAllMetrics().filter(
      (m) =>
        m.executionCount >= minExecutionsForOptimization &&
        m.successRate < reviewThreshold,
    )
  }

  /**
   * Skills with a success rate at or above `optimizationThreshold` and
   * enough data to be confident. These are good candidates for automated
   * prompt shortening or restructuring.
   */
  getOptimizableSkills(): SkillMetrics[] {
    const { minExecutionsForOptimization, optimizationThreshold } = this.config
    return this.getAllMetrics().filter(
      (m) =>
        m.executionCount >= minExecutionsForOptimization &&
        m.successRate >= optimizationThreshold,
    )
  }

  /**
   * Build an LLM prompt that can be used to optimize a skill's instructions.
   * The caller is responsible for actually invoking the LLM with the result.
   */
  buildOptimizationPrompt(skillName: string, currentPrompt: string): string {
    const m = this.metrics.get(skillName)
    const statsBlock = m
      ? [
          `Executions: ${m.executionCount}`,
          `Success rate: ${(m.successRate * 100).toFixed(1)}%`,
          `Avg tokens: ${Math.round(m.avgTokens)}`,
          `Avg latency: ${Math.round(m.avgLatencyMs)}ms`,
        ].join('\n')
      : 'No metrics available.'

    return [
      'You are an expert prompt engineer. Optimize the following skill prompt.',
      'Goals: reduce token usage, improve clarity, preserve intent.',
      'Do NOT change the skill name or purpose.',
      '',
      '## Performance Metrics',
      statsBlock,
      '',
      '## Current Prompt',
      '```',
      currentPrompt,
      '```',
      '',
      '## Instructions',
      '1. Remove redundant wording and filler.',
      '2. Consolidate overlapping instructions.',
      '3. Keep all verification/safety steps.',
      '4. Return ONLY the optimized prompt text (no explanation).',
    ].join('\n')
  }

  /** Reset metrics for a skill (typically called after optimization). */
  resetMetrics(name: string): void {
    this.metrics.delete(name)
  }
}
