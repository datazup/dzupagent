import { describe, expect, it } from 'vitest'
import type {
  AgentRunnerModelPort,
  AgentRunnerModelRequest,
  AgentRunnerModelResult,
  AgentRunnerReadOnlyToolPort,
  AgentRunnerReadOnlyToolRequest,
  AgentRunnerReadOnlyToolResult,
} from '../runner.js'
import type { AgentRunEventEnvelope } from '@dzupagent/agent-types/run'

import {
  AgentRunnerSerializationError,
  InMemoryAgentEventJournal,
  InMemoryAgentRunner,
  InMemoryAgentRunStore,
  RunControl,
  assertDurableJson,
  type AgentRunnerIdentityKind,
  type AgentRunnerInput,
  type AgentRunnerResult,
} from '../runner.js'

type Deferred<T> = {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolveValue: (value: T) => void = () => undefined
  let rejectValue: (reason?: unknown) => void = () => undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve
    rejectValue = reject
  })
  return { promise, resolve: resolveValue, reject: rejectValue }
}

const input: AgentRunnerInput = {
  agentId: 'researcher',
  behaviorDigest: 'sha256:test-behavior',
  items: [
    {
      type: 'message',
      itemId: 'input-1',
      role: 'user',
      content: [{ type: 'text', text: 'Read the local fixture.' }],
    },
  ],
}

const toolCallResult: AgentRunnerModelResult = {
  item: {
    type: 'tool-call',
    itemId: 'model-item-tool',
    callId: 'call-read-1',
    toolId: 'read-fixture',
    arguments: { fixtureId: 'fixture-1' },
  },
  usage: { accountingSource: 'fake-model', inputTokens: 8, outputTokens: 3 },
}

const finalResult: AgentRunnerModelResult = {
  item: {
    type: 'message',
    itemId: 'model-item-final',
    role: 'assistant',
    content: [{ type: 'text', text: 'Fixture read.' }],
  },
  usage: { accountingSource: 'fake-model', inputTokens: 12, outputTokens: 4 },
}

class ScriptedModel implements AgentRunnerModelPort {
  readonly adapterId = 'fake-model'
  readonly calls: AgentRunnerModelRequest[] = []
  readonly #responses: Array<AgentRunnerModelResult | Promise<AgentRunnerModelResult>>

  constructor(responses: Array<AgentRunnerModelResult | Promise<AgentRunnerModelResult>>) {
    this.#responses = responses
  }

  async invoke(request: AgentRunnerModelRequest): Promise<AgentRunnerModelResult> {
    this.calls.push(request)
    const response = this.#responses.shift()
    if (response === undefined) throw new Error('Fake model response exhausted')
    return response
  }
}

class ScriptedReadTool implements AgentRunnerReadOnlyToolPort {
  readonly toolId = 'read-fixture'
  readonly toolRevision = '1'
  readonly effectClass = 'read' as const
  readonly calls: AgentRunnerReadOnlyToolRequest[] = []
  readonly #responses: Array<AgentRunnerReadOnlyToolResult | Promise<AgentRunnerReadOnlyToolResult>>

  constructor(
    responses: Array<AgentRunnerReadOnlyToolResult | Promise<AgentRunnerReadOnlyToolResult>>,
  ) {
    this.#responses = responses
  }

