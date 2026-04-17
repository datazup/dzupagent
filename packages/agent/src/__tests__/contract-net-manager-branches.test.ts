/**
 * Branch-coverage tests for ContractNetManager.
 * Targets: bid JSON parsing edge cases (markdown, invalid JSON),
 * CFP fields, bid deadline enforcement, abort paths, empty ranked bids,
 * winner not found branch.
 */
import { describe, it, expect, vi } from 'vitest'
import { AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import { DzupAgent } from '../agent/dzip-agent.js'
import { ContractNetManager } from '../orchestration/contract-net/contract-net-manager.js'
import { OrchestrationError } from '../orchestration/orchestration-error.js'
import {
  lowestCostStrategy,
} from '../orchestration/contract-net/bid-strategies.js'
import { createEventBus, type DzupEvent } from '@dzupagent/core'

function makeModel(respondWith: string | ((i: number) => string)): BaseChatModel {
  let i = 0
  return {
    invoke: vi.fn(async (_messages: BaseMessage[]) => {
      const content = typeof respondWith === 'function' ? respondWith(i) : respondWith
      i++
      return new AIMessage({ content, response_metadata: {} })
    }),
    bindTools: vi.fn(function (this: BaseChatModel) { return this }),
    _modelType: () => 'base_chat_model',
    _llmType: () => 'mock',
  } as unknown as BaseChatModel
}

function makeAgent(id: string, model: BaseChatModel): DzupAgent {
  return new DzupAgent({ id, description: id, instructions: `You are ${id}.`, model })
}

describe('ContractNetManager — branch coverage', () => {
  it('parses bids from markdown-fenced JSON blocks', async () => {
    // First call returns a bid wrapped in ```json fences
    // Second call is the execution
    let i = 0
    const model = {
      invoke: vi.fn(async () => {
        i++
        if (i === 1) {
          return new AIMessage({
            content: '```json\n{"estimatedCostCents":50,"estimatedDurationMs":100,"qualityEstimate":0.9,"confidence":0.8,"approach":"fenced"}\n```',
            response_metadata: {},
          })
        }
        return new AIMessage({ content: 'executed', response_metadata: {} })
      }),
      bindTools: vi.fn(function (this: BaseChatModel) { return this }),
      _modelType: () => 'base_chat_model',
      _llmType: () => 'mock',
    } as unknown as BaseChatModel

    const agent = makeAgent('spec', model)
    const result = await ContractNetManager.execute({
      specialists: [agent],
      task: 'do it',
      strategy: lowestCostStrategy,
    })
    expect(result.success).toBe(true)
    expect(result.agentId).toBe('spec')
  })

  it('clamps out-of-range qualityEstimate and confidence to [0, 1]', async () => {
    // Return bid with values outside [0,1]
    let i = 0
    const model = {
      invoke: vi.fn(async () => {
        i++
        if (i === 1) {
          return new AIMessage({
            content: JSON.stringify({
              estimatedCostCents: 10,
              estimatedDurationMs: 100,
              qualityEstimate: 10, // way above 1
              confidence: -1,      // below 0
              approach: 'clamp',
            }),
            response_metadata: {},
          })
        }
        return new AIMessage({ content: 'done', response_metadata: {} })
      }),
      bindTools: vi.fn(function (this: BaseChatModel) { return this }),
      _modelType: () => 'base_chat_model',
      _llmType: () => 'mock',
    } as unknown as BaseChatModel
    const agent = makeAgent('spec', model)
    const result = await ContractNetManager.execute({
      specialists: [agent],
      task: 'clamp test',
    })
    expect(result.success).toBe(true)
  })

  it('provides default values when bid JSON is missing fields', async () => {
    let i = 0
    const model = {
      invoke: vi.fn(async () => {
        i++
        if (i === 1) {
          return new AIMessage({
            content: JSON.stringify({}),
            response_metadata: {},
          })
        }
        return new AIMessage({ content: 'done', response_metadata: {} })
      }),
      bindTools: vi.fn(function (this: BaseChatModel) { return this }),
      _modelType: () => 'base_chat_model',
      _llmType: () => 'mock',
    } as unknown as BaseChatModel
    const agent = makeAgent('spec', model)
    const result = await ContractNetManager.execute({
      specialists: [agent],
      task: 'default-fields',
    })
    expect(result.success).toBe(true)
  })

  it('throws when aborted before execution starts', async () => {
    const model = makeModel(JSON.stringify({
      estimatedCostCents: 1, estimatedDurationMs: 1,
      qualityEstimate: 1, confidence: 1, approach: 'ok',
    }))
    const agent = makeAgent('spec', model)
    const controller = new AbortController()
    controller.abort()
    await expect(
      ContractNetManager.execute({
        specialists: [agent],
        task: 'pre-abort',
        signal: controller.signal,
      }),
    ).rejects.toThrow(OrchestrationError)
  })

  it('emits announce/bid/award/completed events through eventBus', async () => {
    const events: DzupEvent[] = []
    const bus = createEventBus()
    bus.onAny((e) => events.push(e))
    let i = 0
    const model = {
      invoke: vi.fn(async () => {
        i++
        if (i === 1) {
          return new AIMessage({
            content: JSON.stringify({
              estimatedCostCents: 10, estimatedDurationMs: 1,
              qualityEstimate: 0.9, confidence: 0.9, approach: 'A',
            }),
            response_metadata: {},
          })
        }
        return new AIMessage({ content: 'fin', response_metadata: {} })
      }),
      bindTools: vi.fn(function (this: BaseChatModel) { return this }),
      _modelType: () => 'base_chat_model',
      _llmType: () => 'mock',
    } as unknown as BaseChatModel
    const agent = makeAgent('spec', model)

    const result = await ContractNetManager.execute({
      specialists: [agent],
      task: 'events',
      eventBus: bus,
    })
    expect(result.success).toBe(true)
    const types = events
      .filter((e) => e.type === 'protocol:message_sent')
      .map((e) => (e as unknown as { messageType: string }).messageType)
    expect(types).toContain('contract-net:cfp_announced')
    expect(types).toContain('contract-net:bid_received')
    expect(types).toContain('contract-net:awarded')
    expect(types).toContain('contract-net:completed')
  })

  it('includes requiredCapabilities and maxCostCents in CFP prompt', async () => {
    const invokeCalls: BaseMessage[][] = []
    const model = {
      invoke: vi.fn(async (msgs: BaseMessage[]) => {
        invokeCalls.push(msgs)
        return new AIMessage({
          content: JSON.stringify({
            estimatedCostCents: 10, estimatedDurationMs: 1,
            qualityEstimate: 0.9, confidence: 0.9, approach: 'A',
          }),
          response_metadata: {},
        })
      }),
      bindTools: vi.fn(function (this: BaseChatModel) { return this }),
      _modelType: () => 'base_chat_model',
      _llmType: () => 'mock',
    } as unknown as BaseChatModel
    const agent = makeAgent('spec', model)
    await ContractNetManager.execute({
      specialists: [agent],
      task: 'cfp-content',
      requiredCapabilities: ['foo', 'bar'],
      maxCostCents: 500,
    })
    // The first invoke corresponds to the bid request
    const bidMsgs = invokeCalls[0]!
    const content = (bidMsgs.map(m =>
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    )).join('\n')
    expect(content).toContain('Required capabilities: foo, bar')
    expect(content).toContain('Maximum budget: 500 cents')
  })

  it('emits failed event when execution throws', async () => {
    const events: DzupEvent[] = []
    const bus = createEventBus()
    bus.onAny((e) => events.push(e))
    let i = 0
    const model = {
      invoke: vi.fn(async () => {
        i++
        if (i === 1) {
          return new AIMessage({
            content: JSON.stringify({
              estimatedCostCents: 10, estimatedDurationMs: 1,
              qualityEstimate: 0.9, confidence: 0.9, approach: 'A',
            }),
            response_metadata: {},
          })
        }
        throw new Error('execution failed!')
      }),
      bindTools: vi.fn(function (this: BaseChatModel) { return this }),
      _modelType: () => 'base_chat_model',
      _llmType: () => 'mock',
    } as unknown as BaseChatModel
    const agent = makeAgent('spec', model)

    const result = await ContractNetManager.execute({
      specialists: [agent],
      task: 'error-during-exec',
      eventBus: bus,
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('execution failed!')
    const failedType = events
      .filter((e) => e.type === 'protocol:message_sent')
      .map((e) => (e as unknown as { messageType: string }).messageType)
    expect(failedType).toContain('contract-net:failed')
  })

  it('uses default bid deadline when not configured', async () => {
    // Just confirms the default path runs; if a default wasn't used, no bid
    // would parse because timeout is too short.
    const model = makeModel((i) =>
      i === 0
        ? JSON.stringify({
            estimatedCostCents: 1, estimatedDurationMs: 1,
            qualityEstimate: 1, confidence: 1, approach: 'd',
          })
        : 'done')
    const agent = makeAgent('spec', model)
    const result = await ContractNetManager.execute({
      specialists: [agent],
      task: 'default-deadline',
    })
    expect(result.success).toBe(true)
  })

  it('returns a result with actualDurationMs >= 0', async () => {
    const model = makeModel((i) =>
      i === 0
        ? JSON.stringify({
            estimatedCostCents: 1, estimatedDurationMs: 1,
            qualityEstimate: 1, confidence: 1, approach: 'd',
          })
        : 'done')
    const agent = makeAgent('spec', model)
    const result = await ContractNetManager.execute({
      specialists: [agent],
      task: 'duration',
    })
    expect(result.actualDurationMs).toBeGreaterThanOrEqual(0)
  })
})
