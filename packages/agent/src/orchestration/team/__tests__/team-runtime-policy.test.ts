import { describe, expect, it, vi } from 'vitest'
import { AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import { DzupAgent } from '../../../agent/dzip-agent.js'
import { TeamRuntime } from '../team-runtime.js'
import type {
  ParticipantDefinition,
  TeamDefinition,
} from '../team-definition.js'
import type { TeamPolicies } from '../team-policy.js'
import type { TeamRuntimeEvent } from '../team-runtime.js'
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

function createBlackboardAgent(
  id: string,
  responses: string[],
  prompts: string[] = [],
): DzupAgent {
  let index = 0
  const model: BaseChatModel = {
    invoke: vi.fn(async (messages: BaseMessage[]) => {
      const lastMessage = messages.at(-1)
      prompts.push(
        typeof lastMessage?.content === 'string'
          ? lastMessage.content
          : JSON.stringify(lastMessage?.content),
      )
      const content = responses[index] ?? responses.at(-1) ?? ''
      index += 1
      return new AIMessage({ content, response_metadata: {} })
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

  it('rejects governance policy fields that TeamRuntime does not enforce yet', () => {
    const councilDefinition: TeamDefinition = {
      ...buildDefinition('unsupported-governance', [
        { id: 'judge', role: 'judge' },
        { id: 'p1', role: 'worker' },
      ]),
      coordinatorPattern: 'council',
    }
    const peerDefinition = buildDefinition('unsupported-governance-peer', [
      { id: 'p1', role: 'worker' },
    ])

    expect(() => new TeamRuntime({
      definition: peerDefinition,
      policies: { governance: { judgeModel: 'claude-opus-4-7' } },
    })).toThrow(
      "governance policy group is only supported for coordinator pattern 'council'",
    )

    expect(() => new TeamRuntime({
      definition: councilDefinition,
      policies: { governance: { judgeModel: 'claude-opus-4-7', minScore: 0.8 } },
    })).toThrow("governance policy field 'minScore' is not supported yet")

    expect(() => new TeamRuntime({
      definition: councilDefinition,
      policies: {
        governance: {
          judgeModel: 'claude-opus-4-7',
          requireUnanimous: true,
        },
      },
    })).toThrow(
      "governance policy field 'requireUnanimous' is not supported yet",
    )
  })

  it('emits metadata-safe diagnostics when enforcing governance judgeModel', async () => {
    const definition: TeamDefinition = {
      ...buildDefinition('governance-diagnostic', [
        { id: 'judge', role: 'judge' },
        { id: 'p1', role: 'worker' },
      ]),
      coordinatorPattern: 'council',
      participants: [
        { id: 'judge', role: 'judge', model: 'claude-opus-4-7' },
        { id: 'p1', role: 'worker', model: 'mock' },
      ],
    }
    const events: TeamRuntimeEvent[] = []
    const agentsById = new Map([
      ['judge', createDelayedAgent('judge', () => {})],
      ['p1', createDelayedAgent('p1', () => {})],
    ])
    const runtime = new TeamRuntime({
      definition,
      policies: { governance: { judgeModel: 'claude-opus-4-7' } },
      generateRunId: () => 'run-governance',
      onEvent: (event) => events.push(event),
      resolveParticipant: async (participant): Promise<SpawnedAgent> => ({
        agent: agentsById.get(participant.id)!,
        status: 'idle',
        role: participant.role as SpawnedAgent['role'],
        tags: [],
        spawnedAt: Date.now(),
      }),
    })

    await runtime.execute('task')

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'policy_applied',
        teamId: 'governance-diagnostic',
        runId: 'run-governance',
        policyGroup: 'governance',
        policyField: 'judgeModel',
        coordinatorPattern: 'council',
      }),
    )
    expect(JSON.stringify(events)).not.toContain('claude-opus-4-7')
  })

  it.each([
    ['isolation', { isolation: { sandboxed: true, sharedWorkspace: false } }],
    ['mailbox', { mailbox: { deliveryMode: 'targeted' } }],
    ['evaluation', { evaluation: { scorerModel: 'claude-opus-4-7' } }],
  ] satisfies Array<[string, TeamPolicies]>)(
    'rejects unsupported %s policy group fail-closed',
    (group, policies) => {
      const definition = buildDefinition(`unsupported-${group}`, [
        { id: 'p1', role: 'worker' },
      ])

      expect(() => new TeamRuntime({
        definition,
        policies,
      })).toThrow(`TeamRuntime policy group '${group}' is not supported yet`)
    },
  )
})

