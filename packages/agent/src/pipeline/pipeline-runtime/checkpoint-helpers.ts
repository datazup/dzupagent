import type { PipelineCheckpoint } from '@dzupagent/core'

export function createPipelineCheckpoint(options: {
  pipelineRunId: string
  pipelineId: string
  version: number
  completedNodeIds: string[]
  state: Record<string, unknown>
  suspendedAtNodeId?: string
}): PipelineCheckpoint {
  return {
    pipelineRunId: options.pipelineRunId,
    pipelineId: options.pipelineId,
    version: options.version,
    schemaVersion: '1.0.0',
    completedNodeIds: [...options.completedNodeIds],
    state: structuredClone(options.state),
    suspendedAtNodeId: options.suspendedAtNodeId,
    createdAt: new Date().toISOString(),
  }
}
