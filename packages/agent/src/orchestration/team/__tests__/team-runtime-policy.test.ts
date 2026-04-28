import { describe, expect, it, vi } from 'vitest'
import { AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { DzupAgent } from '../../../agent/dzip-agent.js'
import { TeamRuntime } from '../team-runtime.js'
import type {
  ParticipantDefinition,
  TeamDefinition,
} from '../team-definition.js'
import type { TeamCheckpoint, ResumeContract } from '../team-checkpoint.js'
import type { SpawnedAgent } from '../team-workspace.js'

function buildDefinition(
  id: string,
  participants: Array<Pick<ParticipantDefinition, 'id' | 'role'>>,
): TeamDefinition {
  return {
    id,
    name: id,
    coordinatorPattern: 'peer_to_peer',
    participants: participants.map((participant) => ({
      ...participant,
      model: 'mock',
    })),
  }
}

function createDelayedAgent(
  id: string,
  onActiveChange: (delta: 1 | -1) => void,
): DzupAgent {
  const model: BaseChatModel = {
    invoke: vi.fn(async () => {
      onActiveChange(1)
      try {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return new AIMessage({ content: `${id}-done`, response_metadata: {} })
      } finally {
        onActiveChange(-1)
      }
    }),
    bindTools: vi.fn(function (this: BaseChatModel) { return this }),
    _modelType: () => 'base_chat_model',
    _llmType: () => 'mock',
  } as unknown as BaseChatModel

  return new DzupAgent({
    id,
    name: id,
    instructions: `You are ${id}.`,
    model,
  })
}

function makeRuntime(
  definition: TeamDefinition,
  agentsById: Map<string, DzupAgent>,
  maxParallelParticipants: number,
): TeamRuntime {
  return new TeamRuntime({
    definition,
    policies: { execution: { maxParallelParticipants } },
    resolveParticipant: async (participant): Promise<SpawnedAgent> => ({
      agent: agentsById.get(participant.id)!,
      status: 'idle',
      role: participant.role as SpawnedAgent['role'],
      tags: [],
      spawnedAt: Date.now(),
    }),
  })
}

describe('TeamRuntime execution policy', () => {
  it('limits peer_to_peer participant fan-out with maxParallelParticipants', async () => {
    let active = 0
    let maxActive = 0
    const onActiveChange = (delta: 1 | -1) => {
      active += delta
      maxActive = Math.max(maxActive, active)
    }
    const participants = ['a', 'b', 'c', 'd'].map((id) => ({
      id,
      role: 'worker',
    }))
    const runtime = makeRuntime(
      buildDefinition('policy-parallel', participants),
      new Map(
        participants.map((participant) => [
          participant.id,
          createDelayedAgent(participant.id, onActiveChange),
        ]),
      ),
      2,
    )

    const result = await runtime.execute('task')

    expect(result.agentResults).toHaveLength(4)
    expect(maxActive).toBeLessThanOrEqual(2)
  })

  it('keeps maxParallelParticipants in force during resume', async () => {
    let active = 0
    let maxActive = 0
    const onActiveChange = (delta: 1 | -1) => {
      active += delta
      maxActive = Math.max(maxActive, active)
    }
    const participants = ['done', 'p1', 'p2'].map((id) => ({
      id,
      role: 'worker',
    }))
    const runtime = makeRuntime(
      buildDefinition('policy-resume', participants),
      new Map(
        participants.map((participant) => [
          participant.id,
          createDelayedAgent(participant.id, onActiveChange),
        ]),
      ),
      1,
    )
    const checkpoint: TeamCheckpoint = {
      teamId: 'policy-resume',
      runId: 'run-1',
      phase: 'executing',
      completedParticipantIds: ['done'],
      pendingParticipantIds: ['p1', 'p2'],
      sharedContext: {},
      checkpointedAt: new Date(),
    }
    const contract: ResumeContract = {
      checkpointId: 'ck-1',
      resumeFromPhase: 'executing',
      skipCompletedParticipants: true,
    }

    const result = await runtime.resume(checkpoint, contract, 'task')

    expect(result.agentResults.map((agentResult) => agentResult.agentId)).toEqual([
      'p1',
      'p2',
    ])
    expect(maxActive).toBe(1)
  })

  it('rejects pending timeout and retry policy fields', () => {
    const definition = buildDefinition('unsupported-policy', [
      { id: 'p1', role: 'worker' },
    ])

    expect(() => new TeamRuntime({
      definition,
      policies: { execution: { timeoutMs: 100 } },
    })).toThrow("execution policy field 'timeoutMs' is not supported yet")

    expect(() => new TeamRuntime({
      definition,
      policies: { execution: { retryOnFailure: true } },
    })).toThrow("execution policy field 'retryOnFailure' is not supported yet")

    expect(() => new TeamRuntime({
      definition,
      policies: { execution: { maxRetries: 1 } },
    })).toThrow("execution policy field 'maxRetries' is not supported yet")
  })
})
