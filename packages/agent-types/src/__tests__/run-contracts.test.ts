import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  AGENT_RUN_EVENT_SCHEMA,
  AGENT_SESSION_SCHEMA,
  AGENT_RUN_STATE_SCHEMA,
  AGENT_RUN_STATE_STABILITY,
  type AgentRunEventEnvelope,
  type AgentRunJsonValue,
  type AgentRunStateMigrationResult,
  type AgentRunStateV2,
} from '../run.js'

const now = '2026-08-09T12:00:00.000Z'

const state = {
  schema: AGENT_RUN_STATE_SCHEMA,
  runId: 'run-1',
  revision: 3,
  status: 'suspended',
  agent: {
    initialAgentId: 'researcher',
    currentAgentId: 'reviewer',
    behaviorDigest: 'sha256:behavior',
  },
  attempt: { number: 1, startedAt: now },
  input: [
    {
      type: 'message',
      itemId: 'item-1',
      role: 'user',
      content: [{ type: 'text', text: 'Review this.' }],
    },
  ],
  committedItems: [],
  nextEventSeq: 7,
  invocations: [
    {
      invocationId: 'invocation-1',
      callId: 'call-1',
      attempt: 1,
      inputDigest: 'sha256:input',
      effectKey: 'effect-1',
      toolId: 'write-report',
      toolRevision: 'v3',
      effectClass: 'reversible-write',
      state: 'approval-required',
    },
  ],
  interactions: [
    {
      interactionId: 'interaction-1',
      generation: 1,
      kind: 'tool-approval',
      stateRevision: 3,
      request: { summary: 'Approve report write' },
      requestDigest: 'sha256:request',
      invocationId: 'invocation-1',
      requestedBy: { principalId: 'runner', principalType: 'agent' },
      decisionPolicyRef: 'policy/report-write',
      decisionPolicyRevision: '4',
    },
  ],
  interactionDecisions: [],
  handoffs: [
    {
      handoffId: 'handoff-1',
      invocationId: 'handoff-invocation-1',
      sourceAgentId: 'researcher',
      targetAgentId: 'reviewer',
      state: 'committed',
      inputDigest: 'sha256:handoff',
    },
  ],
  usage: { records: [] },
  budget: {
    policyRef: 'budget/default',
    policyRevision: '2',
    status: 'within-limit',
    limits: { totalTokens: 10_000 },
    consumed: { totalTokens: 450 },
  },
  context: {
    state: 'included',
    schema: 'example.context/v1',
    value: { tenantRef: 'tenant-opaque' },
  },
  sessionBinding: { sessionId: 'session-1', baseRevision: '5' },
  adapterState: {
    model: {
      namespace: 'example.model',
      schema: 'example.model-state/v1',
      value: { continuationRef: 'opaque-ref' },
    },
  },
  createdAt: now,
  updatedAt: now,
} as const satisfies AgentRunStateV2

function migrationStatus(result: AgentRunStateMigrationResult): string {
  switch (result.status) {
    case 'migrated':
      return result.state.runId
    case 'unsupported-newer':
      return result.sourceSchema
    case 'invalid':
      return result.reason
    case 'behavior-mismatch':
      return result.actualBehaviorDigest
    default: {
      const exhaustive: never = result
      return exhaustive
    }
  }
}

describe('draft AgentRunner data contracts', () => {
  it('publishes explicit version and stability markers', () => {
    expect(AGENT_RUN_EVENT_SCHEMA).toBe('dzupagent.run-event/v1')
    expect(AGENT_SESSION_SCHEMA).toBe('dzupagent.agentSession/v1')
    expect(AGENT_RUN_STATE_SCHEMA).toBe('dzupagent.agentRunState/v2')
    expect(AGENT_RUN_STATE_STABILITY).toBe('draft')
  })

  it('round-trips draft run state through JSON without provider objects', () => {
    const roundTripped: unknown = JSON.parse(JSON.stringify(state))

    expect(roundTripped).toEqual(state)
    expectTypeOf(state).toMatchTypeOf<AgentRunStateV2>()
  })

  it('correlates a typed event with run, revision, attempt, and invocation', () => {
    const event = {
      schema: AGENT_RUN_EVENT_SCHEMA,
      runId: state.runId,
      eventId: 'event-7',
      sequence: 7,
      stateRevision: state.revision,
      attempt: 1,
      occurredAt: now,
      type: 'tool.started',
      payload: {
        callId: 'call-1',
        invocationId: 'invocation-1',
        executionAttempt: 1,
      },
    } as const satisfies AgentRunEventEnvelope<'tool.started'>

    expect(JSON.parse(JSON.stringify(event))).toEqual(event)
    expect(event.payload.invocationId).toBe('invocation-1')
  })

  it('keeps migration outcomes exhaustive and fail-closed', () => {
    expect(
      migrationStatus({
        status: 'behavior-mismatch',
        expectedBehaviorDigest: 'sha256:expected',
        actualBehaviorDigest: 'sha256:actual',
      }),
    ).toBe('sha256:actual')
  })

  it('accepts only JSON-safe values at the durable extension boundary', () => {
    const extension: AgentRunJsonValue = {
      namespace: 'example',
      values: [null, true, 1, 'two'],
    }

    expect(JSON.parse(JSON.stringify(extension))).toEqual(extension)
  })

  it('keeps reusable conversation history distinct from run state', () => {
    const session = {
      schema: AGENT_SESSION_SCHEMA,
      sessionId: 'session-1',
      revision: '0',
      items: state.input,
    }

    expect(JSON.parse(JSON.stringify(session))).toEqual(session)
    expect(session.schema).not.toBe(state.schema)
  })
})
