/**
 * Tests for sequential, parallel, and debate orchestration patterns.
 *
 * Uses the same mock chat model convention as supervisor.test.ts
 * so all tests are deterministic (no real LLM calls).
 */
import { describe, it, expect, vi } from 'vitest'
import { AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import { ForgeAgent } from '../agent/forge-agent.js'
import { AgentOrchestrator } from '../orchestration/orchestrator.js'

// ---------------------------------------------------------------------------
// Mock helpers (same pattern as supervisor.test.ts)
// ---------------------------------------------------------------------------

function createMockModel(
  responses: Array<{ content: string; tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }> }>,
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
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this
    }),
    _modelType: () => 'base_chat_model',
    _llmType: () => 'mock',
  } as unknown as BaseChatModel
}

function createAgent(id: string, responses: Array<{ content: string }>): ForgeAgent {
  return new ForgeAgent({
    id,
    name: id,
    model: createMockModel(responses),
    instructions: `You are ${id}`,
  })
}

// ---------------------------------------------------------------------------
// Sequential pattern
// ---------------------------------------------------------------------------

describe('AgentOrchestrator.sequential', () => {
  it('chains 2 agents where B receives A output', async () => {
    const agentA = createAgent('agent-a', [{ content: 'step1' }])
    const agentB = createAgent('agent-b', [{ content: 'step2' }])

    const result = await AgentOrchestrator.sequential([agentA, agentB], 'initial')
    expect(result).toBe('step2')
  })

  it('chains 3 agents passing output forward', async () => {
    // Each agent receives the previous agent's output as a HumanMessage.
    // We verify the final result comes from the last agent.
    const agentA = createAgent('a', [{ content: 'from-a' }])
    const agentB = createAgent('b', [{ content: 'from-b' }])
    const agentC = createAgent('c', [{ content: 'from-c' }])

    const result = await AgentOrchestrator.sequential([agentA, agentB, agentC], 'start')
    expect(result).toBe('from-c')
  })

  it('works with a single agent', async () => {
    const agent = createAgent('solo', [{ content: 'solo-result' }])

    const result = await AgentOrchestrator.sequential([agent], 'input')
    expect(result).toBe('solo-result')
  })

  it('returns initialInput when agents array is empty', async () => {
    // With no agents, the loop body never executes, so `current` stays as initialInput
    const result = await AgentOrchestrator.sequential([], 'passthrough')
    expect(result).toBe('passthrough')
  })

  it('propagates agent failure', async () => {
    const failModel = {
      invoke: vi.fn(async () => { throw new Error('LLM exploded') }),
      bindTools: vi.fn(function (this: BaseChatModel) { return this }),
      _modelType: () => 'base_chat_model',
      _llmType: () => 'mock',
    } as unknown as BaseChatModel

    const failAgent = new ForgeAgent({
      id: 'fail',
      name: 'fail',
      model: failModel,
      instructions: 'You fail',
    })

    await expect(
      AgentOrchestrator.sequential([failAgent], 'input'),
    ).rejects.toThrow('LLM exploded')
  })
})

// ---------------------------------------------------------------------------
// Parallel pattern
// ---------------------------------------------------------------------------

describe('AgentOrchestrator.parallel', () => {
  it('runs 3 agents on same input with default merge', async () => {
    const a1 = createAgent('p1', [{ content: 'result-1' }])
    const a2 = createAgent('p2', [{ content: 'result-2' }])
    const a3 = createAgent('p3', [{ content: 'result-3' }])

    const result = await AgentOrchestrator.parallel([a1, a2, a3], 'shared-input')

    // Default merge: "--- Agent N ---\nresult"
    expect(result).toContain('--- Agent 1 ---')
    expect(result).toContain('result-1')
    expect(result).toContain('--- Agent 2 ---')
    expect(result).toContain('result-2')
    expect(result).toContain('--- Agent 3 ---')
    expect(result).toContain('result-3')
  })

  it('uses a custom merge function', async () => {
    const a1 = createAgent('m1', [{ content: 'alpha' }])
    const a2 = createAgent('m2', [{ content: 'beta' }])

    const customMerge = vi.fn((results: string[]) => results.join(' + '))

    const result = await AgentOrchestrator.parallel([a1, a2], 'input', customMerge)

    expect(customMerge).toHaveBeenCalledWith(['alpha', 'beta'])
    expect(result).toBe('alpha + beta')
  })

  it('works with a single agent', async () => {
    const agent = createAgent('solo-p', [{ content: 'only-one' }])

    const result = await AgentOrchestrator.parallel([agent], 'input')
    expect(result).toContain('only-one')
  })

  it('returns empty merge output when agents array is empty', async () => {
    // Promise.all on empty array resolves to [], defaultMerge joins nothing
    const result = await AgentOrchestrator.parallel([], 'input')
    expect(result).toBe('')
  })

  it('rejects if any agent fails (Promise.all behavior)', async () => {
    const goodAgent = createAgent('good', [{ content: 'ok' }])

    const failModel = {
      invoke: vi.fn(async () => { throw new Error('parallel-fail') }),
      bindTools: vi.fn(function (this: BaseChatModel) { return this }),
      _modelType: () => 'base_chat_model',
      _llmType: () => 'mock',
    } as unknown as BaseChatModel

    const failAgent = new ForgeAgent({
      id: 'fail',
      name: 'fail',
      model: failModel,
      instructions: 'You fail',
    })

    // parallel uses Promise.all, so one failure rejects the whole batch
    await expect(
      AgentOrchestrator.parallel([goodAgent, failAgent], 'input'),
    ).rejects.toThrow('parallel-fail')
  })
})