  async execute(request: AgentRunnerReadOnlyToolRequest): Promise<AgentRunnerReadOnlyToolResult> {
    this.calls.push(request)
    const response = this.#responses.shift()
    if (response === undefined) throw new Error('Fake tool response exhausted')
    return response
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

function createRunner(
  model: AgentRunnerModelPort,
  tool: AgentRunnerReadOnlyToolPort,
  store = new InMemoryAgentRunStore(),
): { runner: InMemoryAgentRunner; store: InMemoryAgentRunStore } {
  return {
    runner: new InMemoryAgentRunner({
      model,
      tools: [tool],
      store,
      journal: new InMemoryAgentEventJournal(),
      createId: deterministicIds(),
      now: () => '2026-08-09T12:00:00.000Z',
    }),
    store,
  }
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

describe('in-memory AgentRunner', () => {
  it('observes pause before model dispatch and resumes without an early provider call', async () => {
    const model = new ScriptedModel([finalResult])
    const tool = new ScriptedReadTool([])
    const { runner, store } = createRunner(model, tool)
    const control = new RunControl()
    const acknowledgement = control.requestPause()
    expect(acknowledgement).toMatchObject({ accepted: true, state: 'requested' })
    if (!acknowledgement.accepted) throw new Error('Expected accepted pause')

    const resultPromise = runner.run(input, { control })
    await expect(control.waitForObservation(acknowledgement.requestId)).resolves.toMatchObject({
      kind: 'pause',
      safePoint: 'before-model-dispatch',
    })
    expect(model.calls).toHaveLength(0)
    expect((await store.load('run-1'))?.status).toBe('suspended')

    expect(control.resume()).toBe(true)
    const result = await resultPromise
    expect(result.state.status).toBe('completed')
    expect(model.calls).toHaveLength(1)
  })

  it('lets a stream resume immediately after the suspended event is observed', async () => {
    const model = new ScriptedModel([finalResult])
    const tool = new ScriptedReadTool([])
    const { runner } = createRunner(model, tool)
    const control = new RunControl()
    const acknowledgement = control.requestPause()
    if (!acknowledgement.accepted) throw new Error('Expected accepted pause')
    const stream = runner.stream(input, { control })

    expect((await stream.next()).value).toMatchObject({ type: 'run.started' })
    expect((await stream.next()).value).toMatchObject({ type: 'run.suspended' })
    await expect(control.waitForObservation(acknowledgement.requestId)).resolves.toMatchObject({
      safePoint: 'before-model-dispatch',
    })
    expect(control.resume()).toBe(true)

    const resumed = await stream.next()
    expect(resumed.value).toMatchObject({ type: 'run.resumed' })
    const remaining = await collectStream(stream)
    expect(remaining.result.state.status).toBe('completed')
  })

  it('observes pause after a model result and before tool dispatch', async () => {
    const modelGate = deferred<AgentRunnerModelResult>()
    const modelStarted = deferred<void>()
    const model: AgentRunnerModelPort = {
      adapterId: 'fake-model',
      async invoke(request) {
        if (request.turn === 1) {
          modelStarted.resolve()
          return modelGate.promise
        }
        return finalResult
      },
    }
    const tool = new ScriptedReadTool([{ status: 'completed', output: { value: 'fixture' } }])
    const { runner, store } = createRunner(model, tool)
    const control = new RunControl()
    const resultPromise = runner.run(input, { control })
    await modelStarted.promise

    const acknowledgement = control.requestPause()
    if (!acknowledgement.accepted) throw new Error('Expected accepted pause')
    modelGate.resolve(toolCallResult)
    await expect(control.waitForObservation(acknowledgement.requestId)).resolves.toMatchObject({
      safePoint: 'before-tool-dispatch',
    })
    expect(tool.calls).toHaveLength(0)
    expect((await store.load('run-1'))?.status).toBe('suspended')

    control.resume()
    expect((await resultPromise).state.status).toBe('completed')
    expect(tool.calls).toHaveLength(1)
  })

  it('cancels before model dispatch without executing an effect', async () => {
    const model = new ScriptedModel([finalResult])
    const tool = new ScriptedReadTool([])
    const { runner } = createRunner(model, tool)
    const control = new RunControl()
    const acknowledgement = control.requestCancel()
    if (!acknowledgement.accepted) throw new Error('Expected accepted cancel')

    const result = await runner.run(input, { control })
    await expect(control.waitForObservation(acknowledgement.requestId)).resolves.toMatchObject({
      safePoint: 'before-model-dispatch',
    })
    expect(result.state.status).toBe('cancelled')
    expect(model.calls).toHaveLength(0)
    expect(tool.calls).toHaveLength(0)
    expect(result.events.map((event) => event.type)).toEqual(['run.started', 'run.cancelled'])
  })

  it('waits for an already-dispatched read tool and commits its result before cancellation', async () => {
    const toolGate = deferred<AgentRunnerReadOnlyToolResult>()
    const toolStarted = deferred<void>()
    const tool: AgentRunnerReadOnlyToolPort = {
      toolId: 'read-fixture',
      toolRevision: '1',
      effectClass: 'read',
      async execute() {
        toolStarted.resolve()
        return toolGate.promise
      },
    }
    const model = new ScriptedModel([toolCallResult])
    const { runner, store } = createRunner(model, tool)
    const control = new RunControl()
    const resultPromise = runner.run(input, { control })
    await toolStarted.promise

    const acknowledgement = control.requestCancel()
    if (!acknowledgement.accepted) throw new Error('Expected accepted cancel')
    expect((await store.load('run-1'))?.status).toBe('running')
    toolGate.resolve({ status: 'completed', output: { value: 'fixture' } })

    const result = await resultPromise
    await expect(control.waitForObservation(acknowledgement.requestId)).resolves.toMatchObject({
      safePoint: 'after-tool-dispatch',
    })
    expect(result.state.status).toBe('cancelled')
    expect(result.state.invocations).toMatchObject([{ state: 'completed', effectClass: 'read' }])
    expect(result.state.committedItems.at(-1)).toMatchObject({
      type: 'tool-result',
      output: { value: 'fixture' },
    })
    expect(model.calls).toHaveLength(1)
  })

  it('reports an unknown tool outcome when dispatched work rejects instead of inventing abort', async () => {
    const toolGate = deferred<AgentRunnerReadOnlyToolResult>()
    const toolStarted = deferred<void>()
    const tool: AgentRunnerReadOnlyToolPort = {
      toolId: 'read-fixture',
      toolRevision: '1',
      effectClass: 'read',
      async execute() {
        toolStarted.resolve()
        return toolGate.promise
      },
    }
    const model = new ScriptedModel([toolCallResult])
    const { runner } = createRunner(model, tool)
    const control = new RunControl()
    const resultPromise = runner.run(input, { control })
    await toolStarted.promise

    const acknowledgement = control.requestCancel()
    if (!acknowledgement.accepted) throw new Error('Expected accepted cancel')
    toolGate.reject(new Error('test-only adapter rejection'))

    const result = await resultPromise
    await expect(control.waitForObservation(acknowledgement.requestId)).resolves.toEqual({
      requestId: acknowledgement.requestId,
      kind: 'cancel',
      state: 'not-observed',
      reason: 'terminal-before-safe-point',
    })
    expect(result.state.status).toBe('failed')
    expect(result.state.invocations).toMatchObject([{ state: 'effect-unknown' }])
    expect(result.events.map((event) => event.type)).not.toContain('run.cancelled')
  })

  it('retries only a declared failed-before-effect outcome with the same invocation ID', async () => {
    const model = new ScriptedModel([toolCallResult, finalResult])
    const tool = new ScriptedReadTool([
      { status: 'failed-before-effect', code: 'fixture-not-ready', retryable: true },
      { status: 'completed', output: { value: 'fixture' } },
    ])
    const { runner } = createRunner(model, tool)

    const result = await runner.run(input)
    expect(result.state.status).toBe('completed')
    expect(tool.calls.map((call) => call.attempt)).toEqual([1, 2])
    expect(new Set(tool.calls.map((call) => call.invocationId))).toEqual(
      new Set(['invocation-1']),
    )
    expect(result.state.invocations).toMatchObject([
      { invocationId: 'invocation-1', attempt: 2, state: 'completed' },
    ])
    expect(result.events.filter((event) => event.type === 'tool.started')).toHaveLength(2)
    expect(result.events.filter((event) => event.type === 'tool.failed')).toHaveLength(1)
  })

  it('projects run and stream from the same scheduler with exact terminal parity', async () => {
    const runModel = new ScriptedModel([toolCallResult, finalResult])
    const runTool = new ScriptedReadTool([
      { status: 'completed', output: { value: 'fixture' } },
    ])
    const streamModel = new ScriptedModel([toolCallResult, finalResult])
    const streamTool = new ScriptedReadTool([
      { status: 'completed', output: { value: 'fixture' } },
    ])

    const runResult = await createRunner(runModel, runTool).runner.run(input)
    const streamed = await collectStream(createRunner(streamModel, streamTool).runner.stream(input))

    expect(streamed.events).toEqual(runResult.events)
    expect(streamed.result).toEqual(runResult)
    expect(streamed.result.state.revision).toBe(streamed.events.length)
    expect(streamed.result.state.nextEventSeq).toBe(streamed.events.length)
    expect(streamed.result.state.usage).toEqual(runResult.state.usage)
  })

  it('fails durable serialization closed for runtime objects, sensitive fields, and host paths', async () => {
    const unsafeValues: unknown[] = [
      { callback: () => undefined },
      new Error('test-only error'),
      { providerClient: {} },
      { apiKey: 'redacted-test-value' },
      { rawProviderPayload: { opaque: true } },
      { artifactPath: '/test-only/absolute/path' },
    ]

    for (const value of unsafeValues) {
      expect(() => assertDurableJson(value)).toThrow(AgentRunnerSerializationError)
    }

    const model = new ScriptedModel([finalResult])
    const tool = new ScriptedReadTool([])
    const result = await createRunner(model, tool).runner.run(input)
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
    expect(JSON.stringify(result)).not.toMatch(
      /providerClient|rawProviderPayload|redacted-test-value|test-only\/absolute/u,
    )
  })
})
