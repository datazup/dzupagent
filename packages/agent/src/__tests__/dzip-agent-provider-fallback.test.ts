/**
 * Provider-fallback / circuit-breaker integration tests for DzupAgent.
 *
 * Audit fix RF-AGENT-06:
 * - Documents the **selection-time only** fallback decision: the provider
 *   is chosen once at agent construction via
 *   `ModelRegistry.getModelWithFallback`; mid-run failover is intentionally
 *   out of scope.
 * - Verifies the streaming path records circuit-breaker outcomes against
 *   the same provider the non-streaming path uses, closing the gap where
 *   `streamModel.stream(...)` previously bypassed
 *   `recordProviderSuccess` / `recordProviderFailure`.
 */
import { describe, it, expect, vi } from 'vitest'
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { DzupAgent } from '../agent/dzip-agent.js'
import type { AgentStreamEvent, DzupAgentConfig } from '../agent/agent-types.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createSucceedingStreamModel(text: string): BaseChatModel {
  const model: Record<string, unknown> = {
    invoke: vi.fn(async (_msgs: BaseMessage[]) => new AIMessage(text)),
    bindTools: vi.fn().mockReturnThis(),
    stream: vi.fn(async function* (_msgs: BaseMessage[]) {
      yield new AIMessage(text)
    }),
  }
  return model as unknown as BaseChatModel
}

function createTransientFailingStreamModel(): BaseChatModel {
  const model: Record<string, unknown> = {
    invoke: vi.fn(async () => {
      throw new Error('429 rate_limit exceeded')
    }),
    bindTools: vi.fn().mockReturnThis(),
    // Simulate a provider whose .stream() throws synchronously when called
    // (resolved with a rejected promise) — emulating an upstream 429 before
    // any chunk is yielded.
    stream: vi.fn(async () => {
      throw new Error('429 rate_limit exceeded during stream')
    }),
  }
  return model as unknown as BaseChatModel
}

function createFailingInvokeModel(message = '429 rate_limit exceeded'): BaseChatModel {
  const model: Record<string, unknown> = {
    invoke: vi.fn(async () => {
      throw new Error(message)
    }),
    bindTools: vi.fn().mockReturnThis(),
  }
  return model as unknown as BaseChatModel
}

function createToolRequestModel(toolName: string): BaseChatModel {
  let calls = 0
  const model: Record<string, unknown> = {
    invoke: vi.fn(async () => {
      calls++
      if (calls === 1) {
        return new AIMessage({
          content: '',
          tool_calls: [{ id: 'call_1', name: toolName, args: {} }],
        })
      }
      throw new Error('429 rate_limit exceeded after tool')
    }),
    bindTools: vi.fn().mockReturnThis(),
  }
  return model as unknown as BaseChatModel
}

function createMidStreamFailingModel(): BaseChatModel {
  const model: Record<string, unknown> = {
    invoke: vi.fn(),
    bindTools: vi.fn().mockReturnThis(),
    // Yield one chunk, then throw a transient error mid-stream.
    stream: vi.fn(async function* (_msgs: BaseMessage[]) {
      yield new AIMessage('partial ')
      throw new Error('overloaded — please retry')
    }),
  }
  return model as unknown as BaseChatModel
}

interface MockRegistry {
  getModel: ReturnType<typeof vi.fn>
  getModelByName: ReturnType<typeof vi.fn>
  getModelWithFallback: ReturnType<typeof vi.fn>
  getModelFallbackCandidates: ReturnType<typeof vi.fn>
  recordProviderSuccess: ReturnType<typeof vi.fn>
  recordProviderFailure: ReturnType<typeof vi.fn>
}

function createMockRegistry(model: BaseChatModel, provider = 'mock-provider'): MockRegistry {
  return {
    getModel: vi.fn(() => model),
    getModelByName: vi.fn(() => model),
    getModelWithFallback: vi.fn(() => ({ model, provider })),
    getModelFallbackCandidates: vi.fn(() => ([{ model, provider, modelName: provider + '-model' }])),
    recordProviderSuccess: vi.fn(),
    recordProviderFailure: vi.fn(),
  }
}

function createFailoverRegistry(
  primary: BaseChatModel,
  secondary: BaseChatModel,
): MockRegistry {
  return {
    getModel: vi.fn(() => primary),
    getModelByName: vi.fn(() => primary),
    getModelWithFallback: vi.fn(() => ({ model: primary, provider: 'primary' })),
    getModelFallbackCandidates: vi.fn(() => [
      { model: primary, provider: 'primary', modelName: 'primary-model' },
      { model: secondary, provider: 'secondary', modelName: 'secondary-model' },
    ]),
    recordProviderSuccess: vi.fn(),
    recordProviderFailure: vi.fn(),
  }
}

function mockTool(name: string): StructuredToolInterface {
  return {
    name,
    description: `Mock tool ${name}`,
    schema: {} as never,
    lc_namespace: [] as string[],
    invoke: vi.fn(async () => 'tool ok'),
  } as unknown as StructuredToolInterface
}

