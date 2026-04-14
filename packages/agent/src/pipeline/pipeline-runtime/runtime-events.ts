import type { PipelineRuntimeEvent } from '../pipeline-runtime-types.js'

export function pipelineStartedEvent(
  pipelineId: string,
  runId: string,
): PipelineRuntimeEvent {
  return { type: 'pipeline:started', pipelineId, runId }
}

export function pipelineCompletedEvent(
  runId: string,
  totalDurationMs: number,
): PipelineRuntimeEvent {
  return { type: 'pipeline:completed', runId, totalDurationMs }
}

export function pipelineFailedEvent(
  runId: string,
  error: string,
): PipelineRuntimeEvent {
  return { type: 'pipeline:failed', runId, error }
}

export function pipelineSuspendedEvent(nodeId: string): PipelineRuntimeEvent {
  return { type: 'pipeline:suspended', nodeId }
}

export function checkpointSavedEvent(
  runId: string,
  version: number,
): PipelineRuntimeEvent {
  return { type: 'pipeline:checkpoint_saved', runId, version }
}

export function nodeStartedEvent(
  nodeId: string,
  nodeType: string,
): PipelineRuntimeEvent {
  return { type: 'pipeline:node_started', nodeId, nodeType }
}

export function nodeCompletedEvent(
  nodeId: string,
  durationMs: number,
): PipelineRuntimeEvent {
  return { type: 'pipeline:node_completed', nodeId, durationMs }
}

export function nodeFailedEvent(
  nodeId: string,
  error: string,
): PipelineRuntimeEvent {
  return { type: 'pipeline:node_failed', nodeId, error }
}

export function nodeRetryEvent(
  nodeId: string,
  attempt: number,
  maxAttempts: number,
  error: string,
  backoffMs: number,
): PipelineRuntimeEvent {
  return { type: 'pipeline:node_retry', nodeId, attempt, maxAttempts, error, backoffMs }
}

export function recoveryAttemptedEvent(
  nodeId: string,
  attempt: number,
  maxAttempts: number,
  error: string,
): PipelineRuntimeEvent {
  return { type: 'pipeline:recovery_attempted', nodeId, attempt, maxAttempts, error }
}

export function recoverySucceededEvent(
  nodeId: string,
  attempt: number,
  summary: string,
): PipelineRuntimeEvent {
  return { type: 'pipeline:recovery_succeeded', nodeId, attempt, summary }
}

export function recoveryFailedEvent(
  nodeId: string,
  attempt: number,
  error: string,
): PipelineRuntimeEvent {
  return { type: 'pipeline:recovery_failed', nodeId, attempt, error }
}

export function stuckDetectedEvent(
  nodeId: string,
  reason: string,
  suggestedAction: string,
): PipelineRuntimeEvent {
  return { type: 'pipeline:stuck_detected', nodeId, reason, suggestedAction }
}

export function nodeOutputRecordedEvent(
  nodeId: string,
  outputHash: string,
): PipelineRuntimeEvent {
  return { type: 'pipeline:node_output_recorded', nodeId, outputHash }
}

export function calibrationSuboptimalEvent(
  nodeId: string,
  baseline: number,
  currentScore: number,
  deviation: number,
  suggestion: string,
): PipelineRuntimeEvent {
  return { type: 'pipeline:calibration_suboptimal', nodeId, baseline, currentScore, deviation, suggestion }
}

export function iterationBudgetWarningEvent(
  level: 'warn_70' | 'warn_90',
  totalCost: number,
  budgetCents: number,
  iteration: number,
): PipelineRuntimeEvent {
  return { type: 'pipeline:iteration_budget_warning', level, totalCost, budgetCents, iteration }
}
