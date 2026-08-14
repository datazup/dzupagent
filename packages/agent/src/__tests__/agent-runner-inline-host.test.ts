import { describe, expect, it, vi } from 'vitest'
import type {
  AgentRunnerIdentityKind,
  AgentRunnerInput,
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
  digestRunnerJson,
} from '../runner.js'
import { AGENT_SESSION_SCHEMA } from '@dzupagent/agent-types/run'
import {
  AI_EXECUTION_EVENT_SCHEMA,
  AI_EXECUTION_BINDING_SCHEMA,
  AI_EXECUTION_OFFER_SCHEMA,
  AI_EXECUTION_RECEIPT_V2_SCHEMA,
  AI_EXECUTION_REQUEST_SCHEMA,
  AI_RESOLVED_TARGET_SCHEMA,
  validateAiExecutionTranscript,
  type AiExecutionBinding,
  type AiExecutionEvent,
  type AiExecutionRequest,
} from '@dzupagent/runtime-contracts/ai-execution'
import {
  materializeAiExecutionBinding,
  materializeAiExecutionOfferSnapshot,
  materializeAiResolvedTargetSnapshot,
  materializeAiRouteDecisionBinding,
  validateAiExecutionReceiptCustody,
} from '@dzupagent/runtime-contracts/ai-execution/node'

const runnerNow = '2026-08-09T12:00:00.000Z'
const digest = (character: string) => `sha256:${character.repeat(64)}` as const
const behaviorDigest = digest('a')
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

const modelIdentity = {
  modelRef: 'model/provider-free-runner',
  revision: '1',
  catalogDigest: digest('b'),
} as const

const offer = materializeAiExecutionOfferSnapshot({
  schema: AI_EXECUTION_OFFER_SCHEMA,
  offerId: 'runner-local',
  offerRevision: '1',
  model: modelIdentity,
  provider: 'provider-free-runner',
  backend: 'local-model',
  authMode: 'local_model',
  locality: 'local',
  privacyClass: 'device',
  capabilities: ['agent.run/v1'],
  cacheBehavior: 'none',
  sessionBehavior: 'stateful',
  health: { status: 'healthy', checkedAt: runnerNow },
  effectiveAt: runnerNow,
  catalogDigest: digest('c'),
})

