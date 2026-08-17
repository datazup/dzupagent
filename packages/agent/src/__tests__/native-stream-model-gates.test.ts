import { describe, expect, it, vi } from 'vitest'
import {
  AIMessage,
  HumanMessage,
  type StandardMessageStructure,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { TokenBucket, type ModelRegistry } from '@dzupagent/core'

import { DzupAgent } from '../agent/dzip-agent.js'
import type { AgentStreamEvent, DzupAgentConfig } from '../agent/agent-types.js'
import {
  isModelCancellationError,
  isModelTimeoutError,
} from '../agent/model-timeout-error.js'
import { CostCeilingExceededError } from '../agent/rate-limit-coordinator.js'

type StreamMock = ReturnType<typeof vi.fn>
type NativeModel = BaseChatModel & { stream: StreamMock }

function usageMessage(content = 'done'): AIMessage {
  return new AIMessage<StandardMessageStructure>({
    content,
    response_metadata: { model: 'gpt-4o' },
    usage_metadata: {
      input_tokens: 1_000,
      output_tokens: 1_000,
      total_tokens: 2_000,
    },
  })
}

function successfulModel(content = 'done'): NativeModel {
  return {
    invoke: vi.fn(),
    bindTools: vi.fn().mockReturnThis(),
    model: 'gpt-4o',
    stream: vi.fn(async function* () {
      yield usageMessage(content)
    }),
  } as unknown as NativeModel
}

function openStalledModel(): NativeModel {
  return {
    invoke: vi.fn(),
    bindTools: vi.fn().mockReturnThis(),
    model: 'gpt-4o',
    stream: vi.fn(() => new Promise<AsyncIterable<AIMessage>>(() => {})),
  } as unknown as NativeModel
}

function consumptionStalledModel(): NativeModel {
  return {
    invoke: vi.fn(),
    bindTools: vi.fn().mockReturnThis(),
    model: 'gpt-4o',
    stream: vi.fn(async () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<AIMessage>>(() => {}),
      }),
    })),
  } as unknown as NativeModel
}

function partialThenStalledModel(): NativeModel {
  return {
    invoke: vi.fn(),
    bindTools: vi.fn().mockReturnThis(),
    model: 'gpt-4o',
    stream: vi.fn(async function* () {
      yield new AIMessage('partial')
      await new Promise<void>(() => {})
    }),
  } as unknown as NativeModel
}

type MockRegistry = ModelRegistry & {
  getModelWithFallback: ReturnType<typeof vi.fn>
  getModelFallbackCandidates: ReturnType<typeof vi.fn>
  recordProviderSuccess: ReturnType<typeof vi.fn>
  recordProviderFailure: ReturnType<typeof vi.fn>
}

function failoverRegistry(
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
  } as unknown as MockRegistry
}

function baseConfig(
  model: BaseChatModel | 'chat',
  overrides: Partial<DzupAgentConfig> = {},
): DzupAgentConfig {
  return {
    id: 'native-stream-gates',
    instructions: 'Exercise native stream model gates.',
    model,
    ...overrides,
  }
}

async function drain(agent: DzupAgent, signal?: AbortSignal): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = []
  for await (const event of agent.stream(
    [new HumanMessage('hello')],
    signal ? { signal } : undefined,
  )) {
    events.push(event)
  }
  return events
}

function sharedClient() {
  let requests = 0
  let totalCost = 0
  return {
    incr: vi.fn(async () => ++requests),
    expire: vi.fn(async () => 1),
    get: vi.fn(async () => null),
    del: vi.fn(async () => 1),
    incrByFloat: vi.fn(async (_key: string, increment: number) => {
      totalCost += increment
      return totalCost
    }),
  }
}

