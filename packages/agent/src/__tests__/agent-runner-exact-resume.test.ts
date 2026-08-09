import { describe, expect, it } from 'vitest'
import type {
  AgentRunnerIdentityKind,
  AgentRunnerModelPort,
  AgentRunnerModelRequest,
  AgentRunnerModelResult,
  AgentRunnerPersistence,
  AgentRunnerReadOnlyToolPort,
  AgentRunnerReadOnlyToolRequest,
  AgentRunnerResumeInput,
  AgentRunnerResult,
} from '../runner.js'
import type {
  AgentInteractionDecisionInput,
  AgentRunEventEnvelope,
  AgentRunStateV2,
} from '@dzupagent/agent-types/run'

import {
  InMemoryAgentRunner,
  InMemoryAgentRunnerPersistence,
  assertDurableJson,
} from '../runner.js'

const now = '2026-08-09T12:00:00.000Z'
const behaviorDigest = 'sha256:exact-resume-behavior'

const input = {
  agentId: 'researcher',
  behaviorDigest,
  items: [
    {
      type: 'message' as const,
      itemId: 'input-1',
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'Read the approved fixture.' }],
    },
  ],
}

function toolCall(toolId = 'read-approved', callId = 'call-approved'): AgentRunnerModelResult {
  return {
    item: {
      type: 'tool-call',
      itemId: `item-${callId}`,
      callId,
      toolId,
      arguments: { fixtureId: toolId },
    },
  }
}

const finalResult: AgentRunnerModelResult = {
  item: {
    type: 'message',
    itemId: 'final-item',
    role: 'assistant',
    content: [{ type: 'text', text: 'Approved fixture read.' }],
  },
}

class ScriptedModel implements AgentRunnerModelPort {
  readonly adapterId = 'fake-model'
  readonly calls: AgentRunnerModelRequest[] = []
  readonly #responses: AgentRunnerModelResult[]

  constructor(responses: AgentRunnerModelResult[]) {
    this.#responses = [...responses]
  }

  async invoke(request: AgentRunnerModelRequest): Promise<AgentRunnerModelResult> {
    this.calls.push(request)
    const response = this.#responses.shift()
    if (response === undefined) throw new Error('Fake model response exhausted')
    return response
  }
}

class ReadTool implements AgentRunnerReadOnlyToolPort {
  readonly toolRevision = '1'
  readonly effectClass = 'read' as const
  readonly calls: AgentRunnerReadOnlyToolRequest[] = []
  readonly approval

  constructor(
    readonly toolId: string,
    approvalRequired: boolean,
    expiresAt = '2026-08-09T13:00:00.000Z',
  ) {
    this.approval = approvalRequired
      ? {
          requestedBy: { principalId: 'runner', principalType: 'agent' as const },
          decisionPolicyRef: 'policy/read-fixture',
          decisionPolicyRevision: '1',
          expiresAt,
        }
      : undefined
  }

  async execute(request: AgentRunnerReadOnlyToolRequest) {
    this.calls.push(request)
    return {
      status: 'completed' as const,
      output: { value: request.callId },
      completionEvidence: { fixtureRevision: '1' },
    }
  }
}

function deterministicIds(): (kind: AgentRunnerIdentityKind) => string {
  const counters = new Map<AgentRunnerIdentityKind, number>()
  return (kind) => {
    const next = (counters.get(kind) ?? 0) + 1
    counters.set(kind, next)
    return `${kind}-${next}`
  }
}

function createRunner(options: {
  readonly model: AgentRunnerModelPort
  readonly tools: readonly AgentRunnerReadOnlyToolPort[]
  readonly persistence: InMemoryAgentRunnerPersistence
  readonly createId: (kind: AgentRunnerIdentityKind) => string
}): InMemoryAgentRunner {
  return new InMemoryAgentRunner({ ...options, now: () => now })
}

function decisionFor(
  state: AgentRunStateV2,
  decision: 'approved' | 'rejected' = 'approved',
): AgentInteractionDecisionInput {
  const interaction = state.interactions[0]
  if (interaction === undefined) throw new Error('Expected a pending interaction')
  return {
    interactionId: interaction.interactionId,
    generation: interaction.generation,
    requestDigest: interaction.requestDigest,
    stateRevision: state.revision,
    decision,
    decisionPolicyRef: interaction.decisionPolicyRef,
    decisionPolicyRevision: interaction.decisionPolicyRevision,
    actor: { principalId: 'operator-1', principalType: 'user' },
  }
}

