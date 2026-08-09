import { describe, expect, it } from 'vitest'
import type {
  AgentRunnerIdentityKind,
  AgentRunnerModelPort,
  AgentRunnerModelRequest,
  AgentRunnerModelResult,
  AgentRunnerReadOnlyToolPort,
  AgentRunnerReadOnlyToolRequest,
} from '../runner.js'
import type {
  AgentInteractionDecisionInput,
  AgentItem,
  AgentRunStateV2,
} from '@dzupagent/agent-types/run'
import { AGENT_SESSION_SCHEMA } from '@dzupagent/agent-types/run'

import {
  InMemoryAgentRunner,
  InMemoryAgentRunnerPersistence,
  RunControl,
} from '../runner.js'

const now = '2026-08-09T12:00:00.000Z'
const behaviorDigest = 'sha256:transactional-session'

type Deferred<T> = {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolveValue: (value: T) => void = () => undefined
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve
  })
  return { promise, resolve: resolveValue }
}

function message(itemId: string, role: 'user' | 'assistant', text: string): AgentItem {
  return {
    type: 'message',
    itemId,
    role,
    content: [{ type: 'text', text }],
  }
}

function inputFor(itemId: string, sessionId?: string) {
  return {
    agentId: 'researcher',
    behaviorDigest,
    items: [message(itemId, 'user', `input:${itemId}`)],
    ...(sessionId === undefined ? {} : { sessionId }),
  }
}

function finalResult(itemId: string): AgentRunnerModelResult {
  return { item: message(itemId, 'assistant', `output:${itemId}`) }
}

class ScriptedModel implements AgentRunnerModelPort {
  readonly adapterId = 'fake-model'
  readonly calls: AgentRunnerModelRequest[] = []
  readonly #responses: Array<AgentRunnerModelResult | Error>

  constructor(responses: Array<AgentRunnerModelResult | Error>) {
    this.#responses = [...responses]
  }

  async invoke(request: AgentRunnerModelRequest): Promise<AgentRunnerModelResult> {
    this.calls.push(request)
    const response = this.#responses.shift()
    if (response === undefined) throw new Error('Fake model response exhausted')
    if (response instanceof Error) throw response
    return response
  }
}

class ApprovalTool implements AgentRunnerReadOnlyToolPort {
  readonly toolId = 'read-session-fixture'
  readonly toolRevision = '1'
  readonly effectClass = 'read' as const
  readonly approval = {
    requestedBy: { principalId: 'runner', principalType: 'agent' as const },
    decisionPolicyRef: 'policy/session-read',
    decisionPolicyRevision: '1',
  }
  readonly calls: AgentRunnerReadOnlyToolRequest[] = []

  async execute(request: AgentRunnerReadOnlyToolRequest) {
    this.calls.push(request)
    return { status: 'completed' as const, output: { read: request.callId } }
  }
}

function toolCall(): AgentRunnerModelResult {
  return {
    item: {
      type: 'tool-call',
      itemId: 'tool-call-item',
      callId: 'call-session-read',
      toolId: 'read-session-fixture',
      arguments: { fixture: 'session' },
    },
  }
}

function ids(prefix: string): (kind: AgentRunnerIdentityKind) => string {
  const counters = new Map<AgentRunnerIdentityKind, number>()
  return (kind) => {
    const next = (counters.get(kind) ?? 0) + 1
    counters.set(kind, next)
    return `${prefix}-${kind}-${next}`
  }
}

function runner(options: {
  readonly prefix: string
  readonly model: AgentRunnerModelPort
  readonly persistence: InMemoryAgentRunnerPersistence
  readonly tools?: readonly AgentRunnerReadOnlyToolPort[]
}) {
  return new InMemoryAgentRunner({
    model: options.model,
    persistence: options.persistence,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    createId: ids(options.prefix),
    now: () => now,
  })
}

