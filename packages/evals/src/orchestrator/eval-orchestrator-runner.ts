/**
 * Run-execution helper for EvalOrchestrator.
 *
 * Owns the per-run runEvalSuite invocation, abort plumbing, cost-cap
 * enforcement, and the success/failure persistence transitions. Extracted
 * from eval-orchestrator-impl.ts in MC-026a to keep the orchestrator class
 * focused on the queue lifecycle.
 */

import type {
  EvalExecutionContext,
  EvalExecutionTarget,
  EvalRunRecord,
  EvalRunStore,
} from '@dzupagent/eval-contracts'
import { runEvalSuite } from '../eval-runner.js'
import {
  createAbortError,
  getCurrentAttemptNumber,
  toEvalRunError,
  updateAttemptHistory,
} from './eval-orchestrator-attempts.js'
import { assertCostWithinCap, type CostCapConfig } from './eval-orchestrator-cost.js'
import { EvalExecutionUnavailableError } from './eval-orchestrator-errors.js'
import type { QueueMetricsTracker } from './eval-orchestrator-metrics.js'

export interface RunExecutorConfig {
  store: EvalRunStore
  ownerId: string
  queueMetrics: QueueMetricsTracker
  costCap: CostCapConfig
  getExecuteTarget: () => EvalExecutionTarget | undefined
}

export class RunExecutor {
  constructor(private readonly config: RunExecutorConfig) {}

  async execute(run: EvalRunRecord, abortController: AbortController): Promise<void> {
    if (abortController.signal.aborted) return
    if (run.status !== 'running') return

    const startedAt = run.startedAt ?? new Date().toISOString()
    const attempt = getCurrentAttemptNumber(run)

    this.config.queueMetrics.increment('started')
    this.config.queueMetrics.recordQueueEvent('forge_eval_queue_started_total')
    this.config.queueMetrics.recordQueueHistogram(
      'forge_eval_queue_wait_ms',
      Date.parse(startedAt) - Date.parse(run.queuedAt),
    )
    await this.config.queueMetrics.refreshQueueMetrics()

    try {
      const result = await runEvalSuite(run.suite, async (input: string) => {
        if (abortController.signal.aborted) {
          throw createAbortError()
        }

        const target = this.config.getExecuteTarget()
        if (!target) {
          throw new EvalExecutionUnavailableError('Eval execution target is not configured')
        }

        await assertCostWithinCap(this.config.costCap)

        const ctx: EvalExecutionContext = {
          suiteId: run.suiteId,
          runId: run.id,
          attempt,
          metadata: run.metadata,
          signal: abortController.signal,
        }
        const output = await target(input, ctx)
        await assertCostWithinCap(this.config.costCap)
        return output
      })

      await this.recordCompletion(run, attempt, abortController, result)
    } catch (error) {
      await this.recordFailure(run, attempt, abortController, error)
    }
  }

  private async recordCompletion(
    run: EvalRunRecord,
    attempt: number,
    abortController: AbortController,
    result: EvalRunRecord['result'],
  ): Promise<void> {
    const completedAt = new Date().toISOString()
    const currentRun = await this.config.store.getRun(run.id)

    const completed = await this.config.store.updateRunIf(run.id, (current) => {
      return current.status === 'running'
        && current.executionOwner?.ownerId === this.config.ownerId
        && !abortController.signal.aborted
    }, {
      status: 'completed',
      result,
      completedAt,
      executionOwner: undefined,
      attempts: Math.max(run.attempts, attempt),
      attemptHistory: updateAttemptHistory(currentRun ?? run, attempt, {
        status: 'completed',
        completedAt,
        result,
      }),
    })

    if (!completed) return
    await this.config.queueMetrics.track('completed', 'forge_eval_queue_completed_total')
  }

  private async recordFailure(
    run: EvalRunRecord,
    attempt: number,
    abortController: AbortController,
    error: unknown,
  ): Promise<void> {
    const completedAt = new Date().toISOString()
    const failure = toEvalRunError(error)
    const currentRun = await this.config.store.getRun(run.id)

    const failed = await this.config.store.updateRunIf(run.id, (current) => {
      return current.status === 'running'
        && current.executionOwner?.ownerId === this.config.ownerId
        && !abortController.signal.aborted
    }, {
      status: 'failed',
      error: failure,
      completedAt,
      executionOwner: undefined,
      attempts: Math.max(run.attempts, attempt),
      attemptHistory: updateAttemptHistory(currentRun ?? run, attempt, {
        status: 'failed',
        completedAt,
        error: failure,
      }),
    })

    if (!failed) return
    await this.config.queueMetrics.track('failed', 'forge_eval_queue_failed_total')
  }
}
