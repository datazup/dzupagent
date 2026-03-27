/**
 * Recovery Copilot — autonomous recovery orchestrator.
 *
 * When an agent or pipeline fails, the RecoveryCopilot:
 * 1. Analyzes the failure (FailureAnalyzer)
 * 2. Generates candidate recovery strategies
 * 3. Ranks strategies (StrategyRanker)
 * 4. Optionally requests human approval for high-risk strategies
 * 5. Executes the selected strategy (RecoveryExecutor)
 *
 * Integrates with StuckDetector for automatic triggering and
 * with the approval gate for human-in-the-loop workflows.
 *
 * @module recovery/recovery-copilot
 */

import type { DzipEventBus } from '@dzipagent/core'
import type { StuckStatus } from '../guardrails/stuck-detector.js'
import type { ApprovalGate } from '../approval/approval-gate.js'
import { FailureAnalyzer, type FailureAnalysis } from './failure-analyzer.js'
import { StrategyRanker } from './strategy-ranker.js'
import { RecoveryExecutor, type ActionHandler } from './recovery-executor.js'
import type {
  FailureContext,
  RecoveryPlan,
  RecoveryStrategy,
  RecoveryCopilotConfig,
  RecoveryResult,
} from './recovery-types.js'
import type { RecoveryFeedback, RecoveryLesson } from '../self-correction/recovery-feedback.js'

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: RecoveryCopilotConfig = {
  maxAttempts: 3,
  requireApprovalForHighRisk: true,
  dryRun: false,
  maxStrategies: 5,
  minAutoExecuteConfidence: 0.6,
}

// ---------------------------------------------------------------------------
// Strategy generator (user-extensible)
// ---------------------------------------------------------------------------

/**
 * A function that generates recovery strategies for a given failure.
 * Users can supply a custom generator for domain-specific strategies.
 */
export type StrategyGenerator = (
  analysis: FailureAnalysis,
  context: FailureContext,
) => RecoveryStrategy[]

// ---------------------------------------------------------------------------
// RecoveryCopilot
// ---------------------------------------------------------------------------

export class RecoveryCopilot {
  private readonly config: RecoveryCopilotConfig
  private readonly analyzer: FailureAnalyzer
  private readonly ranker: StrategyRanker
  private readonly executor: RecoveryExecutor
  private readonly eventBus: DzipEventBus
  private readonly plans = new Map<string, RecoveryPlan>()
  private readonly strategyGenerator: StrategyGenerator
  private readonly feedback: RecoveryFeedback | undefined
  private planCounter = 0