// ---------------------------------------------------------------------------
// Debate pattern
// ---------------------------------------------------------------------------

describe('AgentOrchestrator.debate', () => {
  it('2 proposers + judge, 1 round (default)', async () => {
    const proposer1 = createAgent('prop1', [{ content: 'Proposal A: use PostgreSQL' }])
    const proposer2 = createAgent('prop2', [{ content: 'Proposal B: use MongoDB' }])
    const judge = createAgent('judge', [{ content: 'Best: PostgreSQL for ACID compliance' }])

    const result = await AgentOrchestrator.debate(
      [proposer1, proposer2],
      judge,
      'Choose a database',
    )

    expect(result).toBe('Best: PostgreSQL for ACID compliance')
  })

  it('multi-round debate (2 rounds)', async () => {
    // Round 1: proposers give initial answers
    // Round 2: proposers see previous proposals and refine
    const proposer1 = createAgent('r-prop1', [
      { content: 'Round1: idea A' },
      { content: 'Round2: refined A' },
    ])
    const proposer2 = createAgent('r-prop2', [
      { content: 'Round1: idea B' },
      { content: 'Round2: refined B' },
    ])
    const judge = createAgent('r-judge', [
      { content: 'Synthesized: best of refined A and B' },
    ])

    const result = await AgentOrchestrator.debate(
      [proposer1, proposer2],
      judge,
      'Design a system',
      { rounds: 2 },
    )

    expect(result).toBe('Synthesized: best of refined A and B')
  })

  it('works with a single proposer', async () => {
    const proposer = createAgent('solo-prop', [{ content: 'Only proposal' }])
    const judge = createAgent('solo-judge', [{ content: 'Accepted the only proposal' }])

    const result = await AgentOrchestrator.debate(
      [proposer],
      judge,
      'Single proposer task',
    )

    expect(result).toBe('Accepted the only proposal')
  })

  it('handles empty proposers (Promise.all resolves empty, judge still runs)', async () => {
    // With 0 proposers, proposals array stays [], judge still gets invoked
    const judge = createAgent('empty-judge', [{ content: 'No proposals received' }])

    const result = await AgentOrchestrator.debate([], judge, 'Empty task')

    // Judge runs on empty proposals — judgeInput will be empty but judge still executes
    expect(result).toBe('No proposals received')
  })

  it('judge receives all proposal texts in input', async () => {
    // We need to capture what the judge model receives
    const judgeModel = createMockModel([
      { content: 'Final verdict' },
    ])

    const proposer1 = createAgent('v-prop1', [{ content: 'Plan Alpha' }])
    const proposer2 = createAgent('v-prop2', [{ content: 'Plan Beta' }])

    const judge = new ForgeAgent({
      id: 'v-judge',
      name: 'v-judge',
      model: judgeModel,
      instructions: 'You are v-judge',
    })

    const result = await AgentOrchestrator.debate(
      [proposer1, proposer2],
      judge,
      'Pick a plan',
    )

    expect(result).toBe('Final verdict')

    // Verify the judge model was invoked and the messages contain both proposals
    expect(judgeModel.invoke).toHaveBeenCalledTimes(1)
    const invokeArgs = (judgeModel.invoke as ReturnType<typeof vi.fn>).mock.calls[0]![0] as BaseMessage[]

    // The input messages should include system message + human message with proposals
    const allText = invokeArgs.map(m => {
      const content = m.content
      return typeof content === 'string' ? content : JSON.stringify(content)
    }).join(' ')

    expect(allText).toContain('Plan Alpha')
    expect(allText).toContain('Plan Beta')
    expect(allText).toContain('Proposal 1')
    expect(allText).toContain('Proposal 2')
  })
})
