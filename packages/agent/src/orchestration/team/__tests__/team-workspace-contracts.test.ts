import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import { DzupAgent } from '../../../agent/dzip-agent.js'
import { SharedWorkspace, type TeamRunResult } from '../team-workspace.js'
import { TeamRuntime } from '../team-runtime.js'
import type { ParticipantDefinition, TeamDefinition } from '../team-definition.js'
import type { TeamSpawnedAgent } from '../team-workspace.js'
import {
  SharedWorkspace as PlaygroundSharedWorkspace,
} from '../../../playground/shared-workspace.js'
import type {
  SpawnedAgent as PlaygroundSpawnedAgent,
  TeamRunResult as PlaygroundTeamRunResult,
} from '../../../playground/types.js'

function createModel(response: string): BaseChatModel {
  const invoke = vi.fn(async (_messages: BaseMessage[]) => {
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

function createAgent(id: string, response: string): DzupAgent {
  return new DzupAgent({
    id,
    description: `${id} agent`,
    instructions: `You are ${id}.`,
    model: createModel(response),
  })
}

function makeResolver(
  agents: Map<string, DzupAgent>,
): (participant: ParticipantDefinition) => Promise<TeamSpawnedAgent> {
  return async (participant) => {
    const agent = agents.get(participant.id)
    if (!agent) throw new Error(`missing agent ${participant.id}`)
    return {
      agent,
      status: 'idle',
      role: participant.role as TeamSpawnedAgent['role'],
      tags: [],
      spawnedAt: Date.now(),
    }
  }
}

describe('team workspace/result contracts', () => {
  it('runs blackboard teams with orchestration-owned workspace contracts', async () => {
    const definition: TeamDefinition = {
      id: 'blackboard-team',
      name: 'Blackboard team',
      coordinatorPattern: 'blackboard',
      participants: [
        { id: 'planner', role: 'planner', model: 'mock' },
        { id: 'reviewer', role: 'reviewer', model: 'mock' },
      ],
    }

    const runtime = new TeamRuntime({
      definition,
      resolveParticipant: makeResolver(
        new Map([
          ['planner', createAgent('planner', 'plan draft')],
          ['reviewer', createAgent('reviewer', 'review notes')],
        ]),
      ),
    })

    const result = await runtime.execute('ship the feature')

    expect(result.pattern).toBe('blackboard')
    expect(result.agentResults).toHaveLength(2)
    expect(result.content).toContain('## Shared Workspace')
    expect(result.content).toContain('### task')
    expect(result.content).toContain('ship the feature')
    expect(result.content).toContain('### planner')
    expect(result.content).toContain('plan draft')
  })

  it('keeps playground workspace and result aliases compatible', async () => {
    expect(PlaygroundSharedWorkspace).toBe(SharedWorkspace)

    const workspace = new PlaygroundSharedWorkspace()
    await workspace.set('answer', '42', 'agent-a')

    expect(workspace).toBeInstanceOf(SharedWorkspace)
    expect(workspace.get('answer')).toBe('42')

    expectTypeOf<PlaygroundTeamRunResult>().toEqualTypeOf<TeamRunResult>()
    expectTypeOf<PlaygroundSpawnedAgent>().toEqualTypeOf<TeamSpawnedAgent>()
  })
})
