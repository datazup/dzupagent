import { afterEach, describe, expect, it, vi } from 'vitest'
import { AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import { DzupAgent } from '../../../agent/dzip-agent.js'
import { AgentOrchestrator } from '../../orchestrator.js'
import { ContractNetManager } from '../../contract-net/contract-net-manager.js'
import { TeamRuntime } from '../team-runtime.js'
import type { ParticipantDefinition, TeamDefinition } from '../team-definition.js'
import type { TeamPolicies } from '../team-policy.js'
import type { SupervisionPolicy } from '../supervision-policy.js'
import type { TeamRunResult, TeamSpawnedAgent } from '../team-workspace.js'

type AgentMap = Map<string, DzupAgent>

function createMockModel(response: string, shouldThrow = false): BaseChatModel {
  const invoke = vi.fn(async (_messages: BaseMessage[]) => {
    if (shouldThrow) throw new Error('mock model failed')
    return new AIMessage({ content: response, response_metadata: {} })
  })

  return {
    invoke,
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this
    }),
    _modelType: () => 'base_chat_model',
    _llmType: () => 'mock',
  } as unknown as BaseChatModel
}

function createAgent(id: string, response = `${id}-result`, shouldThrow = false): DzupAgent {
  return new DzupAgent({
    id,
    description: `${id} agent`,
    instructions: `You are ${id}.`,
    model: createMockModel(response, shouldThrow),
  })
}

function buildDefinition(
  id: string,
  pattern: TeamDefinition['coordinatorPattern'],
  participants: Partial<ParticipantDefinition>[],
): TeamDefinition {
  return {
    id,
    name: `Team ${id}`,
    coordinatorPattern: pattern,
    participants: participants.map((participant, index) => ({
      id: participant.id ?? `p${index + 1}`,
      role: participant.role ?? 'worker',
      model: participant.model ?? 'mock-model',
      capabilities: participant.capabilities,
      systemPrompt: participant.systemPrompt,
    })),
  }
}

function makeRuntime(
  definition: TeamDefinition,
  agentsById: AgentMap,
  options?: {
    policies?: TeamPolicies
    supervisionPolicy?: SupervisionPolicy
  },
): TeamRuntime {
  return new TeamRuntime({
    definition,
    policies: options?.policies,
    supervisionPolicy: options?.supervisionPolicy,
    resolveParticipant: async (participant): Promise<TeamSpawnedAgent> => ({
      agent: agentsById.get(participant.id)!,
      status: 'idle',
      role: participant.role as TeamSpawnedAgent['role'],
      tags: [],
      spawnedAt: Date.now(),
    }),
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TeamRuntime result pattern labels', () => {
  const patternLabelCases: Array<{
    name: string
    coordinatorPattern: TeamDefinition['coordinatorPattern']
    participants: Partial<ParticipantDefinition>[]
    expectedPattern: TeamRunResult['pattern']
    agents?: AgentMap
    policies?: TeamPolicies
    supervisionPolicy?: SupervisionPolicy
    setup?: () => void
    prime?: (runtime: TeamRuntime) => Promise<void>
  }> = [
    {
      name: 'supervisor',
      coordinatorPattern: 'supervisor',
      participants: [
        { id: 'mgr', role: 'supervisor' },
        { id: 's1', role: 'specialist' },
      ],
      expectedPattern: 'supervisor',
      setup: () => {
        vi.spyOn(AgentOrchestrator, 'supervisor').mockResolvedValue({
          content: 'supervised',
          availableSpecialists: ['s1'],
          filteredSpecialists: [],
        })
      },
    },
    {
      name: 'contract-net',
      coordinatorPattern: 'contract_net',
      participants: [
        { id: 'mgr', role: 'supervisor' },
        { id: 's1', role: 'specialist' },
      ],
      expectedPattern: 'contract-net',
      setup: () => {
        vi.spyOn(ContractNetManager, 'execute').mockResolvedValue({
          cfpId: 'cfp-1',
          agentId: 's1',
          success: true,
          result: 'contract result',
          actualDurationMs: 1,
        })
      },
    },
    {
      name: 'blackboard',
      coordinatorPattern: 'blackboard',
      participants: [{ id: 'bb1', role: 'contributor' }],
      expectedPattern: 'blackboard',
      policies: { execution: { maxRounds: 1 } },
    },
    {
      name: 'peer-to-peer',
      coordinatorPattern: 'peer_to_peer',
      participants: [{ id: 'p1', role: 'worker' }],
      expectedPattern: 'peer-to-peer',
    },
    {
      name: 'council',
      coordinatorPattern: 'council',
      participants: [
        { id: 'judge', role: 'judge', model: 'claude-opus-4-7' },
        { id: 'prop1', role: 'proposer' },
      ],
      expectedPattern: 'council',
      policies: { governance: { judgeModel: 'claude-opus-4-7' } },
      setup: () => {
        vi.spyOn(AgentOrchestrator, 'debate').mockResolvedValue('council verdict')
      },
    },
    {
      name: 'single-participant fallback',
      coordinatorPattern: 'contract_net',
      participants: [{ id: 'solo', role: 'supervisor' }],
      expectedPattern: 'single-participant',
    },
    {
      name: 'breaker-short-circuit',
      coordinatorPattern: 'peer_to_peer',
      participants: [{ id: 'flaky', role: 'worker' }],
      expectedPattern: 'breaker-short-circuit',
      agents: new Map([['flaky', createAgent('flaky', '', true)]]),
      supervisionPolicy: {
        maxFailuresBeforeCircuitBreak: 1,
        resetAfterMs: 60_000,
      },
      prime: async (runtime) => {
        await runtime.execute('trip breaker')
      },
    },
  ]

  it.each(patternLabelCases)(
    'reports the accurate pattern label for $name runs',
    async ({
      coordinatorPattern,
      participants,
      expectedPattern,
      agents,
      policies,
      supervisionPolicy,
      setup,
      prime,
    }) => {
      setup?.()
      const definition = buildDefinition(
        `label-${expectedPattern}`,
        coordinatorPattern,
        participants,
      )
      const agentsById = agents ?? new Map(
        definition.participants.map((participant) => [
          participant.id,
          createAgent(participant.id),
        ]),
      )
      const runtime = makeRuntime(definition, agentsById, {
        policies,
        supervisionPolicy,
      })

      await prime?.(runtime)
      const result = await runtime.execute('task')

      expect(result.pattern).toBe(expectedPattern)
    },
  )
})
