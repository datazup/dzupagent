import { describe, expect, it, vi } from 'vitest'
import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { createEventBus, type DzupEvent } from '@dzupagent/core/events'
import { DzupAgent } from '../../../agent/dzip-agent.js'
import { RuntimeHardBudgetAdoptionError } from '../../../agent/runtime-hard-budget.js'
import { TeamRuntime } from '../team-runtime.js'
import type { TeamDefinition } from '../team-definition.js'
import type { TeamRuntimeEvent } from '../team-runtime-events.js'
import type { TeamSpawnedAgent } from '../team-workspace.js'

const definition: TeamDefinition = {
  id: 'budgeted-team',
  name: 'Budgeted team',
  coordinatorPattern: 'peer_to_peer',
  participants: [{ id: 'worker', role: 'worker', model: 'mock' }],
}

const exactCharacterCounter = {
  count: (text: string) => text.length,
  countDetailed: (text: string) => ({
    tokens: text.length,
    method: 'exact' as const,
  }),
}

function spawnedAgent(requests: BaseMessage[][]): TeamSpawnedAgent {
  const model = {
    invoke: vi.fn(async (messages: BaseMessage[]) => {
      requests.push([...messages])
      return new AIMessage('team-done')
    }),
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this
    }),
    _modelType: () => 'base_chat_model',
    _llmType: () => 'mock',
  } as unknown as BaseChatModel
  return {
    agent: new DzupAgent({
      id: 'worker',
      instructions: 'Work safely.',
      model,
    }),
    status: 'idle',
    role: 'worker',
    tags: [],
    spawnedAt: Date.now(),
  }
}

describe('TeamRuntime hard-budget handoff', () => {
  it('truncates the runtime-owned task and emits instance plus bus proof', async () => {
    const requests: BaseMessage[][] = []
    const teamEvents: TeamRuntimeEvent[] = []
    const busEvents: DzupEvent[] = []
    const bus = createEventBus()
    bus.onAny((event) => {
      busEvents.push(event)
    })
    const runtime = new TeamRuntime({
      definition,
      generateRunId: () => 'run-budgeted',
      onEvent: (event) => teamEvents.push(event),
      eventBus: bus,
      hardBudget: {
        contextWindowTokens: 120,
        reservedOutputTokens: 20,
        reservedSummaryTokens: 10,
        fixedEnvelopeTokens: 4,
        perMessageEnvelopeTokens: 2,
        tokenCounter: exactCharacterCounter,
      },
      resolveParticipant: async () => spawnedAgent(requests),
    })

    await runtime.execute('T'.repeat(300))
    await Promise.resolve()

    const human = requests[0]!.find((message) => message._getType() === 'human')
    expect(String(human?.content)).toContain('truncated')
    expect(String(human?.content).length).toBeLessThanOrEqual(82)
    expect(teamEvents).toContainEqual(expect.objectContaining({
      type: 'context_handoff_budget_evaluated',
      adoptionSafe: true,
      truncated: true,
      markerIncluded: true,
    }))
    expect(busEvents).toContainEqual(expect.objectContaining({
      type: 'team:context_handoff_budget_evaluated',
      teamId: 'budgeted-team',
      adoptionSafe: true,
      truncated: true,
    }))
  })

  it('fails before resolving a participant when proof is heuristic', async () => {
    const teamEvents: TeamRuntimeEvent[] = []
    const resolveParticipant = vi.fn()
    const runtime = new TeamRuntime({
      definition,
      generateRunId: () => 'run-unsafe',
      onEvent: (event) => teamEvents.push(event),
      hardBudget: {
        contextWindowTokens: 120,
        reservedOutputTokens: 20,
        reservedSummaryTokens: 10,
        fixedEnvelopeTokens: 4,
        perMessageEnvelopeTokens: 2,
        tokenCounter: { count: (text) => text.length },
      },
      resolveParticipant,
    })

    await expect(runtime.execute('original task')).rejects.toBeInstanceOf(
      RuntimeHardBudgetAdoptionError,
    )

    expect(resolveParticipant).not.toHaveBeenCalled()
    expect(teamEvents).toContainEqual(expect.objectContaining({
      type: 'context_handoff_budget_evaluated',
      adoptionSafe: false,
      satisfied: false,
    }))
    expect(teamEvents.at(-1)).toMatchObject({ type: 'team_failed' })
  })
})