async function seedSession(
  persistence: InMemoryAgentRunnerPersistence,
  items: readonly AgentItem[] = [],
  sessionId = 'session-1',
): Promise<void> {
  await expect(
    persistence.createSession({ schema: AGENT_SESSION_SCHEMA, sessionId, revision: '0', items }),
  ).resolves.toBe('created')
}

function decisionFor(state: AgentRunStateV2, decision: 'approved' | 'rejected') {
  const interaction = state.interactions[0]
  if (interaction === undefined) throw new Error('Expected pending interaction')
  return {
    interactionId: interaction.interactionId,
    generation: interaction.generation,
    requestDigest: interaction.requestDigest,
    stateRevision: state.revision,
    decision,
    decisionPolicyRef: interaction.decisionPolicyRef,
    decisionPolicyRevision: interaction.decisionPolicyRevision,
    actor: { principalId: 'operator-1', principalType: 'user' },
  } satisfies AgentInteractionDecisionInput
}

describe('AgentRunner transactional conversation session', () => {
  it('reads immutable empty/existing snapshots and rejects malformed revisions', async () => {
    const persistence = new InMemoryAgentRunnerPersistence()
    const history = message('history-1', 'assistant', 'existing')
    await seedSession(persistence, [history])

    const loaded = await persistence.readSession('session-1')
    expect(loaded).toEqual({
      schema: AGENT_SESSION_SCHEMA,
      sessionId: 'session-1',
      revision: '0',
      items: [history],
    })
    ;(loaded?.items as AgentItem[]).push(message('mutation', 'user', 'not durable'))
    expect((await persistence.readSession('session-1'))?.items).toEqual([history])
    await seedSession(persistence, [], 'session-empty')
    expect((await persistence.readSession('session-empty'))?.items).toEqual([])

    await expect(
      persistence.createSession({
        schema: AGENT_SESSION_SCHEMA,
        sessionId: 'bad',
        revision: '01',
        items: [],
      }),
    ).rejects.toThrow('Invalid AgentSession snapshot')
  })

  it('commits by revision and makes identical transaction commits idempotent', async () => {
    const persistence = new InMemoryAgentRunnerPersistence()
    await seedSession(persistence)
    const stagedInput = [message('input-1', 'user', 'hello')]
    const output = [message('output-1', 'assistant', 'hello back')]
    const opened = await persistence.beginSessionTransaction({
      sessionId: 'session-1',
      transactionId: 'transaction-1',
      stagedInput,
    })
    expect(opened).toMatchObject({ status: 'opened', transaction: { baseRevision: '0' } })
    await expect(
      persistence.beginSessionTransaction({
        sessionId: 'session-1',
        transactionId: 'transaction-1',
        stagedInput: [message('different-input', 'user', 'conflict')],
      }),
    ).resolves.toEqual({ status: 'rejected', code: 'transaction-id-conflict' })

    const commit = {
      sessionId: 'session-1',
      transactionId: 'transaction-1',
      baseRevision: '0',
      items: output,
    }
    await expect(persistence.commitSessionTransaction(commit)).resolves.toMatchObject({
      status: 'committed',
      snapshot: { revision: '1', items: [...stagedInput, ...output] },
    })
    await expect(persistence.commitSessionTransaction(commit)).resolves.toMatchObject({
      status: 'already-committed',
      snapshot: { revision: '1' },
    })
    await expect(
      persistence.commitSessionTransaction({
        ...commit,
        items: [message('different', 'assistant', 'conflict')],
      }),
    ).resolves.toEqual({ status: 'rejected', code: 'transaction-content-conflict' })
  })

  it('persists the session binding before model dispatch and composes history deterministically', async () => {
    const persistence = new InMemoryAgentRunnerPersistence()
    const history = message('history-1', 'assistant', 'existing')
    await seedSession(persistence, [history])
    const model = new ScriptedModel([finalResult('final-1')])
    const stream = runner({ prefix: 'bound', model, persistence }).stream(
      inputFor('input-1', 'session-1'),
    )

    const first = await stream.next()
    expect(first.done).toBe(false)
    if (first.done) throw new Error('Expected run.started')
    expect(first.value.type).toBe('run.started')
    const state = await persistence.loadRun(first.value.runId)
    expect(state?.sessionBinding).toEqual({
      sessionId: 'session-1',
      baseRevision: '0',
      transactionId: `${first.value.runId}:session`,
    })
    expect(state?.input).toEqual([history, ...inputFor('input-1').items])
    expect(model.calls).toHaveLength(0)

    let step = await stream.next()
    while (!step.done) step = await stream.next()
    expect(step.value.state.status).toBe('completed')
    expect(model.calls[0]?.input).toEqual([history, ...inputFor('input-1').items])
    expect((await persistence.readSession('session-1'))?.items).toEqual([
      history,
      ...inputFor('input-1').items,
      finalResult('final-1').item,
    ])
  })

  it('surfaces a simultaneous stale transaction without interleaving or losing history', async () => {
    const persistence = new InMemoryAgentRunnerPersistence()
    const history = message('history-1', 'assistant', 'existing')
    await seedSession(persistence, [history])
    const ready = deferred<void>()
    const release = deferred<void>()
    let calls = 0
    class GatedModel extends ScriptedModel {
      override async invoke(request: AgentRunnerModelRequest) {
        calls += 1
        if (calls === 2) ready.resolve(undefined)
        await release.promise
        return super.invoke(request)
      }
    }
    const modelA = new GatedModel([finalResult('final-a')])
    const modelB = new GatedModel([finalResult('final-b')])
    const runA = runner({ prefix: 'a', model: modelA, persistence }).run(
      inputFor('input-a', 'session-1'),
    )
    const runB = runner({ prefix: 'b', model: modelB, persistence }).run(
      inputFor('input-b', 'session-1'),
    )
    await ready.promise
    release.resolve(undefined)
    const results = await Promise.all([runA, runB])

    expect(results.map((result) => result.state.status).sort()).toEqual(['completed', 'failed'])
    const failed = results.find((result) => result.state.status === 'failed')
    expect(failed?.events.at(-1)).toMatchObject({
      type: 'run.failed',
      payload: { code: 'session-revision-conflict' },
    })
    const snapshot = await persistence.readSession('session-1')
    expect(snapshot?.revision).toBe('1')
    expect(snapshot?.items).toHaveLength(3)
    expect(snapshot?.items[0]).toEqual(history)
    expect(snapshot?.items.filter((item) => item.itemId.startsWith('input-'))).toHaveLength(1)
    expect(snapshot?.items.filter((item) => item.itemId.startsWith('final-'))).toHaveLength(1)
    expect(modelA.calls[0]?.input).toEqual([history, ...inputFor('input-a').items])
    expect(modelB.calls[0]?.input).toEqual([history, ...inputFor('input-b').items])
  })

  it('retains one transaction across suspension and approved new-runner resume', async () => {
    const persistence = new InMemoryAgentRunnerPersistence()
    const history = message('history-1', 'assistant', 'existing')
    await seedSession(persistence, [history])
    const tool = new ApprovalTool()
    const suspended = await runner({
      prefix: 'suspend',
      model: new ScriptedModel([toolCall()]),
      persistence,
      tools: [tool],
    }).run(inputFor('input-1', 'session-1'))
    const binding = suspended.state.sessionBinding
    expect(suspended.state.status).toBe('suspended')
    expect(binding?.transactionId).toBeDefined()
    expect(await persistence.loadSessionTransaction(binding?.transactionId ?? '')).toMatchObject({
      status: 'open',
      baseRevision: '0',
    })
    expect((await persistence.readSession('session-1'))?.revision).toBe('0')

    const result = await runner({
      prefix: 'resume',
      model: new ScriptedModel([finalResult('final-1')]),
      persistence,
      tools: [tool],
    }).resume({
      runId: suspended.state.runId,
      behaviorDigest,
      decision: decisionFor(suspended.state, 'approved'),
    })
    expect(result.state.status).toBe('completed')
    expect(result.state.sessionBinding).toEqual(binding)
    expect(tool.calls).toHaveLength(1)
    const snapshot = await persistence.readSession('session-1')
    expect(snapshot?.revision).toBe('1')
    expect(new Set(snapshot?.items.map((item) => item.itemId)).size).toBe(snapshot?.items.length)
    expect(await persistence.loadSessionTransaction(binding?.transactionId ?? '')).toMatchObject({
      status: 'committed',
      committedRevision: '1',
    })
  })

  it('recovers a failed run-completion transition without appending the session twice', async () => {
    let failCompletion = true
    const persistence = new InMemoryAgentRunnerPersistence({
      failCommit(transition) {
        if (failCompletion && transition.event.type === 'run.completed') {
          failCompletion = false
          return 'journal'
        }
        return undefined
      },
    })
    await seedSession(persistence)
    const result = await runner({
      prefix: 'recover',
      model: new ScriptedModel([finalResult('final-1')]),
      persistence,
    }).run(inputFor('input-1', 'session-1'))

    expect(result.state.status).toBe('completed')
    expect(result.events.filter((event) => event.type === 'run.completed')).toHaveLength(1)
    expect((await persistence.readSession('session-1'))?.items).toEqual([
      ...inputFor('input-1').items,
      finalResult('final-1').item,
    ])
  })

  it('fails closed on missing sessions and injected commit failures before false completion', async () => {
    const missingPersistence = new InMemoryAgentRunnerPersistence()
    const missingModel = new ScriptedModel([finalResult('unused')])
    await expect(
      runner({ prefix: 'missing', model: missingModel, persistence: missingPersistence }).run(
        inputFor('input-1', 'missing-session'),
      ),
    ).rejects.toMatchObject({ code: 'session-not-found' })
    expect(missingModel.calls).toHaveLength(0)

    const persistence = new InMemoryAgentRunnerPersistence({
      failSession: (operation) => operation === 'commit',
    })
    await seedSession(persistence)
    const result = await runner({
      prefix: 'failure',
      model: new ScriptedModel([finalResult('final-1')]),
      persistence,
    }).run(inputFor('input-1', 'session-1'))
    expect(result.state.status).toBe('failed')
    expect(result.events.at(-1)).toMatchObject({
      type: 'run.failed',
      payload: { code: 'session-injected-failure' },
    })
    expect((await persistence.readSession('session-1'))?.items).toEqual([])
    expect(
      await persistence.loadSessionTransaction(result.state.sessionBinding?.transactionId ?? ''),
    ).toMatchObject({ status: 'aborted' })
  })

  it('aborts staged history for rejected, failed, and cancelled runs', async () => {
    const rejectedPersistence = new InMemoryAgentRunnerPersistence()
    await seedSession(rejectedPersistence)
    const tool = new ApprovalTool()
    const suspended = await runner({
      prefix: 'reject',
      model: new ScriptedModel([toolCall()]),
      persistence: rejectedPersistence,
      tools: [tool],
    }).run(inputFor('input-reject', 'session-1'))
    const rejected = await runner({
      prefix: 'reject-resume',
      model: new ScriptedModel([finalResult('unused')]),
      persistence: rejectedPersistence,
      tools: [tool],
    }).resume({
      runId: suspended.state.runId,
      behaviorDigest,
      decision: decisionFor(suspended.state, 'rejected'),
    })
    expect(rejected.state.status).toBe('failed')
    expect(await rejectedPersistence.loadSessionTransaction(
      rejected.state.sessionBinding?.transactionId ?? '',
    )).toMatchObject({ status: 'aborted' })

    const failedPersistence = new InMemoryAgentRunnerPersistence()
    await seedSession(failedPersistence, [], 'session-failed')
    const failed = await runner({
      prefix: 'failed',
      model: new ScriptedModel([new Error('model failed')]),
      persistence: failedPersistence,
    }).run(inputFor('input-failed', 'session-failed'))
    expect(failed.state.status).toBe('failed')
    expect((await failedPersistence.readSession('session-failed'))?.items).toEqual([])

    const cancelledPersistence = new InMemoryAgentRunnerPersistence()
    await seedSession(cancelledPersistence, [], 'session-cancelled')
    const cancelledModel = new ScriptedModel([finalResult('unused')])
    const control = new RunControl()
    control.requestCancel()
    const cancelled = await runner({
      prefix: 'cancelled',
      model: cancelledModel,
      persistence: cancelledPersistence,
    }).run(inputFor('input-cancelled', 'session-cancelled'), { control })
    expect(cancelled.state.status).toBe('cancelled')
    expect(cancelledModel.calls).toHaveLength(0)
    expect((await cancelledPersistence.readSession('session-cancelled'))?.items).toEqual([])
  })

  it('blocks resume when the retained session transaction is no longer open', async () => {
    const persistence = new InMemoryAgentRunnerPersistence()
    await seedSession(persistence)
    const tool = new ApprovalTool()
    const suspended = await runner({
      prefix: 'closed',
      model: new ScriptedModel([toolCall()]),
      persistence,
      tools: [tool],
    }).run(inputFor('input-1', 'session-1'))
    await persistence.abortSessionTransaction(suspended.state.sessionBinding?.transactionId ?? '')
    const finalModel = new ScriptedModel([finalResult('unused')])

    await expect(
      runner({ prefix: 'closed-resume', model: finalModel, persistence, tools: [tool] }).resume({
        runId: suspended.state.runId,
        behaviorDigest,
        decision: decisionFor(suspended.state, 'approved'),
      }),
    ).rejects.toMatchObject({ code: 'transaction-closed' })
    expect(tool.calls).toHaveLength(0)
    expect(finalModel.calls).toHaveLength(0)
  })

  it('retries a rejected decision after its first terminal transition fails', async () => {
    let failRejectedTerminal = true
    const persistence = new InMemoryAgentRunnerPersistence({
      failCommit(transition) {
        if (failRejectedTerminal && transition.event.type === 'run.failed') {
          failRejectedTerminal = false
          return 'state'
        }
        return undefined
      },
    })
    await seedSession(persistence)
    const tool = new ApprovalTool()
    const suspended = await runner({
      prefix: 'reject-retry',
      model: new ScriptedModel([toolCall()]),
      persistence,
      tools: [tool],
    }).run(inputFor('input-1', 'session-1'))
    const resumeInput = {
      runId: suspended.state.runId,
      behaviorDigest,
      decision: decisionFor(suspended.state, 'rejected'),
    }
    const resumed = runner({
      prefix: 'reject-retry-resume',
      model: new ScriptedModel([finalResult('unused')]),
      persistence,
      tools: [tool],
    })

    await expect(resumed.resume(resumeInput)).rejects.toMatchObject({
      code: 'atomic-state-failure',
    })
    await expect(resumed.resume(resumeInput)).resolves.toMatchObject({
      state: { status: 'failed' },
    })
    expect(tool.calls).toHaveLength(0)
    expect((await persistence.readSession('session-1'))?.items).toEqual([])
  })

  it('keeps session snapshots and transaction records durable and credential-free', async () => {
    const persistence = new InMemoryAgentRunnerPersistence()
    await seedSession(persistence)
    const result = await runner({
      prefix: 'durable',
      model: new ScriptedModel([finalResult('final-1')]),
      persistence,
    }).run(inputFor('input-1', 'session-1'))
    const evidence = {
      state: result.state,
      session: await persistence.readSession('session-1'),
      transaction: await persistence.loadSessionTransaction(
        result.state.sessionBinding?.transactionId ?? '',
      ),
    }
    expect(JSON.parse(JSON.stringify(evidence))).toEqual(evidence)
    expect(JSON.stringify(evidence)).not.toMatch(
      /apiKey|authorization|callback|credential|password|providerClient|rawProviderPayload|secret|\/home\/|\/media\//u,
    )
  })
})
