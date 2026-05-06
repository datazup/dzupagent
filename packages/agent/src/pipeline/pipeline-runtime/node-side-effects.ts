/**
 * Side-effects performed around standard node execution.
 *
 * Stuck-detector hooks, trajectory calibration, iteration-budget
 * accounting, and the recovery-copilot integration are pulled out here
 * so the executor's main dispatch flow stays focused on graph traversal
 * and error handling.
 *
 * @module pipeline/pipeline-runtime/node-side-effects
 */

import type {
  NodeResult,
  NodeExecutionContext,
  PipelineRuntimeConfig,
  PipelineRuntimeEvent,
} from '../pipeline-runtime-types.js'
import type { FailureContext } from '../../recovery/recovery-types.js'
import {
  stuckDetectedEvent,
  nodeOutputRecordedEvent,
  calibrationSuboptimalEvent,
  iterationBudgetWarningEvent,
  recoveryAttemptedEvent,
  recoverySucceededEvent,
  recoveryFailedEvent,
} from './runtime-events.js'
import {
  applyCost as applyBudgetCost,
  type BudgetTrackerState,
} from './iteration-budget-tracker.js'
import { classifyFailureType } from './error-classification.js'

/**
 * Record a node failure with the configured stuck detector. Returns an
 * abort error string when the detector decides the pipeline should
 * abort, or undefined to keep going (possibly with a `stuckHint`
 * mutated onto `context`).
 */
export function recordFailureInStuckDetector(
  config: PipelineRuntimeConfig,
  emit: (event: PipelineRuntimeEvent) => void,
  nodeId: string,
  error: string,
  context: NodeExecutionContext,
): string | undefined {
  if (!config.stuckDetector) return undefined

  const stuckStatus = config.stuckDetector.recordNodeFailure(nodeId, error)
  if (!stuckStatus.stuck) return undefined

  emit(
    stuckDetectedEvent(
      stuckStatus.nodeId ?? nodeId,
      stuckStatus.reason ?? 'Unknown',
      stuckStatus.suggestedAction ?? 'abort',
    ),
  )

  if (stuckStatus.suggestedAction === 'abort') {
    return `Pipeline stuck: ${stuckStatus.reason}`
  }

  if (stuckStatus.suggestedAction === 'switch_strategy') {
    if (stuckStatus.reason !== undefined) {
      context.stuckHint = stuckStatus.reason
    }
  }

  return undefined
}

/**
 * Record a successful node output with the stuck detector. Returns an
 * abort error string when output-stuck is detected and the action is
 * `abort`.
 */
export function recordSuccessInStuckDetector(
  config: PipelineRuntimeConfig,
  emit: (event: PipelineRuntimeEvent) => void,
  nodeId: string,
  finalResult: NodeResult,
  context: NodeExecutionContext,
): string | undefined {
  if (!config.stuckDetector) return undefined

  const outputStr = JSON.stringify(finalResult.output) ?? ''
  const stuckStatus = config.stuckDetector.recordNodeOutput(nodeId, outputStr)
  emit(nodeOutputRecordedEvent(nodeId, outputStr.slice(0, 32)))

  if (!stuckStatus.stuck) return undefined

  emit(
    stuckDetectedEvent(
      stuckStatus.nodeId ?? nodeId,
      stuckStatus.reason ?? 'Unknown',
      stuckStatus.suggestedAction ?? 'switch_strategy',
    ),
  )

  if (stuckStatus.suggestedAction === 'abort') {
    return `Pipeline stuck: ${stuckStatus.reason}`
  }

  if (stuckStatus.suggestedAction === 'switch_strategy') {
    if (stuckStatus.reason !== undefined) {
      context.stuckHint = stuckStatus.reason
    }
  }

  return undefined
}

/**
 * Record step quality with the trajectory calibrator (if configured)
 * and emit `calibration_suboptimal` when the score deviates from the
 * baseline. Calibration failures are non-fatal.
 */