  constructor(opts: {
    eventBus: DzipEventBus
    config?: Partial<RecoveryCopilotConfig>
    approvalGate?: ApprovalGate
    actionHandler: ActionHandler
    strategyGenerator?: StrategyGenerator
    /** Optional feedback module for persisting recovery outcomes as lessons. */
    feedback?: RecoveryFeedback
  }) {
    this.config = { ...DEFAULT_CONFIG, ...opts.config }
    this.eventBus = opts.eventBus
    this.analyzer = new FailureAnalyzer()
    this.ranker = new StrategyRanker()
    this.strategyGenerator = opts.strategyGenerator ?? defaultStrategyGenerator
    this.feedback = opts.feedback
    this.executor = new RecoveryExecutor({
      eventBus: opts.eventBus,
      approvalGate: opts.approvalGate,
      copilotConfig: this.config,
      actionHandler: opts.actionHandler,
    })
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Create a recovery plan for a failure. Analyzes the failure,
   * generates strategies, ranks them, and selects the best one.
   *
   * When `pastLessons` are provided (from RecoveryFeedback), strategies
   * are boosted or penalized based on historical outcomes.
   */
  createPlan(
    failureContext: FailureContext,
    pastLessons: RecoveryLesson[] = [],
  ): RecoveryPlan {
    // Don't create more plans if we've exceeded max attempts
    if (failureContext.previousAttempts >= this.config.maxAttempts) {
      return this.createEscalationPlan(failureContext)
    }

    const analysis = this.analyzer.analyze(failureContext)

    // Generate candidate strategies
    let strategies = this.strategyGenerator(analysis, failureContext)

    // Apply confidence adjustments from past lessons
    if (pastLessons.length > 0) {
      strategies = applyLessonBoosts(strategies, pastLessons)
    }

    // Limit to maxStrategies
    if (strategies.length > this.config.maxStrategies) {
      strategies = strategies.slice(0, this.config.maxStrategies)
    }

    // Rank strategies
    strategies = this.ranker.rank(strategies)

    // Select best strategy
    const selected = this.ranker.selectBest(
      strategies,
      this.config.minAutoExecuteConfidence,
    )

    const plan: RecoveryPlan = {
      id: this.generatePlanId(),
      failureContext,
      strategies,
      selectedStrategy: selected,
      status: 'proposed',
      createdAt: new Date(),
    }

    this.plans.set(plan.id, plan)

    this.eventBus.emit({
      type: 'agent:stuck_detected',
      agentId: failureContext.runId,
      reason: `Recovery plan created: ${plan.id} with ${strategies.length} strategies`,
      recovery: selected?.name ?? 'none_selected',
      timestamp: Date.now(),
    })

    return plan
  }

  /**
   * Execute a recovery plan. Approves it first (if required),
   * then runs the selected strategy's actions.
   */
  async executePlan(plan: RecoveryPlan): Promise<RecoveryResult> {
    plan.status = 'approved'
    const result = await this.executor.execute(plan)

    // Record the outcome in the analyzer for future pattern matching
    this.analyzer.recordFailure(
      plan.failureContext,
      result.success
        ? `Resolved via ${plan.selectedStrategy?.name ?? 'unknown'}`
        : undefined,
    )

    // Mark the strategy as attempted
    if (plan.selectedStrategy) {
      this.ranker.markAttempted(plan.selectedStrategy.name)
    }

    return result
  }

  /**
   * One-shot: create a plan and immediately execute it.
   *
   * When a `RecoveryFeedback` instance is configured, this method will:
   * 1. Retrieve past lessons for similar errors to inform strategy selection
   * 2. Boost/penalize strategy confidence based on past outcomes
   * 3. Record the recovery outcome as a new lesson after execution
   */
  async recover(failureContext: FailureContext): Promise<RecoveryResult> {
    // Retrieve past lessons if feedback is configured
    const analysis = this.analyzer.analyze(failureContext)
    let pastLessons: RecoveryLesson[] = []

    if (this.feedback) {
      pastLessons = await this.feedback.retrieveSimilar(
        analysis.type,
        failureContext.nodeId ?? '',
      )
    }

    const plan = this.createPlan(failureContext, pastLessons)

    if (plan.status === 'failed') {
      // Record escalation as a failed lesson
      await this.recordFeedback(analysis, failureContext, plan, false)

      return {
        plan,
        success: false,
        summary: plan.executionError ?? 'Max recovery attempts exceeded — escalating to human',
        durationMs: 0,
      }
    }

    const result = await this.executePlan(plan)

    // Record the outcome as a lesson
    await this.recordFeedback(analysis, failureContext, plan, result.success, result.summary)

    return result
  }

  /**
   * Handle a StuckDetector signal. Call this when the stuck detector
   * fires to automatically trigger recovery.
   */
  handleStuckSignal(
    stuckStatus: StuckStatus,
    runId: string,
    nodeId?: string,
  ): RecoveryPlan | null {
    if (!stuckStatus.stuck) return null

    const failureContext: FailureContext = {
      type: 'generation_failure',
      error: stuckStatus.reason ?? 'Agent stuck — no progress detected',
      runId,
      nodeId,
      timestamp: new Date(),
      previousAttempts: this.countAttemptsForRun(runId),
    }

    return this.createPlan(failureContext)
  }

  /**
   * Get a previously created plan by ID.
   */
  getPlan(planId: string): RecoveryPlan | undefined {
    return this.plans.get(planId)
  }

  /**
   * Get all plans for a given run.
   */
  getPlansForRun(runId: string): RecoveryPlan[] {
    return [...this.plans.values()].filter(
      p => p.failureContext.runId === runId,
    )
  }

  /**
   * Access the underlying failure analyzer (for external history queries).
   */
  getAnalyzer(): FailureAnalyzer {
    return this.analyzer
  }

  /**
   * Access the underlying strategy ranker (for external ranking queries).
   */
  getRanker(): StrategyRanker {
    return this.ranker
  }

  /**
   * Reset all internal state.
   */
  reset(): void {
    this.plans.clear()
    this.analyzer.reset()
    this.ranker.reset()
    this.planCounter = 0
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private createEscalationPlan(failureContext: FailureContext): RecoveryPlan {
    const plan: RecoveryPlan = {
      id: this.generatePlanId(),
      failureContext,
      strategies: [{
        name: 'human_escalation',
        description: `Max recovery attempts (${this.config.maxAttempts}) exceeded — escalating to human operator`,
        confidence: 1.0,
        risk: 'low',
        estimatedSteps: 1,
        actions: [{
          type: 'human_escalation',
          params: {
            reason: `${failureContext.previousAttempts} previous recovery attempts failed`,
            error: failureContext.error,
          },
          description: 'Escalate to human operator for manual intervention',
        }],
      }],
      selectedStrategy: null,
      status: 'failed',
      createdAt: new Date(),
      executionError: 'Max recovery attempts exceeded',
    }
    this.plans.set(plan.id, plan)
    return plan
  }

  private countAttemptsForRun(runId: string): number {
    return [...this.plans.values()].filter(
      p => p.failureContext.runId === runId,
    ).length
  }

  private generatePlanId(): string {
    this.planCounter++
    return `recovery_${Date.now()}_${this.planCounter}`
  }

  /**
   * Record a recovery outcome as a lesson in the feedback store.
   * No-op if feedback is not configured.
   */
  private async recordFeedback(
    analysis: { type: string; fingerprint: string },
    failureContext: FailureContext,
    plan: RecoveryPlan,
    success: boolean,
    summary?: string,
  ): Promise<void> {
    if (!this.feedback) return

    const lesson: RecoveryLesson = {
      id: this.feedback.generateLessonId(),
      errorType: analysis.type as RecoveryLesson['errorType'],
      errorFingerprint: analysis.fingerprint,
      nodeId: failureContext.nodeId ?? '',
      strategy: plan.selectedStrategy?.name ?? 'none',
      outcome: success ? 'success' : 'failure',
      summary: summary ?? (success ? 'Recovery succeeded' : 'Recovery failed'),
      timestamp: new Date(),
    }

    try {
      await this.feedback.recordOutcome(lesson)
    } catch {
      // Feedback recording is best-effort — don't fail recovery over it
    }
  }
}

// ---------------------------------------------------------------------------
// Lesson-based confidence adjustments
// ---------------------------------------------------------------------------

/**
 * Boost or penalize strategy confidence based on past recovery lessons.
 *
 * - Strategies that previously succeeded for the same error type get a boost.
 * - Strategies that previously failed get a penalty.
 * - The magnitude of the adjustment scales with how many past data points exist.
 */
function applyLessonBoosts(
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

// ---------------------------------------------------------------------------
// Default strategy generator
// ---------------------------------------------------------------------------

function defaultStrategyGenerator(
  analysis: FailureAnalysis,
  context: FailureContext,
): RecoveryStrategy[] {
  const strategies: RecoveryStrategy[] = []

  switch (analysis.type) {
    case 'build_failure':
      strategies.push(
        {
          name: 'retry_with_fix_prompt',
          description: 'Retry the build with an error-aware prompt that includes the build error details',
          confidence: 0.7,
          risk: 'low',
          estimatedSteps: 2,
          actions: [
            {
              type: 'modify_params',
              params: { injectError: context.error, promptSuffix: 'Fix the build error shown above.' },
              description: 'Modify generation params to include build error context',
            },
            {
              type: 'retry',
              params: {},
              description: 'Retry the generation with error-aware prompt',
            },
          ],
        },
        {
          name: 'reduce_scope',
          description: 'Reduce the scope of generation to avoid the failing component',
          confidence: 0.5,
          risk: 'medium',
          estimatedSteps: 2,
          actions: [
            {
              type: 'reduce_scope',
              params: { extractedInfo: analysis.extractedInfo },
              description: 'Reduce generation scope to isolate failing component',
            },
            {
              type: 'retry',
              params: {},
              description: 'Retry with reduced scope',
            },
          ],
        },
      )
      break

    case 'test_failure':
      strategies.push(
        {
          name: 'retry_with_test_context',
          description: 'Retry generation with the failing test output as additional context',
          confidence: 0.65,
          risk: 'low',
          estimatedSteps: 2,
          actions: [
            {
              type: 'modify_params',
              params: { testError: context.error },
              description: 'Inject test failure details into generation context',
            },
            {
              type: 'retry',
              params: {},
              description: 'Retry with test failure context',
            },
          ],
        },
        {
          name: 'skip_failing_tests',
          description: 'Skip the failing tests and continue with generation',
          confidence: 0.4,
          risk: 'medium',
          estimatedSteps: 1,
          actions: [
            {
              type: 'skip',
              params: { skipTests: true },
              description: 'Skip the failing test step and continue',
            },
          ],
        },
      )
      break

    case 'timeout':
      strategies.push(
        {
          name: 'retry_with_smaller_scope',
          description: 'Reduce scope and retry with a smaller workload to avoid timeout',
          confidence: 0.6,
          risk: 'low',
          estimatedSteps: 2,
          actions: [
            {
              type: 'reduce_scope',
              params: { factor: 0.5 },
              description: 'Halve the workload scope',
            },
            {
              type: 'retry',
              params: {},
              description: 'Retry with reduced scope',
            },
          ],
        },
        {
          name: 'simple_retry',
          description: 'Simple retry — the timeout may have been transient',
          confidence: 0.3,
          risk: 'low',
          estimatedSteps: 1,
          actions: [
            {
              type: 'retry',
              params: {},
              description: 'Retry the operation',
            },
          ],
        },
      )
      break

    case 'resource_exhaustion':
      strategies.push(
        {
          name: 'fallback_to_cheaper_model',
          description: 'Switch to a cheaper/smaller model to reduce resource usage',
          confidence: 0.7,
          risk: 'medium',
          estimatedSteps: 2,
          actions: [
            {
              type: 'fallback_model',
              params: { reason: 'resource_exhaustion' },
              description: 'Switch to a fallback (cheaper/smaller) model',
            },
            {
              type: 'retry',
              params: {},
              description: 'Retry with fallback model',
            },
          ],
        },
        {
          name: 'reduce_scope_and_retry',
          description: 'Reduce the scope to fit within resource limits',
          confidence: 0.6,
          risk: 'low',
          estimatedSteps: 2,
          actions: [
            {
              type: 'reduce_scope',
              params: { factor: 0.3 },
              description: 'Significantly reduce workload scope',
            },
            {
              type: 'retry',
              params: {},
              description: 'Retry with reduced scope',
            },
          ],
        },
      )
      break

    case 'generation_failure':
      strategies.push(
        {
          name: 'simple_retry',
          description: 'Retry the generation — the failure may be transient',
          confidence: 0.5,
          risk: 'low',
          estimatedSteps: 1,
          actions: [
            {
              type: 'retry',
              params: {},
              description: 'Retry the generation',
            },
          ],
        },
        {
          name: 'fallback_model',
          description: 'Switch to a different model and retry',
          confidence: 0.6,
          risk: 'medium',
          estimatedSteps: 2,
          actions: [
            {
              type: 'fallback_model',
              params: { reason: 'generation_failure' },
              description: 'Switch to fallback model',
            },
            {
              type: 'retry',
              params: {},
              description: 'Retry with fallback model',
            },
          ],
        },
      )
      break
  }

  // Always add human escalation as a fallback strategy
  strategies.push({
    name: 'escalate_to_human',
    description: 'Escalate to a human operator for manual resolution',
    confidence: 1.0,
    risk: 'low',
    estimatedSteps: 1,
    actions: [
      {
        type: 'human_escalation',
        params: { error: context.error, type: analysis.type },
        description: 'Request human intervention',
      },
    ],
  })

  // Boost confidence for strategies that previously resolved this fingerprint
  if (analysis.previousResolutions.length > 0) {
    for (const strategy of strategies) {
      for (const resolution of analysis.previousResolutions) {
        if (resolution.toLowerCase().includes(strategy.name.replace(/_/g, ' '))) {
          strategy.confidence = Math.min(strategy.confidence + 0.2, 1.0)
        }
      }
    }
  }

  // Decrease confidence on recurring failures
  if (analysis.isRecurring && analysis.occurrenceCount > 2) {
    for (const strategy of strategies) {
      if (strategy.actions.some(a => a.type === 'retry')) {
        strategy.confidence *= 0.7
      }
    }
  }

  return strategies
}
