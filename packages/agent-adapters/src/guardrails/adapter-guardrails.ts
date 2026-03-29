/**
 * Adapter guardrails — stuck detection, iteration budgets, and safety
 * boundaries for the adapter execution layer.
 *
 * Adapts patterns from `@dzipagent/agent` guardrails for use with the
 * unified AgentEvent stream produced by CLI/SDK adapters.
 */

import { createHash } from 'node:crypto'
import type { DzipEventBus } from '@dzipagent/core'
import type { BudgetUsage } from '@dzipagent/core'
import type { AgentEvent, TokenUsage } from '../types.js'

// ---------------------------------------------------------------------------
// Stuck detector types
// ---------------------------------------------------------------------------

export interface StuckDetectorConfig {
  /** Max identical sequential tool calls before flagging (default: 3) */
  maxRepeatCalls: number
  /** Max errors in a window before flagging (default: 5) */
  maxErrorsInWindow: number
  /** Error window in ms (default: 60_000) */
  errorWindowMs: number
  /** Max iterations with no tool calls before flagging (default: 3) */
  maxIdleIterations: number
}

export interface StuckStatus {
  stuck: boolean
  reason?: string
}

const DEFAULT_STUCK_CONFIG: StuckDetectorConfig = {
  maxRepeatCalls: 3,
  maxErrorsInWindow: 5,
  errorWindowMs: 60_000,
  maxIdleIterations: 3,
}

// ---------------------------------------------------------------------------
// Guardrail types
// ---------------------------------------------------------------------------

export interface AdapterGuardrailsConfig {
  /** Max total iterations (tool call rounds) across the execution. Default 50 */
  maxIterations?: number
  /** Max total tokens (input + output). Default: unlimited */
  maxTokens?: number
  /** Max total cost in cents. Default: unlimited */
  maxCostCents?: number
  /** Max duration in ms. Default: 300_000 (5 min) */
  maxDurationMs?: number
  /** Stuck detector config. Set to false to disable. */
  stuckDetector?: Partial<StuckDetectorConfig> | false
  /** Tool names that are forbidden */
  blockedTools?: string[]
  /** Warning thresholds (0-1). Default [0.7, 0.9] */
  warningThresholds?: number[]
  /** Event bus for emitting guardrail events */
  eventBus?: DzipEventBus
  /** Content filter for output */
  outputFilter?: (output: string) => Promise<string | null>
}

export interface GuardrailViolation {
  type: 'stuck' | 'budget_exceeded' | 'blocked_tool' | 'timeout' | 'output_filtered'
  message: string
  severity: 'warning' | 'critical'
}

export interface BudgetState {
  iterations: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCostCents: number
  durationMs: number
  warnings: string[]
}

export interface GuardrailStatus {
  safe: boolean
  violations: GuardrailViolation[]
  budgetState: BudgetState
  stuckStatus: StuckStatus
}

// ---------------------------------------------------------------------------
// AdapterStuckDetector
// ---------------------------------------------------------------------------

/**
 * Detects when an adapter execution is stuck by tracking:
 * - Repeated identical tool calls (same name + same input hash)
 * - High error rate within a sliding time window
 * - Idle iterations with no tool calls
 */
export class AdapterStuckDetector {
  private recentCalls: Array<{ name: string; hash: string; timestamp: number }> = []
  private recentErrors: Array<{ message: string; timestamp: number }> = []
  private idleCount = 0
  private readonly config: StuckDetectorConfig

  constructor(config?: Partial<StuckDetectorConfig>) {
    this.config = { ...DEFAULT_STUCK_CONFIG, ...config }
  }

  /** Record a tool call. Returns stuck status. */
  recordToolCall(name: string, input: unknown): StuckStatus {
    const hash = this.hashInput(input)
    this.recentCalls.push({ name, hash, timestamp: Date.now() })
    this.idleCount = 0 // tool call = progress

    // Check for repeated identical calls
    const tail = this.recentCalls.slice(-this.config.maxRepeatCalls)
    if (tail.length >= this.config.maxRepeatCalls) {
      const first = tail[0]!
      const allSame = tail.every(c => c.name === first.name && c.hash === first.hash)
      if (allSame) {
        return {
          stuck: true,
          reason: `Tool "${name}" called ${this.config.maxRepeatCalls} times with identical input`,
        }
      }
    }

    return { stuck: false }
  }

