import { describe, expect, it } from 'vitest'
import type {
  AgentRunnerIdentityKind,
  AgentRunnerModelPort,
  AgentRunnerModelRequest,
  AgentRunnerModelResult,
  AgentRunnerReadOnlyToolPort,
  AgentRunnerReadOnlyToolRequest,
} from '../runner.js'
import {
  AgentRunnerInlineError,
  BoundedAgentRunnerEventQueue,
  InMemoryAgentRunner,
  InMemoryAgentRunnerPersistence,
  createInlineAgentRunnerExecutionPort,
} from '../runner.js'
import { AGENT_SESSION_SCHEMA } from '@dzupagent/agent-types/run'
import {
  AI_EXECUTION_EVENT_SCHEMA,
  AI_EXECUTION_REQUEST_SCHEMA,
  AI_RESOLVED_TARGET_SCHEMA,
  validateAiExecutionTranscript,
  type AiExecutionEvent,
  type AiExecutionRequest,
} from '@dzupagent/runtime-contracts/ai-execution'
import {
  materializeAiResolvedTargetSnapshot,
  validateAiExecutionReceiptCustody,
} from '@dzupagent/runtime-contracts/ai-execution/node'

const runnerNow = '2026-08-09T12:00:00.000Z'
const behaviorDigest = 'sha256:inline-host-behavior'
const route = {
  id: 'route-inline-1', requestId: 'execution-1', strategy: 'fixed',
  candidates: [{ id: 'runner-local', backend: 'local-model' }],
  hardConstraints: [], preferenceOrder: [], fallback: 'none', maxSelectionLatencyMs: 100,
} as const

const request = {
  schema: AI_EXECUTION_REQUEST_SCHEMA,
  execution: {
    schema: 'dzupagent.executionRequest/v1',
    kind: 'agent',
    requestId: 'execution-1',
    correlationId: 'correlation-1',
    attempt: 1,
    source: { nodeId: 'node-1', nodePath: 'node-1' },
    prompt: { layers: [{ kind: 'task', content: 'Run the agent.' }], bindings: {} },
    tools: { mode: 'explicit', grants: [{ toolRef: 'read-approved' }] },
    output: { key: 'answer', format: 'text' },
    route,
    policy: { maxIterations: 4, maxToolCalls: 2 },
    effects: { effectClass: 'llm' },
    cancellation: { mode: 'cooperative' },
    evidenceRequirements: [],
    identity: { agentId: 'researcher' },
  },
  operation: {
    kind: 'agent.run',
    input: { agentRef: 'researcher' },
    output: { modality: 'text' },
  },
  target: { kind: 'target-id', targetId: 'agent.researcher.local' },
} satisfies AiExecutionRequest

const target = materializeAiResolvedTargetSnapshot({
  schema: AI_RESOLVED_TARGET_SCHEMA,
  targetId: 'agent.researcher.local',
  targetRevision: '1',
  policyRevision: '1',
  operation: 'agent.run',
  placement: 'server',
  executionStyle: 'inline',
  routeCandidateId: 'runner-local',
  backend: 'local-model',
  resolvedAt: runnerNow,
})

const routeDecision = {
  id: 'decision-inline-1',
  policyId: route.id,
  requestId: route.requestId,
  eligibleCandidateIds: ['runner-local'],
  rejected: [],
  selectedCandidateId: 'runner-local',
  fallbackCandidateIds: [],
  strategy: 'fixed',
  reasoningSummary: 'Must not be retained in runner state or receipt.',
  decidedAt: runnerNow,
} as const

const runnerInput = {
  agentId: 'researcher',
  behaviorDigest,
  sessionId: 'conversation-1',
  items: [{
    type: 'message' as const,
    itemId: 'input-1',
    role: 'user' as const,
    content: [{ type: 'text' as const, text: 'Read the approved fixture.' }],
  }],
}

const finalResult: AgentRunnerModelResult = {
  item: {
    type: 'message', itemId: 'final-1', role: 'assistant',
    content: [{ type: 'text', text: 'Approved fixture read.' }],
  },
  usage: { accountingSource: 'fake-model', inputTokens: 8, outputTokens: 3 },
}

function toolCall(): AgentRunnerModelResult {
  return {
    item: {
      type: 'tool-call', itemId: 'tool-call-1', callId: 'call-1',
      toolId: 'read-approved', arguments: { fixtureId: 'fixture-1' },
    },
    usage: { accountingSource: 'fake-model', inputTokens: 4, outputTokens: 2 },
  }
}

class ScriptedModel implements AgentRunnerModelPort {
  readonly adapterId = 'fake-model'
  readonly calls: AgentRunnerModelRequest[] = []
  readonly #responses: Array<AgentRunnerModelResult | Promise<AgentRunnerModelResult>>

  constructor(responses: Array<AgentRunnerModelResult | Promise<AgentRunnerModelResult>>) {
    this.#responses = [...responses]
  }

