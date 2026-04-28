/**
 * H4 — TeamRuntime SupervisionPolicy + circuit breaker tests.
 *
 * Verifies the per-agent circuit-breaker integration: an agent trips its
 * breaker after `maxFailuresBeforeCircuitBreak` failures, the breaker resets
 * after `resetAfterMs`, and the `onCircuitOpen` callback is invoked exactly
 * once on the first trip.
 */
import { describe, it, expect, vi } from 'vitest'
import { AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import { DzupAgent } from '../../../agent/dzip-agent.js'
import { TeamRuntime } from '../team-runtime.js'
import type { ParticipantDefinition, TeamDefinition } from '../team-definition.js'
import type { TeamSpawnedAgent as SpawnedAgent } from '../team-workspace.js'

function createMockModel(shouldThrow: boolean): {
  model: BaseChatModel
  invoke: ReturnType<typeof vi.fn>
} {
  const invoke = vi.fn(async (_messages: BaseMessage[]) => {
    if (shouldThrow) throw new Error('mock model failed')
    return new AIMessage({ content: 'ok', response_metadata: {} })
  })
  const model = {
    invoke,
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this
    }),
    _modelType: () => 'base_chat_model',
    _llmType: () => 'mock',
  } as unknown as BaseChatModel
  return { model, invoke }
}

function createAgent(
  id: string,
  shouldThrow: boolean,
): { agent: DzupAgent; invoke: ReturnType<typeof vi.fn> } {
  const { model, invoke } = createMockModel(shouldThrow)
  const agent = new DzupAgent({
    id,
    description: `${id}`,
    instructions: `You are ${id}.`,
    model,
  })
  return { agent, invoke }
}

function buildTeam(
  id: string,
  participantIds: string[],
): TeamDefinition {
  return {
    id,
    name: `Team ${id}`,
    coordinatorPattern: 'peer_to_peer',
    participants: participantIds.map((pid) => ({
      id: pid,
      role: 'specialist',
      model: 'mock-model',
    })) as ParticipantDefinition[],
  }
}

function makeResolver(
  agents: Map<string, DzupAgent>,
): (p: ParticipantDefinition) => Promise<SpawnedAgent> {
  return async (p) => {
    const agent = agents.get(p.id)
    if (!agent) throw new Error(`no agent for ${p.id}`)
    return {
      agent,
      status: 'idle',
      role: p.role as SpawnedAgent['role'],
      tags: [],
      spawnedAt: Date.now(),
    }
  }
}

describe('TeamRuntime — SupervisionPolicy', () => {
  it('trips the circuit and skips the agent after maxFailuresBeforeCircuitBreak failures', async () => {
    const def = buildTeam('team-trip', ['flaky'])
    const { agent, invoke } = createAgent('flaky', true)
    const runtime = new TeamRuntime({
      definition: def,
      resolveParticipant: makeResolver(new Map([['flaky', agent]])),
      supervisionPolicy: {
        maxFailuresBeforeCircuitBreak: 2,
        resetAfterMs: 60_000,
      },
    })

    // First two runs: agent fails, breaker increments.
    await runtime.execute('task 1')
    await runtime.execute('task 2')
    expect(invoke).toHaveBeenCalledTimes(2)

    // Third run: breaker is open, the participant is skipped entirely so
    // there are no agentResults and the model is not invoked again.
    const third = await runtime.execute('task 3')
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(third.agentResults).toHaveLength(0)
  })

  it('invokes onCircuitOpen exactly once on the first trip', async () => {
    const def = buildTeam('team-cb', ['flaky'])
    const { agent } = createAgent('flaky', true)
    const onCircuitOpen = vi.fn()
    const runtime = new TeamRuntime({
      definition: def,
      resolveParticipant: makeResolver(new Map([['flaky', agent]])),
      supervisionPolicy: {
        maxFailuresBeforeCircuitBreak: 1,
        resetAfterMs: 60_000,
        onCircuitOpen,
      },
    })

    await runtime.execute('task 1')
    expect(onCircuitOpen).toHaveBeenCalledTimes(1)
    expect(onCircuitOpen).toHaveBeenCalledWith('flaky')

    // A second run with the breaker already open must not re-fire the callback.
    await runtime.execute('task 2')
    expect(onCircuitOpen).toHaveBeenCalledTimes(1)
  })

  it('resets the breaker after resetAfterMs has elapsed', async () => {
    const def = buildTeam('team-reset', ['flaky'])
    // First model fails to open the breaker; we then swap the agent for a
    // healthy one to confirm the participant runs again after reset.
    const { agent: flaky } = createAgent('flaky', true)
    const { agent: healthy } = createAgent('flaky', false)
    let useHealthy = false
    const runtime = new TeamRuntime({
      definition: def,
      resolveParticipant: async (p) => ({
        agent: useHealthy ? healthy : flaky,
        status: 'idle',
        role: p.role as SpawnedAgent['role'],
        tags: [],
        spawnedAt: Date.now(),
      }),
      supervisionPolicy: {
        maxFailuresBeforeCircuitBreak: 1,
        resetAfterMs: 10,
      },
    })

    await runtime.execute('task 1') // trips breaker
    // While breaker is open, agent is skipped.
    const skipped = await runtime.execute('task 2')
    expect(skipped.agentResults).toHaveLength(0)

    // Wait past resetAfterMs, then swap to the healthy agent and re-run.
    await new Promise((r) => setTimeout(r, 25))
    useHealthy = true
    const recovered = await runtime.execute('task 3')
    expect(recovered.agentResults).toHaveLength(1)
    expect(recovered.agentResults[0]!.success).toBe(true)
  })
})