  /** Record an error. Returns stuck status. */
  recordError(message: string): StuckStatus {
    this.recentErrors.push({ message, timestamp: Date.now() })

    // Check error rate in sliding window
    const windowStart = Date.now() - this.config.errorWindowMs
    const recent = this.recentErrors.filter(e => e.timestamp >= windowStart)
    if (recent.length >= this.config.maxErrorsInWindow) {
      return {
        stuck: true,
        reason: `${recent.length} errors in ${Math.round(this.config.errorWindowMs / 1000)}s window`,
      }
    }

    return { stuck: false }
  }

  /** Record an iteration tick. Detects idle (no tool calls) iterations. */
  recordIteration(toolCallCount: number): StuckStatus {
    if (toolCallCount === 0) {
      this.idleCount++
    } else {
      this.idleCount = 0
    }

    if (this.idleCount >= this.config.maxIdleIterations) {
      return {
        stuck: true,
        reason: `${this.idleCount} consecutive iterations with no tool calls`,
      }
    }

    return { stuck: false }
  }

  /** Reset all tracking state */
  reset(): void {
    this.recentCalls = []
    this.recentErrors = []
    this.idleCount = 0
  }

  private hashInput(input: unknown): string {
    const str = typeof input === 'string' ? input : JSON.stringify(input)
    return createHash('sha256').update(str).digest('hex').slice(0, 16)
  }
}

