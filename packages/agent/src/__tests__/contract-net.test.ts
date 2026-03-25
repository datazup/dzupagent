/**
 * Tests for the contract-net negotiation protocol.
 */
import { describe, it, expect, vi } from 'vitest'
import { AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import { ForgeAgent } from '../agent/forge-agent.js'
import { AgentOrchestrator } from '../orchestration/orchestrator.js'
import { ContractNetManager } from '../orchestration/contract-net/contract-net-manager.js'
import { OrchestrationError } from '../orchestration/orchestration-error.js'
import {
  lowestCostStrategy,
  fastestStrategy,
  highestQualityStrategy,
  createWeightedStrategy,
} from '../orchestration/contract-net/bid-strategies.js'
import type { ContractBid } from '../orchestration/contract-net/contract-net-types.js'

/**
 * Create a mock BaseChatModel that returns a sequence of responses.
 */
function createMockModel(
  responses: Array<{ content: string }>,
): BaseChatModel {
  let callIndex = 0
  const invoke = vi.fn(async (_messages: BaseMessage[]) => {
    const resp = responses[callIndex] ?? responses[responses.length - 1]!
    callIndex++
    return new AIMessage({
      content: resp.content,
      response_metadata: {},
    })
  })

  return {
    invoke,
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this
    }),
    _modelType: () => 'base_chat_model',
    _llmType: () => 'mock',
  } as unknown as BaseChatModel
}

function createAgent(id: string, description: string, model: BaseChatModel): ForgeAgent {
  return new ForgeAgent({
    id,
    description,
    instructions: `You are ${id}.`,
    model,
  })
}

/** Create a mock bid JSON response for a specialist agent. */
function bidResponse(bid: Partial<ContractBid>): string {
  return JSON.stringify({
    estimatedCostCents: bid.estimatedCostCents ?? 100,
    estimatedDurationMs: bid.estimatedDurationMs ?? 5000,
    qualityEstimate: bid.qualityEstimate ?? 0.8,
    confidence: bid.confidence ?? 0.9,
    approach: bid.approach ?? 'Standard approach',
  })
}

// ---------------------------------------------------------------------------
// Bid strategy tests
// ---------------------------------------------------------------------------

const sampleBids: ContractBid[] = [
  {
    agentId: 'a1', cfpId: 'cfp1',
    estimatedCostCents: 300, estimatedDurationMs: 10000,
    qualityEstimate: 0.7, confidence: 0.8, approach: 'Cheap',
  },
  {
    agentId: 'a2', cfpId: 'cfp1',
    estimatedCostCents: 100, estimatedDurationMs: 20000,
    qualityEstimate: 0.9, confidence: 0.9, approach: 'Quality',
  },
  {
    agentId: 'a3', cfpId: 'cfp1',
    estimatedCostCents: 200, estimatedDurationMs: 5000,
    qualityEstimate: 0.5, confidence: 0.7, approach: 'Fast',
  },
]

