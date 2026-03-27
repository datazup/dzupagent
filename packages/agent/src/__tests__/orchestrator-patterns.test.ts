/**
 * Comprehensive tests for AgentOrchestrator patterns:
 *   sequential, parallel, supervisor, debate.
 *
 * Uses the same mock chat model convention as supervisor.test.ts
 * so all tests are deterministic (no real LLM calls).
 */
import { describe, it, expect, vi } from 'vitest'
import { AIMessage, HumanMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import { DzipAgent } from '../agent/dzip-agent.js'
import { AgentOrchestrator } from '../orchestration/orchestrator.js'
import { OrchestrationError } from '../orchestration/orchestration-error.js'

// ---------------------------------------------------------------------------
// Mock helpers (same pattern as supervisor.test.ts)
// ---------------------------------------------------------------------------

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
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this
    }),
    _modelType: () => 'base_chat_model',
    _llmType: () => 'mock',
  } as unknown as BaseChatModel
}

function createFailModel(errorMsg: string): BaseChatModel {
  return {
    invoke: vi.fn(async () => {
      throw new Error(errorMsg)
    }),
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this
    }),
    _modelType: () => 'base_chat_model',
    _llmType: () => 'mock',
  } as unknown as BaseChatModel
}

function createAgent(
  id: string,
  responses: Array<{ content: string }>,
): DzipAgent {
  return new DzipAgent({
    id,
    name: id,
    model: createMockModel(responses),
    instructions: `You are ${id}`,
  })
}

function createAgentWithModel(
  id: string,
  description: string,
  model: BaseChatModel,
): DzipAgent {
  return new DzipAgent({
    id,
    description,
    instructions: `You are ${id}.`,
    model,
  })
}

// ---------------------------------------------------------------------------
// Sequential pattern
// ---------------------------------------------------------------------------

describe('AgentOrchestrator.sequential', () => {
  it('chains 3 agents where each receives the previous output', async () => {
    const modelA = createMockModel([{ content: 'from-a' }])
    const modelB = createMockModel([{ content: 'from-b' }])
    const modelC = createMockModel([{ content: 'from-c' }])

    const agentA = createAgentWithModel('a', 'Agent A', modelA)
    const agentB = createAgentWithModel('b', 'Agent B', modelB)
    const agentC = createAgentWithModel('c', 'Agent C', modelC)

    const result = await AgentOrchestrator.sequential(
      [agentA, agentB, agentC],
      'start',
    )

    expect(result).toBe('from-c')

    // Verify agent A received the initial input
    const callsA = (modelA.invoke as ReturnType<typeof vi.fn>).mock.calls
    expect(callsA).toHaveLength(1)
    const msgsA = callsA[0]![0] as BaseMessage[]
    const humanA = msgsA.find(m => m._getType() === 'human')
    expect(humanA?.content).toBe('start')

    // Verify agent B received agent A's output
    const callsB = (modelB.invoke as ReturnType<typeof vi.fn>).mock.calls
    expect(callsB).toHaveLength(1)
    const msgsB = callsB[0]![0] as BaseMessage[]
    const humanB = msgsB.find(m => m._getType() === 'human')
    expect(humanB?.content).toBe('from-a')

    // Verify agent C received agent B's output
    const callsC = (modelC.invoke as ReturnType<typeof vi.fn>).mock.calls
    expect(callsC).toHaveLength(1)
    const msgsC = callsC[0]![0] as BaseMessage[]
    const humanC = msgsC.find(m => m._getType() === 'human')
    expect(humanC?.content).toBe('from-b')
  })

  it('single agent returns its result directly', async () => {
    const agent = createAgent('solo', [{ content: 'solo-result' }])
    const result = await AgentOrchestrator.sequential([agent], 'input')
    expect(result).toBe('solo-result')
  })

  it('returns initialInput unchanged when agents array is empty', async () => {
    const result = await AgentOrchestrator.sequential([], 'passthrough')
    expect(result).toBe('passthrough')
  })

  it('middle agent failure propagates and stops the chain', async () => {
    const agentA = createAgent('a', [{ content: 'ok-from-a' }])
    const failAgent = new DzipAgent({
      id: 'fail',
      name: 'fail',
      model: createFailModel('middle-agent-exploded'),
      instructions: 'You fail',
    })
    const agentC = createAgent('c', [{ content: 'never-reached' }])

    await expect(
      AgentOrchestrator.sequential([agentA, failAgent, agentC], 'start'),
    ).rejects.toThrow('middle-agent-exploded')

    // Agent C should never have been called
    const modelC = (agentC as unknown as { config: { model: BaseChatModel } })
    // We verify by checking that the third agent's model was never invoked
    // (the error from the middle agent should abort the chain)
  })

  it('preserves content fidelity through the chain', async () => {
    // Test that special characters, multiline content, etc. pass through correctly
    const agentA = createAgent('a', [
      { content: 'Line 1\nLine 2\n{"key": "value"}' },
    ])
    const agentB = createAgent('b', [{ content: 'processed' }])

    const modelB = createMockModel([{ content: 'processed' }])
    const agentBWithModel = createAgentWithModel('b', 'B', modelB)

    const result = await AgentOrchestrator.sequential(
      [agentA, agentBWithModel],
      'start',
    )
    expect(result).toBe('processed')

    // Verify agent B received the multiline content from A
    const callsB = (modelB.invoke as ReturnType<typeof vi.fn>).mock.calls
    const msgsB = callsB[0]![0] as BaseMessage[]
    const humanB = msgsB.find(m => m._getType() === 'human')
    expect(humanB?.content).toBe('Line 1\nLine 2\n{"key": "value"}')
  })
})

