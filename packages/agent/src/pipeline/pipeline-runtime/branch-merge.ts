import type { NodeResult } from '../pipeline-runtime-types.js'
import { valuesEqual } from './state-utils.js'

export interface BranchExecutionResult {
  state: 'completed'
  stateDelta: Record<string, unknown>
  nodeResults: Map<string, NodeResult>
  completedNodeIds: string[]
}

export function collectStateDelta(
  baselineState: Record<string, unknown>,
  nextState: Record<string, unknown>,
): Record<string, unknown> {
  const stateDelta: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(nextState)) {
    if (!valuesEqual(value, baselineState[key])) {
      stateDelta[key] = value
    }
  }
  return stateDelta
}

export function mergeBranchExecutionResult(
  targetNodeResults: Map<string, NodeResult>,
  targetCompletedNodeIds: string[],
  targetRunState: Record<string, unknown>,
  branchResult: BranchExecutionResult,
): void {
  for (const [nodeId, result] of branchResult.nodeResults) {
    targetNodeResults.set(nodeId, result)
  }
  targetCompletedNodeIds.push(...branchResult.completedNodeIds)
  Object.assign(targetRunState, branchResult.stateDelta)
}
