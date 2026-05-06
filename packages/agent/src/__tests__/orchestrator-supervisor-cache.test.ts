/**
 * Tests for AgentOrchestrator.supervisor() agent-instance memoization (H-26).
 *
 * The supervisor() method should reuse the manager-with-tools DzupAgent
 * instance per (managerId, sortedSpecialistIds) cache key, only paying
 * full init cost when the specialist set changes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import { DzupAgent } from '../agent/dzip-agent.js'
import { AgentOrchestrator } from '../orchestration/orchestrator.js'
import type { AgentCircuitBreaker } from '../orchestration/circuit-breaker.js'

function createMockModel(
  responses: Array<{
    content: string
    tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>
  }>,
): BaseChatModel {
  let callIndex = 0
  const invoke = vi.fn(async (_messages: BaseMessage[]) => {
    const resp = responses[callIndex] ?? responses[responses.length - 1]!
    callIndex++
    return new AIMessage({
      content: resp.content,
      tool_calls: resp.tool_calls?.map(tc => ({
        id: tc.id,
        name: tc.name,
        args: tc.args,
        type: 'tool_call' as const,
      })),
      response_metadata: {},
    })
  })

  return {
    invoke,
    bindTools: vi.fn(function (this: BaseChatModel, _tools: unknown[]) {
      return this
    }),
    _modelType: () => 'base_chat_model',
    _llmType: () => 'mock',
  } as unknown as BaseChatModel
}

function createAgent(id: string, model: BaseChatModel): DzupAgent {
  return new DzupAgent({
    id,
    description: `Agent ${id}`,
    instructions: `You are ${id}.`,
    model,
  })
}

function createBreakerSpy(): AgentCircuitBreaker {
  return {
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    recordTimeout: vi.fn(),
    filterAvailable: vi.fn((agents) => agents),
    getState: vi.fn(() => 'closed'),
  } as unknown as AgentCircuitBreaker
}

/**
 * Helper: peek at the cache via supervisor() side effects.
 *
 * We can't access the private cache field directly, but we can spy on
 * `DzupAgent`'s asTool() to count how many times specialists were
 * converted to tools -- this is the canonical proof of cache reuse.
 */

describe('AgentOrchestrator.supervisor() agent caching (H-26)', () => {
  beforeEach(() => {
    AgentOrchestrator.clearSupervisorCache()
  })

  it('returns the same cached supervisor agent for identical specialists', async () => {
    const managerModel = createMockModel([{ content: 'done' }])
    const specModel = createMockModel([{ content: 'spec output' }])

    const manager = createAgent('manager-1', managerModel)
    const specialist = createAgent('spec-a', specModel)

    // Spy on asTool to count construction work.
    const asToolSpy = vi.spyOn(specialist, 'asTool')

    await AgentOrchestrator.supervisor({
      manager,
      specialists: [specialist],
      task: 'first task',
    })
    const firstCallCount = asToolSpy.mock.calls.length

    await AgentOrchestrator.supervisor({
      manager,
      specialists: [specialist],
      task: 'second task',
    })
    const secondCallCount = asToolSpy.mock.calls.length

    // asTool() must NOT be called again on cache hit -- proves the
    // manager-with-tools DzupAgent and its specialist tools were reused.
    expect(firstCallCount).toBe(1)
    expect(secondCallCount).toBe(1)
  })

  it('treats specialist order as irrelevant to cache key', async () => {
    const managerModel = createMockModel([{ content: 'done' }])

    const manager = createAgent('manager-2', managerModel)
    const a = createAgent('spec-a', createMockModel([{ content: 'A' }]))
    const b = createAgent('spec-b', createMockModel([{ content: 'B' }]))

    const aSpy = vi.spyOn(a, 'asTool')
    const bSpy = vi.spyOn(b, 'asTool')

    await AgentOrchestrator.supervisor({
      manager,
      specialists: [a, b],
      task: 't1',
    })

    await AgentOrchestrator.supervisor({
      manager,
      specialists: [b, a], // reversed -- should hit the same cache entry
      task: 't2',
    })

    expect(aSpy).toHaveBeenCalledTimes(1)
    expect(bSpy).toHaveBeenCalledTimes(1)
  })

  it('builds a new supervisor agent when the specialist set changes', async () => {
    const managerModel = createMockModel([{ content: 'done' }])
    const manager = createAgent('manager-3', managerModel)

    const a = createAgent('spec-a', createMockModel([{ content: 'A' }]))
    const b = createAgent('spec-b', createMockModel([{ content: 'B' }]))
    const aSpy = vi.spyOn(a, 'asTool')
    const bSpy = vi.spyOn(b, 'asTool')

    await AgentOrchestrator.supervisor({
      manager,
      specialists: [a],
      task: 't1',
    })
    expect(aSpy).toHaveBeenCalledTimes(1)
    expect(bSpy).toHaveBeenCalledTimes(0)

    // Different specialist set => cache miss, fresh construction.
    await AgentOrchestrator.supervisor({
      manager,
      specialists: [a, b],
      task: 't2',
    })
    // a is converted again as part of the new key's tool list.
    expect(aSpy).toHaveBeenCalledTimes(2)
    expect(bSpy).toHaveBeenCalledTimes(1)
  })

  it('uses distinct cache entries per managerId', async () => {
    const m1 = createAgent('manager-x', createMockModel([{ content: 'done' }]))
    const m2 = createAgent('manager-y', createMockModel([{ content: 'done' }]))
    const specialist = createAgent('shared-spec', createMockModel([{ content: 'S' }]))
    const specSpy = vi.spyOn(specialist, 'asTool')

    await AgentOrchestrator.supervisor({
      manager: m1,
      specialists: [specialist],
      task: 't1',
    })

    await AgentOrchestrator.supervisor({
      manager: m2,
      specialists: [specialist],
      task: 't2',
    })

    // Different manager => different cache entry => fresh asTool() call.
    expect(specSpy).toHaveBeenCalledTimes(2)
  })

  it('clearSupervisorCache() forces reconstruction on the next call', async () => {
    const manager = createAgent('manager-4', createMockModel([{ content: 'done' }]))
    const specialist = createAgent('spec-c', createMockModel([{ content: 'C' }]))
    const specSpy = vi.spyOn(specialist, 'asTool')

    await AgentOrchestrator.supervisor({
      manager,
      specialists: [specialist],
      task: 't1',
    })
    expect(specSpy).toHaveBeenCalledTimes(1)

    AgentOrchestrator.clearSupervisorCache()

    await AgentOrchestrator.supervisor({
      manager,
      specialists: [specialist],
      task: 't2',
    })
    expect(specSpy).toHaveBeenCalledTimes(2)
  })

  it('does not reuse cached tools when a per-call circuit breaker is present', async () => {
    const manager = createAgent('manager-5', createMockModel([{ content: 'done' }]))
    const specialist = createAgent('spec-d', createMockModel([{ content: 'D' }]))
    const specSpy = vi.spyOn(specialist, 'asTool')

    await AgentOrchestrator.supervisor({
      manager,
      specialists: [specialist],
      task: 't1',
      circuitBreaker: createBreakerSpy(),
    })

    await AgentOrchestrator.supervisor({
      manager,
      specialists: [specialist],
      task: 't2',
      circuitBreaker: createBreakerSpy(),
    })

    expect(specSpy).toHaveBeenCalledTimes(2)
  })
})