function minimalConfig(overrides: Partial<DzupAgentConfig> = {}): DzupAgentConfig {
  return {
    id: 'test-agent',
    instructions: 'You are a test agent.',
    model: 'chat',
    ...overrides,
  }
}

async function consume(stream: AsyncGenerator<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = []
  for await (const ev of stream) events.push(ev)
  return events
}

// ---------------------------------------------------------------------------
// Selection-time fallback (both modes)
// ---------------------------------------------------------------------------

describe('DzupAgent provider fallback — selection-time only', () => {
  it('skips an open-circuit provider at construction (generate path)', async () => {
    // Two providers in the chain; getModelWithFallback simulates the registry
    // skipping the first because its breaker is open and returning the second.
    const goodModel = createSucceedingStreamModel('hello')

    const registry: MockRegistry = {
      getModel: vi.fn(),
      getModelByName: vi.fn(),
      getModelWithFallback: vi.fn(() => ({ model: goodModel, provider: 'secondary' })),
      getModelFallbackCandidates: vi.fn(),
      recordProviderSuccess: vi.fn(),
      recordProviderFailure: vi.fn(),
    }

    const agent = new DzupAgent(minimalConfig({
      model: 'chat',
      registry: registry as never,
    }))

    expect(registry.getModelWithFallback).toHaveBeenCalledWith('chat')
    const result = await agent.generate([new HumanMessage('hi')])
    expect(result.content).toBe('hello')
    // The selected provider's breaker received the success signal.
    expect(registry.recordProviderSuccess).toHaveBeenCalledWith('secondary')
    expect(registry.recordProviderFailure).not.toHaveBeenCalled()
  })

  it('skips an open-circuit provider at construction (stream path)', async () => {
    const goodModel = createSucceedingStreamModel('streamed')
    const registry: MockRegistry = {
      getModel: vi.fn(),
      getModelByName: vi.fn(),
      getModelWithFallback: vi.fn(() => ({ model: goodModel, provider: 'secondary' })),
      getModelFallbackCandidates: vi.fn(),
      recordProviderSuccess: vi.fn(),
      recordProviderFailure: vi.fn(),
    }

    const agent = new DzupAgent(minimalConfig({
      model: 'chat',
      registry: registry as never,
    }))

    expect(registry.getModelWithFallback).toHaveBeenCalledWith('chat')

    const events = await consume(agent.stream([new HumanMessage('hi')]))
    const text = events.find(e => e.type === 'text')
    expect(text).toBeDefined()
    expect(registry.recordProviderSuccess).toHaveBeenCalledWith('secondary')
  })
})

// ---------------------------------------------------------------------------
// Native streaming outcome recording
// ---------------------------------------------------------------------------

