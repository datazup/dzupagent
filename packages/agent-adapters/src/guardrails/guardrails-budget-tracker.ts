/**
 * Budget tracking for {@link AdapterGuardrails}.
 *
 * Extracted from `adapter-guardrails.ts` (MC-027a-2). Owns the numeric
 * budget state (iterations / tokens / cost / duration), threshold
 * warnings, and the `budget:warning` event-bus emission.
 *
 * The orchestrator forwards usage from completed events and drives
 * iteration counts; this tracker decides whether the run must abort.
 */
import type { DzupEventBus } from '@dzupagent/core/events'
import type { BudgetUsage } from '@dzupagent/core/events'
import type { TokenUsage } from '../types.js'
import type { BudgetState, GuardrailViolation } from './adapter-guardrails-types.js'

export interface BudgetTrackerConfig {
  maxIterations: number
  maxDurationMs: number
  maxTokens?: number
  maxCostCents?: number
  warningThresholds: number[]
  eventBus?: DzupEventBus
  /**
   * Called as a function so the orchestrator can swap the underlying
   * callback after construction (see {@link AdapterGuardrails.setOnRuleViolation}).
   * Returning `undefined` skips the side-channel notification.
   */
  getOnRuleViolation?: () =>
    | ((ruleId: string, severity: 'warn' | 'block', detail: string) => void)
    | undefined
}

export interface BudgetCheckResult {
  abort: boolean
  abortReason?: string
}

/**
 * Mutable budget tracker — owns iteration / token / cost / duration counters
 * and emits threshold warnings as they are crossed. Treats `startTime === 0`
 * as "not yet started".
 */
export class GuardrailsBudgetTracker {
  startTime = 0
  iterations = 0
  totalInputTokens = 0
  totalOutputTokens = 0
  totalCostCents = 0

  private readonly violations: GuardrailViolation[]
  private readonly warningMessages: string[]
  private readonly emittedThresholds = new Set<string>()

  constructor(
    private readonly config: BudgetTrackerConfig,
    sinks: { violations: GuardrailViolation[]; warnings: string[] },
  ) {
    this.violations = sinks.violations
    this.warningMessages = sinks.warnings
  }

  /** Mark the run as started; subsequent duration checks become active. */
  start(): void {
    this.startTime = Date.now()
  }

  /** Reset all counters; used by {@link AdapterGuardrails.reset}. */
  reset(): void {
    this.startTime = 0
    this.iterations = 0
    this.totalInputTokens = 0
    this.totalOutputTokens = 0
    this.totalCostCents = 0
    this.emittedThresholds.clear()
  }

  /** Add a token-usage record from a completed event into the running totals. */
  accumulateUsage(usage: TokenUsage): void {
    this.totalInputTokens += usage.inputTokens
    this.totalOutputTokens += usage.outputTokens
    if (usage.costCents !== undefined) {
      this.totalCostCents += usage.costCents
    }
  }

  /** Snapshot of the current budget state for `getStatus()`. */
  getBudgetState(): BudgetState {
    return {
      iterations: this.iterations,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalCostCents: this.totalCostCents,
      durationMs: this.startTime > 0 ? Date.now() - this.startTime : 0,
      warnings: [...this.warningMessages],
    }
  }

  /**
   * Check all configured budgets and either return `{abort:true,...}` or
   * emit threshold warnings (via the event bus) and return `{abort:false}`.
   */
  checkBudgets(): BudgetCheckResult {
    if (this.iterations >= this.config.maxIterations) {
      const message = `Iteration limit exceeded: ${this.iterations}/${this.config.maxIterations}`
      this.addViolation('budget_exceeded', message, 'critical')
      return { abort: true, abortReason: message }
    }

    if (this.startTime > 0) {
      const durationMs = Date.now() - this.startTime
      if (durationMs >= this.config.maxDurationMs) {
        const message = `Timeout exceeded: ${Math.round(durationMs / 1000)}s / ${Math.round(this.config.maxDurationMs / 1000)}s`
        this.addViolation('timeout', message, 'critical')
        return { abort: true, abortReason: message }
      }
    }

    if (this.config.maxTokens !== undefined) {
      const totalTokens = this.totalInputTokens + this.totalOutputTokens
      if (totalTokens >= this.config.maxTokens) {
        const message = `Token limit exceeded: ${totalTokens}/${this.config.maxTokens}`
        this.addViolation('budget_exceeded', message, 'critical')
        return { abort: true, abortReason: message }
      }
    }

    if (this.config.maxCostCents !== undefined && this.totalCostCents >= this.config.maxCostCents) {
      const message = `Cost limit exceeded: ${this.totalCostCents.toFixed(2)}c/${this.config.maxCostCents}c`
      this.addViolation('budget_exceeded', message, 'critical')
      return { abort: true, abortReason: message }
    }

    this.checkWarningThresholds()
    return { abort: false }
  }

