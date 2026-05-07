import type { PipelineCheckpoint } from '@dzupagent/core/pipeline'
import { omitUndefined } from '../../utils/exact-optional.js'

export function createPipelineCheckpoint(options: {
  pipelineRunId: string
  pipelineId: string
  version: number
  completedNodeIds: string[]
  state: Record<string, unknown>
  suspendedAtNodeId?: string
  recoveryAttemptsUsed?: number
}): PipelineCheckpoint {
  return omitUndefined({
    pipelineRunId: options.pipelineRunId,
    pipelineId: options.pipelineId,
    version: options.version,
    schemaVersion: '1.0.0',
    completedNodeIds: [...options.completedNodeIds],
    state: structuredClone(options.state),
    suspendedAtNodeId: options.suspendedAtNodeId,
    recoveryAttemptsUsed: options.recoveryAttemptsUsed,
    createdAt: new Date().toISOString(),
  })
}