async function suspendFixture(options: {
  readonly expiresAt?: string
  readonly modelResponses?: AgentRunnerModelResult[]
  readonly tools?: ReadTool[]
} = {}) {
  const persistence = new InMemoryAgentRunnerPersistence()
  const createId = deterministicIds()
  const tool = options.tools?.[0] ?? new ReadTool('read-approved', true, options.expiresAt)
  const tools = options.tools ?? [tool]
  const model = new ScriptedModel(options.modelResponses ?? [toolCall()])
  const runner = createRunner({ model, tools, persistence, createId })
  const suspended = await runner.run(input)
  return { persistence, createId, tool, tools, model, suspended }
}

async function collectStream(
  stream: AsyncGenerator<AgentRunEventEnvelope, AgentRunnerResult>,
): Promise<{ result: AgentRunnerResult; events: AgentRunEventEnvelope[] }> {
  const events: AgentRunEventEnvelope[] = []
  let step = await stream.next()
  while (!step.done) {
    events.push(step.value)
    step = await stream.next()
  }
  return { result: step.value, events }
}

describe('AgentRunner exact suspended resume', () => {
  it('suspends before an approval-required read tool and resumes exactly in a new runner', async () => {
    const fixture = await suspendFixture()
    expect(fixture.suspended.state.status).toBe('suspended')
    expect(fixture.tool.calls).toHaveLength(0)
    expect(fixture.suspended.state.interactions).toHaveLength(1)
    expect(fixture.suspended.events.at(-2)?.type).toBe('interaction.requested')
    expect(fixture.suspended.events.at(-1)?.type).toBe('run.suspended')
    expect(JSON.parse(JSON.stringify(fixture.suspended))).toEqual(fixture.suspended)

    const pendingInvocation = fixture.suspended.state.invocations[0]
    const finalModel = new ScriptedModel([finalResult])
    const resumedRunner = createRunner({
      model: finalModel,
      tools: fixture.tools,
      persistence: fixture.persistence,
      createId: fixture.createId,
    })
    const result = await resumedRunner.resume({
      runId: fixture.suspended.state.runId,
      behaviorDigest,
      decision: decisionFor(fixture.suspended.state),
    })

    expect(result.state.status).toBe('completed')
    expect(result.state.runId).toBe(fixture.suspended.state.runId)
    expect(result.state.invocations[0]).toMatchObject({
      invocationId: pendingInvocation?.invocationId,
      attempt: 1,
      state: 'completed',
    })
    expect(result.state.revision).toBeGreaterThan(fixture.suspended.state.revision)
    expect(result.state.revision).toBe(result.events.length)
    expect(result.state.nextEventSeq).toBe(result.events.length)
    expect(result.events.map((event) => event.sequence)).toEqual(
      result.events.map((_, sequence) => sequence),
    )
    expect(fixture.tool.calls).toHaveLength(1)
    expect(fixture.tool.calls[0]?.invocationId).toBe(pendingInvocation?.invocationId)
    expect(finalModel.calls[0]?.turn).toBe(2)
  })

  it('rejects duplicate identical and conflicting same-generation decisions deterministically', async () => {
    const fixture = await suspendFixture()
    const resumeInput: AgentRunnerResumeInput = {
      runId: fixture.suspended.state.runId,
      behaviorDigest,
      decision: decisionFor(fixture.suspended.state),
    }
    const runner = createRunner({
      model: new ScriptedModel([finalResult]),
      tools: fixture.tools,
      persistence: fixture.persistence,
      createId: fixture.createId,
    })
    await runner.resume(resumeInput)

    await expect(runner.resume(resumeInput)).rejects.toMatchObject({
      code: 'decision-already-applied',
    })
    await expect(
      runner.resume({
        ...resumeInput,
        decision: { ...resumeInput.decision, decision: 'rejected' },
      }),
    ).rejects.toMatchObject({ code: 'decision-conflict' })
    expect(fixture.tool.calls).toHaveLength(1)
  })

  it('recovers idempotently when the decision committed but the resume transition failed', async () => {
    let failResumeOnce = true
    const persistence = new InMemoryAgentRunnerPersistence({
      failCommit(transition) {
        if (failResumeOnce && transition.event.type === 'run.resumed') {
          failResumeOnce = false
          return 'journal'
        }
        return undefined
      },
    })
    const createId = deterministicIds()
    const tool = new ReadTool('read-approved', true)
    const suspended = await createRunner({
      model: new ScriptedModel([toolCall()]),
      tools: [tool],
      persistence,
      createId,
    }).run(input)
    const resumeInput: AgentRunnerResumeInput = {
      runId: suspended.state.runId,
      behaviorDigest,
      decision: decisionFor(suspended.state),
    }

    await expect(
      createRunner({
        model: new ScriptedModel([finalResult]),
        tools: [tool],
        persistence,
        createId,
      }).resume(resumeInput),
    ).rejects.toMatchObject({ code: 'atomic-journal-failure' })
    expect(await persistence.loadRun(suspended.state.runId)).toMatchObject({
      status: 'suspended',
      interactionDecisions: [{ decision: 'approved' }],
    })
    expect(tool.calls).toHaveLength(0)

    const recovered = await createRunner({
      model: new ScriptedModel([finalResult]),
      tools: [tool],
      persistence,
      createId,
    }).resume(resumeInput)
    expect(recovered.state.status).toBe('completed')
    expect(recovered.state.interactionDecisions).toHaveLength(1)
    expect(tool.calls).toHaveLength(1)
  })

  it.each([
    [
      'stale revision',
      (resume: AgentRunnerResumeInput) => ({
        ...resume,
        decision: { ...resume.decision, stateRevision: resume.decision.stateRevision - 1 },
      }),
      'decision-state-revision-stale',
    ],
    [
      'generation mismatch',
      (resume: AgentRunnerResumeInput) => ({
        ...resume,
        decision: { ...resume.decision, generation: resume.decision.generation + 1 },
      }),
      'decision-generation-mismatch',
    ],
    [
      'request mismatch',
      (resume: AgentRunnerResumeInput) => ({
        ...resume,
        decision: { ...resume.decision, requestDigest: 'sha256:mismatch' },
      }),
      'decision-request-mismatch',
    ],
    [
      'policy mismatch',
      (resume: AgentRunnerResumeInput) => ({
        ...resume,
        decision: { ...resume.decision, decisionPolicyRevision: '2' },
      }),
      'decision-policy-mismatch',
    ],
    [
      'behavior mismatch',
      (resume: AgentRunnerResumeInput) => ({ ...resume, behaviorDigest: 'sha256:drifted' }),
      'behavior-mismatch',
    ],
  ] as const)('fails closed on %s before dispatch', async (_label, mutate, code) => {
    const fixture = await suspendFixture()
    const model = new ScriptedModel([finalResult])
    const runner = createRunner({
      model,
      tools: fixture.tools,
      persistence: fixture.persistence,
      createId: fixture.createId,
    })
    const resumeInput: AgentRunnerResumeInput = {
      runId: fixture.suspended.state.runId,
      behaviorDigest,
      decision: decisionFor(fixture.suspended.state),
    }

    await expect(runner.resume(mutate(resumeInput))).rejects.toMatchObject({ code })
    expect(fixture.tool.calls).toHaveLength(0)
    expect(model.calls).toHaveLength(0)
  })

  it('fails closed on an expired interaction before dispatch', async () => {
    const fixture = await suspendFixture({ expiresAt: '2026-08-09T11:00:00.000Z' })
    const model = new ScriptedModel([finalResult])
    const runner = createRunner({
      model,
      tools: fixture.tools,
      persistence: fixture.persistence,
      createId: fixture.createId,
    })

    await expect(
      runner.resume({
        runId: fixture.suspended.state.runId,
        behaviorDigest,
        decision: decisionFor(fixture.suspended.state),
      }),
    ).rejects.toMatchObject({ code: 'interaction-expired' })
    expect(fixture.tool.calls).toHaveLength(0)
    expect(model.calls).toHaveLength(0)
  })

  it('fails closed on malformed persisted state before dispatch', async () => {
    const fixture = await suspendFixture()
    const corruptPersistence: AgentRunnerPersistence = {
      createRun: (state) => fixture.persistence.createRun(state),
      async loadRun(runId) {
        const state = await fixture.persistence.loadRun(runId)
        return { ...state, interactionDecisions: undefined } as unknown as AgentRunStateV2
      },
      readEvents: (runId) => fixture.persistence.readEvents(runId),
      commitTransition: (transition) => fixture.persistence.commitTransition(transition),
    }
    const model = new ScriptedModel([finalResult])
    const runner = createRunner({
      model,
      tools: fixture.tools,
      persistence: corruptPersistence as unknown as InMemoryAgentRunnerPersistence,
      createId: fixture.createId,
    })

    await expect(
      runner.resume({
        runId: fixture.suspended.state.runId,
        behaviorDigest,
        decision: decisionFor(fixture.suspended.state),
      }),
    ).rejects.toMatchObject({ code: 'malformed-state' })
    expect(fixture.tool.calls).toHaveLength(0)
    expect(model.calls).toHaveLength(0)
  })

  it('does not re-execute a completed predecessor invocation after restart', async () => {
    const firstTool = new ReadTool('read-first', false)
    const approvalTool = new ReadTool('read-approved', true)
    const fixture = await suspendFixture({
      tools: [firstTool, approvalTool],
      modelResponses: [toolCall('read-first', 'call-first'), toolCall()],
    })
    expect(firstTool.calls).toHaveLength(1)
    expect(approvalTool.calls).toHaveLength(0)
    expect(fixture.suspended.state.invocations).toMatchObject([
      { toolId: 'read-first', state: 'completed' },
      { toolId: 'read-approved', state: 'approval-required' },
    ])

    const runner = createRunner({
      model: new ScriptedModel([finalResult]),
      tools: fixture.tools,
      persistence: fixture.persistence,
      createId: fixture.createId,
    })
    const result = await runner.resume({
      runId: fixture.suspended.state.runId,
      behaviorDigest,
      decision: decisionFor(fixture.suspended.state),
    })

    expect(result.state.status).toBe('completed')
    expect(firstTool.calls).toHaveLength(1)
    expect(approvalTool.calls).toHaveLength(1)
    expect(result.state.invocations.filter((invocation) => invocation.state === 'completed')).toHaveLength(
      2,
    )
  })

  it('persists a rejected decision, never dispatches the tool, and terminates as failed', async () => {
    const fixture = await suspendFixture()
    const model = new ScriptedModel([finalResult])
    const runner = createRunner({
      model,
      tools: fixture.tools,
      persistence: fixture.persistence,
      createId: fixture.createId,
    })
    const result = await runner.resume({
      runId: fixture.suspended.state.runId,
      behaviorDigest,
      decision: decisionFor(fixture.suspended.state, 'rejected'),
    })

    expect(result.state.status).toBe('failed')
    expect(result.state.invocations).toMatchObject([{ state: 'rejected' }])
    expect(result.state.interactionDecisions).toMatchObject([{ decision: 'rejected' }])
    expect(result.events.slice(-2).map((event) => event.type)).toEqual([
      'interaction.resolved',
      'run.failed',
    ])
    expect(fixture.tool.calls).toHaveLength(0)
    expect(model.calls).toHaveLength(0)
  })

  it('keeps resumed streaming and non-streaming terminal projections equal', async () => {
    async function execute(streaming: boolean) {
      const fixture = await suspendFixture()
      const runner = createRunner({
        model: new ScriptedModel([finalResult]),
        tools: fixture.tools,
        persistence: fixture.persistence,
        createId: fixture.createId,
      })
      const resumeInput: AgentRunnerResumeInput = {
        runId: fixture.suspended.state.runId,
        behaviorDigest,
        decision: decisionFor(fixture.suspended.state),
      }
      return streaming
        ? (await collectStream(runner.resumeStream(resumeInput))).result
        : runner.resume(resumeInput)
    }

    await expect(execute(true)).resolves.toEqual(await execute(false))
  })

  it('keeps suspended state, events, and decisions durable and credential-free', async () => {
    const fixture = await suspendFixture()
    const runner = createRunner({
      model: new ScriptedModel([finalResult]),
      tools: fixture.tools,
      persistence: fixture.persistence,
      createId: fixture.createId,
    })
    const result = await runner.resume({
      runId: fixture.suspended.state.runId,
      behaviorDigest,
      decision: decisionFor(fixture.suspended.state),
    })

    expect(() => assertDurableJson(result)).not.toThrow()
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
    expect(JSON.stringify(result)).not.toMatch(
      /apiKey|authorization|callback|credential|password|providerClient|rawProviderPayload|secret|\/home\/|\/media\//u,
    )
  })
})
