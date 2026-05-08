/**
 * Adapter guardrails — stuck detection, iteration budgets, and safety
 * boundaries for the adapter execution layer.
 *
 * Adapts patterns from `@dzupagent/agent` guardrails for use with the
 * unified AgentEvent stream produced by CLI/SDK adapters.
 *
 * After the MC-027a-2 split, types live in `./adapter-guardrails-types`,
 * the stuck-detector subclass in `./adapter-stuck-detector`, the budget /
 * threshold logic in `./guardrails-budget-tracker`, and the per-event
 * handlers in `./guardrails-event-handlers`. This file owns the public
 * `AdapterGuardrails` orchestrator and wires those collaborators together.
 */
import type { AgentEvent, AgentStreamEvent } from '../types.js'
import { AdapterStuckDetector } from './adapter-stuck-detector.js'
import {
  DEFAULT_MAX_DURATION_MS,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_WARNING_THRESHOLDS,
  isProviderRawStreamEvent,
  type AdapterGuardrailsConfig,
  type GuardrailStatus,
  type GuardrailViolation,
} from './adapter-guardrails-types.js'
import { GuardrailsBudgetTracker } from './guardrails-budget-tracker.js'
import {
  processGuardrailEvent,
  type GuardrailsHandlerState,
} from './guardrails-event-handlers.js'

export { AdapterStuckDetector } from './adapter-stuck-detector.js'
export type {
  AdapterGuardrailsConfig,
  BudgetState,
  GuardrailStatus,
  GuardrailViolation,
  StuckDetectorConfig,
  StuckStatus,
} from './adapter-guardrails-types.js'

/**
 * Wraps an adapter event stream with guardrail enforcement.
 *
 * Monitors AgentEvent streams for budget violations, stuck patterns,
 * blocked tools, timeouts, and output content filtering. Can abort
 * execution when critical violations are detected.
 */
export class AdapterGuardrails {
  private readonly config: Required<
    Pick<AdapterGuardrailsConfig, 'maxIterations' | 'maxDurationMs' | 'warningThresholds'>
  > & AdapterGuardrailsConfig

  private readonly stuckDetector: AdapterStuckDetector | null
  private readonly blockedTools: Set<string>
  private readonly budget: GuardrailsBudgetTracker

  private violations: GuardrailViolation[] = []
  private warningMessages: string[] = []
  private readonly handlerState: GuardrailsHandlerState

  constructor(config?: AdapterGuardrailsConfig) {
    this.config = {
      ...config,
      maxIterations: config?.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      maxDurationMs: config?.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
      warningThresholds: config?.warningThresholds ?? DEFAULT_WARNING_THRESHOLDS,
    }

    if (config?.stuckDetector === false) {
      this.stuckDetector = null
    } else {
      const stuckConfig = typeof config?.stuckDetector === 'object'
        ? config.stuckDetector
        : undefined
      this.stuckDetector = new AdapterStuckDetector(stuckConfig)
    }

    this.blockedTools = new Set(config?.blockedTools ?? [])

    this.budget = new GuardrailsBudgetTracker(
      {
        maxIterations: this.config.maxIterations,
        maxDurationMs: this.config.maxDurationMs,
        ...(this.config.maxTokens !== undefined ? { maxTokens: this.config.maxTokens } : {}),
        ...(this.config.maxCostCents !== undefined ? { maxCostCents: this.config.maxCostCents } : {}),
        warningThresholds: this.config.warningThresholds,
        ...(this.config.eventBus ? { eventBus: this.config.eventBus } : {}),
        // Use a getter so updates via setOnRuleViolation() take effect.
        getOnRuleViolation: () => this.config.onRuleViolation,
      },
      { violations: this.violations, warnings: this.warningMessages },
    )

    this.handlerState = {
      stuckDetector: this.stuckDetector,
      blockedTools: this.blockedTools,
      budget: this.budget,
      violations: this.violations,
      lastStuckStatus: { stuck: false },
      toolCallsInCurrentIteration: 0,
      eventBus: this.config.eventBus,
      outputFilter: this.config.outputFilter,
      getOnRuleViolation: () => this.config.onRuleViolation,
    }
  }

  /**
   * Wrap an adapter event stream with guardrail enforcement.
   *
   * Monitors events, enforces limits, and can abort execution.
   * For each event:
   * 1. `adapter:tool_call` - check blocked tools, record in stuck detector, increment iterations
   * 2. `adapter:tool_result` - check for errors in output
   * 3. `adapter:completed` - accumulate tokens/cost, apply output filter
   * 4. `adapter:failed` - record error in stuck detector
   *
   * At each event, checks all budget limits and emits warnings/violations as needed.
   */
  wrap(
    source: AsyncGenerator<AgentEvent>,
    abortFn?: () => void,
  ): AsyncGenerator<AgentEvent>
  wrap(
    source: AsyncGenerator<AgentStreamEvent>,
    abortFn?: () => void,
  ): AsyncGenerator<AgentStreamEvent>
  async *wrap(
    source: AsyncGenerator<AgentStreamEvent>,
    abortFn?: () => void,
  ): AsyncGenerator<AgentStreamEvent> {
    this.budget.start()

    for await (const event of source) {
      if (isProviderRawStreamEvent(event)) {
        yield event
        continue
      }

      const result = await processGuardrailEvent(event, this.handlerState)

      if (result.abort) {
        abortFn?.()
        yield {
          type: 'adapter:failed',
          providerId: event.providerId,
          error: result.abortReason ?? 'Guardrail violation',
          code: 'GUARDRAIL_VIOLATION',
          timestamp: Date.now(),
        } satisfies AgentEvent
        return
      }

      yield result.filteredEvent ?? event
    }
  }

  /**
   * Replace the `onRuleViolation` callback after construction.  Used by
   * {@link BaseCliAdapter.attachGuardrailsGovernance} to route guardrail
   * violations into the adapter's governance side-channel without
   * rebuilding the guardrails instance.
   */
  setOnRuleViolation(
    cb: ((ruleId: string, severity: 'warn' | 'block', detail: string) => void) | undefined,
  ): void {
    this.config.onRuleViolation = cb
  }

  /** Read the current `onRuleViolation` callback, if any. */
  getOnRuleViolation():
    | ((ruleId: string, severity: 'warn' | 'block', detail: string) => void)
    | undefined {
    return this.config.onRuleViolation
  }

  /** Get current guardrail status */
  getStatus(): GuardrailStatus {
    return {
      safe: this.violations.filter(v => v.severity === 'critical').length === 0,
      violations: [...this.violations],
      budgetState: this.budget.getBudgetState(),
      stuckStatus: { ...this.handlerState.lastStuckStatus },
    }
  }

  /** Reset all tracking state */
  reset(): void {
    this.budget.reset()
    this.violations.length = 0
    this.warningMessages.length = 0
    this.handlerState.lastStuckStatus = { stuck: false }
    this.handlerState.toolCallsInCurrentIteration = 0
    this.stuckDetector?.reset()
  }
}
