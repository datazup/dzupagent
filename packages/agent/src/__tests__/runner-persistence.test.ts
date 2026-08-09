import { describe, expect, it } from 'vitest'
import {
  AGENT_RUN_EVENT_SCHEMA,
  AGENT_RUN_STATE_SCHEMA,
  type AgentRunEventEnvelope,
  type AgentRunStateV2,
} from '@dzupagent/agent-types/run'

import {
  AGENT_RUNNER_PERSISTENCE_PORT_VERSION,
  InMemoryAgentEventJournal,
  InMemoryAgentRunner,
  InMemoryAgentRunnerPersistence,
  InMemoryAgentRunStore,
  type AgentRunnerModelPort,
  type AgentRunnerPersistence,
  type AgentRunnerPersistenceCommitResult,
  type AgentRunnerSessionAbortResult,
  type AgentRunnerSessionBeginResult,
  type AgentRunnerSessionCommitResult,
} from '../runner.js'

const now = '2026-08-09T12:00:00.000Z'

function createState(revision = 0): AgentRunStateV2 {
  return {
    schema: AGENT_RUN_STATE_SCHEMA,
    runId: 'run-cas',
    revision,
    status: revision === 0 ? 'created' : 'running',
    agent: {
      initialAgentId: 'agent-1',
      currentAgentId: 'agent-1',
      behaviorDigest: 'sha256:behavior',
    },
    attempt: { number: 1, startedAt: now },
    input: [],
    committedItems: [],
    nextEventSeq: revision,
    invocations: [],
    interactions: [],
    interactionDecisions: [],
    handoffs: [],
    usage: { records: [] },
    budget: {
      policyRef: 'test',
      policyRevision: '1',
      status: 'within-limit',
      limits: {},
      consumed: {},
    },
    context: { state: 'absent' },
    createdAt: now,
    updatedAt: now,
  }
}

function createEvent(eventId: string, sequence: number): AgentRunEventEnvelope {
  return {
    schema: AGENT_RUN_EVENT_SCHEMA,
    runId: 'run-cas',
    eventId,
    sequence,
    stateRevision: sequence + 1,
    attempt: 1,
    occurredAt: now,
    type: 'run.started',
    payload: { sequence },
  }
}

const structuralPersistence = {
  async createRun(state: AgentRunStateV2) {
    return { status: 'created' as const, state }
  },
  async loadRun() {
    return undefined
  },
  async readEvents() {
    return []
  },
  async beginSessionTransaction(): Promise<AgentRunnerSessionBeginResult> {
    return { status: 'rejected', code: 'session-not-found' }
  },
  async loadSessionTransaction() {
    return undefined
  },
  async commitSessionTransaction(): Promise<AgentRunnerSessionCommitResult> {
    return { status: 'rejected', code: 'transaction-not-found' }
  },
  async abortSessionTransaction(): Promise<AgentRunnerSessionAbortResult> {
    return { status: 'rejected', code: 'transaction-not-found' }
  },
  async commitTransition(transition): Promise<AgentRunnerPersistenceCommitResult> {
    return { status: 'run-not-found', runId: transition.runId }
  },
} satisfies AgentRunnerPersistence

const structuralModel = {
  adapterId: 'structural-fixture',
  async invoke() {
    return {
      item: {
        type: 'message' as const,
        itemId: 'structural-result',
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'ok' }],
      },
    }
  },
} satisfies AgentRunnerModelPort

describe('in-memory AgentRunner persistence', () => {
  it('publishes the versioned structural persistence port without requiring the in-memory class', async () => {
    expect(AGENT_RUNNER_PERSISTENCE_PORT_VERSION).toBe('0.1.0')
    expect(
      new InMemoryAgentRunner({
        model: structuralModel,
        persistence: structuralPersistence,
      }),
    ).toBeInstanceOf(InMemoryAgentRunner)
    await expect(structuralPersistence.beginSessionTransaction()).resolves.toEqual({
      status: 'rejected',
      code: 'session-not-found',
    })
    await expect(structuralPersistence.commitSessionTransaction()).resolves.toEqual({
      status: 'rejected',
      code: 'transaction-not-found',
    })
    await expect(structuralPersistence.abortSessionTransaction()).resolves.toEqual({
      status: 'rejected',
      code: 'transaction-not-found',
    })
  })

  it('atomically commits one successor state with its corresponding event', async () => {
    const persistence = new InMemoryAgentRunnerPersistence()
    expect(await persistence.createRun(createState())).toMatchObject({ status: 'created' })

    expect(
      await persistence.commitTransition({
        runId: 'run-cas',
        expectedRevision: 0,
        nextState: createState(1),
        event: createEvent('event-0', 0),
      }),
    ).toMatchObject({ status: 'committed', state: { revision: 1 }, event: { sequence: 0 } })
    expect((await persistence.loadRun('run-cas'))?.revision).toBe(1)
    expect(await persistence.readEvents('run-cas')).toHaveLength(1)
  })

  it.each(['state', 'journal'] as const)(
    'does not expose a successor revision after an injected %s failure',
    async (phase) => {
      const persistence = new InMemoryAgentRunnerPersistence({ failCommit: () => phase })
      expect(await persistence.createRun(createState())).toMatchObject({ status: 'created' })

      expect(
        await persistence.commitTransition({
          runId: 'run-cas',
          expectedRevision: 0,
          nextState: createState(1),
          event: createEvent('event-0', 0),
        }),
      ).toEqual({ status: 'injected-failure', phase })
      expect((await persistence.loadRun('run-cas'))?.revision).toBe(0)
      expect(await persistence.readEvents('run-cas')).toEqual([])
    },
  )

  it('advances state with compare-and-swap and rejects a stale writer deterministically', async () => {
    const store = new InMemoryAgentRunStore()
    expect(await store.create(createState())).toMatchObject({ status: 'created' })

    const advanced = await store.compareAndSwap('run-cas', 0, createState(1))
    expect(advanced).toMatchObject({ status: 'updated', state: { revision: 1 } })

    const stale = await store.compareAndSwap('run-cas', 0, createState(1))
    expect(stale).toEqual({
      status: 'revision-conflict',
      runId: 'run-cas',
      expectedRevision: 0,
      actualRevision: 1,
    })
    expect((await store.load('run-cas'))?.revision).toBe(1)

    expect(await store.compareAndSwap('run-cas', 1, createState(3))).toEqual({
      status: 'invalid-transition',
      runId: 'run-cas',
      reason: 'revision-not-successor',
    })
  })

  it('keeps journal order and rejects duplicate IDs and sequence collisions', async () => {
    const journal = new InMemoryAgentEventJournal()
    expect(await journal.append(createEvent('event-0', 0))).toMatchObject({ status: 'appended' })

    expect(await journal.append(createEvent('event-0', 0))).toEqual({
      status: 'event-id-conflict',
      eventId: 'event-0',
      existingRunId: 'run-cas',
      existingSequence: 0,
    })
    expect(await journal.append(createEvent('event-collision', 0))).toEqual({
      status: 'sequence-conflict',
      runId: 'run-cas',
      attemptedSequence: 0,
      expectedSequence: 1,
    })
    expect(await journal.append(createEvent('event-1', 1))).toMatchObject({ status: 'appended' })

    expect((await journal.read('run-cas')).map((event) => event.eventId)).toEqual([
      'event-0',
      'event-1',
    ])
  })
})