describe('DzupAgent stream() — circuit-breaker outcome recording', () => {
  it('records a success against the resolved provider when the stream completes normally', async () => {
    const model = createSucceedingStreamModel('all good')
    const registry = createMockRegistry(model, 'primary')

    const agent = new DzupAgent(minimalConfig({
      registry: registry as never,
    }))

    await consume(agent.stream([new HumanMessage('hi')]))

    expect(registry.recordProviderSuccess).toHaveBeenCalledTimes(1)
    expect(registry.recordProviderSuccess).toHaveBeenCalledWith('primary')
    expect(registry.recordProviderFailure).not.toHaveBeenCalled()
  })

  it('records a failure when the stream call rejects before yielding chunks', async () => {
    const model = createTransientFailingStreamModel()
    const registry = createMockRegistry(model, 'primary')

    const agent = new DzupAgent(minimalConfig({
      registry: registry as never,
    }))

    await expect(consume(agent.stream([new HumanMessage('hi')]))).rejects.toThrow(
      /rate_limit/,
    )

    expect(registry.recordProviderFailure).toHaveBeenCalledTimes(1)
    const [providerArg, errArg] = registry.recordProviderFailure.mock.calls[0] as [string, Error]
    expect(providerArg).toBe('primary')
    expect(errArg).toBeInstanceOf(Error)
    expect(errArg.message).toMatch(/rate_limit/)
    // No success recorded for a failing call.
    expect(registry.recordProviderSuccess).not.toHaveBeenCalled()
  })

  it('records a failure when the stream throws mid-iteration', async () => {
    const model = createMidStreamFailingModel()
    const registry = createMockRegistry(model, 'primary')

    const agent = new DzupAgent(minimalConfig({
      registry: registry as never,
    }))

    await expect(consume(agent.stream([new HumanMessage('hi')]))).rejects.toThrow(
      /overloaded/,
    )

    expect(registry.recordProviderFailure).toHaveBeenCalledTimes(1)
    const [providerArg] = registry.recordProviderFailure.mock.calls[0] as [string, Error]
    expect(providerArg).toBe('primary')
    expect(registry.recordProviderSuccess).not.toHaveBeenCalled()
  })

  it('does not record provider outcomes when the agent was constructed with a direct model (no registry)', async () => {
    // No registry => no resolvedProvider => streaming path skips recording.
    const model = createSucceedingStreamModel('direct')
    const agent = new DzupAgent(minimalConfig({
      model,
      registry: undefined,
    }))

    await consume(agent.stream([new HumanMessage('hi')]))
    // Nothing to assert against (no spy) — but the test confirms the path
    // does not throw when ctx.resolvedProvider/registry are undefined.
    expect(true).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Cross-mode breaker consistency
// ---------------------------------------------------------------------------

describe('DzupAgent — breaker state consistency between generate() and stream()', () => {
  it('records outcomes for the same provider across both modes', async () => {
    const model = createSucceedingStreamModel('hello')
    const registry = createMockRegistry(model, 'primary')

    const agent = new DzupAgent(minimalConfig({
      registry: registry as never,
    }))

    await agent.generate([new HumanMessage('round 1')])
    await consume(agent.stream([new HumanMessage('round 2')]))

    // Both paths feed the same breaker (provider="primary").
    expect(registry.recordProviderSuccess).toHaveBeenCalledTimes(2)
    for (const call of registry.recordProviderSuccess.mock.calls) {
      expect(call[0]).toBe('primary')
    }
  })
})

// ---------------------------------------------------------------------------
// Opt-in run-level failover
// ---------------------------------------------------------------------------

describe('DzupAgent provider failover — opt-in run-level wrapper', () => {
  it('retries a transient generate invocation on the next provider and emits attempt events', async () => {
    const primary = createFailingInvokeModel()
    const secondary = createSucceedingStreamModel('secondary ok')
    const registry = createFailoverRegistry(primary, secondary)
    const eventBus = { emit: vi.fn() }

    const agent = new DzupAgent(minimalConfig({
      registry: registry as never,
      eventBus: eventBus as never,
      providerFailover: { enabled: true, maxAttempts: 2 },
    }))

    const result = await agent.generate([new HumanMessage('hi')])

    expect(result.content).toBe('secondary ok')
    expect(primary.invoke).toHaveBeenCalledTimes(1)
    expect(secondary.invoke).toHaveBeenCalledTimes(1)
    expect(registry.recordProviderFailure).toHaveBeenCalledWith('primary', expect.any(Error))
    expect(registry.recordProviderSuccess).toHaveBeenCalledWith('secondary')
    expect(eventBus.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'provider:run_failure',
      attempt: 1,
      provider: 'primary',
      model: 'primary-model',
      reason: expect.stringMatching(/rate_limit/),
      retrying: true,
    }))
    expect(eventBus.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'provider:run_selected',
      attempt: 2,
      provider: 'secondary',
      model: 'secondary-model',
    }))
  })

  it('does not retry a model failure after tool results by default', async () => {
    const primary = createToolRequestModel('side_effect')
    const secondary = createSucceedingStreamModel('should not run')
    const registry = createFailoverRegistry(primary, secondary)
    const tool = mockTool('side_effect')

    const agent = new DzupAgent(minimalConfig({
      registry: registry as never,
      tools: [tool],
      providerFailover: { enabled: true, maxAttempts: 2 },
      maxIterations: 2,
    }))

    await expect(agent.generate([new HumanMessage('run tool')])).rejects.toThrow(
      /rate_limit/,
    )

    expect(tool.invoke).toHaveBeenCalledTimes(1)
    expect(primary.invoke).toHaveBeenCalledTimes(2)
    expect(secondary.invoke).not.toHaveBeenCalled()
  })

  it('fails over streaming when the stream open fails before yielding chunks', async () => {
    const primary = createTransientFailingStreamModel()
    const secondary = createSucceedingStreamModel('stream fallback')
    const registry = createFailoverRegistry(primary, secondary)

    const agent = new DzupAgent(minimalConfig({
      registry: registry as never,
      providerFailover: { enabled: true, maxAttempts: 2 },
    }))

    const events = await consume(agent.stream([new HumanMessage('hi')]))

    expect(events.find(e => e.type === 'text')?.data.content).toBe('stream fallback')
    expect(primary.stream).toHaveBeenCalledTimes(1)
    expect(secondary.stream).toHaveBeenCalledTimes(1)
    expect(registry.recordProviderFailure).toHaveBeenCalledWith('primary', expect.any(Error))
    expect(registry.recordProviderSuccess).toHaveBeenCalledWith('secondary')
  })

  it('does not replay a stream on another provider after a chunk was yielded', async () => {
    const primary = createMidStreamFailingModel()
    const secondary = createSucceedingStreamModel('should not stream')
    const registry = createFailoverRegistry(primary, secondary)

    const agent = new DzupAgent(minimalConfig({
      registry: registry as never,
      providerFailover: { enabled: true, maxAttempts: 2 },
    }))

    await expect(consume(agent.stream([new HumanMessage('hi')]))).rejects.toThrow(
      /overloaded/,
    )

    expect(primary.stream).toHaveBeenCalledTimes(1)
    expect(secondary.stream).not.toHaveBeenCalled()
    expect(registry.recordProviderFailure).toHaveBeenCalledWith('primary', expect.any(Error))
  })
})
