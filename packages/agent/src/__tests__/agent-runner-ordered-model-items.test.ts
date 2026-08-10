import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_SCHEMA,
  type AgentInteractionDecisionInput,
  type AgentRunStateV2,
} from '@dzupagent/agent-types/run'
import type {
  AgentRunnerIdentityKind,
  AgentRunnerModelPort,
  AgentRunnerModelRequest,
  AgentRunnerModelResult,
  AgentRunnerReadOnlyToolPort,
  AgentRunnerReadOnlyToolRequest,
  AgentRunnerReadOnlyToolResult,
  AgentRunnerSessionCommitInput,
} from '../runner.js'
import {
  InMemoryAgentRunner,
  InMemoryAgentRunnerPersistence,
  RunControl,
} from '../runner.js'

const now = '2026-08-10T12:00:00.000Z'
const behaviorDigest = 'sha256:ordered-model-items'
const input = {
  agentId: 'researcher',
  behaviorDigest,
  items: [{
    type: 'message' as const,
    itemId: 'input-1',
    role: 'user' as const,
    content: [{ type: 'text' as const, text: 'Read the fixtures in order.' }],
  }],
}

function ids(): (kind: AgentRunnerIdentityKind) => string {
  const counters = new Map<AgentRunnerIdentityKind, number>()
  return (kind) => {
    const next = (counters.get(kind) ?? 0) + 1
    counters.set(kind, next)
    return `${kind}-${next}`
  }
}

function call(itemId: string, callId: string, toolId = 'read-record'): AgentRunnerModelResult['item'] {
  return {
    type: 'tool-call',
    itemId,
    callId,
    toolId,
    arguments: { recordId: callId },
  }
}

function finalResult(itemId = 'final-item'): AgentRunnerModelResult {
  return {
    status: 'completed',
    item: {
      type: 'message',
      itemId,
      role: 'assistant',
      content: [{ type: 'text', text: 'All reads completed.' }],
    },
    finishReason: 'stop',
  }
}

function orderedTurn(toolIds = ['read-record', 'read-record']): AgentRunnerModelResult {
  return {
    status: 'completed',
    item: {
      type: 'message',
      itemId: 'assistant-preface',
      role: 'assistant',
      content: [{ type: 'text', text: 'Reading both records.' }],
    },
    additionalItems: [
      call('call-item-a', 'call-a', toolIds[0]),
      call('call-item-b', 'call-b', toolIds[1]),
    ],
    usage: {
      accountingSource: 'provider-free',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      reasoningTokens: 2,
    },
    finishReason: 'tool-calls',
  }
}

class Model implements AgentRunnerModelPort {
  readonly adapterId = 'ordered-model/v1'
  readonly calls: AgentRunnerModelRequest[] = []
  readonly #results: AgentRunnerModelResult[]

  constructor(results: AgentRunnerModelResult[]) {
    this.#results = [...results]
  }

  async invoke(request: AgentRunnerModelRequest): Promise<AgentRunnerModelResult> {
    this.calls.push(request)
    const result = this.#results.shift()
    if (result === undefined) throw new Error('Model fixture exhausted')
    return result
  }
}

class Tool implements AgentRunnerReadOnlyToolPort {
  readonly toolRevision = '1'
  readonly effectClass = 'read' as const
  readonly calls: AgentRunnerReadOnlyToolRequest[] = []
  readonly approval
  readonly #execute: (
    request: AgentRunnerReadOnlyToolRequest,
  ) => AgentRunnerReadOnlyToolResult | Promise<AgentRunnerReadOnlyToolResult>

  constructor(
    readonly toolId = 'read-record',
    options: {
      readonly approval?: boolean
      readonly execute?: (
        request: AgentRunnerReadOnlyToolRequest,
      ) => AgentRunnerReadOnlyToolResult | Promise<AgentRunnerReadOnlyToolResult>
    } = {},
  ) {
    this.approval = options.approval === true
      ? {
          requestedBy: { principalId: 'runner', principalType: 'agent' as const },
          decisionPolicyRef: 'policy/read',
          decisionPolicyRevision: '1',
        }
      : undefined
    this.#execute = options.execute ?? ((request) => ({
      status: 'completed',
      output: { value: request.callId },
    }))
  }

  async execute(request: AgentRunnerReadOnlyToolRequest): Promise<AgentRunnerReadOnlyToolResult> {
    this.calls.push(request)
    return this.#execute(request)
  }
}

