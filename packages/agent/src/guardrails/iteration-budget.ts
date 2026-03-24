/**
 * Iteration budget — tracks cumulative token/cost/iteration spend
 * across parent and child agents. Emits warnings at configurable thresholds.
 */
import { calculateCostCents, type TokenUsage } from '@forgeagent/core'
import type { GuardrailConfig, BudgetState, BudgetWarning } from './guardrail-types.js'

export class IterationBudget {
  private state: BudgetState = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostCents: 0,
    llmCalls: 0,
    iterations: 0,
    warnings: [],
  }

  private emittedThresholds = new Set<string>()

  constructor(private readonly config: GuardrailConfig) {}

  /** Record token usage from an LLM call */
  recordUsage(usage: TokenUsage): BudgetWarning[] {
    this.state.totalInputTokens += usage.inputTokens
    this.state.totalOutputTokens += usage.outputTokens
    this.state.totalCostCents += calculateCostCents(usage)
    this.state.llmCalls++

    return this.checkThresholds()
  }

  /** Record one tool-loop iteration */
  recordIteration(): BudgetWarning[] {
    this.state.iterations++
    return this.checkThresholds()
  }

  /** Check if any hard limit has been exceeded */
  isExceeded(): { exceeded: boolean; reason?: string } {
    const { maxTokens, maxCostCents, maxIterations } = this.config
    const totalTokens = this.state.totalInputTokens + this.state.totalOutputTokens

    if (maxTokens && totalTokens >= maxTokens) {
      return { exceeded: true, reason: `Token limit exceeded: ${totalTokens}/${maxTokens}` }
    }
    if (maxCostCents && this.state.totalCostCents >= maxCostCents) {
      return { exceeded: true, reason: `Cost limit exceeded: ${this.state.totalCostCents}c/${maxCostCents}c` }
    }
    if (maxIterations && this.state.iterations >= maxIterations) {
      return { exceeded: true, reason: `Iteration limit exceeded: ${this.state.iterations}/${maxIterations}` }
    }
    return { exceeded: false }
  }

  /** Check if a tool is blocked by guardrails */
  isToolBlocked(toolName: string): boolean {
    return this.config.blockedTools?.includes(toolName) ?? false
  }

  /** Get current budget state snapshot */
  getState(): Readonly<BudgetState> {
    return { ...this.state }
  }

  /** Create a child budget that shares state with this parent */
  fork(): IterationBudget {
    const child = new IterationBudget(this.config)
    child.state = this.state // shared reference
    child.emittedThresholds = this.emittedThresholds
    return child
  }

  private checkThresholds(): BudgetWarning[] {
    const warnings: BudgetWarning[] = []
    const thresholds = this.config.budgetWarnings ?? [0.7, 0.9]

    for (const threshold of thresholds) {
      // Check token threshold
      if (this.config.maxTokens) {
        const total = this.state.totalInputTokens + this.state.totalOutputTokens
        const ratio = total / this.config.maxTokens
        const key = `tokens:${threshold}`
        if (ratio >= threshold && !this.emittedThresholds.has(key)) {
          this.emittedThresholds.add(key)
          const warning: BudgetWarning = {
            type: 'tokens',
            threshold,
            current: total,
            limit: this.config.maxTokens,
            message: `Token budget at ${Math.round(ratio * 100)}% (${total}/${this.config.maxTokens})`,
          }
          warnings.push(warning)
          this.state.warnings.push(warning)
        }
      }

      // Check cost threshold
      if (this.config.maxCostCents) {
        const ratio = this.state.totalCostCents / this.config.maxCostCents
        const key = `cost:${threshold}`
        if (ratio >= threshold && !this.emittedThresholds.has(key)) {
          this.emittedThresholds.add(key)
          const warning: BudgetWarning = {
            type: 'cost',
            threshold,
            current: this.state.totalCostCents,
            limit: this.config.maxCostCents,
            message: `Cost budget at ${Math.round(ratio * 100)}% (${this.state.totalCostCents}c/${this.config.maxCostCents}c)`,
          }
          warnings.push(warning)
          this.state.warnings.push(warning)
        }
      }

      // Check iteration threshold
      if (this.config.maxIterations) {
        const ratio = this.state.iterations / this.config.maxIterations
        const key = `iterations:${threshold}`
        if (ratio >= threshold && !this.emittedThresholds.has(key)) {
          this.emittedThresholds.add(key)
          const warning: BudgetWarning = {
            type: 'iterations',
            threshold,
            current: this.state.iterations,
            limit: this.config.maxIterations,
            message: `Iteration budget at ${Math.round(ratio * 100)}% (${this.state.iterations}/${this.config.maxIterations})`,
          }
          warnings.push(warning)
          this.state.warnings.push(warning)
        }
      }
    }

    return warnings
  }
}
