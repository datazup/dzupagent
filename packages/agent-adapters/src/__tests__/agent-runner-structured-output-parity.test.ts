import { AIMessage, HumanMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import {
  AGENT_RUNNER_STRUCTURED_OUTPUT_CAPABILITY_SCHEMA,
  InMemoryAgentRunner,
  InMemoryAgentRunnerPersistence,
  RunControl,
  type AgentRunnerIdentityKind,
  type AgentRunnerInput,
  type AgentRunnerModelPort,
} from '@dzupagent/agent/runner'
import {
  AGENT_STRUCTURED_OUTPUT_REQUEST_SCHEMA,
  type AgentRunJsonObject,
  type AgentStructuredOutputStrategy,
} from '@dzupagent/agent-types/run'
import { describeStructuredOutputSchema } from '@dzupagent/core'
import { DzupAgent, type DzupAgentConfig } from '@dzupagent/agent'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import {
  ProviderFreeAgentRunnerModelAdapter,
  type ProviderFreeAgentRunnerModelState,
  type ProviderFreeAgentRunnerStructuredAttempt,
} from '../integration/agent-runner-provider-free.js'

const schema = z.object({ answer: z.number() })
const schemaName = 'r5j-agent.generation.answer'
const descriptor = describeStructuredOutputSchema(schema, { schemaName, provider: 'generic' })

function ids(): (kind: AgentRunnerIdentityKind) => string {
  const counters = new Map<AgentRunnerIdentityKind, number>()
  return (kind) => {
    const value = (counters.get(kind) ?? 0) + 1
    counters.set(kind, value)
    return `${kind}-${value}`
  }
}

function runnerInput(
  allowedStrategies: readonly AgentStructuredOutputStrategy[] = [
    'native-json-schema',
    'json-text',
  ],
  maxAttempts = 3,
): AgentRunnerInput {
  return {
    agentId: 'r5j-agent',
    behaviorDigest: 'sha256:r5j-structured-output',
    items: [{
      type: 'message',
      itemId: 'input-1',
      role: 'user',
      content: [{ type: 'text', text: 'Return the answer.' }],
    }],
    structuredOutput: {
      schema: AGENT_STRUCTURED_OUTPUT_REQUEST_SCHEMA,
      schemaName,
      schemaDigest: descriptor.schemaHash,
      jsonSchema: descriptor.jsonSchema as AgentRunJsonObject,
      allowedStrategies,
      maxAttempts,
    },
  }
}

function modelState(
  strategies: readonly AgentStructuredOutputStrategy[],
  attempts: readonly ProviderFreeAgentRunnerStructuredAttempt[],
  usage = { accountingSource: 'provider-free-r5j', inputTokens: 8, outputTokens: 3, totalTokens: 11 },
): ProviderFreeAgentRunnerModelState {
  return {
    schema: 'dzupagent.providerFreeAgentRunnerModel/v1',
    cursor: 0,
    structuredOutputCapabilities: {
      schema: AGENT_RUNNER_STRUCTURED_OUTPUT_CAPABILITY_SCHEMA,
      strategies,
    },
    steps: [{
      status: 'completed',
      content: [],
      structuredAttempts: attempts,
      usage,
      finishReason: 'stop',
    }],
  }
}

function runner(model: AgentRunnerModelPort): InMemoryAgentRunner {
  return new InMemoryAgentRunner({
    model,
    persistence: new InMemoryAgentRunnerPersistence(),
    createId: ids(),
    now: () => '2026-08-10T12:00:00.000Z',
  })
}

function legacyModel(options: {
  readonly text?: readonly string[]
  readonly native?: { readonly value?: unknown; readonly reject?: boolean }
  readonly fallbackOnly?: boolean
}) {
  let cursor = 0
  const invoke = vi.fn(async () => {
    const text = options.text?.[cursor] ?? options.text?.at(-1) ?? '{"answer":42}'
    cursor += 1
    return new AIMessage({
      content: text,
      usage_metadata: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
    })
  })
  const nativeInvoke = vi.fn(async () => {
    if (options.native?.reject) throw new Error('native-schema-rejected')
    return {
      parsed: options.native?.value ?? { answer: 42 },
      raw: new AIMessage({
        content: 'structured',
        usage_metadata: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
      }),
    }
  })
  const model = {
    invoke,
    bindTools: vi.fn().mockReturnThis(),
    withStructuredOutput: vi.fn(() => ({ invoke: nativeInvoke })),
    ...(options.fallbackOnly ? {
      structuredOutputCapabilities: {
        preferredStrategy: 'generic-parse' as const,
        schemaProvider: 'generic' as const,
        fallbackStrategies: ['fallback-prompt' as const],
      },
    } : {}),
  } as unknown as BaseChatModel & {
    invoke: typeof invoke
    withStructuredOutput: ReturnType<typeof vi.fn>
  }
  return { model, invoke, nativeInvoke }
}

function legacyAgent(model: BaseChatModel): DzupAgent {
  return new DzupAgent({
    id: 'r5j-agent',
    instructions: 'Return validated structured data.',
    model,
  } satisfies DzupAgentConfig)
}

function structuredEvent(result: Awaited<ReturnType<InMemoryAgentRunner['run']>>) {
  return result.events.find((event) => event.type === 'model.completed')?.payload
}

describe('AgentRunner R5J structured-output parity', () => {
  it('retains native validated value, schema identity, strategy, and comparable usage', async () => {
    const legacy = legacyModel({ native: { value: { answer: 42 } } })
    const legacyResult = await legacyAgent(legacy.model).generateStructured(
      [new HumanMessage('Return the answer.')], schema, { schemaName, schemaProvider: 'generic' },
    )
    const model = new ProviderFreeAgentRunnerModelAdapter(modelState(
      ['native-json-schema', 'json-text'], [{ outcome: 'output', text: '{"answer":42}' }],
    ))
    const result = await runner(model).run(runnerInput())

    expect(legacyResult.data).toEqual({ answer: 42 })
    expect(legacyResult.usage).toMatchObject({ totalInputTokens: 8, totalOutputTokens: 3 })
    expect(result.state.usage.records).toMatchObject([{
      inputTokens: 8, outputTokens: 3, totalTokens: 11,
    }])
    expect(structuredEvent(result)).toMatchObject({
      structuredOutput: {
        schemaName,
        schemaDigest: descriptor.schemaHash,
        strategy: 'native-json-schema',
        attempts: 1,
        value: { answer: 42 },
      },
    })
  })

  it('selects JSON text when native support is absent', async () => {
    const legacy = legacyModel({ text: ['{"answer":42}'], fallbackOnly: true })
    const legacyResult = await legacyAgent(legacy.model).generateStructured(
      [new HumanMessage('Return the answer.')], schema, { schemaName, schemaProvider: 'generic' },
    )
    const model = new ProviderFreeAgentRunnerModelAdapter(modelState(
      ['json-text'], [{ outcome: 'output', text: '```json\n{"answer":42}\n```' }],
    ))
    const result = await runner(model).run(runnerInput())

    expect(legacyResult.data).toEqual({ answer: 42 })
    expect(legacy.nativeInvoke).not.toHaveBeenCalled()
    expect(model.invocations).toMatchObject([{ structuredStrategy: 'json-text' }])
    expect(structuredEvent(result)).toMatchObject({
      structuredOutput: { strategy: 'json-text', attempts: 1 },
    })
  })

  it('allows native rejection to fall back only when JSON text is admitted', async () => {
    const legacy = legacyModel({ native: { reject: true }, text: ['{"answer":42}'] })
    await expect(legacyAgent(legacy.model).generateStructured(
      [new HumanMessage('Return the answer.')], schema, { schemaName, schemaProvider: 'generic' },
    )).resolves.toMatchObject({ data: { answer: 42 } })

    const allowed = await runner(new ProviderFreeAgentRunnerModelAdapter(modelState(
      ['native-json-schema', 'json-text'],
      [{ outcome: 'native-rejected' }, { outcome: 'output', text: '{"answer":42}' }],
    ))).run(runnerInput())
    expect(structuredEvent(allowed)).toMatchObject({
      structuredOutput: {
        strategy: 'json-text', fallbackFrom: 'native-json-schema', attempts: 2,
      },
    })

    const denied = await runner(new ProviderFreeAgentRunnerModelAdapter(modelState(
      ['native-json-schema', 'json-text'], [{ outcome: 'native-rejected' }],
    ))).run(runnerInput(['native-json-schema']))
    expect(denied.state.status).toBe('failed')
    expect(denied.events).toContainEqual(expect.objectContaining({
      type: 'model.failed',
      payload: expect.objectContaining({
        outcome: 'failed-after-dispatch',
        structuredOutput: expect.objectContaining({ failure: 'native-rejected', attempts: 1 }),
      }),
    }))
  })

  it('keeps malformed JSON and schema-invalid output as distinct typed failures', async () => {
    const malformed = await runner(new ProviderFreeAgentRunnerModelAdapter(modelState(
      ['json-text'], [{ outcome: 'output', text: 'not-json' }],
    ))).run(runnerInput(['json-text'], 1))
    const invalid = await runner(new ProviderFreeAgentRunnerModelAdapter(modelState(
      ['json-text'], [{ outcome: 'output', text: '{"answer":"wrong"}' }],
    ))).run(runnerInput(['json-text'], 1))

    expect(malformed.events).toContainEqual(expect.objectContaining({
      type: 'model.failed',
      payload: expect.objectContaining({
        structuredOutput: expect.objectContaining({ failure: 'malformed-json' }),
      }),
    }))
    expect(invalid.events).toContainEqual(expect.objectContaining({
      type: 'model.failed',
      payload: expect.objectContaining({
        structuredOutput: expect.objectContaining({ failure: 'schema-invalid' }),
      }),
    }))
  })

  it('rejects invalid schema identity and absent capability before adapter dispatch', async () => {
    const malformedModel = new ProviderFreeAgentRunnerModelAdapter(modelState(
      ['json-text'], [{ outcome: 'output', text: '{"answer":42}' }],
    ))
    const malformed = runnerInput(['json-text'])
    await expect(runner(malformedModel).run({
      ...malformed,
      structuredOutput: { ...malformed.structuredOutput!, schemaDigest: 'not-the-schema' },
    })).rejects.toThrow('AgentRunner structured-output request is invalid')
    expect(malformedModel.invocations).toHaveLength(0)

    const unsupportedModel = new ProviderFreeAgentRunnerModelAdapter(modelState(
      [], [{ outcome: 'output', text: '{"answer":42}' }],
    ))
    const unsupported = await runner(unsupportedModel).run(runnerInput())
    expect(unsupportedModel.invocations).toHaveLength(0)
    expect(unsupported.events).toContainEqual(expect.objectContaining({
      type: 'model.failed',
      payload: expect.objectContaining({
        outcome: 'failed-before-dispatch',
        structuredOutput: expect.objectContaining({ failure: 'unsupported', attempts: 0 }),
      }),
    }))
  })

  it('bounds corrective retry and commits an accepted result once', async () => {
    const legacy = legacyModel({ text: ['not-json', '{"answer":42}'], fallbackOnly: true })
    const legacyResult = await legacyAgent(legacy.model).generateStructured(
      [new HumanMessage('Return the answer.')], schema, { schemaName, schemaProvider: 'generic' },
    )
    const result = await runner(new ProviderFreeAgentRunnerModelAdapter(modelState(
      ['json-text'], [
        { outcome: 'output', text: 'not-json' },
        { outcome: 'output', text: '{"answer":42}' },
        { outcome: 'output', text: '{"answer":99}' },
      ],
    ))).run(runnerInput(['json-text'], 2))

    expect(legacyResult.data).toEqual({ answer: 42 })
    expect(legacy.invoke).toHaveBeenCalledTimes(2)
    expect(structuredEvent(result)).toMatchObject({
      structuredOutput: { attempts: 2, value: { answer: 42 } },
    })
    expect(result.state.committedItems).toHaveLength(1)
  })

  it('cancels before dispatch and makes no provider-abort claim after dispatch', async () => {
    const before = new AbortController()
    before.abort()
    const legacyBefore = legacyModel({ native: { value: { answer: 42 } } })
    await expect(legacyAgent(legacyBefore.model).generateStructured(
      [new HumanMessage('Return the answer.')], schema, { signal: before.signal },
    )).rejects.toMatchObject({ name: 'ModelCancellationError' })
    expect(legacyBefore.nativeInvoke).not.toHaveBeenCalled()

    const runnerBeforeModel = new ProviderFreeAgentRunnerModelAdapter(modelState(
      ['native-json-schema'], [{ outcome: 'output', text: '{"answer":42}' }],
    ))
    const beforeControl = new RunControl()
    beforeControl.requestCancel()
    const beforeResult = await runner(runnerBeforeModel).run(runnerInput(), { control: beforeControl })
    expect(beforeResult.state.status).toBe('cancelled')
    expect(runnerBeforeModel.invocations).toHaveLength(0)

    let releaseLegacy!: () => void
    let observedLegacy!: () => void
    const legacyDispatched = new Promise<void>((resolve) => { observedLegacy = resolve })
    const legacyGate = new Promise<void>((resolve) => { releaseLegacy = resolve })
    const legacyNativeInvoke = vi.fn(async () => {
      observedLegacy()
      await legacyGate
      return { parsed: { answer: 42 }, raw: new AIMessage('structured') }
    })
    const legacyAfterModel = {
      invoke: vi.fn(async () => new AIMessage('{"answer":42}')),
      bindTools: vi.fn().mockReturnThis(),
      withStructuredOutput: vi.fn(() => ({ invoke: legacyNativeInvoke })),
    } as unknown as BaseChatModel
    const afterAbort = new AbortController()
    const legacyRunning = legacyAgent(legacyAfterModel).generateStructured(
      [new HumanMessage('Return the answer.')], schema, { signal: afterAbort.signal },
    )
    await legacyDispatched
    afterAbort.abort()
    releaseLegacy()
    await expect(legacyRunning).resolves.toMatchObject({ data: { answer: 42 } })
    expect(legacyNativeInvoke).toHaveBeenCalledTimes(1)

    let release!: () => void
    let observed!: () => void
    const dispatched = new Promise<void>((resolve) => { observed = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const delegate = new ProviderFreeAgentRunnerModelAdapter(modelState(
      ['native-json-schema'], [{ outcome: 'output', text: '{"answer":42}' }],
    ))
    const delayed: AgentRunnerModelPort = {
      adapterId: 'delayed-provider-free-r5j',
      structuredOutputCapabilities: delegate.structuredOutputCapabilities,
      invoke: async (request) => {
        observed()
        await gate
        return delegate.invoke(request)
      },
    }
    const afterControl = new RunControl()
    const running = runner(delayed).run(runnerInput(), { control: afterControl })
    await dispatched
    afterControl.requestCancel()
    release()
    const afterResult = await running
    expect(afterResult.state.status).toBe('cancelled')
    expect(delegate.invocations).toHaveLength(1)
    expect(afterResult.events.some((event) => event.type === 'model.failed')).toBe(false)
    expect(afterResult.events).toContainEqual(expect.objectContaining({ type: 'model.completed' }))
  })

  it('keeps unrelated legacy obligations explicitly unsupported', () => {
    const profile = {
      memory: 'unsupported',
      middleware: 'unsupported',
      providerFailover: 'unsupported',
      legacyDiagnosticDetails: 'unsupported',
    } as const
    expect(new Set(Object.values(profile))).toEqual(new Set(['unsupported']))
  })
})
