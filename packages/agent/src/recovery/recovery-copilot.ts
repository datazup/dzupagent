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
 * Helpers split into sibling modules:
 * - {@link defaultStrategyGenerator} — built-in strategy catalogue
 * - {@link applyLessonBoosts} — confidence adjustments from past lessons
 * - {@link buildEscalationPlan} — terminal escalation plan factory
 * - {@link recordRecoveryFeedback} — best-effort lesson persistence
 *
 * @module recovery/recovery-copilot
 */

import type { DzupEventBus } from '@dzupagent/core/events'
import type { StuckStatus } from '../guardrails/stuck-detector.js'
import type { ApprovalGate } from '../approval/approval-gate.js'
import { FailureAnalyzer } from './failure-analyzer.js'
import { StrategyRanker } from './strategy-ranker.js'
import { RecoveryExecutor, type ActionHandler } from './recovery-executor.js'
import type {
  FailureContext,
  RecoveryPlan,
  RecoveryCopilotConfig,
  RecoveryResult,
} from './recovery-types.js'
import type { RecoveryFeedback, RecoveryLesson } from '../self-correction/recovery-feedback.js'
import { omitUndefined } from '../utils/exact-optional.js'
import { applyLessonBoosts } from './lesson-boosts.js'
import {
  defaultStrategyGenerator,
  type StrategyGenerator,
} from './default-strategy-generator.js'
import { buildEscalationPlan } from './escalation-plan.js'
import { recordRecoveryFeedback } from './feedback-recorder.js'

export type { StrategyGenerator } from './default-strategy-generator.js'

const DEFAULT_CONFIG: RecoveryCopilotConfig = {
  maxAttempts: 3,
  requireApprovalForHighRisk: true,
  dryRun: false,
  maxStrategies: 5,
  minAutoExecuteConfidence: 0.6,
}

export class RecoveryCopilot {
  private readonly config: RecoveryCopilotConfig
  private readonly analyzer: FailureAnalyzer
  private readonly ranker: StrategyRanker
  private readonly executor: RecoveryExecutor
  private readonly eventBus: DzupEventBus
  private readonly plans = new Map<string, RecoveryPlan>()
  private readonly strategyGenerator: StrategyGenerator
  private readonly feedback: RecoveryFeedback | undefined
  private planCounter = 0

  constructor(opts: {
    eventBus: DzupEventBus
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
    this.executor = new RecoveryExecutor(omitUndefined({
      eventBus: opts.eventBus,
      approvalGate: opts.approvalGate,
      copilotConfig: this.config,
      actionHandler: opts.actionHandler,
    }))
  }

  /** Create a recovery plan for a failure. */
  createPlan(
    failureContext: FailureContext,
    pastLessons: RecoveryLesson[] = [],
  ): RecoveryPlan {
    if (failureContext.previousAttempts >= this.config.maxAttempts) {
      const plan = buildEscalationPlan({
        id: this.generatePlanId(),
        failureContext,
        maxAttempts: this.config.maxAttempts,
      })
      this.plans.set(plan.id, plan)
      return plan
    }

    const analysis = this.analyzer.analyze(failureContext)
    let strategies = this.strategyGenerator(analysis, failureContext)

    if (pastLessons.length > 0) {
      strategies = applyLessonBoosts(strategies, pastLessons)
    }

    if (strategies.length > this.config.maxStrategies) {
      strategies = strategies.slice(0, this.config.maxStrategies)
    }

    strategies = this.ranker.rank(strategies)
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

  /** Execute a recovery plan (approve, run actions, record outcome). */
  async executePlan(plan: RecoveryPlan): Promise<RecoveryResult> {
    plan.status = 'approved'
    const result = await this.executor.execute(plan)

    this.analyzer.recordFailure(
      plan.failureContext,
      result.success
        ? `Resolved via ${plan.selectedStrategy?.name ?? 'unknown'}`
        : undefined,
    )

    if (plan.selectedStrategy) {
      this.ranker.markAttempted(plan.selectedStrategy.name)
    }

    return result
  }

  /** One-shot: create a plan, execute it, and record the outcome as a lesson. */
  async recover(failureContext: FailureContext): Promise<RecoveryResult> {
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
      await this.persistFeedback(analysis, failureContext, plan, false)
      return {
        plan,
        success: false,
        summary: plan.executionError ?? 'Max recovery attempts exceeded — escalating to human',
        durationMs: 0,
      }
    }

    const result = await this.executePlan(plan)
    await this.persistFeedback(analysis, failureContext, plan, result.success, result.summary)
    return result
  }

  /** Handle a StuckDetector signal by triggering recovery. */
  handleStuckSignal(
    stuckStatus: StuckStatus,
    runId: string,
    nodeId?: string,
  ): RecoveryPlan | null {
    if (!stuckStatus.stuck) return null

    const failureContext: FailureContext = omitUndefined({
      type: 'generation_failure',
      error: stuckStatus.reason ?? 'Agent stuck — no progress detected',
      runId,
      nodeId,
      timestamp: new Date(),
      previousAttempts: this.countAttemptsForRun(runId),
    })

    return this.createPlan(failureContext)
  }

  getPlan(planId: string): RecoveryPlan | undefined {
    return this.plans.get(planId)
  }

  getPlansForRun(runId: string): RecoveryPlan[] {
    return [...this.plans.values()].filter(p => p.failureContext.runId === runId)
  }

  getAnalyzer(): FailureAnalyzer {
    return this.analyzer
  }

  getRanker(): StrategyRanker {
    return this.ranker
  }

  reset(): void {
    this.plans.clear()
    this.analyzer.reset()
    this.ranker.reset()
    this.planCounter = 0
  }

  private countAttemptsForRun(runId: string): number {
    return [...this.plans.values()].filter(p => p.failureContext.runId === runId).length
  }

  private generatePlanId(): string {
    this.planCounter++
    return `recovery_${Date.now()}_${this.planCounter}`
  }

  private async persistFeedback(
    analysis: { type: string; fingerprint: string },
    failureContext: FailureContext,
    plan: RecoveryPlan,
    success: boolean,
    summary?: string,
  ): Promise<void> {
    if (!this.feedback) return
    await recordRecoveryFeedback({
      feedback: this.feedback,
      analysis,
      failureContext,
      plan,
      success,
      ...(summary !== undefined ? { summary } : {}),
    })
  }
}