  private checkWarningThresholds(): void {
    for (const threshold of this.config.warningThresholds) {
      const level: 'warn' | 'critical' = threshold >= 0.9 ? 'critical' : 'warn'

      this.checkSingleThreshold('iterations', this.iterations, this.config.maxIterations, threshold, level)

      if (this.config.maxTokens !== undefined) {
        const totalTokens = this.totalInputTokens + this.totalOutputTokens
        this.checkSingleThreshold('tokens', totalTokens, this.config.maxTokens, threshold, level)
      }

      if (this.config.maxCostCents !== undefined) {
        this.checkSingleThreshold('cost', this.totalCostCents, this.config.maxCostCents, threshold, level)
      }

      if (this.startTime > 0) {
        const durationMs = Date.now() - this.startTime
        this.checkSingleThreshold('duration', durationMs, this.config.maxDurationMs, threshold, level)
      }
    }
  }

  private checkSingleThreshold(
    metric: string,
    current: number,
    limit: number,
    threshold: number,
    level: 'warn' | 'critical',
  ): void {
    const ratio = current / limit
    const key = `${metric}:${threshold}`

    if (ratio >= threshold && !this.emittedThresholds.has(key)) {
      this.emittedThresholds.add(key)

      const formattedCurrent =
        typeof current === 'number' && metric === 'cost' ? current.toFixed(2) : Math.round(current)
      const formattedLimit = metric === 'cost' ? limit.toFixed(2) : Math.round(limit)
      const message = `${metric} budget at ${Math.round(ratio * 100)}% (${formattedCurrent}/${formattedLimit})`
      this.warningMessages.push(message)

      this.config.eventBus?.emit({
        type: 'budget:warning',
        level,
        usage: this.buildBudgetUsage(),
      })
    }
  }

  /**
   * Build a {@link BudgetUsage} snapshot for emission on `budget:warning`.
   * `percent` reflects the highest single-metric utilization across all
   * tracked budgets (rounded to 2dp).
   */
  buildBudgetUsage(): BudgetUsage {
    const totalTokens = this.totalInputTokens + this.totalOutputTokens
    const durationMs = this.startTime > 0 ? Date.now() - this.startTime : 0

    let maxPercent = 0
    if (this.config.maxIterations > 0) {
      maxPercent = Math.max(maxPercent, (this.iterations / this.config.maxIterations) * 100)
    }
    if (this.config.maxTokens !== undefined && this.config.maxTokens > 0) {
      maxPercent = Math.max(maxPercent, (totalTokens / this.config.maxTokens) * 100)
    }
    if (this.config.maxCostCents !== undefined && this.config.maxCostCents > 0) {
      maxPercent = Math.max(maxPercent, (this.totalCostCents / this.config.maxCostCents) * 100)
    }
    if (this.config.maxDurationMs > 0) {
      maxPercent = Math.max(maxPercent, (durationMs / this.config.maxDurationMs) * 100)
    }

    return {
      tokensUsed: totalTokens,
      tokensLimit: this.config.maxTokens ?? 0,
      costCents: this.totalCostCents,
      costLimitCents: this.config.maxCostCents ?? 0,
      iterations: this.iterations,
      iterationsLimit: this.config.maxIterations,
      percent: Math.round(maxPercent * 100) / 100,
    }
  }

  private addViolation(
    type: GuardrailViolation['type'],
    message: string,
    severity: GuardrailViolation['severity'],
  ): void {
    this.violations.push({ type, message, severity })
    const cb = this.config.getOnRuleViolation?.()
    cb?.(type, severity === 'critical' ? 'block' : 'warn', message)
  }
}