describe('TeamRuntime blackboard memory policy', () => {
  function buildBlackboardDefinition(id: string): TeamDefinition {
    return {
      ...buildDefinition(id, [{ id: 'writer', role: 'worker' }]),
      coordinatorPattern: 'blackboard',
    }
  }

  function createBlackboardRuntime(
    policies: TeamPolicies,
    agent: DzupAgent,
  ): TeamRuntime {
    return new TeamRuntime({
      definition: buildBlackboardDefinition('blackboard-budget'),
      policies,
      resolveParticipant: async (participant): Promise<SpawnedAgent> => ({
        agent,
        status: 'idle',
        role: participant.role as SpawnedAgent['role'],
        tags: [],
        spawnedAt: Date.now(),
      }),
    })
  }

  it('keeps normal small blackboard context intact', async () => {
    const prompts: string[] = []
    const agent = createBlackboardAgent(
      'writer',
      ['small one', 'small two', 'small three'],
      prompts,
    )
    const runtime = createBlackboardRuntime({
      memory: {
        tier: 'ephemeral',
        shareAcrossParticipants: true,
        blackboardContext: {
          maxSerializedChars: 1_000,
          maxEntryChars: 500,
        },
      },
    }, agent)

    const result = await runtime.execute('small task')

    expect(result.agentResults[0]?.success).toBe(true)
    expect(result.content).toContain('small task')
    expect(result.content).toContain('small three')
    expect(prompts).toHaveLength(3)
    expect(prompts.join('\n')).not.toContain('[compacted:')
  })

  it('compacts oversized blackboard contributions before later prompts', async () => {
    const prompts: string[] = []
    const largeContribution = `${'a'.repeat(160)}keep-tail`
    const agent = createBlackboardAgent(
      'writer',
      [largeContribution, largeContribution, largeContribution],
      prompts,
    )
    const runtime = createBlackboardRuntime({
      memory: {
        tier: 'ephemeral',
        shareAcrossParticipants: true,
        blackboardContext: {
          maxSerializedChars: 240,
          maxEntryChars: 120,
          overflowBehavior: 'compact',
        },
      },
    }, agent)

    const result = await runtime.execute('bounded task')

    expect(result.agentResults[0]?.success).toBe(true)
    expect(result.agentResults[0]?.content.length).toBeLessThanOrEqual(120)
    expect(result.agentResults[0]?.content).toContain('[compacted:')
    expect(result.agentResults[0]?.content).toContain('keep-tail')
    expect(result.content.length).toBeLessThanOrEqual(240)
    expect(prompts[1]).toContain('[compacted:')
    expect(prompts.every((prompt) => prompt.length < 700)).toBe(true)
  })

  it('rejects oversized blackboard contributions when configured to reject', async () => {
    const agent = createBlackboardAgent('writer', ['too large '.repeat(20)])
    const runtime = createBlackboardRuntime({
      memory: {
        tier: 'ephemeral',
        shareAcrossParticipants: true,
        blackboardContext: {
          maxSerializedChars: 500,
          maxEntryChars: 30,
          overflowBehavior: 'reject',
        },
      },
    }, agent)

    const result = await runtime.execute('bounded task')

    expect(result.agentResults[0]?.success).toBe(false)
    expect(result.agentResults[0]?.content).toBe('')
    expect(result.agentResults[0]?.error).toContain('maxEntryChars')
    expect(result.content).not.toContain('too large')
  })

  it('rejects memory policy outside blackboard pattern', () => {
    const peerDefinition = buildDefinition('memory-peer', [
      { id: 'p1', role: 'worker' },
    ])

    expect(() => new TeamRuntime({
      definition: peerDefinition,
      policies: { memory: { tier: 'session', shareAcrossParticipants: true } },
    })).toThrow(
      "memory policy group is only supported for coordinator pattern 'blackboard'",
    )
  })

  it('accepts consolidateOnComplete policy without throwing', () => {
    const blackboardDefinition = buildBlackboardDefinition('memory-consolidate')

    expect(() => new TeamRuntime({
      definition: blackboardDefinition,
      policies: {
        memory: {
          tier: 'session',
          shareAcrossParticipants: true,
          consolidateOnComplete: true,
        },
      },
    })).not.toThrow()
  })
})