  async invoke(input: AgentRunnerModelRequest): Promise<AgentRunnerModelResult> {
    this.calls.push(input)
    const result = this.#responses.shift()
    if (result === undefined) throw new Error('Fake model exhausted')
    return result
  }
}

class ApprovalReadTool implements AgentRunnerReadOnlyToolPort {
  readonly toolId = 'read-approved'
  readonly toolRevision = '1'
  readonly effectClass = 'read' as const
  readonly approval = {
    requestedBy: { principalId: 'runner', principalType: 'agent' as const },
    decisionPolicyRef: 'policy/read-approved',
    decisionPolicyRevision: '1',
  }
  readonly calls: AgentRunnerReadOnlyToolRequest[] = []

  async execute(input: AgentRunnerReadOnlyToolRequest) {
    this.calls.push(input)
    return {
      status: 'completed' as const,
      output: { fixture: 'approved' },
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

function clock(): () => string {
  let tick = 0
  return () => new Date(Date.parse(runnerNow) + tick++ * 1_000).toISOString()
}

function createFixture(
  responses: Array<AgentRunnerModelResult | Promise<AgentRunnerModelResult>>,
  tools: readonly AgentRunnerReadOnlyToolPort[] = [],
) {
  const model = new ScriptedModel(responses)
  const persistence = new InMemoryAgentRunnerPersistence()
  void persistence.createSession({
    schema: AGENT_SESSION_SCHEMA, sessionId: 'conversation-1', revision: '0', items: [],
  })
  const runner = new InMemoryAgentRunner({
    model, tools, persistence, createId: deterministicIds(), now: () => runnerNow,
  })
  const port = createInlineAgentRunnerExecutionPort(
    runner,
    () => ({ input: runnerInput, target, routeDecision }),
    clock(),
  )
  return { model, port }
}

async function collect(events: AsyncIterable<AiExecutionEvent>): Promise<AiExecutionEvent[]> {
  const values: AiExecutionEvent[] = []
  for await (const event of events) values.push(event)
  return values
}

function authorizedPayload(decision: 'approved' | 'rejected') {
  return {
    schema: 'dzupagent.inlineInteractionDecision/v1',
    decision,
    actor: { principalId: 'operator-1', principalType: 'user' },
    authority: {
      status: 'authorized',
      reference: 'policy/read-approved',
      revision: '1',
    },
  } as const
}

describe('inline AgentRunner host composition', () => {
  it('projects a provider-free run into a validator-clean transcript and receipt', async () => {
    const { model, port } = createFixture([finalResult])
    const handle = port.start(request)
    const eventsPromise = collect(handle.events)
    const receipt = await handle.completion
    const events = await eventsPromise

    expect(model.calls).toHaveLength(1)
    expect(events.map(({ type }) => type)).toEqual(['started', 'usage', 'completed'])
    expect(events.map(({ sequence }) => sequence)).toEqual([1, 2, 3])
    expect(new Set(events.map(({ cursor }) => cursor).values()).size).toBe(3)
    expect(receipt.result).toMatchObject({ status: 'succeeded', output: 'Approved fixture read.' })
    expect(receipt.result.routeDecision).not.toHaveProperty('reasoningSummary')
    expect(receipt.usage).toMatchObject({ measurement: 'known', tokens: { input: 8, output: 3 } })
    expect(validateAiExecutionTranscript(receipt, events)).toEqual({ valid: true, diagnostics: [] })
    expect(validateAiExecutionReceiptCustody(receipt)).toEqual({ valid: true, diagnostics: [] })
  })

  it('keeps completion pending across interaction and resumes the exact framework run', async () => {
    const tool = new ApprovalReadTool()
    const { port } = createFixture([toolCall(), finalResult], [tool])
    const handle = port.start(request)
    const iterator = handle.events[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toMatchObject({ type: 'started' })
    const required = (await iterator.next()).value
    expect(required).toMatchObject({ type: 'usage' })
    const interaction = (await iterator.next()).value
    expect(interaction).toMatchObject({ type: 'interaction.required' })
    if (interaction?.type !== 'interaction.required') throw new Error('Expected interaction')

    let settled = false
    void handle.completion.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    const submission = {
      executionId: handle.executionId,
      interactionRef: interaction.interactionRef,
      submissionId: 'submission-1',
      submittedAt: runnerNow,
      payload: authorizedPayload('approved'),
    }
    await expect(handle.submitInteraction(submission)).resolves.toMatchObject({ status: 'accepted' })
    await expect(handle.submitInteraction(submission)).resolves.toMatchObject({ status: 'duplicate' })
    const receipt = await handle.completion
    const remaining: AiExecutionEvent[] = []
    for (let step = await iterator.next(); !step.done; step = await iterator.next()) {
      remaining.push(step.value)
    }
    expect(receipt.result.status).toBe('succeeded')
    expect(tool.calls).toHaveLength(1)
    expect(remaining.at(-1)).toMatchObject({ type: 'completed', status: 'succeeded' })
  })

  it('rejects malformed interaction input without resume and maps authorized rejection terminally', async () => {
    const tool = new ApprovalReadTool()
    const { port } = createFixture([toolCall()], [tool])
    const handle = port.start(request)
    const iterator = handle.events[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.next()
    const interaction = (await iterator.next()).value
    if (interaction?.type !== 'interaction.required') throw new Error('Expected interaction')
    const base = {
      executionId: handle.executionId,
      interactionRef: interaction.interactionRef,
      submittedAt: runnerNow,
    }
    await expect(handle.submitInteraction({
      ...base, submissionId: 'malformed', payload: { decision: 'approved' },
    })).resolves.toMatchObject({ status: 'rejected' })
    await expect(handle.submitInteraction({
      ...base, submissionId: 'rejected', payload: authorizedPayload('rejected'),
    })).resolves.toMatchObject({ status: 'accepted' })
    await expect(handle.completion).resolves.toMatchObject({ result: { status: 'failed' } })
    expect(tool.calls).toHaveLength(0)
  })

  it('acknowledges active cancellation before observed terminal cancellation', async () => {
    const { model, port } = createFixture([finalResult])
    const handle = port.start(request)
    const eventsPromise = collect(handle.events)
    await expect(handle.cancel({
      cancellationId: 'cancel-1', executionId: handle.executionId, requestedAt: runnerNow,
    })).resolves.toMatchObject({ status: 'requested' })
    const receipt = await handle.completion
    const events = await eventsPromise
    expect(model.calls).toHaveLength(0)
    expect(receipt.result.status).toBe('cancelled')
    expect(events.at(-1)).toMatchObject({ type: 'completed', status: 'cancelled' })
    await expect(handle.cancel({
      cancellationId: 'cancel-2', executionId: handle.executionId, requestedAt: runnerNow,
    })).resolves.toMatchObject({ status: 'already-terminal', terminalStatus: 'cancelled' })
    expect(events.filter(({ type }) => type === 'completed')).toHaveLength(1)
  })

  it('fails closed when successful runner output cannot form the requested receipt', async () => {
    const invalidJson: AgentRunnerModelResult = {
      item: {
        type: 'message', itemId: 'invalid-json', role: 'assistant',
        content: [{ type: 'text', text: 'not-json' }],
      },
    }
    const jsonRequest: AiExecutionRequest = {
      ...request,
      execution: { ...request.execution, output: { key: 'answer', format: 'json' } },
      operation: { ...request.operation, output: { modality: 'json' } },
    }
    const { port } = createFixture([invalidJson])
    const handle = port.start(jsonRequest)
    const eventsPromise = collect(handle.events)
    const receipt = await handle.completion
    const events = await eventsPromise
    expect(receipt.result.status).toBe('failed')
    expect(events.at(-1)).toMatchObject({ type: 'completed', status: 'failed' })
    expect(events).not.toContainEqual(expect.objectContaining({ status: 'succeeded' }))
  })

  it('rejects unsupported or sensitive projections before model dispatch', () => {
    const { model } = createFixture([finalResult])
    const runner = new InMemoryAgentRunner({ model, createId: deterministicIds(), now: () => runnerNow })
    const port = createInlineAgentRunnerExecutionPort(runner, () => ({
      input: {
        ...runnerInput,
        items: [{
          type: 'message', itemId: 'sensitive-input', role: 'user',
          content: [{ type: 'extension', namespace: 'test', value: { credential: 'forbidden' } }],
        }],
      },
      target,
      routeDecision,
    }))
    expect(() => port.start(request)).toThrow(AgentRunnerInlineError)
    expect(model.calls).toHaveLength(0)
  })

  it('enforces one event consumer and a bounded 32-event buffer', async () => {
    const { port } = createFixture([finalResult])
    const handle = port.start(request)
    const iterator = handle.events[Symbol.asyncIterator]()
    expect(() => handle.events[Symbol.asyncIterator]()).toThrow(AgentRunnerInlineError)
    await handle.completion
    while (!(await iterator.next()).done) { /* drain */ }

    const queue = new BoundedAgentRunnerEventQueue()
    const event = (sequence: number): AiExecutionEvent => ({
      schema: AI_EXECUTION_EVENT_SCHEMA,
      requestId: 'buffer-request', correlationId: 'buffer-correlation',
      sequence, cursor: `cursor-${sequence}`, attempt: 1, emittedAt: runnerNow, type: 'started',
    })
    for (let sequence = 1; sequence <= 32; sequence += 1) queue.push(event(sequence))
    expect(() => queue.push(event(33))).toThrow(AgentRunnerInlineError)
  })
})