const { reasoningSummary: _reasoningSummary, ...retainedRouteDecision } = routeDecision
const binding: AiExecutionBinding = materializeAiExecutionBinding({
  schema: AI_EXECUTION_BINDING_SCHEMA,
  routeDecision: materializeAiRouteDecisionBinding(retainedRouteDecision),
  offer,
  target,
  prompt: {
    blueprintRef: 'agent/researcher/behavior',
    blueprintRevision: '1',
    blueprintDigest: behaviorDigest,
    renderedPayloadDigest: digestRunnerJson(runnerInput) as `sha256:${string}`,
  },
  persona: {
    status: 'bound',
    personaId: 'persona/researcher',
    revision: '1',
    digest: digest('d'),
  },
  model: modelIdentity,
})

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
  readonly #responses: Array<AgentRunnerModelResult | Error | Promise<AgentRunnerModelResult>>

  constructor(responses: Array<AgentRunnerModelResult | Error | Promise<AgentRunnerModelResult>>) {
    this.#responses = [...responses]
  }

  async invoke(input: AgentRunnerModelRequest): Promise<AgentRunnerModelResult> {
    this.calls.push(input)
    const result = this.#responses.shift()
    if (result === undefined) throw new Error('Fake model exhausted')
    if (result instanceof Error) throw result
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

function deterministicIds(prefix = ''): (kind: AgentRunnerIdentityKind) => string {
  const counters = new Map<AgentRunnerIdentityKind, number>()
  return (kind) => {
    const next = (counters.get(kind) ?? 0) + 1
    counters.set(kind, next)
    return `${prefix}${kind}-${next}`
  }
}

function clock(): () => string {
  let tick = 0
  return () => new Date(Date.parse(runnerNow) + tick++ * 1_000).toISOString()
}

function createFixture(
  responses: Array<AgentRunnerModelResult | Error | Promise<AgentRunnerModelResult>>,
  tools: readonly AgentRunnerReadOnlyToolPort[] = [new ApprovalReadTool()],
  options: {
    readonly input?: AgentRunnerInput
    readonly persistence?: InMemoryAgentRunnerPersistence
    readonly idPrefix?: string
    readonly binding?: AiExecutionBinding
  } = {},
) {
  const model = new ScriptedModel(responses)
  const input = options.input ?? runnerInput
  const persistence = options.persistence ?? new InMemoryAgentRunnerPersistence()
  if (input.sessionId !== undefined) {
    void persistence.createSession({
      schema: AGENT_SESSION_SCHEMA, sessionId: input.sessionId, revision: '0', items: [],
    })
  }
  const runner = new InMemoryAgentRunner({
    model, tools, persistence, createId: deterministicIds(options.idPrefix), now: () => runnerNow,
  })
  const projectionBinding = (() => {
    if (options.binding !== undefined) return options.binding
    if (input === runnerInput) return binding
    const { bindingDigest: _bindingDigest, ...bindingInput } = binding
    return materializeAiExecutionBinding({
      ...bindingInput,
      prompt: {
        ...binding.prompt,
        renderedPayloadDigest: digestRunnerJson(input) as `sha256:${string}`,
      },
    })
  })()
  const port = createInlineAgentRunnerExecutionPort(
    runner,
    () => ({ input, target, routeDecision, binding: projectionBinding }),
    clock(),
  )
  return { model, persistence, port }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
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
    const { model, persistence, port } = createFixture([finalResult])
    const handle = port.start(request)
    const eventsPromise = collect(handle.events)
    const receipt = await handle.completion
    const events = await eventsPromise

    expect(model.calls).toHaveLength(1)
    expect(events.map(({ type }) => type)).toEqual(['started', 'usage', 'completed'])
    expect(events.map(({ sequence }) => sequence)).toEqual([1, 2, 3])
    expect(new Set(events.map(({ cursor }) => cursor).values()).size).toBe(3)
    expect(receipt.result).toMatchObject({ status: 'succeeded', output: 'Approved fixture read.' })
    expect(receipt.schema).toBe(AI_EXECUTION_RECEIPT_V2_SCHEMA)
    expect(receipt).toMatchObject({ binding: { bindingDigest: binding.bindingDigest } })
    expect(receipt.result.routeDecision).not.toHaveProperty('reasoningSummary')
    expect(receipt.usage).toMatchObject({ measurement: 'known', tokens: { input: 8, output: 3 } })
    expect(validateAiExecutionTranscript(receipt, events)).toEqual({ valid: true, diagnostics: [] })
    expect(validateAiExecutionReceiptCustody(receipt)).toEqual({ valid: true, diagnostics: [] })
    const state = await persistence.loadRun('run-1')
    expect(state?.sessionBinding).toMatchObject({
      sessionId: 'conversation-1', baseRevision: '0', transactionId: 'run-1:session',
    })
    expect(handle.executionId).not.toBe(state?.runId)
    expect(receipt.requestId).toBe(request.execution.requestId)
    expect(receipt.correlationId).toBe(request.execution.correlationId)
  })

  it('rejects route, target, payload, and capability drift before model dispatch', () => {
    const { bindingDigest: _bindingDigest, ...bindingInput } = binding
    const { snapshotDigest: _targetDigest, ...targetInput } = target
    const { snapshotDigest: _offerDigest, ...offerInput } = offer
    const changedTarget = materializeAiResolvedTargetSnapshot({
      ...targetInput,
      targetRevision: '2',
    })
    const changedOffer = materializeAiExecutionOfferSnapshot({
      ...offerInput,
      capabilities: [],
    })
    const cases: Array<{ readonly label: string; readonly value: AiExecutionBinding }> = [
      {
        label: 'route',
        value: materializeAiExecutionBinding({
          ...bindingInput,
          routeDecision: materializeAiRouteDecisionBinding({
            ...retainedRouteDecision,
            id: 'decision-other',
          }),
        }),
      },
      {
        label: 'target',
        value: materializeAiExecutionBinding({ ...bindingInput, target: changedTarget }),
      },
      {
        label: 'payload',
        value: materializeAiExecutionBinding({
          ...bindingInput,
          prompt: { ...binding.prompt, renderedPayloadDigest: digest('0') },
        }),
      },
      {
        label: 'capability',
        value: materializeAiExecutionBinding({ ...bindingInput, offer: changedOffer }),
      },
    ]

    for (const candidate of cases) {
      const { model, port } = createFixture(
        [finalResult],
        [new ApprovalReadTool()],
        { idPrefix: `${candidate.label}-drift-`, binding: candidate.value },
      )
      expect(() => port.start(request), candidate.label).toThrow(AgentRunnerInlineError)
      expect(model.calls, candidate.label).toHaveLength(0)
    }
  })

  it('runs without a session binding when the projection omits session identity', async () => {
    const sessionlessInput: AgentRunnerInput = {
      agentId: runnerInput.agentId,
      behaviorDigest: runnerInput.behaviorDigest,
      items: runnerInput.items,
    }
    const { persistence, port } = createFixture(
      [finalResult], [new ApprovalReadTool()],
      { input: sessionlessInput, idPrefix: 'sessionless-' },
    )
    const handle = port.start(request)
    const eventsPromise = collect(handle.events)
    const receipt = await handle.completion
    const events = await eventsPromise

    expect(receipt.result.status).toBe('succeeded')
    expect(validateAiExecutionTranscript(receipt, events)).toEqual({ valid: true, diagnostics: [] })
    expect((await persistence.loadRun('sessionless-run-1'))?.sessionBinding).toBeUndefined()
  })

  it('keeps completion pending across interaction and resumes the exact framework run', async () => {
    const tool = new ApprovalReadTool()
    const { persistence, port } = createFixture([toolCall(), finalResult], [tool])
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
    await expect(handle.submitInteraction({
      ...submission, payload: authorizedPayload('rejected'),
    })).resolves.toMatchObject({ status: 'rejected', reason: 'submission-conflict' })
    const receipt = await handle.completion
    const remaining: AiExecutionEvent[] = []
    for (let step = await iterator.next(); !step.done; step = await iterator.next()) {
      remaining.push(step.value)
    }
    expect(receipt.result.status).toBe('succeeded')
    expect(tool.calls).toHaveLength(1)
    expect(remaining.at(-1)).toMatchObject({ type: 'completed', status: 'succeeded' })
    const state = await persistence.loadRun('run-1')
    expect(state?.interactionDecisions).toHaveLength(1)
    expect(state?.invocations).toHaveLength(1)
    expect(state?.interactionDecisions[0]?.interactionId).not.toBe(submission.submissionId)
    expect(state?.invocations[0]?.invocationId).not.toBe(handle.executionId)
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
    const malformed = {
      ...base, submissionId: 'malformed', payload: { decision: 'approved' },
    }
    const firstRejection = await handle.submitInteraction(malformed)
    expect(firstRejection).toMatchObject({ status: 'rejected' })
    await expect(handle.submitInteraction(malformed)).resolves.toEqual(firstRejection)
    await expect(handle.submitInteraction({
      ...malformed, payload: { decision: 'rejected' },
    })).resolves.toMatchObject({ status: 'rejected', reason: 'submission-conflict' })
    await expect(handle.submitInteraction({
      ...base,
      interactionRef: `${interaction.interactionRef}:stale`,
      submissionId: 'stale-interaction',
      payload: authorizedPayload('approved'),
    })).resolves.toMatchObject({ status: 'rejected', reason: 'invalid-interaction-decision' })
    await expect(handle.submitInteraction({
      ...base,
      executionId: 'different-execution',
      submissionId: 'wrong-execution',
      payload: authorizedPayload('approved'),
    })).resolves.toMatchObject({ status: 'rejected', reason: 'invalid-submission' })
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

  it('redacts model failures and preserves fail-closed session commit evidence', async () => {
    const modelFailure = createFixture([
      new Error('provider-shaped secret must not escape'),
    ], [new ApprovalReadTool()], { idPrefix: 'model-failure-' })
    const modelHandle = modelFailure.port.start(request)
    const modelEventsPromise = collect(modelHandle.events)
    const modelReceipt = await modelHandle.completion
    const modelEvents = await modelEventsPromise

    expect(modelReceipt.result).toMatchObject({
      status: 'failed', errorCode: 'model-invocation-failed',
    })
    expect(JSON.stringify({ modelReceipt, modelEvents })).not.toContain('provider-shaped secret')
    expect(validateAiExecutionTranscript(modelReceipt, modelEvents)).toEqual({
      valid: true, diagnostics: [],
    })

    const persistence = new InMemoryAgentRunnerPersistence({
      failSession: (operation) => operation === 'commit',
    })
    const sessionFailure = createFixture(
      [finalResult], [new ApprovalReadTool()],
      { persistence, idPrefix: 'session-failure-' },
    )
    const sessionHandle = sessionFailure.port.start(request)
    const sessionEventsPromise = collect(sessionHandle.events)
    const sessionReceipt = await sessionHandle.completion
    const sessionEvents = await sessionEventsPromise

    expect(sessionReceipt.result).toMatchObject({
      status: 'failed', errorCode: 'session-injected-failure',
    })
    expect(sessionEvents.at(-1)).toMatchObject({ type: 'completed', status: 'failed' })
    expect((await persistence.readSession('conversation-1'))?.items).toEqual([])
  })

  it('fails one simultaneous session commit without interleaving shared history', async () => {
    const persistence = new InMemoryAgentRunnerPersistence()
    const leftResult = deferred<AgentRunnerModelResult>()
    const rightResult = deferred<AgentRunnerModelResult>()
    const left = createFixture(
      [leftResult.promise], [new ApprovalReadTool()],
      { persistence, idPrefix: 'left-' },
    )
    const right = createFixture(
      [rightResult.promise], [new ApprovalReadTool()],
      { persistence, idPrefix: 'right-' },
    )
    const leftHandle = left.port.start(request)
    const rightHandle = right.port.start(request)
    const leftEventsPromise = collect(leftHandle.events)
    const rightEventsPromise = collect(rightHandle.events)
    await vi.waitFor(() => {
      expect(left.model.calls).toHaveLength(1)
      expect(right.model.calls).toHaveLength(1)
    })
    leftResult.resolve(finalResult)
    rightResult.resolve({
      ...finalResult,
      item: { ...finalResult.item, itemId: 'final-right' },
    })
    const [leftReceipt, rightReceipt, leftEvents, rightEvents] = await Promise.all([
      leftHandle.completion, rightHandle.completion, leftEventsPromise, rightEventsPromise,
    ])

    expect([leftReceipt.result.status, rightReceipt.result.status].sort()).toEqual([
      'failed', 'succeeded',
    ])
    const failedReceipt = [leftReceipt, rightReceipt].find(({ result }) =>
      result.status === 'failed')
    expect(failedReceipt?.result).toMatchObject({ errorCode: 'session-revision-conflict' })
    expect([...leftEvents, ...rightEvents].filter(({ type }) => type === 'completed')).toHaveLength(2)
    const session = await persistence.readSession('conversation-1')
    expect(session?.revision).toBe('1')
    expect(session?.items.filter((item) => item.type === 'message' && item.role === 'assistant'))
      .toHaveLength(1)
  })

  it('rejects invalid authority before projection and sensitive projection before model dispatch', async () => {
    const model = new ScriptedModel([finalResult])
    const persistence = new InMemoryAgentRunnerPersistence()
    const runner = new InMemoryAgentRunner({
      model, tools: [new ApprovalReadTool()], persistence,
      createId: deterministicIds(), now: () => runnerNow,
    })
    let projections = 0
    const port = createInlineAgentRunnerExecutionPort(runner, () => {
      projections += 1
      return {
        input: {
          ...runnerInput,
          items: [{
            type: 'message', itemId: 'sensitive-input', role: 'user',
            content: [{ type: 'extension', namespace: 'test', value: { credential: 'forbidden' } }],
          }],
        },
        target,
        routeDecision,
        binding,
      }
    })
    const incompatible = {
      ...request,
      operation: {
        kind: 'text.generate', input: { prompt: 'Invalid agent dispatch.' },
        output: { modality: 'text' },
      },
    } as unknown as AiExecutionRequest
    let invalidRequestError: unknown
    try { port.start(incompatible) } catch (error) { invalidRequestError = error }
    expect(invalidRequestError).toMatchObject({ code: 'invalid-request' })
    expect(projections).toBe(0)

    const mismatchedIdentity: AiExecutionRequest = {
      ...request,
      execution: { ...request.execution, identity: { agentId: 'different-agent' } },
    }
    let identityError: unknown
    try { port.start(mismatchedIdentity) } catch (error) { identityError = error }
    expect(identityError).toMatchObject({ code: 'invalid-request' })
    expect(projections).toBe(0)

    const mismatchedTools: AiExecutionRequest = {
      ...request,
      execution: {
        ...request.execution,
        tools: { mode: 'explicit', grants: [{ toolRef: 'not-configured' }] },
      },
    }
    let toolPolicyError: unknown
    try { port.start(mismatchedTools) } catch (error) { toolPolicyError = error }
    expect(toolPolicyError).toMatchObject({ code: 'invalid-request' })
    expect(projections).toBe(0)

    expect(() => port.start(request)).toThrow(AgentRunnerInlineError)
    expect(projections).toBe(1)
    expect(model.calls).toHaveLength(0)
    await expect(persistence.loadRun('run-1')).resolves.toBeUndefined()
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