describe('Bid evaluation strategies', () => {
  it('lowestCostStrategy sorts by cost ascending', () => {
    const result = lowestCostStrategy.evaluate(sampleBids)
    expect(result.map(b => b.agentId)).toEqual(['a2', 'a3', 'a1'])
  })

  it('fastestStrategy sorts by duration ascending', () => {
    const result = fastestStrategy.evaluate(sampleBids)
    expect(result.map(b => b.agentId)).toEqual(['a3', 'a1', 'a2'])
  })

  it('highestQualityStrategy sorts by quality descending', () => {
    const result = highestQualityStrategy.evaluate(sampleBids)
    expect(result.map(b => b.agentId)).toEqual(['a2', 'a1', 'a3'])
  })

  it('strategies do not mutate the original array', () => {
    const original = [...sampleBids]
    lowestCostStrategy.evaluate(sampleBids)
    expect(sampleBids).toEqual(original)
  })

  it('strategies handle empty arrays', () => {
    expect(lowestCostStrategy.evaluate([])).toEqual([])
    expect(fastestStrategy.evaluate([])).toEqual([])
    expect(highestQualityStrategy.evaluate([])).toEqual([])
  })

  it('createWeightedStrategy normalizes weights to sum to 1', () => {
    // With weights 2:1:1 (total=4), cost weight should be 0.5
    const strategy = createWeightedStrategy({ cost: 2, speed: 1, quality: 1 })
    const result = strategy.evaluate(sampleBids)
    // a2 has lowest cost (100), so should rank well with cost-heavy weights
    expect(result[0]!.agentId).toBe('a2')
  })

  it('createWeightedStrategy scores correctly with equal weights', () => {
    const strategy = createWeightedStrategy({ cost: 1, speed: 1, quality: 1 })
    const result = strategy.evaluate(sampleBids)
    // With equal weights, the ranking depends on normalized scores
    expect(result.length).toBe(3)
    // Each bid should appear exactly once
    const ids = result.map(b => b.agentId).sort()
    expect(ids).toEqual(['a1', 'a2', 'a3'])
  })

  it('createWeightedStrategy handles single bid', () => {
    const strategy = createWeightedStrategy({ cost: 0.5, speed: 0.3, quality: 0.2 })
    const result = strategy.evaluate([sampleBids[0]!])
    expect(result).toHaveLength(1)
    expect(result[0]!.agentId).toBe('a1')
  })

  it('createWeightedStrategy uses default weights when none specified', () => {
    const strategy = createWeightedStrategy({})
    const result = strategy.evaluate(sampleBids)
    expect(result.length).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// ContractNetManager tests
// ---------------------------------------------------------------------------

describe('ContractNetManager.execute', () => {
  it('successful execution: bid -> award -> execute', async () => {
    // Specialist 1: bids, then executes if chosen
    const spec1Model = createMockModel([
      { content: bidResponse({ estimatedCostCents: 100, qualityEstimate: 0.9, approach: 'My plan A' }) },
      { content: 'Task completed successfully by spec1' },
    ])
    // Specialist 2: bids higher cost
    const spec2Model = createMockModel([
      { content: bidResponse({ estimatedCostCents: 500, qualityEstimate: 0.6, approach: 'My plan B' }) },
      { content: 'Task completed by spec2' },
    ])

    const managerModel = createMockModel([{ content: 'Managed' }])

    const manager = createAgent('manager', 'Manager', managerModel)
    const spec1 = createAgent('spec1', 'Specialist 1', spec1Model)
    const spec2 = createAgent('spec2', 'Specialist 2', spec2Model)

    const result = await ContractNetManager.execute({
      manager,
      specialists: [spec1, spec2],
      task: 'Build a widget',
      strategy: lowestCostStrategy,
    })

    expect(result.success).toBe(true)
    expect(result.agentId).toBe('spec1') // lowest cost wins
    expect(result.result).toBe('Task completed successfully by spec1')
    expect(result.cfpId).toBeTruthy()
    expect(result.actualDurationMs).toBeGreaterThanOrEqual(0)
  })

  it('no bids throws OrchestrationError', async () => {
    // Specialist returns invalid JSON (not a valid bid)
    const specModel = createMockModel([
      { content: 'I do not know how to bid' },
    ])

    const managerModel = createMockModel([{ content: 'ok' }])
    const manager = createAgent('manager', 'Manager', managerModel)
    const spec = createAgent('spec', 'Specialist', specModel)

    await expect(
      ContractNetManager.execute({
        manager,
        specialists: [spec],
        task: 'Do something',
      }),
    ).rejects.toThrow(OrchestrationError)

    try {
      await ContractNetManager.execute({
        manager,
        specialists: [spec],
        task: 'Do something',
      })
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestrationError)
      expect((err as OrchestrationError).pattern).toBe('contract-net')
      expect((err as OrchestrationError).message).toContain('No bids received')
    }
  })

  it('retryOnNoBids retries once on no bids', async () => {
    let callCount = 0
    // First call returns garbage (bid attempt 1), second call returns valid bid (retry)
    const specModel = {
      invoke: vi.fn(async () => {
        callCount++
        if (callCount === 1) {
          return new AIMessage({ content: 'not a bid', response_metadata: {} })
        }
        // Retry attempt returns valid bid, and third call is the execution
        return new AIMessage({
          content: callCount === 2
            ? bidResponse({ estimatedCostCents: 50, approach: 'retry plan' })
            : 'Task completed on retry',
          response_metadata: {},
        })
      }),
      bindTools: vi.fn(function (this: BaseChatModel) { return this }),
      _modelType: () => 'base_chat_model',
      _llmType: () => 'mock',
    } as unknown as BaseChatModel

    const managerModel = createMockModel([{ content: 'ok' }])
    const manager = createAgent('manager', 'Manager', managerModel)
    const spec = createAgent('spec', 'Specialist', specModel)

    const result = await ContractNetManager.execute({
      manager,
      specialists: [spec],
      task: 'Do something',
      retryOnNoBids: true,
    })

    expect(result.success).toBe(true)
    expect(callCount).toBeGreaterThanOrEqual(2)
  })

  it('retryOnNoBids throws after retry fails', async () => {
    const specModel = createMockModel([
      { content: 'still not a valid bid' },
    ])

    const managerModel = createMockModel([{ content: 'ok' }])
    const manager = createAgent('manager', 'Manager', managerModel)
    const spec = createAgent('spec', 'Specialist', specModel)

    await expect(
      ContractNetManager.execute({
        manager,
        specialists: [spec],
        task: 'Do something',
        retryOnNoBids: true,
      }),
    ).rejects.toThrow('No bids received after retry')
  })

  it('abort signal cancels before execution', async () => {
    const specModel = createMockModel([
      { content: bidResponse({ estimatedCostCents: 100 }) },
    ])

    const managerModel = createMockModel([{ content: 'ok' }])
    const manager = createAgent('manager', 'Manager', managerModel)
    const spec = createAgent('spec', 'Specialist', specModel)

    const controller = new AbortController()
    controller.abort()

    await expect(
      ContractNetManager.execute({
        manager,
        specialists: [spec],
        task: 'Do something',
        signal: controller.signal,
      }),
    ).rejects.toThrow('contract-net aborted before execution')
  })

  it('bid deadline timeout results in no bid from slow agent', async () => {
    // Create an agent that takes too long to respond
    const slowModel = {
      invoke: vi.fn(async (_messages: BaseMessage[], options?: { signal?: AbortSignal }) => {
        // Simulate a slow response by waiting, but respect abort signal
        return new Promise<AIMessage>((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve(new AIMessage({
              content: bidResponse({ estimatedCostCents: 50 }),
              response_metadata: {},
            }))
          }, 5000) // 5 seconds

          options?.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new Error('Aborted'))
          })
        })
      }),
      bindTools: vi.fn(function (this: BaseChatModel) { return this }),
      _modelType: () => 'base_chat_model',
      _llmType: () => 'mock',
    } as unknown as BaseChatModel

    // A fast agent that responds quickly with a valid bid
    const fastModel = createMockModel([
      { content: bidResponse({ estimatedCostCents: 100, approach: 'fast approach' }) },
      { content: 'Completed by fast agent' },
    ])

    const managerModel = createMockModel([{ content: 'ok' }])
    const manager = createAgent('manager', 'Manager', managerModel)
    const slowAgent = createAgent('slow', 'Slow agent', slowModel)
    const fastAgent = createAgent('fast', 'Fast agent', fastModel)

    const result = await ContractNetManager.execute({
      manager,
      specialists: [slowAgent, fastAgent],
      task: 'Do something',
      bidDeadlineMs: 50, // Very short deadline
    })

    // The fast agent should win since slow agent times out
    expect(result.success).toBe(true)
    expect(result.agentId).toBe('fast')
  })

  it('emits events via eventBus', async () => {
    const specModel = createMockModel([
      { content: bidResponse({ estimatedCostCents: 100, approach: 'my plan' }) },
      { content: 'Done!' },
    ])

    const managerModel = createMockModel([{ content: 'ok' }])
    const manager = createAgent('manager', 'Manager', managerModel)
    const spec = createAgent('spec', 'Specialist', specModel)

    const emitted: Array<{ type: string }> = []
    const eventBus = {
      emit: vi.fn((event: { type: string }) => { emitted.push(event) }),
      on: vi.fn(() => () => {}),
      once: vi.fn(() => () => {}),
      onAny: vi.fn(() => () => {}),
    }

    await ContractNetManager.execute({
      manager,
      specialists: [spec],
      task: 'Do something',
      eventBus: eventBus as never,
    })

    // Should have emitted: cfp_announced, bid_received, awarded, completed
    expect(eventBus.emit).toHaveBeenCalled()
    const messageTypes = emitted.map(e => (e as Record<string, unknown>)['messageType'])
    expect(messageTypes).toContain('contract-net:cfp_announced')
    expect(messageTypes).toContain('contract-net:bid_received')
    expect(messageTypes).toContain('contract-net:awarded')
    expect(messageTypes).toContain('contract-net:completed')
  })

  it('returns failed result when execution throws', async () => {
    // Specialist bids successfully but throws during execution
    let callCount = 0
    const specModel = {
      invoke: vi.fn(async () => {
        callCount++
        if (callCount === 1) {
          return new AIMessage({
            content: bidResponse({ estimatedCostCents: 100, approach: 'my plan' }),
            response_metadata: {},
          })
        }
        throw new Error('Execution failed unexpectedly')
      }),
      bindTools: vi.fn(function (this: BaseChatModel) { return this }),
      _modelType: () => 'base_chat_model',
      _llmType: () => 'mock',
    } as unknown as BaseChatModel

    const managerModel = createMockModel([{ content: 'ok' }])
    const manager = createAgent('manager', 'Manager', managerModel)
    const spec = createAgent('spec', 'Specialist', specModel)

    const result = await ContractNetManager.execute({
      manager,
      specialists: [spec],
      task: 'Do something',
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Execution failed unexpectedly')
    expect(result.agentId).toBe('spec')
  })
})

// ---------------------------------------------------------------------------
// AgentOrchestrator.contractNet delegation
// ---------------------------------------------------------------------------

describe('AgentOrchestrator.contractNet', () => {
  it('delegates to ContractNetManager.execute', async () => {
    const specModel = createMockModel([
      { content: bidResponse({ estimatedCostCents: 100, approach: 'plan' }) },
      { content: 'Completed via orchestrator' },
    ])

    const managerModel = createMockModel([{ content: 'ok' }])
    const manager = createAgent('manager', 'Manager', managerModel)
    const spec = createAgent('spec', 'Specialist', specModel)

    const result = await AgentOrchestrator.contractNet({
      manager,
      specialists: [spec],
      task: 'Build feature',
    })

    expect(result.success).toBe(true)
    expect(result.result).toBe('Completed via orchestrator')
  })
})