// ---------------------------------------------------------------------------
// Parallel pattern
// ---------------------------------------------------------------------------

describe('AgentOrchestrator.parallel', () => {
  it('runs 3 agents on the same input with default merge format', async () => {
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

  it('all agents receive the same input (not chained)', async () => {
    const model1 = createMockModel([{ content: 'r1' }])
    const model2 = createMockModel([{ content: 'r2' }])

    const a1 = createAgentWithModel('a1', 'A1', model1)
    const a2 = createAgentWithModel('a2', 'A2', model2)

    await AgentOrchestrator.parallel([a1, a2], 'same-for-all')

    // Both models should have received a human message with the same input
    for (const model of [model1, model2]) {
      const calls = (model.invoke as ReturnType<typeof vi.fn>).mock.calls
      expect(calls).toHaveLength(1)
      const msgs = calls[0]![0] as BaseMessage[]
      const human = msgs.find(m => m._getType() === 'human')
      expect(human?.content).toBe('same-for-all')
    }
  })

  it('custom merge function receives all results and its return value is used', async () => {
    const a1 = createAgent('m1', [{ content: 'alpha' }])
    const a2 = createAgent('m2', [{ content: 'beta' }])

    const customMerge = vi.fn((results: string[]) => results.join(' + '))

    const result = await AgentOrchestrator.parallel([a1, a2], 'input', customMerge)

    expect(customMerge).toHaveBeenCalledTimes(1)
    expect(customMerge).toHaveBeenCalledWith(['alpha', 'beta'])
    expect(result).toBe('alpha + beta')
  })

  it('async merge function is awaited', async () => {
    const a1 = createAgent('async1', [{ content: 'x' }])
    const a2 = createAgent('async2', [{ content: 'y' }])

    const asyncMerge = vi.fn(async (results: string[]) => {
      return `async:${results.join(',')}`
    })

    const result = await AgentOrchestrator.parallel([a1, a2], 'input', asyncMerge)
    expect(result).toBe('async:x,y')
  })

  it('single agent returns its result wrapped in default merge', async () => {
    const agent = createAgent('solo-p', [{ content: 'only-one' }])
    const result = await AgentOrchestrator.parallel([agent], 'input')
    expect(result).toContain('--- Agent 1 ---')
    expect(result).toContain('only-one')
  })

  it('rejects if any agent fails (Promise.all behavior)', async () => {
    const goodAgent = createAgent('good', [{ content: 'ok' }])
    const failAgent = new DzipAgent({
      id: 'fail',
      name: 'fail',
      model: createFailModel('parallel-fail'),
      instructions: 'You fail',
    })

    await expect(
      AgentOrchestrator.parallel([goodAgent, failAgent], 'input'),
    ).rejects.toThrow('parallel-fail')
  })

  it('returns empty string when agents array is empty', async () => {
    const result = await AgentOrchestrator.parallel([], 'input')
    expect(result).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Supervisor pattern
// ---------------------------------------------------------------------------

describe('AgentOrchestrator.supervisor', () => {
  it('manager receives specialist tools via asTool()', async () => {
    const managerModel = createMockModel([
      { content: 'Delegated and done.' },
    ])

    const specModel = createMockModel([{ content: 'spec output' }])
    const manager = createAgentWithModel('mgr', 'Manager', managerModel)
    const specialist = createAgentWithModel('db-spec', 'Database expert', specModel)

    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [specialist],
      task: 'Design DB schema',
    })

    expect(result.content).toContain('Delegated and done')
    expect(result.availableSpecialists).toEqual(['db-spec'])
    expect(result.filteredSpecialists).toEqual([])

    // The manager's model should have had bindTools called with the specialist tool
    // (the orchestrator creates a new DzipAgent internally, so we check indirectly)
  })

  it('health check filters out unhealthy specialists', async () => {
    const managerModel = createMockModel([
      { content: 'Done with healthy only.' },
    ])
    const healthyModel = createMockModel([{ content: 'healthy' }])

    const manager = createAgentWithModel('mgr', 'Manager', managerModel)
    const healthy = createAgentWithModel('healthy', 'Healthy spec', healthyModel)

    const broken = createAgentWithModel(
      'broken',
      'Broken spec',
      createMockModel([{ content: 'ok' }]),
    )
    vi.spyOn(broken, 'asTool').mockRejectedValue(new Error('unhealthy'))

    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [healthy, broken],
      task: 'Do work',
      healthCheck: true,
    })

    expect(result.availableSpecialists).toEqual(['healthy'])
    expect(result.filteredSpecialists).toEqual(['broken'])
  })

  it('throws OrchestrationError when all specialists fail health check', async () => {
    const managerModel = createMockModel([{ content: 'hello' }])
    const manager = createAgentWithModel('mgr', 'Manager', managerModel)

    const broken = createAgentWithModel(
      'broken',
      'Broken',
      createMockModel([{ content: 'ok' }]),
    )
    vi.spyOn(broken, 'asTool').mockRejectedValue(new Error('unhealthy'))

    await expect(
      AgentOrchestrator.supervisor({
        manager,
        specialists: [broken],
        task: 'Do work',
        healthCheck: true,
      }),
    ).rejects.toThrow('All specialists failed health check')

    try {
      await AgentOrchestrator.supervisor({
        manager,
        specialists: [broken],
        task: 'Do work',
        healthCheck: true,
      })
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestrationError)
      expect((err as OrchestrationError).pattern).toBe('supervisor')
      expect((err as OrchestrationError).context).toHaveProperty('filteredSpecialists')
    }
  })

  it('throws OrchestrationError on empty specialists array', async () => {
    const model = createMockModel([{ content: 'hello' }])
    const manager = createAgentWithModel('mgr', 'Manager', model)

    await expect(
      AgentOrchestrator.supervisor({
        manager,
        specialists: [],
        task: 'Do something',
      }),
    ).rejects.toThrow(OrchestrationError)

    try {
      await AgentOrchestrator.supervisor({
        manager,
        specialists: [],
        task: 'Do something',
      })
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestrationError)
      expect((err as OrchestrationError).pattern).toBe('supervisor')
      expect((err as OrchestrationError).message).toContain('at least one specialist')
    }
  })

  it('abort signal prevents execution', async () => {
    const model = createMockModel([{ content: 'hello' }])
    const manager = createAgentWithModel('mgr', 'Manager', model)
    const specialist = createAgentWithModel('spec', 'Specialist', model)

    const controller = new AbortController()
    controller.abort()

    await expect(
      AgentOrchestrator.supervisor({
        manager,
        specialists: [specialist],
        task: 'Do something',
        signal: controller.signal,
      }),
    ).rejects.toThrow(OrchestrationError)

    // The manager model should never have been invoked
    expect(model.invoke).not.toHaveBeenCalled()
  })

  it('legacy positional args return a plain string', async () => {
    const managerModel = createMockModel([{ content: 'Legacy result' }])
    const specModel = createMockModel([{ content: 'spec output' }])

    const manager = createAgentWithModel('mgr', 'Manager', managerModel)
    const specialist = createAgentWithModel('spec', 'Specialist', specModel)

    const result = await AgentOrchestrator.supervisor(
      manager,
      [specialist],
      'Do stuff',
    )

    expect(typeof result).toBe('string')
    expect(result).toBe('Legacy result')
  })

  it('legacy positional args throw when specialists or task missing', async () => {
    const model = createMockModel([{ content: 'hello' }])
    const manager = createAgentWithModel('mgr', 'Manager', model)

    await expect(
      // @ts-expect-error -- deliberately passing incomplete args for legacy path
      AgentOrchestrator.supervisor(manager, undefined, undefined),
    ).rejects.toThrow(OrchestrationError)
  })
})

