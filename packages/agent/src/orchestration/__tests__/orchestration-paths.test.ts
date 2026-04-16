/**
 * Integration tests for the 6 orchestration paths.
 *
 * Uses mock agents (no real LLM calls) to exercise the happy path
 * of each orchestration pattern.
 */
import { describe, it, expect, vi } from 'vitest'
import { AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import { DzupAgent } from '../../agent/dzip-agent.js'
import { AgentOrchestrator } from '../orchestrator.js'
import { ContractNetManager } from '../contract-net/contract-net-manager.js'
import { TopologyExecutor } from '../topology/topology-executor.js'
import { UsePartialMergeStrategy } from '../merge/use-partial.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockModel(responses: Array<{ content: string }>): BaseChatModel {
  let callIndex = 0
  const invoke = vi.fn(async (_messages: BaseMessage[]) => {
    const resp = responses[callIndex] ?? responses[responses.length - 1]!
    callIndex++
    return new AIMessage({ content: resp.content, response_metadata: {} })
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

function createAgent(id: string, response: string): DzupAgent {
  return new DzupAgent({
    id,
    description: `${id} agent`,
    instructions: `You are ${id}.`,
    model: createMockModel([{ content: response }]),
  })
}

// ---------------------------------------------------------------------------
// Path 1: supervisor-single
// ---------------------------------------------------------------------------

describe('orchestration path: supervisor-single', () => {
  it('delegates to a single specialist and returns result', async () => {
    const manager = createAgent('manager', 'Final answer from manager.')
    const specialist = createAgent('specialist-1', 'Specialist result.')

    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [specialist],
      task: 'Solve this problem',
    })

    expect(result.content).toBeTruthy()
    expect(result.availableSpecialists).toEqual(['specialist-1'])
    expect(result.filteredSpecialists).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Path 2: supervisor-parallel
// ---------------------------------------------------------------------------

describe('orchestration path: supervisor-parallel', () => {
  it('runs 3 agents in parallel with UsePartial merge', async () => {
    const agents = [
      createAgent('agent-a', 'Result A'),
      createAgent('agent-b', 'Result B'),
      createAgent('agent-c', 'Result C'),
    ]
    const merge = new UsePartialMergeStrategy<string>()

    const result = await AgentOrchestrator.parallel(
      agents,
      'Process this input',
      undefined,
      { mergeStrategy: merge },
    )

    // UsePartial returns "partial" status with outputs joined
    // The result should contain at least some agent output
    expect(result).toBeTruthy()
    expect(typeof result).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// Path 3: contract-net
// ---------------------------------------------------------------------------

describe('orchestration path: contract-net', () => {
  it('executes full CFP-bid-award-execute lifecycle', async () => {
    // Manager: first call evaluates bids, second call is unused
    const manager = createAgent('cnm-manager', 'Task complete.')

    // Specialists return valid bid JSON
    const bid = (agentId: string, cost: number) =>
      JSON.stringify({
        estimatedCostCents: cost,
        estimatedDurationMs: 5000,
        qualityEstimate: 0.8,
        confidence: 0.9,
        approach: `Approach from ${agentId}`,
      })

    const s1 = createAgent('s1', bid('s1', 100))
    const s2 = createAgent('s2', bid('s2', 200))

    // The execute response (winner re-runs with the task)
    // After bidding, the winner is asked to execute, which returns another response
    const winnerModel = createMockModel([
      { content: bid('s1', 100) },   // bid phase
      { content: 'Executed result' }, // execution phase
    ])
    const s1WithExec = new DzupAgent({
      id: 's1',
      description: 's1 agent',
      instructions: 'You are s1.',
      model: winnerModel,
    })

    const result = await ContractNetManager.execute({
      manager,
      specialists: [s1WithExec, s2],
      task: 'Build the feature',
    })

    expect(result.cfpId).toBeTruthy()
    expect(result.success).toBe(true)
    expect(result.agentId).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Path 4: map-reduce
// ---------------------------------------------------------------------------

describe('orchestration path: map-reduce', () => {
  it('maps chunks across agent and merges results', async () => {
    const { mapReduce } = await import('../map-reduce.js')
    const agent = createAgent('mr-agent', 'Processed chunk')
    const result = await mapReduce(agent, ['chunk-1', 'chunk-2', 'chunk-3'], {
      concurrency: 2,
      mergeStrategy: 'concat',
    })

    expect(result.stats.total).toBe(3)
    expect(result.stats.succeeded).toBe(3)
    expect(result.stats.failed).toBe(0)
    expect(result.result).toContain('Processed chunk')
  })
})

// ---------------------------------------------------------------------------
// Path 5: topology-pipeline
// ---------------------------------------------------------------------------

describe('orchestration path: topology-pipeline', () => {
  it('executes pipeline topology (sequential handoff via AgentOrchestrator)', async () => {
    const agents = [
      createAgent('pipe-a', 'Step A output'),
      createAgent('pipe-b', 'Step B output'),
    ]

    // Pipeline topology delegates to AgentOrchestrator.sequential internally
    // Test via TopologyExecutor.execute with topology: 'pipeline'
    const result = await TopologyExecutor.execute({
      agents,
      task: 'Process this through pipeline',
      topology: 'pipeline',
    })

    expect(result.result).toBeTruthy()
    expect(result.metrics.topology).toBe('pipeline')
    expect(result.metrics.agentCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Path 6: planning-decompose
// ---------------------------------------------------------------------------

describe('orchestration path: planning-decompose', () => {
  it('builds and validates a plan with buildExecutionLevels', async () => {
    const { buildExecutionLevels, validatePlanStructure } = await import(
      '../planning-agent.js'
    )
    const nodes = [
      {
        id: 'step-1',
        task: 'Create schema',
        specialistId: 'db-agent',
        input: {},
        dependsOn: [],
      },
      {
        id: 'step-2',
        task: 'Build API',
        specialistId: 'api-agent',
        input: {},
        dependsOn: ['step-1'],
      },
      {
        id: 'step-3',
        task: 'Build UI',
        specialistId: 'ui-agent',
        input: {},
        dependsOn: ['step-1'],
      },
    ]

    const levels = buildExecutionLevels(nodes)
    // step-1 has no deps -> level 0; step-2 and step-3 depend on step-1 -> level 1
    expect(levels).toHaveLength(2)
    expect(levels[0]).toEqual(['step-1'])
    expect(levels[1]!.sort()).toEqual(['step-2', 'step-3'])

    const plan = {
      goal: 'Build full-stack feature',
      nodes,
      executionLevels: levels,
    }

    const errors = validatePlanStructure(plan, ['db-agent', 'api-agent', 'ui-agent'])
    expect(errors).toHaveLength(0)
  })

  it('detects cycles in plan DAG', async () => {
    const { buildExecutionLevels } = await import('../planning-agent.js')
    const cyclicNodes = [
      {
        id: 'a',
        task: 'Task A',
        specialistId: 'agent-1',
        input: {},
        dependsOn: ['b'],
      },
      {
        id: 'b',
        task: 'Task B',
        specialistId: 'agent-2',
        input: {},
        dependsOn: ['a'],
      },
    ]

    expect(() => buildExecutionLevels(cyclicNodes)).toThrow(/[Cc]ycle/)
  })
})
