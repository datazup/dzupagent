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
  recordProviderSuccess: ReturnType<typeof vi.fn>
  recordProviderFailure: ReturnType<typeof vi.fn>
}

function createMockRegistry(model: BaseChatModel, provider = 'mock-provider'): MockRegistry {
  return {
    getModel: vi.fn(() => model),
    getModelByName: vi.fn(() => model),
    getModelWithFallback: vi.fn(() => ({ model, provider })),
    recordProviderSuccess: vi.fn(),
    recordProviderFailure: vi.fn(),
  }
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