describe('native stream model-gate parity', () => {
  it('takes one local rate token and threads a live signal into one stream attempt', async () => {
    const model = successfulModel()
    const limiter = new TokenBucket({ capacity: 10, refillPerSecond: 10 })
    const wait = vi.spyOn(limiter, 'waitUntilAvailable')
    const agent = new DzupAgent(baseConfig(model, {
      rateLimiter: limiter,
      guardrails: { modelTimeoutMs: 1_000 },
    }))

    await drain(agent)

    expect(wait).toHaveBeenCalledTimes(1)
    expect(wait).toHaveBeenCalledWith(1)
    expect(model.stream).toHaveBeenCalledTimes(1)
    const options = model.stream.mock.calls[0]?.[1] as
      | { signal?: AbortSignal }
      | undefined
    expect(options?.signal).toBeInstanceOf(AbortSignal)
    expect(options?.signal?.aborted).toBe(false)
  })

  it('takes exactly one local rate token for every actual failover attempt', async () => {
    const primary = {
      invoke: vi.fn(),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(async () => {
        throw new Error('429 transient open failure')
      }),
    } as unknown as NativeModel
    const secondary = successfulModel('secondary')
    const registry = failoverRegistry(primary, secondary)
    const limiter = new TokenBucket({ capacity: 10, refillPerSecond: 10 })
    const wait = vi.spyOn(limiter, 'waitUntilAvailable')
    const agent = new DzupAgent(baseConfig('chat', {
      registry,
      rateLimiter: limiter,
      providerFailover: { enabled: true, shouldRetry: () => true },
    }))

    const events = await drain(agent)

    expect(events.findLast(event => event.type === 'done')?.data.content).toBe(
      'secondary',
    )
    expect(wait).toHaveBeenCalledTimes(2)
    expect(primary.stream).toHaveBeenCalledTimes(1)
    expect(secondary.stream).toHaveBeenCalledTimes(1)
  })

  it('does not contact, blame, or fail over a provider after rate admission fails', async () => {
    const primary = successfulModel('primary')
    const secondary = successfulModel('secondary')
    const registry = failoverRegistry(primary, secondary)
    const limiter = new TokenBucket({ capacity: 10, refillPerSecond: 10 })
    const denial = new Error('local rate admission denied')
    const wait = vi
      .spyOn(limiter, 'waitUntilAvailable')
      .mockRejectedValueOnce(denial)
    const agent = new DzupAgent(baseConfig('chat', {
      registry,
      rateLimiter: limiter,
      providerFailover: { enabled: true, shouldRetry: () => true },
    }))

    await expect(drain(agent)).rejects.toBe(denial)
    expect(wait).toHaveBeenCalledTimes(1)
    expect(primary.stream).not.toHaveBeenCalled()
    expect(secondary.stream).not.toHaveBeenCalled()
    expect(registry.recordProviderFailure).not.toHaveBeenCalled()
  })

  it('bounds a provider that never opens with the model timeout', async () => {
    const model = openStalledModel()
    const agent = new DzupAgent(baseConfig(model, {
      guardrails: { modelTimeoutMs: 40 },
    }))

    await expect(drain(agent)).rejects.toSatisfy(isModelTimeoutError)
    const options = model.stream.mock.calls[0]?.[1] as
      | { signal?: AbortSignal }
      | undefined
    expect(options?.signal?.aborted).toBe(true)
  }, 5_000)

  it('bounds a stream that opens and then stalls with the model timeout', async () => {
    const model = consumptionStalledModel()
    const agent = new DzupAgent(baseConfig(model, {
      guardrails: { modelTimeoutMs: 40 },
    }))

    await expect(drain(agent)).rejects.toSatisfy(isModelTimeoutError)
    expect(model.stream).toHaveBeenCalledTimes(1)
  }, 5_000)

  it('applies the whole-run deadline while consuming a stalled stream', async () => {
    const model = consumptionStalledModel()
    const agent = new DzupAgent(baseConfig(model, {
      guardrails: { maxDurationMs: 40 },
    }))

    await expect(drain(agent)).rejects.toSatisfy(isModelCancellationError)
  }, 5_000)

  it('terminates a pre-open caller abort without contacting the provider', async () => {
    const model = successfulModel()
    const agent = new DzupAgent(baseConfig(model))

    await expect(drain(agent, AbortSignal.abort())).resolves.toEqual(
      [{ type: 'done', data: { stopReason: 'aborted' } }],
    )
    expect(model.stream).not.toHaveBeenCalled()
  })

  it('releases a caller after partial output when the signal aborts mid-stream', async () => {
    const controller = new AbortController()
    const model = partialThenStalledModel()
    const agent = new DzupAgent(baseConfig(model))
    const stream = agent.stream([new HumanMessage('hello')], {
      signal: controller.signal,
    })

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'text', data: { content: 'partial' } },
    })
    controller.abort()
    await expect(stream.next()).rejects.toSatisfy(isModelCancellationError)
    expect(model.stream).toHaveBeenCalledTimes(1)
  }, 5_000)

  it('records one distributed cost entry only after real streamed usage completes', async () => {
    const client = sharedClient()
    const agent = new DzupAgent(baseConfig(successfulModel(), {
      memoryScope: { tenantId: 'tenant-a' },
      guardrails: {
        distributed: {
          costLedger: { client, maxCostUsd: 10 },
        },
      },
    }))

    await drain(agent)

    expect(client.incrByFloat).toHaveBeenCalledTimes(1)
    expect(client.incrByFloat).toHaveBeenCalledWith(
      'dzupagent:cost:tenant-a:native-stream-gates',
      expect.any(Number),
    )
    expect(client.incrByFloat.mock.calls[0]?.[1]).toBeGreaterThan(0)
  })

  it('does not write estimated usage into the distributed cost ledger', async () => {
    const client = sharedClient()
    const model = {
      invoke: vi.fn(),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(async function* () {
        yield new AIMessage('usage missing')
      }),
    } as unknown as NativeModel
    const agent = new DzupAgent(baseConfig(model, {
      guardrails: {
        distributed: { costLedger: { client, maxCostUsd: 10 } },
      },
    }))

    await drain(agent)

    expect(client.incrByFloat).not.toHaveBeenCalled()
  })

  it('stops on a confirmed cost breach without blaming or trying another provider', async () => {
    const client = sharedClient()
    const primary = successfulModel('primary')
    const secondary = successfulModel('secondary')
    const registry = failoverRegistry(primary, secondary)
    const agent = new DzupAgent(baseConfig('chat', {
      registry,
      providerFailover: { enabled: true, shouldRetry: () => true },
      guardrails: {
        distributed: { costLedger: { client, maxCostUsd: 0 } },
      },
    }))

    await expect(drain(agent)).rejects.toBeInstanceOf(CostCeilingExceededError)
    expect(client.incrByFloat).toHaveBeenCalledTimes(1)
    expect(primary.stream).toHaveBeenCalledTimes(1)
    expect(secondary.stream).not.toHaveBeenCalled()
    expect(registry.recordProviderSuccess).toHaveBeenCalledWith('primary')
    expect(registry.recordProviderFailure).not.toHaveBeenCalled()
  })
})