function runner(options: {
  readonly model: AgentRunnerModelPort
  readonly tools?: readonly AgentRunnerReadOnlyToolPort[]
  readonly persistence?: InMemoryAgentRunnerPersistence
  readonly createId?: (kind: AgentRunnerIdentityKind) => string
}) {
  return new InMemoryAgentRunner({
    model: options.model,
    tools: options.tools ?? [],
    persistence: options.persistence ?? new InMemoryAgentRunnerPersistence(),
    createId: options.createId ?? ids(),
    now: () => now,
  })
}

function decisionFor(state: AgentRunStateV2): AgentInteractionDecisionInput {
  const interaction = state.interactions[0]
  if (interaction === undefined) throw new Error('Expected a pending interaction')
  return {
    interactionId: interaction.interactionId,
    generation: interaction.generation,
    requestDigest: interaction.requestDigest,
    stateRevision: state.revision,
    decision: 'approved',
    decisionPolicyRef: interaction.decisionPolicyRef,
    decisionPolicyRevision: interaction.decisionPolicyRevision,
    actor: { principalId: 'operator', principalType: 'user' },
  }
}

describe('AgentRunner ordered same-turn model items', () => {
  it('commits one exact model batch and executes every read in canonical order', async () => {
    const model = new Model([orderedTurn(), finalResult()])
    const tool = new Tool()
    const result = await runner({ model, tools: [tool] }).run(input)

    expect(result.state.status).toBe('completed')
    expect(tool.calls.map((entry) => ({
      callId: entry.callId,
      invocationId: entry.invocationId,
      input: entry.input,
    }))).toEqual([
      { callId: 'call-a', invocationId: 'invocation-1', input: { recordId: 'call-a' } },
      { callId: 'call-b', invocationId: 'invocation-2', input: { recordId: 'call-b' } },
    ])
    expect(result.state.invocations).toMatchObject([
      { callId: 'call-a', invocationId: 'invocation-1', attempt: 1, state: 'completed' },
      { callId: 'call-b', invocationId: 'invocation-2', attempt: 1, state: 'completed' },
    ])
    expect(result.state.usage.records).toEqual([
      expect.objectContaining({
        usageId: 'usage-1',
        accountingSource: 'provider-free',
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        reasoningTokens: 2,
      }),
    ])
    expect(result.state.committedItems.map((item) => item.itemId)).toEqual([
      'assistant-preface',
      'call-item-a',
      'call-item-b',
      'tool-result-item-1',
      'tool-result-item-2',
      'final-item',
    ])
    expect(model.calls[1]?.committedItems.map((item) => item.itemId)).toEqual([
      'assistant-preface',
      'call-item-a',
      'call-item-b',
      'tool-result-item-1',
      'tool-result-item-2',
    ])
    expect(result.events).toContainEqual(expect.objectContaining({
      type: 'model.completed',
      payload: expect.objectContaining({
        itemIds: ['assistant-preface', 'call-item-a', 'call-item-b'],
        callIds: ['call-a', 'call-b'],
        usageId: 'usage-1',
        finishReason: 'tool-calls',
      }),
    }))
    const firstStarted = result.events.findIndex((event) => event.type === 'tool.started')
    const selected = result.events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.type === 'tool.selected')
    expect(selected).toHaveLength(2)
    expect(selected.filter(({ index }) => index < firstStarted)).toHaveLength(2)
  })

  it.each([
    ['duplicate item IDs', {
      ...orderedTurn(),
      additionalItems: [call('assistant-preface', 'call-a')],
    }, 'model-duplicate-item-id'],
    ['duplicate call IDs', {
      ...orderedTurn(),
      additionalItems: [call('call-item-a', 'same'), call('call-item-b', 'same')],
    }, 'model-duplicate-call-id'],
    ['missing call ID', {
      ...orderedTurn(),
      additionalItems: [{ ...call('call-item-a', 'call-a'), callId: '' }],
    }, 'model-invalid-call-id'],
    ['unknown tool', {
      ...orderedTurn(),
      additionalItems: [call('call-item-a', 'call-a', 'write-record')],
    }, 'model-unknown-tool'],
    ['call before assistant content', {
      ...orderedTurn(),
      item: call('call-item-a', 'call-a'),
      additionalItems: [{
        type: 'message' as const,
        itemId: 'assistant-preface',
        role: 'assistant' as const,
        content: [],
      }],
    }, 'model-invalid-turn-order'],
    ['conflicting finish reason', {
      ...orderedTurn(),
      finishReason: 'stop' as const,
    }, 'model-conflicting-finish-reason'],
  ])('rejects %s before any tool dispatch', async (_label, invalid, code) => {
    const model = new Model([invalid])
    const tool = new Tool()
    const result = await runner({ model, tools: [tool] }).run(input)
    expect(result.state.status).toBe('failed')
    expect(tool.calls).toHaveLength(0)
    expect(result.state.committedItems).toHaveLength(0)
    expect(result.events).toContainEqual(expect.objectContaining({
      type: 'model.failed',
      payload: expect.objectContaining({ code, retryClassification: 'non-retryable' }),
    }))
  })

  it('rejects non-JSON arguments before durable model completion or tool dispatch', async () => {
    const invalid = {
      ...orderedTurn(),
      additionalItems: [{ ...call('call-item-a', 'call-a'), arguments: { value: Number.NaN } }],
    }
    const tool = new Tool()
    const result = await runner({ model: new Model([invalid]), tools: [tool] }).run(input)
    expect(result.state.status).toBe('failed')
    expect(tool.calls).toHaveLength(0)
    expect(result.state.committedItems).toEqual([])
    expect(result.events.some((event) => event.type === 'model.completed')).toBe(false)
  })

  it.each(['model.completed', 'second-item'] as const)(
    'dispatches no tool and retains no partial batch when persistence fails at %s',
    async (phase) => {
      let itemEvents = 0
      const persistence = new InMemoryAgentRunnerPersistence({
        failCommit(transition) {
          if (phase === 'model.completed' && transition.event.type === 'model.completed') {
            return 'journal'
          }
          if (transition.event.type === 'item.added' && ++itemEvents === 2) return 'state'
          return undefined
        },
      })
      const tool = new Tool()
      await expect(
        runner({ model: new Model([orderedTurn()]), tools: [tool], persistence }).run(input),
      ).rejects.toMatchObject({
        code: phase === 'model.completed' ? 'atomic-journal-failure' : 'atomic-state-failure',
      })
      expect(tool.calls).toHaveLength(0)
      const state = await persistence.loadRun('run-1')
      if (phase === 'model.completed') {
        expect(state?.committedItems).toEqual([])
        expect(state?.invocations).toEqual([])
        expect(state?.usage.records).toEqual([])
      } else {
        expect(state?.committedItems.map((item) => item.itemId)).toEqual([
          'assistant-preface', 'call-item-a', 'call-item-b',
        ])
        expect(state?.invocations).toHaveLength(2)
        expect(state?.usage.records).toHaveLength(1)
      }
    },
  )

  it('does not replay a completed predecessor when a later read fails', async () => {
    const attempts = new Map<string, number>()
    const tool = new Tool('read-record', {
      execute(request) {
        attempts.set(request.callId, (attempts.get(request.callId) ?? 0) + 1)
        return request.callId === 'call-a'
          ? { status: 'completed', output: { value: 'a' } }
          : { status: 'failed-before-effect', code: 'fixture-missing', retryable: false }
      },
    })
    const result = await runner({ model: new Model([orderedTurn()]), tools: [tool] }).run(input)
    expect(result.state.status).toBe('failed')
    expect([...attempts]).toEqual([['call-a', 1], ['call-b', 1]])
    expect(result.state.invocations).toMatchObject([
      { callId: 'call-a', state: 'completed' },
      { callId: 'call-b', state: 'failed-before-effect' },
    ])
  })

  it('reconstructs after approval and resumes the exact remaining ordered calls', async () => {
    const persistence = new InMemoryAgentRunnerPersistence()
    const createId = ids()
    const order: string[] = []
    const first = new Tool('read-first', {
      execute(request) {
        order.push(request.callId)
        return { status: 'completed', output: { value: request.callId } }
      },
    })
    const approved = new Tool('read-approved', {
      approval: true,
      execute(request) {
        order.push(request.callId)
        return { status: 'completed', output: { value: request.callId } }
      },
    })
    const last = new Tool('read-last', {
      execute(request) {
        order.push(request.callId)
        return { status: 'completed', output: { value: request.callId } }
      },
    })
    const batch: AgentRunnerModelResult = {
      item: call('call-item-a', 'call-a', 'read-first'),
      additionalItems: [
        call('call-item-b', 'call-b', 'read-approved'),
        call('call-item-c', 'call-c', 'read-last'),
      ],
      finishReason: 'tool-calls',
    }
    const suspended = await runner({
      model: new Model([batch]), tools: [first, approved, last], persistence, createId,
    }).run(input)
    expect(suspended.state.status).toBe('suspended')
    expect(order).toEqual(['call-a'])
    expect(JSON.parse(JSON.stringify(suspended.state))).toEqual(suspended.state)
    const invocationIds = suspended.state.invocations.map((entry) => entry.invocationId)

    const resumed = await runner({
      model: new Model([finalResult()]), tools: [first, approved, last], persistence, createId,
    }).resume({
      runId: suspended.state.runId,
      behaviorDigest,
      decision: decisionFor(suspended.state),
    })
    expect(resumed.state.status).toBe('completed')
    expect(order).toEqual(['call-a', 'call-b', 'call-c'])
    expect(resumed.state.invocations.map((entry) => entry.invocationId)).toEqual(invocationIds)
    expect(first.calls).toHaveLength(1)
    expect(approved.calls).toHaveLength(1)
    expect(last.calls).toHaveLength(1)
  })

  it('observes cancellation between calls and prevents the later dispatch', async () => {
    const control = new RunControl()
    let cancellationId = ''
    const tool = new Tool('read-record', {
      execute(request) {
        if (request.callId === 'call-a') {
          const acknowledgement = control.requestCancel()
          if (!acknowledgement.accepted) throw new Error('Expected cancellation admission')
          cancellationId = acknowledgement.requestId
        }
        return { status: 'completed', output: { value: request.callId } }
      },
    })
    const result = await runner({ model: new Model([orderedTurn()]), tools: [tool] }).run(
      input,
      { control },
    )
    expect(result.state.status).toBe('cancelled')
    expect(tool.calls.map((entry) => entry.callId)).toEqual(['call-a'])
    await expect(control.waitForObservation(cancellationId)).resolves.toMatchObject({
      kind: 'cancel', safePoint: 'after-tool-dispatch',
    })
    expect(result.state.invocations).toMatchObject([
      { callId: 'call-a', state: 'completed' },
      { callId: 'call-b', state: 'planned' },
    ])
  })

  it('bounds retry and blocks all remaining calls after an unknown outcome', async () => {
    const callAttempts = new Map<string, number>()
    const tool = new Tool('read-record', {
      execute(request) {
        const attempt = (callAttempts.get(request.callId) ?? 0) + 1
        callAttempts.set(request.callId, attempt)
        if (request.callId === 'call-a' && attempt === 1) {
          return { status: 'failed-before-effect', code: 'not-ready', retryable: true }
        }
        if (request.callId === 'call-b') throw new Error('outcome unknown')
        return { status: 'completed', output: { value: request.callId } }
      },
    })
    const batch = orderedTurn()
    const result = await runner({ model: new Model([{
      ...batch,
      additionalItems: [
        ...(batch.additionalItems ?? []),
        call('call-item-c', 'call-c'),
      ],
    }]), tools: [tool] }).run(input)
    expect(result.state.status).toBe('failed')
    expect([...callAttempts]).toEqual([['call-a', 2], ['call-b', 1]])
    expect(result.state.invocations).toMatchObject([
      { callId: 'call-a', attempt: 2, state: 'completed' },
      { callId: 'call-b', attempt: 1, state: 'effect-unknown' },
      { callId: 'call-c', attempt: 1, state: 'planned' },
    ])
  })

  it('commits the complete ordered session history exactly once', async () => {
    class CountingPersistence extends InMemoryAgentRunnerPersistence {
      commits = 0

      override async commitSessionTransaction(input: AgentRunnerSessionCommitInput) {
        this.commits += 1
        return super.commitSessionTransaction(input)
      }
    }
    const persistence = new CountingPersistence()
    await persistence.createSession({
      schema: AGENT_SESSION_SCHEMA,
      sessionId: 'session-1',
      revision: '0',
      items: [],
    })
    const result = await runner({
      model: new Model([orderedTurn(), finalResult()]),
      tools: [new Tool()],
      persistence,
    }).run({ ...input, sessionId: 'session-1' })
    expect(result.state.status).toBe('completed')
    expect(persistence.commits).toBe(1)
    expect((await persistence.readSession('session-1'))?.items.map((item) => item.itemId)).toEqual([
      'input-1',
      'assistant-preface',
      'call-item-a',
      'call-item-b',
      'tool-result-item-1',
      'tool-result-item-2',
      'final-item',
    ])
  })
})