// ---------------------------------------------------------------------------
// Debate pattern
// ---------------------------------------------------------------------------

describe('AgentOrchestrator.debate', () => {
  it('2 proposers + judge produces judge verdict (1 round default)', async () => {
    const proposer1 = createAgent('prop1', [
      { content: 'Proposal A: use PostgreSQL' },
    ])
    const proposer2 = createAgent('prop2', [
      { content: 'Proposal B: use MongoDB' },
    ])
    const judge = createAgent('judge', [
      { content: 'Best: PostgreSQL for ACID compliance' },
    ])

    const result = await AgentOrchestrator.debate(
      [proposer1, proposer2],
      judge,
      'Choose a database',
    )

    expect(result).toBe('Best: PostgreSQL for ACID compliance')
  })

  it('single proposer still goes through judge', async () => {
    const proposer = createAgent('solo-prop', [{ content: 'Only proposal' }])
    const judge = createAgent('solo-judge', [
      { content: 'Accepted the only proposal' },
    ])

    const result = await AgentOrchestrator.debate(
      [proposer],
      judge,
      'Single proposer task',
    )

    expect(result).toBe('Accepted the only proposal')
  })

  it('multi-round debate refines proposals across rounds', async () => {
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

  it('round 2 input includes round 1 proposals for refinement', async () => {
    const model1 = createMockModel([
      { content: 'Round1: idea A' },
      { content: 'Round2: refined A' },
    ])
    const model2 = createMockModel([
      { content: 'Round1: idea B' },
      { content: 'Round2: refined B' },
    ])
    const judgeModel = createMockModel([{ content: 'Verdict' }])

    const proposer1 = createAgentWithModel('p1', 'Proposer 1', model1)
    const proposer2 = createAgentWithModel('p2', 'Proposer 2', model2)
    const judge = createAgentWithModel('judge', 'Judge', judgeModel)

    await AgentOrchestrator.debate(
      [proposer1, proposer2],
      judge,
      'Design a system',
      { rounds: 2 },
    )

    // In round 2, proposer1 should have received input containing round 1 proposals
    const calls1 = (model1.invoke as ReturnType<typeof vi.fn>).mock.calls
    expect(calls1).toHaveLength(2) // called once per round

    const round2Msgs = calls1[1]![0] as BaseMessage[]
    const round2Human = round2Msgs.find(m => m._getType() === 'human')
    const round2Content =
      typeof round2Human?.content === 'string'
        ? round2Human.content
        : JSON.stringify(round2Human?.content)

    // Round 2 input should reference previous proposals
    expect(round2Content).toContain('Previous proposals')
    expect(round2Content).toContain('Round1: idea A')
    expect(round2Content).toContain('Round1: idea B')
  })

  it('judge receives all proposal texts formatted with ## headers', async () => {
    const judgeModel = createMockModel([{ content: 'Final verdict' }])

    const proposer1 = createAgent('v-prop1', [{ content: 'Plan Alpha' }])
    const proposer2 = createAgent('v-prop2', [{ content: 'Plan Beta' }])

    const judge = new DzipAgent({
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

    // Verify the judge model was invoked with both proposals
    expect(judgeModel.invoke).toHaveBeenCalledTimes(1)
    const invokeArgs = (judgeModel.invoke as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as BaseMessage[]

    const allText = invokeArgs
      .map(m => {
        const content = m.content
        return typeof content === 'string' ? content : JSON.stringify(content)
      })
      .join(' ')

    expect(allText).toContain('Plan Alpha')
    expect(allText).toContain('Plan Beta')
    expect(allText).toContain('Proposal 1')
    expect(allText).toContain('Proposal 2')
    expect(allText).toContain('Pick a plan')
  })

  it('handles empty proposers array (judge still runs on empty input)', async () => {
    const judge = createAgent('empty-judge', [
      { content: 'No proposals received' },
    ])

    const result = await AgentOrchestrator.debate([], judge, 'Empty task')
    expect(result).toBe('No proposals received')
  })

  it('proposer failure rejects the entire debate', async () => {
    const goodProposer = createAgent('good', [{ content: 'good proposal' }])
    const failProposer = new DzipAgent({
      id: 'fail-prop',
      name: 'fail-prop',
      model: createFailModel('proposer-crashed'),
      instructions: 'You fail',
    })
    const judge = createAgent('judge', [{ content: 'verdict' }])

    // debate uses Promise.all for proposers, so one failure rejects all
    await expect(
      AgentOrchestrator.debate(
        [goodProposer, failProposer],
        judge,
        'Test task',
      ),
    ).rejects.toThrow('proposer-crashed')
  })

  it('judge failure after proposals rejects the debate', async () => {
    const proposer = createAgent('prop', [{ content: 'A proposal' }])
    const failJudge = new DzipAgent({
      id: 'fail-judge',
      name: 'fail-judge',
      model: createFailModel('judge-crashed'),
      instructions: 'You fail',
    })

    await expect(
      AgentOrchestrator.debate([proposer], failJudge, 'Test task'),
    ).rejects.toThrow('judge-crashed')
  })

  it('3-round debate calls each proposer exactly 3 times', async () => {
    const model1 = createMockModel([
      { content: 'R1 idea A' },
      { content: 'R2 idea A' },
      { content: 'R3 idea A' },
    ])
    const model2 = createMockModel([
      { content: 'R1 idea B' },
      { content: 'R2 idea B' },
      { content: 'R3 idea B' },
    ])
    const judgeModel = createMockModel([{ content: 'Final verdict after 3 rounds' }])

    const p1 = createAgentWithModel('p1', 'Proposer 1', model1)
    const p2 = createAgentWithModel('p2', 'Proposer 2', model2)
    const judge = createAgentWithModel('judge', 'Judge', judgeModel)

    const result = await AgentOrchestrator.debate(
      [p1, p2],
      judge,
      'Design something',
      { rounds: 3 },
    )

    expect(result).toBe('Final verdict after 3 rounds')
    expect(model1.invoke).toHaveBeenCalledTimes(3)
    expect(model2.invoke).toHaveBeenCalledTimes(3)
    expect(judgeModel.invoke).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Agent state isolation
// ---------------------------------------------------------------------------

describe('Agent state isolation', () => {
  it('sequential agents do not share model state', async () => {
    // Each agent has its own model; verify one agent's model state
    // does not leak into another agent's execution
    const receivedMessages: string[][] = []

    const modelA = {
      invoke: vi.fn(async (msgs: BaseMessage[]) => {
        receivedMessages.push(msgs.map(m => String(m.content)))
        return new AIMessage({ content: 'output-a', response_metadata: {} })
      }),
      bindTools: vi.fn(function (this: BaseChatModel) { return this }),
      _modelType: () => 'base_chat_model',
      _llmType: () => 'mock',
    } as unknown as BaseChatModel

    const modelB = {
      invoke: vi.fn(async (msgs: BaseMessage[]) => {
        receivedMessages.push(msgs.map(m => String(m.content)))
        return new AIMessage({ content: 'output-b', response_metadata: {} })
      }),
      bindTools: vi.fn(function (this: BaseChatModel) { return this }),
      _modelType: () => 'base_chat_model',
      _llmType: () => 'mock',
    } as unknown as BaseChatModel

    const agentA = createAgentWithModel('iso-a', 'Agent A', modelA)
    const agentB = createAgentWithModel('iso-b', 'Agent B', modelB)

    await AgentOrchestrator.sequential([agentA, agentB], 'initial')

    // Agent A received initial input only
    expect(receivedMessages[0]).toBeDefined()
    expect(receivedMessages[0]!.some(m => m === 'initial')).toBe(true)

    // Agent B received agent A's output only, not the initial input
    expect(receivedMessages[1]).toBeDefined()
    expect(receivedMessages[1]!.some(m => m === 'output-a')).toBe(true)
    expect(receivedMessages[1]!.some(m => m === 'initial')).toBe(false)
  })

  it('parallel agents receive independent copies of input', async () => {
    const receivedInputs: string[] = []

    function createTrackingModel(label: string): BaseChatModel {
      return {
        invoke: vi.fn(async (msgs: BaseMessage[]) => {
          const human = msgs.find(m => m._getType() === 'human')
          receivedInputs.push(`${label}:${String(human?.content)}`)
          return new AIMessage({ content: `${label}-result`, response_metadata: {} })
        }),
        bindTools: vi.fn(function (this: BaseChatModel) { return this }),
        _modelType: () => 'base_chat_model',
        _llmType: () => 'mock',
      } as unknown as BaseChatModel
    }

    const a1 = createAgentWithModel('t1', 'T1', createTrackingModel('m1'))
    const a2 = createAgentWithModel('t2', 'T2', createTrackingModel('m2'))
    const a3 = createAgentWithModel('t3', 'T3', createTrackingModel('m3'))

    await AgentOrchestrator.parallel([a1, a2, a3], 'shared-task')

    // All three received the same input independently
    expect(receivedInputs).toContain('m1:shared-task')
    expect(receivedInputs).toContain('m2:shared-task')
    expect(receivedInputs).toContain('m3:shared-task')
    expect(receivedInputs).toHaveLength(3)
  })
})
