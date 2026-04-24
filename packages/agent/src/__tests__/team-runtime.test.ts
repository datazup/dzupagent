/**
 * Comprehensive tests for TeamRuntime.
 *
 * Covers all five coordination patterns (supervisor, contract_net, blackboard,
 * peer_to_peer, council), phase-transition event emission, checkpoint resume,
 * error recovery, and the team/policy accessor properties.
 *
 * All tests use mocked DzupAgent instances — no real LLM calls are made.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import { DzupAgent } from '../agent/dzip-agent.js'
import { TeamRuntime } from '../orchestration/team/team-runtime.js'
import type { TeamRuntimeEvent, TeamRuntimeEventEmitter } from '../orchestration/team/team-runtime.js'
import type { TeamDefinition, ParticipantDefinition } from '../orchestration/team/team-definition.js'
import type { TeamPolicies } from '../orchestration/team/team-policy.js'
import type { TeamCheckpoint, ResumeContract } from '../orchestration/team/team-checkpoint.js'
import type { SpawnedAgent } from '../playground/types.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockModel(
  responses: Array<{ content: string }>,
  shouldThrow = false,
): BaseChatModel {
  let callIndex = 0
  const invoke = vi.fn(async (_messages: BaseMessage[]) => {
    if (shouldThrow) throw new Error(`mock-throw-${callIndex}`)
    const resp = responses[callIndex] ?? responses[responses.length - 1]!
    callIndex++
    return new AIMessage({ content: resp.content, response_metadata: {} })
  })
  return {
    invoke,
    bindTools: vi.fn(function (this: BaseChatModel) { return this }),
    _modelType: () => 'base_chat_model',
    _llmType: () => 'mock',
  } as unknown as BaseChatModel
}

function createAgent(id: string, responses: Array<{ content: string }>, shouldThrow = false): DzupAgent {
  return new DzupAgent({
    id,
    name: id,
    description: `${id} agent`,
    instructions: `You are ${id}.`,
    model: createMockModel(responses, shouldThrow),
  })
}

function buildDefinition(
  id: string,
  pattern: TeamDefinition['coordinatorPattern'],
  participantDefs?: Partial<ParticipantDefinition>[],
): TeamDefinition {
  const defaults: Partial<ParticipantDefinition>[] = participantDefs ?? [
    { id: 'p1', role: 'supervisor' },
    { id: 'p2', role: 'specialist' },
  ]
  return {
    id,
    name: `Team ${id}`,
    coordinatorPattern: pattern,
    participants: defaults.map((d, i) => ({
      id: d.id ?? `p${i + 1}`,
      role: d.role ?? 'specialist',
      model: d.model ?? 'mock-model',
      capabilities: d.capabilities,
      systemPrompt: d.systemPrompt,
    })),
  }
}

type AgentMap = Map<string, DzupAgent>

function makeResolver(agentsById: AgentMap) {
  return async (p: ParticipantDefinition): Promise<SpawnedAgent> => {
    const agent = agentsById.get(p.id)
    if (!agent) throw new Error(`No agent for participant '${p.id}'`)
    return {
      agent,
      status: 'idle',
      role: p.role as SpawnedAgent['role'],
      tags: [],
      spawnedAt: Date.now(),
    }
  }
}

function collectEvents(runtime: TeamRuntime): { events: TeamRuntimeEvent[] } {
  const events: TeamRuntimeEvent[] = []
  // We need to wrap and re-create the runtime with the collector attached,
  // so this helper is used in conjunction with createRuntime.
  return { events }
}

function createRuntime(
  definition: TeamDefinition,
  agentsById: AgentMap,
  options?: {
    policies?: TeamPolicies
    onEvent?: TeamRuntimeEventEmitter
    generateRunId?: () => string
  },
): TeamRuntime {
  return new TeamRuntime({
    definition,
    resolveParticipant: makeResolver(agentsById),
    policies: options?.policies,
    onEvent: options?.onEvent,
    generateRunId: options?.generateRunId,
  })
}

// ===========================================================================
// Accessor properties
// ===========================================================================

describe('TeamRuntime — accessor properties', () => {
  it('.team returns the supplied TeamDefinition', () => {
    const def = buildDefinition('acc-team', 'peer_to_peer')
    const runtime = new TeamRuntime({ definition: def })
    expect(runtime.team).toBe(def)
  })

  it('.policy returns empty object when no policies are supplied', () => {
    const def = buildDefinition('acc-policy-none', 'peer_to_peer')
    const runtime = new TeamRuntime({ definition: def })
    expect(runtime.policy).toEqual({})
  })

  it('.policy returns the supplied TeamPolicies object', () => {
    const def = buildDefinition('acc-policy', 'peer_to_peer')
    const policies: TeamPolicies = { execution: { maxParallelParticipants: 3 } }
    const runtime = new TeamRuntime({ definition: def, policies })
    expect(runtime.policy).toBe(policies)
  })
})

// ===========================================================================
// Phase events
// ===========================================================================

describe('TeamRuntime — phase transition events', () => {
  it('emits phase_changed events for planning, executing, evaluating, completing', async () => {
    const def = buildDefinition('phase-test', 'peer_to_peer', [{ id: 'a', role: 'worker' }])
    const events: TeamRuntimeEvent[] = []
    const runtime = createRuntime(
      def,
      new Map([['a', createAgent('a', [{ content: 'ok' }])]]),
      { onEvent: (e) => events.push(e) },
    )

    await runtime.execute('do work')

    const phaseEvents = events.filter((e) => e.type === 'phase_changed')
    const phases = phaseEvents.map((e) => (e as Extract<TeamRuntimeEvent, { type: 'phase_changed' }>).to)
    expect(phases).toContain('planning')
    expect(phases).toContain('executing')
    expect(phases).toContain('evaluating')
    expect(phases).toContain('completing')
  })

  it('emits team_completed event on successful run', async () => {
    const def = buildDefinition('completed-test', 'peer_to_peer', [{ id: 'a', role: 'worker' }])
    const events: TeamRuntimeEvent[] = []
    const runtime = createRuntime(
      def,
      new Map([['a', createAgent('a', [{ content: 'done' }])]]),
      { onEvent: (e) => events.push(e) },
    )

    await runtime.execute('task')

    const completed = events.find((e) => e.type === 'team_completed')
    expect(completed).toBeDefined()
    expect((completed as Extract<TeamRuntimeEvent, { type: 'team_completed' }>).teamId).toBe('completed-test')
  })

  it('emits team_failed event when execution throws', async () => {
    const def = buildDefinition('fail-event-test', 'peer_to_peer', [])
    const events: TeamRuntimeEvent[] = []
    const runtime = createRuntime(def, new Map(), { onEvent: (e) => events.push(e) })

    await expect(runtime.execute('task')).rejects.toThrow()

    const failed = events.find((e) => e.type === 'team_failed')
    expect(failed).toBeDefined()
    expect((failed as Extract<TeamRuntimeEvent, { type: 'team_failed' }>).teamId).toBe('fail-event-test')
  })

  it('emits failed phase_changed on execution error', async () => {
    const def = buildDefinition('failed-phase', 'peer_to_peer', [])
    const events: TeamRuntimeEvent[] = []
    const runtime = createRuntime(def, new Map(), { onEvent: (e) => events.push(e) })

    await expect(runtime.execute('task')).rejects.toThrow()

    const phaseEvents = events.filter((e) => e.type === 'phase_changed')
    const phases = phaseEvents.map((e) => (e as Extract<TeamRuntimeEvent, { type: 'phase_changed' }>).to)
    expect(phases).toContain('failed')
  })

  it('phase_changed event carries correct teamId and runId', async () => {
    const def = buildDefinition('phase-ids', 'peer_to_peer', [{ id: 'x', role: 'worker' }])
    const events: TeamRuntimeEvent[] = []
    const runtime = createRuntime(
      def,
      new Map([['x', createAgent('x', [{ content: 'ok' }])]]),
      {
        onEvent: (e) => events.push(e),
        generateRunId: () => 'fixed-run-42',
      },
    )

    await runtime.execute('task')

    const phaseEvent = events.find((e) => e.type === 'phase_changed') as
      | Extract<TeamRuntimeEvent, { type: 'phase_changed' }>
      | undefined
    expect(phaseEvent?.teamId).toBe('phase-ids')
    expect(phaseEvent?.runId).toBe('fixed-run-42')
  })

  it('uses generateRunId to produce stable run IDs', async () => {
    const def = buildDefinition('run-id-test', 'peer_to_peer', [{ id: 'a', role: 'worker' }])
    const events: TeamRuntimeEvent[] = []
    const runtime = createRuntime(
      def,
      new Map([['a', createAgent('a', [{ content: 'ok' }])]]),
      {
        onEvent: (e) => events.push(e),
        generateRunId: () => 'deterministic-id',
      },
    )

    const result = await runtime.execute('task')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)

    const completedEvent = events.find((e) => e.type === 'team_completed') as
      | Extract<TeamRuntimeEvent, { type: 'team_completed' }>
      | undefined
    expect(completedEvent?.runId).toBe('deterministic-id')
  })
})

// ===========================================================================
// Participant events
// ===========================================================================

describe('TeamRuntime — participant events', () => {
  it('emits participant_started for each team member', async () => {
    const def = buildDefinition('participant-start', 'peer_to_peer', [
      { id: 'a', role: 'worker' },
      { id: 'b', role: 'worker' },
    ])
    const events: TeamRuntimeEvent[] = []
    const runtime = createRuntime(
      def,
      new Map([
        ['a', createAgent('a', [{ content: 'r-a' }])],
        ['b', createAgent('b', [{ content: 'r-b' }])],
      ]),
      { onEvent: (e) => events.push(e) },
    )

    await runtime.execute('task')

    const started = events.filter((e) => e.type === 'participant_started')
    const ids = started.map((e) => (e as Extract<TeamRuntimeEvent, { type: 'participant_started' }>).participantId)
    expect(ids).toContain('a')
    expect(ids).toContain('b')
  })

  it('emits participant_completed with success=true on successful agents', async () => {
    const def = buildDefinition('participant-complete', 'peer_to_peer', [
      { id: 'a', role: 'worker' },
    ])
    const events: TeamRuntimeEvent[] = []
    const runtime = createRuntime(
      def,
      new Map([['a', createAgent('a', [{ content: 'done' }])]]),
      { onEvent: (e) => events.push(e) },
    )

    await runtime.execute('task')

    const completed = events.filter((e) => e.type === 'participant_completed') as
      Array<Extract<TeamRuntimeEvent, { type: 'participant_completed' }>>
    expect(completed.every((e) => e.success)).toBe(true)
  })

  it('emits participant_completed with success=false when agent throws (peer_to_peer)', async () => {
    const def = buildDefinition('participant-fail', 'peer_to_peer', [
      { id: 'good', role: 'worker' },
      { id: 'bad', role: 'worker' },
    ])
    const events: TeamRuntimeEvent[] = []
    const runtime = createRuntime(
      def,
      new Map([
        ['good', createAgent('good', [{ content: 'ok' }])],
        ['bad', createAgent('bad', [{ content: 'x' }], true)],
      ]),
      { onEvent: (e) => events.push(e) },
    )

    await runtime.execute('task')

    const completed = events.filter((e) => e.type === 'participant_completed') as
      Array<Extract<TeamRuntimeEvent, { type: 'participant_completed' }>>
    const badCompleted = completed.find((e) => e.participantId === 'bad')
    expect(badCompleted?.success).toBe(false)
    expect(badCompleted?.error).toBeDefined()
  })
})

// ===========================================================================
// peer_to_peer pattern
// ===========================================================================

describe('TeamRuntime — peer_to_peer pattern', () => {
  it('runs all participants and merges results via concatMerge', async () => {
    const def = buildDefinition('p2p-basic', 'peer_to_peer', [
      { id: 'a', role: 'worker' },
      { id: 'b', role: 'worker' },
    ])
    const runtime = createRuntime(
      def,
      new Map([
        ['a', createAgent('a', [{ content: 'result-a' }])],
        ['b', createAgent('b', [{ content: 'result-b' }])],
      ]),
    )

    const result = await runtime.execute('do work')

    expect(result.pattern).toBe('peer-to-peer')
    expect(result.content).toContain('result-a')
    expect(result.content).toContain('result-b')
    expect(result.agentResults).toHaveLength(2)
  })

  it('partial failure: one agent fails, rest succeed, result still returned', async () => {
    const def = buildDefinition('p2p-partial-fail', 'peer_to_peer', [
      { id: 'good', role: 'worker' },
      { id: 'bad', role: 'worker' },
    ])
    const runtime = createRuntime(
      def,
      new Map([
        ['good', createAgent('good', [{ content: 'good-output' }])],
        ['bad', createAgent('bad', [], true)],
      ]),
    )

    const result = await runtime.execute('task')

    expect(result.pattern).toBe('peer-to-peer')
    const goodResult = result.agentResults.find((r) => r.agentId === 'good')
    const badResult = result.agentResults.find((r) => r.agentId === 'bad')
    expect(goodResult?.success).toBe(true)
    expect(goodResult?.content).toBe('good-output')
    expect(badResult?.success).toBe(false)
    expect(badResult?.error).toBeDefined()
  })

  it('throws when team has no participants', async () => {
    const def = buildDefinition('p2p-empty', 'peer_to_peer', [])
    const runtime = new TeamRuntime({ definition: def })

    await expect(runtime.execute('task')).rejects.toThrow('no participants')
  })

  it('single participant returns its result directly', async () => {
    const def = buildDefinition('p2p-single', 'peer_to_peer', [{ id: 'solo', role: 'worker' }])
    const runtime = createRuntime(
      def,
      new Map([['solo', createAgent('solo', [{ content: 'solo-result' }])]]),
    )

    const result = await runtime.execute('task')

    expect(result.content).toContain('solo-result')
    expect(result.agentResults).toHaveLength(1)
  })

  it('all-parallel failure produces empty merged content', async () => {
    const def = buildDefinition('p2p-all-fail', 'peer_to_peer', [
      { id: 'x', role: 'worker' },
      { id: 'y', role: 'worker' },
    ])
    const runtime = createRuntime(
      def,
      new Map([
        ['x', createAgent('x', [], true)],
        ['y', createAgent('y', [], true)],
      ]),
    )

    const result = await runtime.execute('task')

    expect(result.pattern).toBe('peer-to-peer')
    expect(result.content).toBe('')
    expect(result.agentResults.every((r) => !r.success)).toBe(true)
  })

  it('agentResults include correct agentId and role for each participant', async () => {
    const def = buildDefinition('p2p-roles', 'peer_to_peer', [
      { id: 'alpha', role: 'planner' },
      { id: 'beta', role: 'reviewer' },
    ])
    const runtime = createRuntime(
      def,
      new Map([
        ['alpha', createAgent('alpha', [{ content: 'plan' }])],
        ['beta', createAgent('beta', [{ content: 'review' }])],
      ]),
    )

    const result = await runtime.execute('task')

    const alpha = result.agentResults.find((r) => r.agentId === 'alpha')
    const beta = result.agentResults.find((r) => r.agentId === 'beta')
    expect(alpha?.role).toBe('planner')
    expect(beta?.role).toBe('reviewer')
  })

  it('returns durationMs as non-negative number', async () => {
    const def = buildDefinition('p2p-duration', 'peer_to_peer', [{ id: 'a', role: 'worker' }])
    const runtime = createRuntime(
      def,
      new Map([['a', createAgent('a', [{ content: 'ok' }])]]),
    )

    const result = await runtime.execute('task')

    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })
})

// ===========================================================================
// supervisor pattern
// ===========================================================================

describe('TeamRuntime — supervisor pattern', () => {
  it('delegates to AgentOrchestrator.supervisor with manager and specialists', async () => {
    const def = buildDefinition('sup-basic', 'supervisor', [
      { id: 'mgr', role: 'supervisor' },
      { id: 's1', role: 'specialist' },
    ])
    const runtime = createRuntime(
      def,
      new Map([
        ['mgr', createAgent('mgr', [{ content: 'delegated and done' }])],
        ['s1', createAgent('s1', [{ content: 'spec-work' }])],
      ]),
    )

    const result = await runtime.execute('complex task')

    expect(result.pattern).toBe('supervisor')
    expect(result.content).toBe('delegated and done')
  })

  it('picks the first participant as manager when no supervisor role exists', async () => {
    const def = buildDefinition('sup-no-role', 'supervisor', [
      { id: 'first', role: 'worker' },
      { id: 'second', role: 'worker' },
    ])
    const events: TeamRuntimeEvent[] = []
    const runtime = createRuntime(
      def,
      new Map([
        ['first', createAgent('first', [{ content: 'first-result' }])],
        ['second', createAgent('second', [{ content: 'unused' }])],
      ]),
      { onEvent: (e) => events.push(e) },
    )

    const result = await runtime.execute('task')

    expect(result.pattern).toBe('supervisor')
    expect(result.agentResults[0]!.agentId).toBe('first')
  })

  it('throws when team has no participants', async () => {
    const def = buildDefinition('sup-empty', 'supervisor', [])
    const runtime = new TeamRuntime({ definition: def })

    await expect(runtime.execute('task')).rejects.toThrow('no participants')
  })

  it('single participant runs as solo (no specialist delegation)', async () => {
    const def = buildDefinition('sup-solo', 'supervisor', [{ id: 'alone', role: 'supervisor' }])
    const runtime = createRuntime(
      def,
      new Map([['alone', createAgent('alone', [{ content: 'solo-sup-result' }])]]),
    )

    const result = await runtime.execute('task')

    expect(result.pattern).toBe('supervisor')
    expect(result.content).toBe('solo-sup-result')
    expect(result.agentResults).toHaveLength(1)
  })

  it('emits participant events for manager and all specialists', async () => {
    const def = buildDefinition('sup-events', 'supervisor', [
      { id: 'mgr', role: 'supervisor' },
      { id: 's1', role: 'specialist' },
      { id: 's2', role: 'specialist' },
    ])
    const events: TeamRuntimeEvent[] = []
    const runtime = createRuntime(
      def,
      new Map([
        ['mgr', createAgent('mgr', [{ content: 'result' }])],
        ['s1', createAgent('s1', [{ content: 'ok' }])],
        ['s2', createAgent('s2', [{ content: 'ok' }])],
      ]),
      { onEvent: (e) => events.push(e) },
    )

    await runtime.execute('task')

    const started = events.filter((e) => e.type === 'participant_started')
    const startedIds = started.map((e) => (e as Extract<TeamRuntimeEvent, { type: 'participant_started' }>).participantId)
    expect(startedIds).toContain('mgr')
    expect(startedIds).toContain('s1')
    expect(startedIds).toContain('s2')
  })

  it('emits participant_completed with success=false when supervisor call throws', async () => {
    // Force the manager's generate to fail at the AgentOrchestrator level
    // by using a throwing model
    const def = buildDefinition('sup-fail', 'supervisor', [
      { id: 'mgr', role: 'supervisor' },
      { id: 's1', role: 'specialist' },
    ])
    const events: TeamRuntimeEvent[] = []
    const runtime = createRuntime(
      def,
      new Map([
        ['mgr', createAgent('mgr', [], true)],
        ['s1', createAgent('s1', [{ content: 'ok' }])],
      ]),
      { onEvent: (e) => events.push(e) },
    )

    await expect(runtime.execute('task')).rejects.toThrow()

    const completed = events.filter((e) => e.type === 'participant_completed') as
      Array<Extract<TeamRuntimeEvent, { type: 'participant_completed' }>>
    expect(completed.some((e) => !e.success)).toBe(true)
  })
})

// ===========================================================================
// council pattern
// ===========================================================================

describe('TeamRuntime — council pattern', () => {
  it('runs debate with proposers and judge, returns judge verdict', async () => {
    const def = buildDefinition('council-basic', 'council', [
      { id: 'judge', role: 'judge', model: 'claude-opus-4-7' },
      { id: 'prop1', role: 'proposer' },
      { id: 'prop2', role: 'proposer' },
    ])
    const runtime = createRuntime(
      def,
      new Map([
        ['judge', createAgent('judge', [{ content: 'council-verdict' }])],
        ['prop1', createAgent('prop1', [{ content: 'proposal-A' }])],
        ['prop2', createAgent('prop2', [{ content: 'proposal-B' }])],
      ]),
      {
        policies: {
          governance: { judgeModel: 'claude-opus-4-7' },
        },
      },
    )

    const result = await runtime.execute('council task')

    expect(result.pattern).toBe('supervisor')
    expect(result.content).toBe('council-verdict')
  })

  it('throws when team has no participants', async () => {
    const def = buildDefinition('council-empty', 'council', [])
    const runtime = new TeamRuntime({ definition: def })

    await expect(runtime.execute('task')).rejects.toThrow('no participants')
  })

  it('single participant falls back to solo run', async () => {
    const def = buildDefinition('council-solo', 'council', [{ id: 'solo', role: 'judge' }])
    const runtime = createRuntime(
      def,
      new Map([['solo', createAgent('solo', [{ content: 'solo-verdict' }])]]),
    )

    const result = await runtime.execute('task')

    expect(result.content).toBe('solo-verdict')
    expect(result.agentResults).toHaveLength(1)
  })

  it('falls back to DEFAULT_GOVERNANCE_MODEL when no governance policy is set', async () => {
    // Without a governance policy, the runtime uses DEFAULT_GOVERNANCE_MODEL.
    // None of our participants match it, so the first participant is the judge.
    const def = buildDefinition('council-default-model', 'council', [
      { id: 'fallback-judge', role: 'judge' },
      { id: 'p1', role: 'proposer' },
    ])
    const runtime = createRuntime(
      def,
      new Map([
        ['fallback-judge', createAgent('fallback-judge', [{ content: 'default-verdict' }])],
        ['p1', createAgent('p1', [{ content: 'proposal' }])],
      ]),
    )

    const result = await runtime.execute('task')

    expect(result.content).toBe('default-verdict')
  })

  it('emits participant events for all council members', async () => {
    const def = buildDefinition('council-events', 'council', [
      { id: 'judge', role: 'judge', model: 'claude-opus-4-7' },
      { id: 'prop1', role: 'proposer' },
    ])
    const events: TeamRuntimeEvent[] = []
    const runtime = createRuntime(
      def,
      new Map([
        ['judge', createAgent('judge', [{ content: 'verdict' }])],
        ['prop1', createAgent('prop1', [{ content: 'proposal' }])],
      ]),
      {
        onEvent: (e) => events.push(e),
        policies: { governance: { judgeModel: 'claude-opus-4-7' } },
      },
    )

    await runtime.execute('task')

    const started = events.filter((e) => e.type === 'participant_started')
    const startedIds = started.map((e) => (e as Extract<TeamRuntimeEvent, { type: 'participant_started' }>).participantId)
    expect(startedIds).toContain('judge')
    expect(startedIds).toContain('prop1')
  })

  it('throws and emits team_failed when debate throws', async () => {
    const def = buildDefinition('council-fail', 'council', [
      { id: 'judge', role: 'judge', model: 'claude-opus-4-7' },
      { id: 'prop1', role: 'proposer' },
    ])
    const events: TeamRuntimeEvent[] = []
    const runtime = createRuntime(
      def,
      new Map([
        // proposer throws so Promise.all inside debate rejects
        ['judge', createAgent('judge', [{ content: 'verdict' }])],
        ['prop1', createAgent('prop1', [], true)],
      ]),
      {
        onEvent: (e) => events.push(e),
        policies: { governance: { judgeModel: 'claude-opus-4-7' } },
      },
    )

    await expect(runtime.execute('task')).rejects.toThrow()

    const failed = events.find((e) => e.type === 'team_failed')
    expect(failed).toBeDefined()
  })
})

// ===========================================================================
// blackboard pattern
// ===========================================================================

describe('TeamRuntime — blackboard pattern', () => {
  it('runs multiple rounds and returns workspace context as content', async () => {
    const def = buildDefinition('bb-basic', 'blackboard', [
      { id: 'a', role: 'contributor' },
      { id: 'b', role: 'contributor' },
    ])
    const runtime = createRuntime(
      def,
      new Map([
        ['a', createAgent('a', [
          { content: 'a-round1' },
          { content: 'a-round2' },
          { content: 'a-round3' },
        ])],
        ['b', createAgent('b', [
          { content: 'b-round1' },
          { content: 'b-round2' },
          { content: 'b-round3' },
        ])],
      ]),
    )

    const result = await runtime.execute('research task')

    expect(result.pattern).toBe('blackboard')
    // The content is the workspace formatAsContext() output
    expect(typeof result.content).toBe('string')
    expect(result.agentResults).toHaveLength(2)
  })

  it('throws when team has no participants', async () => {
    const def = buildDefinition('bb-empty', 'blackboard', [])
    const runtime = new TeamRuntime({ definition: def })

    await expect(runtime.execute('task')).rejects.toThrow('no participants')
  })

  it('records success=false in agentResults when a participant throws', async () => {
    const def = buildDefinition('bb-partial-fail', 'blackboard', [
      { id: 'ok', role: 'contributor' },
      { id: 'fail', role: 'contributor' },
    ])
    const runtime = createRuntime(
      def,
      new Map([
        ['ok', createAgent('ok', [
          { content: 'ok-1' }, { content: 'ok-2' }, { content: 'ok-3' },
        ])],
        ['fail', createAgent('fail', [], true)],
      ]),
    )

    const result = await runtime.execute('task')

    const failResult = result.agentResults.find((r) => r.agentId === 'fail')
    expect(failResult?.success).toBe(false)
    expect(failResult?.error).toBeDefined()
  })

  it('emits participant_started for all blackboard participants', async () => {
    const def = buildDefinition('bb-events', 'blackboard', [
      { id: 'c1', role: 'contributor' },
      { id: 'c2', role: 'contributor' },
    ])
    const events: TeamRuntimeEvent[] = []
    const runtime = createRuntime(
      def,
      new Map([
        ['c1', createAgent('c1', [
          { content: 'r1' }, { content: 'r2' }, { content: 'r3' },
        ])],
        ['c2', createAgent('c2', [
          { content: 's1' }, { content: 's2' }, { content: 's3' },
        ])],
      ]),
      { onEvent: (e) => events.push(e) },
    )

    await runtime.execute('task')

    const started = events.filter((e) => e.type === 'participant_started')
    const startedIds = started.map((e) => (e as Extract<TeamRuntimeEvent, { type: 'participant_started' }>).participantId)
    expect(startedIds).toContain('c1')
    expect(startedIds).toContain('c2')
  })

  it('agentResults.content contains the last round result for each agent', async () => {
    const def = buildDefinition('bb-last-round', 'blackboard', [
      { id: 'only', role: 'contributor' },
    ])
    const runtime = createRuntime(
      def,
      new Map([
        ['only', createAgent('only', [
          { content: 'round-1-output' },
          { content: 'round-2-output' },
          { content: 'round-3-output' },
        ])],
      ]),
    )

    const result = await runtime.execute('task')

    const agentResult = result.agentResults.find((r) => r.agentId === 'only')
    expect(agentResult?.content).toBe('round-3-output')
  })
})

// ===========================================================================
// contract_net pattern
// ===========================================================================

describe('TeamRuntime — contract_net pattern', () => {
  it('throws when team has no participants', async () => {
    const def = buildDefinition('cn-empty', 'contract_net', [])
    const runtime = new TeamRuntime({ definition: def })

    await expect(runtime.execute('task')).rejects.toThrow('no participants')
  })

  it('runs with single participant as solo fallback', async () => {
    const def = buildDefinition('cn-solo', 'contract_net', [
      { id: 'mgr', role: 'supervisor' },
    ])
    const runtime = createRuntime(
      def,
      new Map([['mgr', createAgent('mgr', [{ content: 'solo-cn-result' }])]]),
    )

    const result = await runtime.execute('task')

    expect(result.content).toBe('solo-cn-result')
    expect(result.agentResults).toHaveLength(1)
  })

  it('emits participant_started for all contract_net participants', async () => {
    // The contract net manager calls specialists; we provide mock models that
    // return valid-ish bid JSON so the protocol can proceed.
    const def = buildDefinition('cn-events', 'contract_net', [
      { id: 'mgr', role: 'supervisor' },
      { id: 's1', role: 'specialist' },
    ])
    const bidJson = JSON.stringify({
      estimatedCostCents: 10,
      estimatedDurationMs: 100,
      qualityEstimate: 0.9,
      confidence: 0.8,
      approach: 'direct',
    })
    const events: TeamRuntimeEvent[] = []
    const runtime = createRuntime(
      def,
      new Map([
        // mgr returns a bid-like response (manager announces CFP, s1 bids)
        ['mgr', createAgent('mgr', [{ content: 'cfp-announced' }, { content: 'awarded' }])],
        ['s1', createAgent('s1', [{ content: bidJson }, { content: 'execution-result' }])],
      ]),
      { onEvent: (e) => events.push(e) },
    )

    try {
      await runtime.execute('task')
    } catch {
      // contract_net may throw if bid parsing fails; we only check events
    }

    const started = events.filter((e) => e.type === 'participant_started')
    const startedIds = started.map((e) => (e as Extract<TeamRuntimeEvent, { type: 'participant_started' }>).participantId)
    expect(startedIds).toContain('mgr')
    expect(startedIds).toContain('s1')
  })
})

// ===========================================================================
// unknown pattern (exhaustiveness guard)
// ===========================================================================

describe('TeamRuntime — unknown coordinator pattern', () => {
  it('throws an error for an unknown coordinator pattern', async () => {
    const def = {
      id: 'unknown-pattern',
      name: 'Bad',
      coordinatorPattern: 'unknown_pattern' as TeamDefinition['coordinatorPattern'],
      participants: [{ id: 'p1', role: 'worker', model: 'mock' }],
    }
    const runtime = createRuntime(
      def as TeamDefinition,
      new Map([['p1', createAgent('p1', [{ content: 'ok' }])]]),
    )

    await expect(runtime.execute('task')).rejects.toThrow("unknown coordinator pattern 'unknown_pattern'")
  })
})

// ===========================================================================
// Checkpoint resume
// ===========================================================================

describe('TeamRuntime — resume()', () => {
  it('throws when checkpoint teamId does not match definition id', async () => {
    const def = buildDefinition('team-A', 'peer_to_peer', [{ id: 'p1', role: 'worker' }])
    const runtime = createRuntime(
      def,
      new Map([['p1', createAgent('p1', [{ content: 'ok' }])]]),
    )

    const checkpoint: TeamCheckpoint = {
      teamId: 'team-B',
      runId: 'run-1',
      phase: 'executing',
      completedParticipantIds: [],
      pendingParticipantIds: ['p1'],
      sharedContext: {},
      checkpointedAt: new Date(),
    }
    const contract: ResumeContract = {
      checkpointId: 'ck-1',
      resumeFromPhase: 'executing',
      skipCompletedParticipants: true,
    }

    await expect(runtime.resume(checkpoint, contract, 'task')).rejects.toThrow(
      "checkpoint belongs to team 'team-B', not 'team-A'",
    )
  })

  it('returns empty result when all participants are already completed', async () => {
    const def = buildDefinition('team-all-done', 'peer_to_peer', [
      { id: 'p1', role: 'worker' },
    ])
    const runtime = createRuntime(
      def,
      new Map([['p1', createAgent('p1', [{ content: 'ok' }])]]),
    )

    const checkpoint: TeamCheckpoint = {
      teamId: 'team-all-done',
      runId: 'run-1',
      phase: 'completing',
      completedParticipantIds: ['p1'],
      pendingParticipantIds: [],
      sharedContext: {},
      checkpointedAt: new Date(),
    }
    const contract: ResumeContract = {
      checkpointId: 'ck-1',
      resumeFromPhase: 'completing',
      skipCompletedParticipants: true,
    }

    const result = await runtime.resume(checkpoint, contract, 'task')

    expect(result.content).toBe('')
    expect(result.agentResults).toHaveLength(0)
    expect(result.durationMs).toBe(0)
  })

  it('skips completed participants when skipCompletedParticipants=true', async () => {
    const def = buildDefinition('team-skip', 'peer_to_peer', [
      { id: 'done', role: 'worker' },
      { id: 'pending', role: 'worker' },
    ])
    const doneModel = createMockModel([{ content: 'done-output' }])
    const pendingModel = createMockModel([{ content: 'pending-output' }])
    const runtime = new TeamRuntime({
      definition: def,
      resolveParticipant: makeResolver(
        new Map([
          ['done', new DzupAgent({ id: 'done', name: 'done', instructions: 'done', model: doneModel })],
          ['pending', new DzupAgent({ id: 'pending', name: 'pending', instructions: 'pending', model: pendingModel })],
        ]),
      ),
    })

    const checkpoint: TeamCheckpoint = {
      teamId: 'team-skip',
      runId: 'run-1',
      phase: 'executing',
      completedParticipantIds: ['done'],
      pendingParticipantIds: ['pending'],
      sharedContext: {},
      checkpointedAt: new Date(),
    }
    const contract: ResumeContract = {
      checkpointId: 'ck-1',
      resumeFromPhase: 'executing',
      skipCompletedParticipants: true,
    }

    const result = await runtime.resume(checkpoint, contract, 'task')

    // 'done' participant was skipped, only 'pending' ran
    expect(doneModel.invoke).not.toHaveBeenCalled()
    expect(pendingModel.invoke).toHaveBeenCalled()
    expect(result.agentResults).toHaveLength(1)
    expect(result.agentResults[0]!.agentId).toBe('pending')
  })

  it('re-runs all participants when skipCompletedParticipants=false', async () => {
    const def = buildDefinition('team-no-skip', 'peer_to_peer', [
      { id: 'p1', role: 'worker' },
      { id: 'p2', role: 'worker' },
    ])
    const m1 = createMockModel([{ content: 'r1' }])
    const m2 = createMockModel([{ content: 'r2' }])
    const runtime = new TeamRuntime({
      definition: def,
      resolveParticipant: makeResolver(
        new Map([
          ['p1', new DzupAgent({ id: 'p1', name: 'p1', instructions: 'p1', model: m1 })],
          ['p2', new DzupAgent({ id: 'p2', name: 'p2', instructions: 'p2', model: m2 })],
        ]),
      ),
    })

    const checkpoint: TeamCheckpoint = {
      teamId: 'team-no-skip',
      runId: 'run-1',
      phase: 'executing',
      completedParticipantIds: ['p1'],
      pendingParticipantIds: ['p2'],
      sharedContext: {},
      checkpointedAt: new Date(),
    }
    const contract: ResumeContract = {
      checkpointId: 'ck-1',
      resumeFromPhase: 'executing',
      skipCompletedParticipants: false,
    }

    const result = await runtime.resume(checkpoint, contract, 'task')

    // Both participants ran (skipCompletedParticipants=false)
    expect(m1.invoke).toHaveBeenCalled()
    expect(m2.invoke).toHaveBeenCalled()
    expect(result.agentResults).toHaveLength(2)
  })

  it('injects sharedContext into the resume task prompt', async () => {
    const def = buildDefinition('team-ctx', 'peer_to_peer', [{ id: 'p1', role: 'worker' }])
    const capturedMessages: BaseMessage[][] = []
    const trackingModel: BaseChatModel = {
      invoke: vi.fn(async (msgs: BaseMessage[]) => {
        capturedMessages.push(msgs)
        return new AIMessage({ content: 'ok', response_metadata: {} })
      }),
      bindTools: vi.fn(function (this: BaseChatModel) { return this }),
      _modelType: () => 'base_chat_model',
      _llmType: () => 'mock',
    } as unknown as BaseChatModel

    const runtime = new TeamRuntime({
      definition: def,
      resolveParticipant: makeResolver(
        new Map([
          ['p1', new DzupAgent({ id: 'p1', name: 'p1', instructions: 'p1', model: trackingModel })],
        ]),
      ),
    })

    const checkpoint: TeamCheckpoint = {
      teamId: 'team-ctx',
      runId: 'run-1',
      phase: 'executing',
      completedParticipantIds: [],
      pendingParticipantIds: ['p1'],
      sharedContext: { previousResult: 'some-context' },
      checkpointedAt: new Date(),
    }
    const contract: ResumeContract = {
      checkpointId: 'ck-1',
      resumeFromPhase: 'executing',
      skipCompletedParticipants: true,
    }

    await runtime.resume(checkpoint, contract, 'original task')

    // The model should have received messages containing the shared context
    const allContent = capturedMessages.flat().map((m) => String(m.content)).join(' ')
    expect(allContent).toContain('previousResult')
    expect(allContent).toContain('some-context')
    expect(allContent).toContain('original task')
  })
})

// ===========================================================================
// spawnParticipant error path
// ===========================================================================

describe('TeamRuntime — spawnParticipant error', () => {
  it('throws when no resolver is supplied', async () => {
    const def = buildDefinition('no-resolver', 'peer_to_peer', [{ id: 'p1', role: 'worker' }])
    const runtime = new TeamRuntime({ definition: def })

    await expect(runtime.execute('task')).rejects.toThrow(
      "no ParticipantResolver supplied; cannot spawn participant 'p1'",
    )
  })

  it('throws when resolver throws for a participant', async () => {
    const def = buildDefinition('resolver-throws', 'peer_to_peer', [{ id: 'bad', role: 'worker' }])
    const runtime = new TeamRuntime({
      definition: def,
      resolveParticipant: async () => {
        throw new Error('resolver-exploded')
      },
    })

    await expect(runtime.execute('task')).rejects.toThrow('resolver-exploded')
  })
})

// ===========================================================================
// DEFAULT_* model constant exports
// ===========================================================================

describe('TeamRuntime — exported model constants', () => {
  it('exports DEFAULT_ROUTER_MODEL', async () => {
    const { DEFAULT_ROUTER_MODEL } = await import('../orchestration/team/team-runtime.js')
    expect(typeof DEFAULT_ROUTER_MODEL).toBe('string')
    expect(DEFAULT_ROUTER_MODEL.length).toBeGreaterThan(0)
  })

  it('exports DEFAULT_PARTICIPANT_MODEL', async () => {
    const { DEFAULT_PARTICIPANT_MODEL } = await import('../orchestration/team/team-runtime.js')
    expect(typeof DEFAULT_PARTICIPANT_MODEL).toBe('string')
    expect(DEFAULT_PARTICIPANT_MODEL.length).toBeGreaterThan(0)
  })

  it('exports DEFAULT_GOVERNANCE_MODEL', async () => {
    const { DEFAULT_GOVERNANCE_MODEL } = await import('../orchestration/team/team-runtime.js')
    expect(typeof DEFAULT_GOVERNANCE_MODEL).toBe('string')
    expect(DEFAULT_GOVERNANCE_MODEL.length).toBeGreaterThan(0)
  })
})

// ===========================================================================
// no-op event emitter (default)
// ===========================================================================

describe('TeamRuntime — default (no-op) event emitter', () => {
  it('runs successfully without an onEvent callback (no crash)', async () => {
    const def = buildDefinition('no-emitter', 'peer_to_peer', [{ id: 'a', role: 'worker' }])
    const runtime = new TeamRuntime({
      definition: def,
      resolveParticipant: makeResolver(new Map([['a', createAgent('a', [{ content: 'ok' }])]])),
      // onEvent is intentionally omitted
    })

    const result = await runtime.execute('task')

    expect(result.content).toContain('ok')
  })
})