export async function recordCalibration(
  config: PipelineRuntimeConfig,
  emit: (event: PipelineRuntimeEvent) => void,
  nodeId: string,
  finalResult: NodeResult & { retryCount?: number },
  runId: string,
): Promise<void> {
  if (!config.trajectoryCalibrator) return
  const tc = config.trajectoryCalibrator
  const quality = tc.extractQuality(nodeId, finalResult)
  if (quality === undefined) return

  try {
    // Record step quality for future baseline computation
    await tc.calibrator.recordStep({
      nodeId,
      runId,
      qualityScore: quality,
      durationMs: finalResult.durationMs,
      tokenCost: 0,
      errorCount: 0,
      timestamp: new Date(),
      retryCount: finalResult.retryCount ?? 0,
    })

    // Check against baseline
    const suboptimal = await tc.calibrator.detectSuboptimal(
      nodeId, quality, tc.taskType,
    )
    if (suboptimal.isSuboptimal) {
      emit(
        calibrationSuboptimalEvent(
          nodeId,
          suboptimal.baseline,
          suboptimal.currentScore,
          suboptimal.deviation,
          suboptimal.suggestion ?? `Node "${nodeId}" quality below baseline`,
        ),
      )
    }
  } catch {
    // Calibration is non-fatal
  }
}

/**
 * Iteration budget tracking: accumulate cost and emit warnings.
 * The accounting + threshold rules live in the standalone
 * iteration-budget-tracker helper so they can be tested in
 * isolation; the runtime owns event emission and `iteration`
 * (completedNodeIds.length) is captured before the tracker
 * mutates so the warning event keeps its original meaning.
 */
export function recordIterationBudget(
  config: PipelineRuntimeConfig,
  emit: (event: PipelineRuntimeEvent) => void,
  budgetTracker: BudgetTrackerState,
  nodeId: string,
  finalResult: NodeResult,
  iteration: number,
): void {
  if (!config.iterationBudget) return
  const ib = config.iterationBudget
  const cost = ib.extractCost(nodeId, finalResult)
  const decision = applyBudgetCost(budgetTracker, cost, ib.maxCostCents)
  if (decision.warning) {
    emit(
      iterationBudgetWarningEvent(
        decision.warning,
        decision.cumulativeCostCents,
        ib.maxCostCents,
        iteration,
      ),
    )
  }
}

export interface RecoveryCounter {
  get(): number
  increment(): number
}

/**
 * Check whether the recovery copilot is configured and eligible for
 * the given node, then attempt recovery. Returns `true` if recovery
 * succeeded and the node should be retried.
 */
export async function attemptRecovery(
  config: PipelineRuntimeConfig,
  emit: (event: PipelineRuntimeEvent) => void,
  recoveryCounter: RecoveryCounter,
  nodeId: string,
  nodeType: string,
  errorMessage: string,
  runId: string,
): Promise<boolean> {
  const rc = config.recoveryCopilot
  if (!rc) return false

  // Check per-node eligibility
  if (rc.enabledForNodes && rc.enabledForNodes.length > 0) {
    if (!rc.enabledForNodes.includes(nodeId)) return false
  }

  // Check global attempt budget
  const maxAttempts = rc.maxRecoveryAttempts ?? 3
  if (recoveryCounter.get() >= maxAttempts) return false

  const attemptsUsed = recoveryCounter.increment()

  emit(recoveryAttemptedEvent(nodeId, attemptsUsed, maxAttempts, errorMessage))

  // Build a FailureContext for the copilot
  const failureType = classifyFailureType(errorMessage, nodeType)
  const failureContext: FailureContext = {
    type: failureType,
    error: errorMessage,
    runId,
    nodeId,
    timestamp: new Date(),
    previousAttempts: attemptsUsed - 1,
  }

  try {
    const result = await rc.copilot.recover(failureContext)

    if (result.success) {
      emit(recoverySucceededEvent(nodeId, attemptsUsed, result.summary))
      return true
    }

    emit(recoveryFailedEvent(nodeId, attemptsUsed, result.summary))
    return false
  } catch (recoveryErr) {
    const msg = recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr)
    emit(recoveryFailedEvent(nodeId, attemptsUsed, `Recovery threw: ${msg}`))
    return false
  }
}