// ---------------------------------------------------------------------------
// AdapterGuardrails
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ITERATIONS = 50
const DEFAULT_MAX_DURATION_MS = 300_000
const DEFAULT_WARNING_THRESHOLDS = [0.7, 0.9]

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

  private startTime = 0
  private iterations = 0
  private totalInputTokens = 0
  private totalOutputTokens = 0
  private totalCostCents = 0
  private toolCallsInCurrentIteration = 0
  private violations: GuardrailViolation[] = []
  private warningMessages: string[] = []
  private emittedThresholds = new Set<string>()
  private lastStuckStatus: StuckStatus = { stuck: false }

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
  async *wrap(
    source: AsyncGenerator<AgentEvent>,
    abortFn?: () => void,
  ): AsyncGenerator<AgentEvent> {
    this.startTime = Date.now()

    for await (const event of source) {
      // Process the event through guardrails
      const result = await this.processEvent(event)

      if (result.abort) {
        // Emit the failure event and call abort
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

      // If we have a filtered event (output filter replaced the original), yield that instead
      if (result.filteredEvent) {
        yield result.filteredEvent
      } else {
        yield event
      }
    }
  }

  /** Get current guardrail status */
  getStatus(): GuardrailStatus {
    return {
      safe: this.violations.filter(v => v.severity === 'critical').length === 0,
      violations: [...this.violations],
      budgetState: this.getBudgetState(),
      stuckStatus: { ...this.lastStuckStatus },
    }
  }

  /** Reset all tracking state */
  reset(): void {
    this.startTime = 0
    this.iterations = 0
    this.totalInputTokens = 0
    this.totalOutputTokens = 0
    this.totalCostCents = 0
    this.toolCallsInCurrentIteration = 0
    this.violations = []
    this.warningMessages = []
    this.emittedThresholds.clear()
    this.lastStuckStatus = { stuck: false }
    this.stuckDetector?.reset()
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private getBudgetState(): BudgetState {
    return {
      iterations: this.iterations,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalCostCents: this.totalCostCents,
      durationMs: this.startTime > 0 ? Date.now() - this.startTime : 0,
      warnings: [...this.warningMessages],
    }
  }

  private async processEvent(
    event: AgentEvent,
  ): Promise<{
    abort: boolean
    abortReason?: string
    filteredEvent?: AgentEvent
  }> {
    switch (event.type) {
      case 'adapter:tool_call':
        return this.handleToolCall(event)

      case 'adapter:tool_result':
        return this.handleToolResult(event)

      case 'adapter:completed':
        return this.handleCompleted(event)

      case 'adapter:failed':
        return this.handleFailed(event)

      default:
        // For all other events, just check duration budget
        return this.checkBudgets()
    }
  }

  private handleToolCall(event: Extract<AgentEvent, { type: 'adapter:tool_call' }>): {
    abort: boolean
    abortReason?: string
  } {
    // Check blocked tools
    if (this.blockedTools.has(event.toolName)) {
      const violation: GuardrailViolation = {
        type: 'blocked_tool',
        message: `Tool "${event.toolName}" is blocked by guardrails`,
        severity: 'critical',
      }
      this.violations.push(violation)
      return { abort: true, abortReason: violation.message }
    }

    // Record in stuck detector
    if (this.stuckDetector) {
      const stuckStatus = this.stuckDetector.recordToolCall(event.toolName, event.input)
      this.lastStuckStatus = stuckStatus

      if (stuckStatus.stuck) {
        const violation: GuardrailViolation = {
          type: 'stuck',
          message: stuckStatus.reason ?? 'Agent appears stuck',
          severity: 'critical',
        }
        this.violations.push(violation)

        this.config.eventBus?.emit({
          type: 'agent:stuck_detected',
          agentId: event.providerId,
          reason: stuckStatus.reason ?? 'Unknown',
          recovery: 'abort',
          timestamp: Date.now(),
          repeatedTool: event.toolName,
        })

        return { abort: true, abortReason: violation.message }
      }
    }

    // Increment iteration count (each tool call = one iteration)
    this.iterations++
    this.toolCallsInCurrentIteration++

    return this.checkBudgets()
  }

  private handleToolResult(event: Extract<AgentEvent, { type: 'adapter:tool_result' }>): {
    abort: boolean
    abortReason?: string
  } {
    // Check for error indicators in tool output
    if (this.stuckDetector && this.looksLikeError(event.output)) {
      const stuckStatus = this.stuckDetector.recordError(event.output)
      this.lastStuckStatus = stuckStatus

      if (stuckStatus.stuck) {
        const violation: GuardrailViolation = {
          type: 'stuck',
          message: stuckStatus.reason ?? 'Too many errors',
          severity: 'critical',
        }
        this.violations.push(violation)

        this.config.eventBus?.emit({
          type: 'agent:stuck_detected',
          agentId: event.providerId,
          reason: stuckStatus.reason ?? 'Error loop detected',
          recovery: 'abort',
          timestamp: Date.now(),
        })

        return { abort: true, abortReason: violation.message }
      }
    }

    return this.checkBudgets()
  }

  private async handleCompleted(
    event: Extract<AgentEvent, { type: 'adapter:completed' }>,
  ): Promise<{
    abort: boolean
    abortReason?: string
    filteredEvent?: AgentEvent
  }> {
    // Accumulate token usage
    if (event.usage) {
      this.accumulateUsage(event.usage)
    }

    // Record idle iteration if no tool calls happened
    if (this.stuckDetector) {
      const stuckStatus = this.stuckDetector.recordIteration(this.toolCallsInCurrentIteration)
      this.toolCallsInCurrentIteration = 0
      this.lastStuckStatus = stuckStatus

      if (stuckStatus.stuck) {
        const violation: GuardrailViolation = {
          type: 'stuck',
          message: stuckStatus.reason ?? 'Agent idle',
          severity: 'warning',
        }
        this.violations.push(violation)
      }
    }

    // Apply output filter
    if (this.config.outputFilter && event.result) {
      const filtered = await this.config.outputFilter(event.result)
      if (filtered === null) {
        const violation: GuardrailViolation = {
          type: 'output_filtered',
          message: 'Output was rejected by content filter',
          severity: 'critical',
        }
        this.violations.push(violation)
        return { abort: true, abortReason: violation.message }
      }
      if (filtered !== event.result) {
        // Return modified event with filtered content
        return {
          abort: false,
          filteredEvent: { ...event, result: filtered },
        }
      }
    }

    return this.checkBudgets()
  }

  private handleFailed(event: Extract<AgentEvent, { type: 'adapter:failed' }>): {
    abort: boolean
    abortReason?: string
  } {
    if (this.stuckDetector) {
      const stuckStatus = this.stuckDetector.recordError(event.error)
      this.lastStuckStatus = stuckStatus

      if (stuckStatus.stuck) {
        const violation: GuardrailViolation = {
          type: 'stuck',
          message: stuckStatus.reason ?? 'Error loop detected',
          severity: 'critical',
        }
        this.violations.push(violation)
      }
    }

    // Don't abort on failure events -- they already indicate failure
    return { abort: false }
  }

  private accumulateUsage(usage: TokenUsage): void {
    this.totalInputTokens += usage.inputTokens
    this.totalOutputTokens += usage.outputTokens
    if (usage.costCents !== undefined) {
      this.totalCostCents += usage.costCents
    }
  }

  private checkBudgets(): { abort: boolean; abortReason?: string } {
    // Check iteration limit
    if (this.iterations >= this.config.maxIterations) {
      const message = `Iteration limit exceeded: ${this.iterations}/${this.config.maxIterations}`
      this.addViolation('budget_exceeded', message, 'critical')
      return { abort: true, abortReason: message }
    }

    // Check duration limit
    if (this.startTime > 0) {
      const durationMs = Date.now() - this.startTime
      if (durationMs >= this.config.maxDurationMs) {
        const message = `Timeout exceeded: ${Math.round(durationMs / 1000)}s / ${Math.round(this.config.maxDurationMs / 1000)}s`
        this.addViolation('timeout', message, 'critical')
        return { abort: true, abortReason: message }
      }
    }

    // Check token limit
    if (this.config.maxTokens !== undefined) {
      const totalTokens = this.totalInputTokens + this.totalOutputTokens
      if (totalTokens >= this.config.maxTokens) {
        const message = `Token limit exceeded: ${totalTokens}/${this.config.maxTokens}`
        this.addViolation('budget_exceeded', message, 'critical')
        return { abort: true, abortReason: message }
      }
    }

    // Check cost limit
    if (this.config.maxCostCents !== undefined && this.totalCostCents >= this.config.maxCostCents) {
      const message = `Cost limit exceeded: ${this.totalCostCents.toFixed(2)}c/${this.config.maxCostCents}c`
      this.addViolation('budget_exceeded', message, 'critical')
      return { abort: true, abortReason: message }
    }

    // Emit threshold warnings
    this.checkWarningThresholds()

    return { abort: false }
  }

  private checkWarningThresholds(): void {
    const thresholds = this.config.warningThresholds

    for (const threshold of thresholds) {
      const level: 'warn' | 'critical' = threshold >= 0.9 ? 'critical' : 'warn'

      // Check iteration threshold
      this.checkSingleThreshold(
        'iterations',
        this.iterations,
        this.config.maxIterations,
        threshold,
        level,
      )

      // Check token threshold
      if (this.config.maxTokens !== undefined) {
        const totalTokens = this.totalInputTokens + this.totalOutputTokens
        this.checkSingleThreshold(
          'tokens',
          totalTokens,
          this.config.maxTokens,
          threshold,
          level,
        )
      }

      // Check cost threshold
      if (this.config.maxCostCents !== undefined) {
        this.checkSingleThreshold(
          'cost',
          this.totalCostCents,
          this.config.maxCostCents,
          threshold,
          level,
        )
      }

      // Check duration threshold
      if (this.startTime > 0) {
        const durationMs = Date.now() - this.startTime
        this.checkSingleThreshold(
          'duration',
          durationMs,
          this.config.maxDurationMs,
          threshold,
          level,
        )
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

      const message = `${metric} budget at ${Math.round(ratio * 100)}% (${typeof current === 'number' && metric === 'cost' ? current.toFixed(2) : Math.round(current)}/${metric === 'cost' ? limit.toFixed(2) : Math.round(limit)})`
      this.warningMessages.push(message)

      this.config.eventBus?.emit({
        type: 'budget:warning',
        level,
        usage: this.buildBudgetUsage(),
      })
    }
  }

  private buildBudgetUsage(): BudgetUsage {
    const totalTokens = this.totalInputTokens + this.totalOutputTokens
    const durationMs = this.startTime > 0 ? Date.now() - this.startTime : 0

    // Calculate the highest ratio across all tracked metrics
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
  }

  /**
   * Simple heuristic to detect error-like output from tool results.
   * Looks for common error patterns without being too aggressive.
   */
  private looksLikeError(output: string): boolean {
    const lower = output.toLowerCase()
    return (
      lower.startsWith('error:') ||
      lower.startsWith('error -') ||
      lower.includes('traceback (most recent call last)') ||
      lower.includes('exception:') ||
      lower.includes('fatal:') ||
      lower.includes('enoent') ||
      lower.includes('permission denied') ||
      lower.includes('command not found')
    )
  }
}
