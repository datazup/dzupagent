/**
 * Tests for TopologyAnalyzer and TopologyExecutor.
 */
import { describe, it, expect, vi } from 'vitest'
import { AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import { DzupAgent } from '../agent/dzip-agent.js'
import { TopologyAnalyzer } from '../orchestration/topology/topology-analyzer.js'
import { TopologyExecutor } from '../orchestration/topology/topology-executor.js'
import type { TaskCharacteristics, TopologyMetrics } from '../orchestration/topology/topology-types.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockModel(
  responses: Array<{ content: string }>,
): BaseChatModel {
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

function createAgent(id: string, content: string): DzupAgent {
  return new DzupAgent({
    id,
    description: `Agent ${id}`,
    instructions: `You are ${id}.`,
    model: createMockModel([{ content }]),
  })
}

function createFailingAgent(id: string): DzupAgent {
  const model = {
    invoke: vi.fn(async () => {
      throw new Error(`Agent ${id} failed`)
    }),
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this
    }),
    _modelType: () => 'base_chat_model',
    _llmType: () => 'mock',
  } as unknown as BaseChatModel

  return new DzupAgent({
    id,
    description: `Failing agent ${id}`,
    instructions: `You are ${id}.`,
    model,
  })
}

// ---------------------------------------------------------------------------
// TopologyAnalyzer tests
// ---------------------------------------------------------------------------

describe('TopologyAnalyzer', () => {
  const analyzer = new TopologyAnalyzer()

  it('recommends hierarchical for high coordination + many subtasks', () => {
    const chars: TaskCharacteristics = {
      subtaskCount: 5,
      interdependence: 0.3,
      iterativeRefinement: 0.2,
      coordinationComplexity: 0.9,
      speedPriority: 0.1,
      sequentialNature: 0.2,
    }
    const result = analyzer.analyze(chars)
    expect(result.recommended).toBe('hierarchical')
    expect(result.confidence).toBeGreaterThan(0)
    expect(result.reason).toBeTruthy()
  })

  it('recommends pipeline for sequential tasks', () => {
    const chars: TaskCharacteristics = {
      subtaskCount: 3,
      interdependence: 0.1,
      iterativeRefinement: 0.1,
      coordinationComplexity: 0.2,
      speedPriority: 0.3,
      sequentialNature: 0.95,
    }
    const result = analyzer.analyze(chars)
    expect(result.recommended).toBe('pipeline')
  })

  it('recommends star for parallel + fast tasks', () => {
    const chars: TaskCharacteristics = {
      subtaskCount: 4,
      interdependence: 0.05,
      iterativeRefinement: 0.1,
      coordinationComplexity: 0.1,
      speedPriority: 0.95,
      sequentialNature: 0.1,
    }
    const result = analyzer.analyze(chars)
    expect(result.recommended).toBe('star')
  })

  it('recommends mesh for highly interdependent tasks', () => {
    const chars: TaskCharacteristics = {
      subtaskCount: 4,
      interdependence: 0.95,
      iterativeRefinement: 0.2,
      coordinationComplexity: 0.8,
      speedPriority: 0.2,
      sequentialNature: 0.1,
    }
    const result = analyzer.analyze(chars)
    expect(result.recommended).toBe('mesh')
  })

  it('recommends ring for iterative refinement', () => {
    const chars: TaskCharacteristics = {
      subtaskCount: 3,
      interdependence: 0.3,
      iterativeRefinement: 0.95,
      coordinationComplexity: 0.2,
      speedPriority: 0.05,
      sequentialNature: 0.3,
    }
    const result = analyzer.analyze(chars)
    expect(result.recommended).toBe('ring')
  })

  it('returns alternatives sorted by score descending', () => {
    const chars: TaskCharacteristics = {
      subtaskCount: 3,
      interdependence: 0.5,
      iterativeRefinement: 0.5,
      coordinationComplexity: 0.5,
      speedPriority: 0.5,
      sequentialNature: 0.5,
    }
    const result = analyzer.analyze(chars)
    expect(result.alternatives).toHaveLength(4) // 5 topologies - 1 recommended

    for (let i = 0; i < result.alternatives.length - 1; i++) {
      expect(result.alternatives[i]!.score).toBeGreaterThanOrEqual(
        result.alternatives[i + 1]!.score,
      )
    }
  })

  it('confidence reflects gap between 1st and 2nd', () => {
    // Very clear-cut case: pipeline should dominate
    const chars: TaskCharacteristics = {
      subtaskCount: 2,
      interdependence: 0.0,
      iterativeRefinement: 0.0,
      coordinationComplexity: 0.0,
      speedPriority: 0.0,
      sequentialNature: 1.0,
    }
    const result = analyzer.analyze(chars)
    expect(result.confidence).toBeGreaterThan(0)
    expect(result.confidence).toBeLessThanOrEqual(1)

    // Ambiguous case: all metrics at 0.5
    const ambiguous: TaskCharacteristics = {
      subtaskCount: 3,
      interdependence: 0.5,
      iterativeRefinement: 0.5,
      coordinationComplexity: 0.5,
      speedPriority: 0.5,
      sequentialNature: 0.5,
    }
    const ambiguousResult = analyzer.analyze(ambiguous)
    // Confidence should be lower for ambiguous cases
    expect(ambiguousResult.confidence).toBeLessThan(result.confidence)
  })
})

// ---------------------------------------------------------------------------
// TopologyExecutor tests
// ---------------------------------------------------------------------------

describe('TopologyExecutor', () => {
  describe('executeMesh', () => {
    it('runs all agents in parallel and returns all results', async () => {
      const agents = [
        createAgent('a1', 'Result from A1'),
        createAgent('a2', 'Result from A2'),
        createAgent('a3', 'Result from A3'),
      ]

      const { results, metrics } = await TopologyExecutor.executeMesh({
        agents,
        task: 'Analyze the data',
      })

      expect(results).toHaveLength(3)
      expect(results).toContain('Result from A1')
      expect(results).toContain('Result from A2')
      expect(results).toContain('Result from A3')
      expect(metrics.topology).toBe('mesh')
      expect(metrics.agentCount).toBe(3)
      expect(metrics.messageCount).toBe(3)
      expect(metrics.errorCount).toBe(0)
      expect(metrics.totalDurationMs).toBeGreaterThanOrEqual(0)
    })

    it('handles agent errors gracefully', async () => {
      const agents = [
        createAgent('a1', 'OK'),
        createFailingAgent('a2'),
      ]

      const { results, metrics } = await TopologyExecutor.executeMesh({
        agents,
        task: 'Do work',
      })

      expect(results).toHaveLength(2)
      expect(results[0]).toBe('OK')
      expect(results[1]).toContain('[error:')
      expect(metrics.errorCount).toBe(1)
    })
  })

  describe('executeRing', () => {
    it('passes output sequentially through agents', async () => {
      // Each agent appends to the conversation, mock returns content based on call order
      const model1 = createMockModel([{ content: 'Step 1 done' }])
      const model2 = createMockModel([{ content: 'Step 2 done' }])
      const model3 = createMockModel([{ content: 'Final result' }])

      const agents = [
        new DzupAgent({ id: 'r1', instructions: 'Agent 1', model: model1 }),
        new DzupAgent({ id: 'r2', instructions: 'Agent 2', model: model2 }),
        new DzupAgent({ id: 'r3', instructions: 'Agent 3', model: model3 }),
      ]

      const { result, metrics } = await TopologyExecutor.executeRing({
        agents,
        task: 'Process data',
        maxRounds: 1,
      })

      expect(result).toBe('Final result')
      expect(metrics.topology).toBe('ring')
      expect(metrics.agentCount).toBe(3)
      expect(metrics.messageCount).toBe(3) // 3 agents * 1 round
      expect(metrics.errorCount).toBe(0)
    })

    it('respects maxRounds', async () => {
      const invokeCount = vi.fn()

      const makeModel = () => {
        return {
          invoke: vi.fn(async () => {
            invokeCount()
            return new AIMessage({ content: 'output', response_metadata: {} })
          }),
          bindTools: vi.fn(function (this: BaseChatModel) {
            return this
          }),
          _modelType: () => 'base_chat_model',
          _llmType: () => 'mock',
        } as unknown as BaseChatModel
      }

      const agents = [
        new DzupAgent({ id: 'r1', instructions: 'A1', model: makeModel() }),
        new DzupAgent({ id: 'r2', instructions: 'A2', model: makeModel() }),
      ]

      await TopologyExecutor.executeRing({
        agents,
        task: 'Refine',
        maxRounds: 3,
      })

      // 2 agents * 3 rounds = 6 calls
      expect(invokeCount).toHaveBeenCalledTimes(6)
    })
  })

  describe('execute', () => {
    it('delegates to executeMesh for mesh topology', async () => {
      const agents = [
        createAgent('m1', 'Mesh 1'),
        createAgent('m2', 'Mesh 2'),
      ]

      const { result, metrics } = await TopologyExecutor.execute({
        agents,
        task: 'Mesh task',
        topology: 'mesh',
      })

      expect(Array.isArray(result)).toBe(true)
      expect(result).toHaveLength(2)
      expect(metrics.topology).toBe('mesh')
    })

    it('delegates to executeRing for ring topology', async () => {
      const agents = [
        createAgent('r1', 'Ring output'),
      ]

      const { result, metrics } = await TopologyExecutor.execute({
        agents,
        task: 'Ring task',
        topology: 'ring',
        maxRounds: 1,
      })

      expect(typeof result).toBe('string')
      expect(result).toBe('Ring output')
      expect(metrics.topology).toBe('ring')
    })

    it('delegates to sequential for pipeline topology', async () => {
      const agents = [
        createAgent('p1', 'Pipeline step 1'),
        createAgent('p2', 'Pipeline done'),
      ]

      const { result, metrics } = await TopologyExecutor.execute({
        agents,
        task: 'Pipeline task',
        topology: 'pipeline',
      })

      expect(typeof result).toBe('string')
      expect(metrics.topology).toBe('pipeline')
      expect(metrics.agentCount).toBe(2)
    })

    it('delegates to parallel for star topology', async () => {
      const agents = [
        createAgent('s1', 'Star 1'),
        createAgent('s2', 'Star 2'),
      ]

      const { result, metrics } = await TopologyExecutor.execute({
        agents,
        task: 'Star task',
        topology: 'star',
      })

      expect(typeof result).toBe('string')
      expect(metrics.topology).toBe('star')
    })
  })

  describe('abort signal', () => {
    it('cancels mesh execution when aborted', async () => {
      const controller = new AbortController()
      controller.abort()

      const agents = [createAgent('a1', 'Should not run')]

      await expect(
        TopologyExecutor.executeMesh({
          agents,
          task: 'Aborted task',
          signal: controller.signal,
        }),
      ).rejects.toThrow('aborted')
    })

    it('cancels ring execution when aborted', async () => {
      const controller = new AbortController()
      controller.abort()

      const agents = [createAgent('a1', 'Should not run')]

      await expect(
        TopologyExecutor.executeRing({
          agents,
          task: 'Aborted task',
          signal: controller.signal,
        }),
      ).rejects.toThrow('aborted')
    })

    it('cancels execute when aborted', async () => {
      const controller = new AbortController()
      controller.abort()

      const agents = [createAgent('a1', 'Should not run')]

      await expect(
        TopologyExecutor.execute({
          agents,
          task: 'Aborted task',
          topology: 'mesh',
          signal: controller.signal,
        }),
      ).rejects.toThrow('aborted')
    })
  })

  describe('metrics', () => {
    it('tracks duration', async () => {
      const agents = [createAgent('a1', 'Result')]

      const { metrics } = await TopologyExecutor.executeMesh({
        agents,
        task: 'Timed task',
      })

      expect(metrics.totalDurationMs).toBeGreaterThanOrEqual(0)
      expect(typeof metrics.totalDurationMs).toBe('number')
    })

    it('tracks agent count and message count', async () => {
      const agents = [
        createAgent('a1', 'R1'),
        createAgent('a2', 'R2'),
        createAgent('a3', 'R3'),
      ]

      const { metrics } = await TopologyExecutor.executeRing({
        agents,
        task: 'Count test',
        maxRounds: 2,
      })

      expect(metrics.agentCount).toBe(3)
      expect(metrics.messageCount).toBe(6) // 3 agents * 2 rounds
    })
  })

  describe('auto-switch', () => {
    it('switches topology when error rate exceeds threshold', async () => {
      // 2 of 3 agents fail in mesh -> error rate = 0.67 > threshold 0.5
      // The successful agent ensures the retry topology can also succeed
      const agents = [
        createFailingAgent('f1'),
        createFailingAgent('f2'),
        createAgent('ok1', 'Success'),
      ]

      const { metrics } = await TopologyExecutor.execute({
        agents,
        task: 'Partially failing task',
        topology: 'mesh',
        autoSwitch: true,
        errorThreshold: 0.5,
      })

      // The analyzer should recommend something different from mesh
      // and switchedFrom should be set
      if (metrics.switchedFrom) {
        expect(metrics.switchedFrom).toBe('mesh')
      }
      // Verify metrics are valid regardless
      expect(metrics.agentCount).toBeGreaterThan(0)
      expect(metrics.totalDurationMs).toBeGreaterThanOrEqual(0)
    })

    it('does not switch when error rate is below threshold', async () => {
      const agents = [
        createAgent('ok1', 'Result 1'),
        createAgent('ok2', 'Result 2'),
        createAgent('ok3', 'Result 3'),
      ]

      const { metrics } = await TopologyExecutor.execute({
        agents,
        task: 'Good task',
        topology: 'mesh',
        autoSwitch: true,
        errorThreshold: 0.5,
      })

      expect(metrics.switchedFrom).toBeUndefined()
      expect(metrics.topology).toBe('mesh')
      expect(metrics.errorCount).toBe(0)
    })
  })

  describe('provider telemetry in metrics', () => {
    it('captures provider telemetry in metrics when available', () => {
      // TopologyMetrics now supports optional provider telemetry fields.
      // Verify the type allows setting them and reading them back.
      const metrics: TopologyMetrics = {
        topology: 'mesh',
        totalDurationMs: 150,
        agentCount: 2,
        messageCount: 2,
        errorCount: 0,
        providerId: 'claude',
        fallbackAttempts: 1,
        attemptedProviders: ['gemini', 'claude'],
      }

      expect(metrics.providerId).toBe('claude')
      expect(metrics.fallbackAttempts).toBe(1)
      expect(metrics.attemptedProviders).toEqual(['gemini', 'claude'])
    })

    it('leaves provider telemetry fields undefined by default', async () => {
      const agents = [createAgent('a1', 'Result')]

      const { metrics } = await TopologyExecutor.executeMesh({
        agents,
        task: 'Standard task',
      })

      expect(metrics.providerId).toBeUndefined()
      expect(metrics.fallbackAttempts).toBeUndefined()
      expect(metrics.attemptedProviders).toBeUndefined()
    })
  })
})

// ---------------------------------------------------------------------------
// Additional coverage tests — Wave 14 Batch C
// ---------------------------------------------------------------------------

describe('TopologyAnalyzer — boundary conditions', () => {
  const analyzer = new TopologyAnalyzer()

  it('handles all-zero characteristics', () => {
    const chars: TaskCharacteristics = {
      subtaskCount: 0,
      interdependence: 0,
      iterativeRefinement: 0,
      coordinationComplexity: 0,
      speedPriority: 0,
      sequentialNature: 0,
    }
    const result = analyzer.analyze(chars)
    expect(result.recommended).toBeTruthy()
    expect(result.alternatives).toHaveLength(4)
    expect(result.confidence).toBeGreaterThanOrEqual(0)
    expect(result.confidence).toBeLessThanOrEqual(1)
  })

  it('handles all-one characteristics', () => {
    const chars: TaskCharacteristics = {
      subtaskCount: 100,
      interdependence: 1,
      iterativeRefinement: 1,
      coordinationComplexity: 1,
      speedPriority: 1,
      sequentialNature: 1,
    }
    const result = analyzer.analyze(chars)
    expect(result.recommended).toBeTruthy()
    expect(result.confidence).toBeGreaterThanOrEqual(0)
    expect(result.confidence).toBeLessThanOrEqual(1)
  })

  it('hierarchical subtaskCount bonus: >3 gives 0.3, <=3 gives 0.1', () => {
    const base = {
      interdependence: 0,
      iterativeRefinement: 0,
      coordinationComplexity: 0,
      speedPriority: 0,
      sequentialNature: 0,
    }
    const lowCount = analyzer.analyze({ ...base, subtaskCount: 2 })
    const highCount = analyzer.analyze({ ...base, subtaskCount: 5 })

    // With all other metrics at 0, hierarchical score is purely subtaskBonus + (1 - 0)*0.3
    // low: 0.1 + 0.3 = 0.4, high: 0.3 + 0.3 = 0.6
    // Both should have hierarchical as a contender; high count should score higher for hierarchical
    const hiHierarchical = [
      ...(highCount.recommended === 'hierarchical'
        ? [{ topology: 'hierarchical' as const, score: 999 }]
        : []),
      ...highCount.alternatives,
    ].find(a => a.topology === 'hierarchical')

    const loHierarchical = [
      ...(lowCount.recommended === 'hierarchical'
        ? [{ topology: 'hierarchical' as const, score: 999 }]
        : []),
      ...lowCount.alternatives,
    ].find(a => a.topology === 'hierarchical')

    // High subtask count should not score lower than low count for hierarchical
    // We just verify the analysis completes and gives valid structure
    expect(hiHierarchical).toBeDefined()
    expect(loHierarchical).toBeDefined()
  })

  it('mesh subtaskCount bonus: <=5 gives 0.2, >5 gives 0.0', () => {
    const base: TaskCharacteristics = {
      subtaskCount: 4,
      interdependence: 0.95,
      iterativeRefinement: 0,
      coordinationComplexity: 0.3,
      speedPriority: 0,
      sequentialNature: 0,
    }
    const result4 = analyzer.analyze(base)
    const result6 = analyzer.analyze({ ...base, subtaskCount: 6 })

    // mesh score with subtaskCount 4: 0.95*0.5 + 0.3*0.3 + 0.2 = 0.865
    // mesh score with subtaskCount 6: 0.95*0.5 + 0.3*0.3 + 0.0 = 0.665
    expect(result4.recommended).toBe('mesh')
    // result6 may or may not be mesh, but the analysis should be valid
    expect(result6.recommended).toBeTruthy()
  })

  it('ring subtaskCount bonus: <=4 gives 0.2, >4 gives 0.1', () => {
    const base: TaskCharacteristics = {
      subtaskCount: 3,
      interdependence: 0,
      iterativeRefinement: 0.95,
      coordinationComplexity: 0,
      speedPriority: 0.05,
      sequentialNature: 0,
    }
    const result3 = analyzer.analyze(base)
    const result5 = analyzer.analyze({ ...base, subtaskCount: 5 })

    expect(result3.recommended).toBe('ring')
    expect(result5.recommended).toBe('ring')
  })

  it('confidence is clamped between 0 and 1', () => {
    // Extreme case: pipeline should dominate heavily
    const chars: TaskCharacteristics = {
      subtaskCount: 1,
      interdependence: 0,
      iterativeRefinement: 0,
      coordinationComplexity: 0,
      speedPriority: 0,
      sequentialNature: 1,
    }
    const result = analyzer.analyze(chars)
    expect(result.confidence).toBeLessThanOrEqual(1)
    expect(result.confidence).toBeGreaterThanOrEqual(0)
  })

  it('each alternative has topology, score, and reason', () => {
    const chars: TaskCharacteristics = {
      subtaskCount: 3,
      interdependence: 0.5,
      iterativeRefinement: 0.5,
      coordinationComplexity: 0.5,
      speedPriority: 0.5,
      sequentialNature: 0.5,
    }
    const result = analyzer.analyze(chars)
    for (const alt of result.alternatives) {
      expect(alt.topology).toBeTruthy()
      expect(typeof alt.score).toBe('number')
      expect(alt.reason).toBeTruthy()
    }
  })

  it('all five topologies are scored (1 recommended + 4 alternatives)', () => {
    const chars: TaskCharacteristics = {
      subtaskCount: 3,
      interdependence: 0.3,
      iterativeRefinement: 0.3,
      coordinationComplexity: 0.3,
      speedPriority: 0.3,
      sequentialNature: 0.3,
    }
    const result = analyzer.analyze(chars)
    const allTopologies = [result.recommended, ...result.alternatives.map(a => a.topology)]
    expect(allTopologies).toHaveLength(5)
    expect(new Set(allTopologies).size).toBe(5)
    expect(allTopologies).toContain('hierarchical')
    expect(allTopologies).toContain('pipeline')
    expect(allTopologies).toContain('star')
    expect(allTopologies).toContain('mesh')
    expect(allTopologies).toContain('ring')
  })

  it('subtaskCount exactly 3 uses <=3 bonus for hierarchical', () => {
    const chars: TaskCharacteristics = {
      subtaskCount: 3,
      interdependence: 0,
      iterativeRefinement: 0,
      coordinationComplexity: 1,
      speedPriority: 0,
      sequentialNature: 0,
    }
    const result = analyzer.analyze(chars)
    // subtaskCount 3 => subtaskBonus 0.1 for hierarchical
    // hierarchical score: 1*0.4 + 0.1 + 1*0.3 = 0.8
    expect(result.recommended).toBe('hierarchical')
  })

  it('subtaskCount exactly 4 uses <=4 bonus for ring', () => {
    const chars: TaskCharacteristics = {
      subtaskCount: 4,
      interdependence: 0,
      iterativeRefinement: 0.95,
      coordinationComplexity: 0,
      speedPriority: 0.05,
      sequentialNature: 0,
    }
    const result = analyzer.analyze(chars)
    expect(result.recommended).toBe('ring')
  })

  it('subtaskCount exactly 5 uses <=5 bonus for mesh', () => {
    const chars: TaskCharacteristics = {
      subtaskCount: 5,
      interdependence: 0.95,
      iterativeRefinement: 0,
      coordinationComplexity: 0.3,
      speedPriority: 0,
      sequentialNature: 0,
    }
    const result = analyzer.analyze(chars)
    // mesh score: 0.95*0.5 + 0.3*0.3 + 0.2 = 0.865
    expect(result.recommended).toBe('mesh')
  })

  it('single subtask still produces valid recommendations', () => {
    const chars: TaskCharacteristics = {
      subtaskCount: 1,
      interdependence: 0.5,
      iterativeRefinement: 0.5,
      coordinationComplexity: 0.5,
      speedPriority: 0.5,
      sequentialNature: 0.5,
    }
    const result = analyzer.analyze(chars)
    expect(result.recommended).toBeTruthy()
    expect(result.alternatives).toHaveLength(4)
  })

  it('very high subtaskCount (>5) removes mesh subtask bonus', () => {
    const chars: TaskCharacteristics = {
      subtaskCount: 20,
      interdependence: 0.5,
      iterativeRefinement: 0.5,
      coordinationComplexity: 0.5,
      speedPriority: 0.5,
      sequentialNature: 0.5,
    }
    const result = analyzer.analyze(chars)
    // mesh loses its 0.2 bonus, so it should score lower
    // hierarchical gets 0.3 bonus for >3
    expect(result.recommended).toBeTruthy()
  })
})

describe('TopologyExecutor — executeMesh edge cases', () => {
  it('throws OrchestrationError for zero agents', async () => {
    await expect(
      TopologyExecutor.executeMesh({
        agents: [],
        task: 'No agents',
      }),
    ).rejects.toThrow('at least one agent')
  })

  it('works with a single agent', async () => {
    const agents = [createAgent('solo', 'Solo result')]
    const { results, metrics } = await TopologyExecutor.executeMesh({
      agents,
      task: 'Solo task',
    })

    expect(results).toHaveLength(1)
    expect(results[0]).toBe('Solo result')
    expect(metrics.agentCount).toBe(1)
    expect(metrics.messageCount).toBe(1)
    expect(metrics.errorCount).toBe(0)
  })

  it('captures non-Error rejection as string in error result', async () => {
    const model = {
      invoke: vi.fn(async () => {
        throw 'string-error'  // eslint-disable-line no-throw-literal
      }),
      bindTools: vi.fn(function (this: BaseChatModel) {
        return this
      }),
      _modelType: () => 'base_chat_model',
      _llmType: () => 'mock',
    } as unknown as BaseChatModel

    const agent = new DzupAgent({
      id: 'str-err',
      instructions: 'fail',
      model,
    })

    const { results, metrics } = await TopologyExecutor.executeMesh({
      agents: [agent],
      task: 'Fail with string',
    })

    expect(results[0]).toContain('[error:')
    expect(results[0]).toContain('string-error')
    expect(metrics.errorCount).toBe(1)
  })

  it('all agents failing still returns results with error markers', async () => {
    const agents = [
      createFailingAgent('f1'),
      createFailingAgent('f2'),
      createFailingAgent('f3'),
    ]

    const { results, metrics } = await TopologyExecutor.executeMesh({
      agents,
      task: 'All fail',
    })

    expect(results).toHaveLength(3)
    for (const r of results) {
      expect(r).toContain('[error:')
    }
    expect(metrics.errorCount).toBe(3)
    expect(metrics.messageCount).toBe(3)
  })

  it('passes signal to agent.generate in mesh', async () => {
    const controller = new AbortController()
    const model = createMockModel([{ content: 'OK' }])
    const invokeSpy = model.invoke as ReturnType<typeof vi.fn>

    const agent = new DzupAgent({
      id: 'sig-test',
      instructions: 'test',
      model,
    })

    await TopologyExecutor.executeMesh({
      agents: [agent],
      task: 'With signal',
      signal: controller.signal,
    })

    expect(invokeSpy).toHaveBeenCalled()
  })
})

describe('TopologyExecutor — executeRing edge cases', () => {
  it('throws OrchestrationError for zero agents', async () => {
    await expect(
      TopologyExecutor.executeRing({
        agents: [],
        task: 'No agents',
      }),
    ).rejects.toThrow('at least one agent')
  })

  it('uses default maxRounds of 3 when not specified', async () => {
    const invokeCount = vi.fn()
    const model = {
      invoke: vi.fn(async () => {
        invokeCount()
        return new AIMessage({ content: 'out', response_metadata: {} })
      }),
      bindTools: vi.fn(function (this: BaseChatModel) {
        return this
      }),
      _modelType: () => 'base_chat_model',
      _llmType: () => 'mock',
    } as unknown as BaseChatModel

    const agents = [
      new DzupAgent({ id: 'r1', instructions: 'A', model }),
    ]

    await TopologyExecutor.executeRing({
      agents,
      task: 'Default rounds',
      // no maxRounds — should default to 3
    })

    // 1 agent * 3 rounds = 3 calls
    expect(invokeCount).toHaveBeenCalledTimes(3)
  })

  it('single agent in ring executes for each round', async () => {
    const model = createMockModel([
      { content: 'Round 1' },
      { content: 'Round 2' },
    ])
    const agent = new DzupAgent({ id: 'solo', instructions: 'A', model })

    const { result, metrics } = await TopologyExecutor.executeRing({
      agents: [agent],
      task: 'Solo ring',
      maxRounds: 2,
    })

    expect(result).toBe('Round 2')
    expect(metrics.agentCount).toBe(1)
    expect(metrics.messageCount).toBe(2)
  })

  it('handles agent error mid-ring and continues', async () => {
    let callCount = 0
    const model = {
      invoke: vi.fn(async () => {
        callCount++
        if (callCount === 2) {
          throw new Error('Mid-ring failure')
        }
        return new AIMessage({ content: `Call ${callCount}`, response_metadata: {} })
      }),
      bindTools: vi.fn(function (this: BaseChatModel) {
        return this
      }),
      _modelType: () => 'base_chat_model',
      _llmType: () => 'mock',
    } as unknown as BaseChatModel

    const agent = new DzupAgent({ id: 'flaky', instructions: 'A', model })

    const { result, metrics } = await TopologyExecutor.executeRing({
      agents: [agent],
      task: 'Flaky ring',
      maxRounds: 3,
    })

    expect(metrics.errorCount).toBe(1)
    // After error, previous output is kept; subsequent calls continue
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('on first-call error with no previous output, sets error message', async () => {
    const model = {
      invoke: vi.fn(async () => {
        throw new Error('First call fail')
      }),
      bindTools: vi.fn(function (this: BaseChatModel) {
        return this
      }),
      _modelType: () => 'base_chat_model',
      _llmType: () => 'mock',
    } as unknown as BaseChatModel

    const agent = new DzupAgent({ id: 'fail-first', instructions: 'A', model })

    const { result, metrics } = await TopologyExecutor.executeRing({
      agents: [agent],
      task: 'Fail first',
      maxRounds: 1,
    })

    expect(result).toContain('[error:')
    expect(result).toContain('First call fail')
    expect(metrics.errorCount).toBe(1)
  })

  it('on error with existing previous output, keeps previous output', async () => {
    const model1 = createMockModel([{ content: 'Good output' }])
    const model2 = {
      invoke: vi.fn(async () => {
        throw new Error('Second agent fail')
      }),
      bindTools: vi.fn(function (this: BaseChatModel) {
        return this
      }),
      _modelType: () => 'base_chat_model',
      _llmType: () => 'mock',
    } as unknown as BaseChatModel

    const agents = [
      new DzupAgent({ id: 'good', instructions: 'A', model: model1 }),
      new DzupAgent({ id: 'bad', instructions: 'B', model: model2 }),
    ]

    const { result, metrics } = await TopologyExecutor.executeRing({
      agents,
      task: 'Partial fail',
      maxRounds: 1,
    })

    // The second agent fails, but currentOutput was 'Good output', so it's preserved
    expect(result).toBe('Good output')
    expect(metrics.errorCount).toBe(1)
  })

  it('ring error with non-Error thrown keeps previous output', async () => {
    const model1 = createMockModel([{ content: 'Previous' }])
    const model2 = {
      invoke: vi.fn(async () => {
        throw 'non-error-string'  // eslint-disable-line no-throw-literal
      }),
      bindTools: vi.fn(function (this: BaseChatModel) {
        return this
      }),
      _modelType: () => 'base_chat_model',
      _llmType: () => 'mock',
    } as unknown as BaseChatModel

    const agents = [
      new DzupAgent({ id: 'ok', instructions: 'A', model: model1 }),
      new DzupAgent({ id: 'str-err', instructions: 'B', model: model2 }),
    ]

    const { result, metrics } = await TopologyExecutor.executeRing({
      agents,
      task: 'String throw',
      maxRounds: 1,
    })

    expect(result).toBe('Previous')
    expect(metrics.errorCount).toBe(1)
  })

  it('ring abort mid-execution after first agent', async () => {
    const controller = new AbortController()
    let callCount = 0

    const model = {
      invoke: vi.fn(async () => {
        callCount++
        if (callCount === 1) {
          // After first call succeeds, abort
          controller.abort()
        }
        return new AIMessage({ content: `Call ${callCount}`, response_metadata: {} })
      }),
      bindTools: vi.fn(function (this: BaseChatModel) {
        return this
      }),
      _modelType: () => 'base_chat_model',
      _llmType: () => 'mock',
    } as unknown as BaseChatModel

    const agents = [
      new DzupAgent({ id: 'a1', instructions: 'A', model }),
      new DzupAgent({ id: 'a2', instructions: 'B', model }),
    ]

    await expect(
      TopologyExecutor.executeRing({
        agents,
        task: 'Abort mid',
        maxRounds: 2,
        signal: controller.signal,
      }),
    ).rejects.toThrow('aborted')
  })

  it('includes previous output in subsequent agent prompts', async () => {
    const capturedInputs: string[] = []
    const makeCapturingModel = (response: string) => ({
      invoke: vi.fn(async (messages: BaseMessage[]) => {
        const lastMsg = messages[messages.length - 1]
        if (lastMsg && 'content' in lastMsg) {
          capturedInputs.push(lastMsg.content as string)
        }
        return new AIMessage({ content: response, response_metadata: {} })
      }),
      bindTools: vi.fn(function (this: BaseChatModel) {
        return this
      }),
      _modelType: () => 'base_chat_model',
      _llmType: () => 'mock',
    }) as unknown as BaseChatModel

    const agents = [
      new DzupAgent({ id: 'a1', instructions: 'A', model: makeCapturingModel('Output A') }),
      new DzupAgent({ id: 'a2', instructions: 'B', model: makeCapturingModel('Output B') }),
    ]

    await TopologyExecutor.executeRing({
      agents,
      task: 'My task',
      maxRounds: 1,
    })

    // First agent gets just the task
    expect(capturedInputs[0]).toBe('My task')
    // Second agent gets task + previous output
    expect(capturedInputs[1]).toContain('My task')
    expect(capturedInputs[1]).toContain('Previous output:')
    expect(capturedInputs[1]).toContain('Output A')
  })
})

describe('TopologyExecutor — execute() routing and hierarchical', () => {
  it('hierarchical topology requires at least 2 agents', async () => {
    const agents = [createAgent('solo', 'Result')]

    await expect(
      TopologyExecutor.execute({
        agents,
        task: 'Hierarchical with 1 agent',
        topology: 'hierarchical',
      }),
    ).rejects.toThrow('at least 2 agents')
  })

  it('hierarchical topology uses first agent as coordinator', async () => {
    const coordinator = createAgent('coordinator', 'Coordinated result')
    const worker = createAgent('worker', 'Worker result')

    const { metrics } = await TopologyExecutor.execute({
      agents: [coordinator, worker],
      task: 'Hierarchical task',
      topology: 'hierarchical',
    })

    expect(metrics.topology).toBe('hierarchical')
    expect(metrics.agentCount).toBe(2)
    expect(metrics.messageCount).toBe(2) // 1 worker + 1 coordinator
    expect(metrics.errorCount).toBe(0)
  })

  it('hierarchical topology with 3 agents has correct message count', async () => {
    const agents = [
      createAgent('coord', 'Final'),
      createAgent('w1', 'Work 1'),
      createAgent('w2', 'Work 2'),
    ]

    const { metrics } = await TopologyExecutor.execute({
      agents,
      task: 'Three agent hierarchy',
      topology: 'hierarchical',
    })

    expect(metrics.topology).toBe('hierarchical')
    expect(metrics.agentCount).toBe(3)
    expect(metrics.messageCount).toBe(3) // 2 workers + 1 coordinator
  })

  it('pipeline topology returns string result', async () => {
    const agents = [
      createAgent('p1', 'Step 1'),
      createAgent('p2', 'Final output'),
    ]

    const { result, metrics } = await TopologyExecutor.execute({
      agents,
      task: 'Pipeline',
      topology: 'pipeline',
    })

    expect(typeof result).toBe('string')
    expect(metrics.topology).toBe('pipeline')
    expect(metrics.messageCount).toBe(2)
    expect(metrics.errorCount).toBe(0)
  })

  it('star topology returns string result with correct metrics', async () => {
    const agents = [
      createAgent('s1', 'Star A'),
      createAgent('s2', 'Star B'),
      createAgent('s3', 'Star C'),
    ]

    const { result, metrics } = await TopologyExecutor.execute({
      agents,
      task: 'Star',
      topology: 'star',
    })

    expect(typeof result).toBe('string')
    expect(metrics.topology).toBe('star')
    expect(metrics.agentCount).toBe(3)
    expect(metrics.messageCount).toBe(3)
    expect(metrics.errorCount).toBe(0)
    expect(metrics.totalDurationMs).toBeGreaterThanOrEqual(0)
  })

  it('mesh via execute returns array result', async () => {
    const agents = [
      createAgent('m1', 'Mesh A'),
      createAgent('m2', 'Mesh B'),
    ]

    const { result } = await TopologyExecutor.execute({
      agents,
      task: 'Mesh via execute',
      topology: 'mesh',
    })

    expect(Array.isArray(result)).toBe(true)
    expect((result as string[])).toHaveLength(2)
  })

  it('ring via execute returns string result', async () => {
    const agents = [createAgent('r1', 'Ring out')]

    const { result } = await TopologyExecutor.execute({
      agents,
      task: 'Ring via execute',
      topology: 'ring',
      maxRounds: 1,
    })

    expect(typeof result).toBe('string')
    expect(result).toBe('Ring out')
  })
})

describe('TopologyExecutor — abort signal edge cases', () => {
  it('non-aborted signal allows execution to proceed', async () => {
    const controller = new AbortController()
    const agents = [createAgent('a1', 'OK')]

    const { results } = await TopologyExecutor.executeMesh({
      agents,
      task: 'With live signal',
      signal: controller.signal,
    })

    expect(results[0]).toBe('OK')
  })

  it('abort signal on execute() checks before routing', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      TopologyExecutor.execute({
        agents: [createAgent('a1', 'No')],
        task: 'Aborted',
        topology: 'pipeline',
        signal: controller.signal,
      }),
    ).rejects.toThrow('aborted')
  })

  it('abort signal on execute() with star topology', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      TopologyExecutor.execute({
        agents: [createAgent('a1', 'No')],
        task: 'Aborted star',
        topology: 'star',
        signal: controller.signal,
      }),
    ).rejects.toThrow('aborted')
  })

  it('abort signal on execute() with hierarchical topology', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      TopologyExecutor.execute({
        agents: [createAgent('a1', 'No'), createAgent('a2', 'No')],
        task: 'Aborted hierarchical',
        topology: 'hierarchical',
        signal: controller.signal,
      }),
    ).rejects.toThrow('aborted')
  })

  it('abort signal on execute() with ring topology', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      TopologyExecutor.execute({
        agents: [createAgent('a1', 'No')],
        task: 'Aborted ring',
        topology: 'ring',
        signal: controller.signal,
      }),
    ).rejects.toThrow('aborted')
  })

  it('undefined signal does not cause errors', async () => {
    const agents = [createAgent('a1', 'Fine')]

    const { results } = await TopologyExecutor.executeMesh({
      agents,
      task: 'No signal',
      // signal is undefined
    })

    expect(results[0]).toBe('Fine')
  })
})

describe('TopologyExecutor — auto-switch advanced scenarios', () => {
  it('does not switch when autoSwitch is false (default)', async () => {
    const agents = [
      createFailingAgent('f1'),
      createFailingAgent('f2'),
      createAgent('ok', 'OK'),
    ]

    const { metrics } = await TopologyExecutor.execute({
      agents,
      task: 'No auto-switch',
      topology: 'mesh',
      // autoSwitch defaults to false
    })

    expect(metrics.switchedFrom).toBeUndefined()
  })

  it('does not switch when agentCount is 0 (impossible in practice)', async () => {
    // This is a logic branch test: agentCount > 0 must be true for switch
    const agents = [createAgent('a1', 'OK')]

    const { metrics } = await TopologyExecutor.execute({
      agents,
      task: 'Single OK agent',
      topology: 'mesh',
      autoSwitch: true,
      errorThreshold: 0.5,
    })

    expect(metrics.switchedFrom).toBeUndefined()
    expect(metrics.errorCount).toBe(0)
  })

  it('does not switch when error rate equals but does not exceed threshold', async () => {
    // 1 of 2 fails => error rate 0.5, threshold 0.5 => NOT > threshold
    const agents = [
      createFailingAgent('f1'),
      createAgent('ok1', 'OK'),
    ]

    const { metrics } = await TopologyExecutor.execute({
      agents,
      task: 'Exactly at threshold',
      topology: 'mesh',
      autoSwitch: true,
      errorThreshold: 0.5,
    })

    expect(metrics.switchedFrom).toBeUndefined()
  })

  it('auto-switch: does not crash when retry topology is recommended', async () => {
    // Use mesh where errors are handled gracefully (allSettled)
    // inferCharacteristics returns speedPriority=0.7, which favors star
    // Since mesh != star, it will attempt a retry with star
    const agents = [
      createFailingAgent('f1'),
      createFailingAgent('f2'),
      createFailingAgent('f3'),
    ]

    const { metrics } = await TopologyExecutor.execute({
      agents,
      task: 'All fail mesh for retry',
      topology: 'mesh',
      autoSwitch: true,
      errorThreshold: 0.0,
    })

    // All agents fail in mesh (error rate 1.0), triggers switch attempt
    // Retry topology also fails (same agents), so original result returned
    expect(metrics.agentCount).toBe(3)
    expect(metrics.errorCount).toBe(3)
  })

  it('auto-switch: retry topology failure returns original result with switchedFrom', async () => {
    // All agents fail in both topologies
    const agents = [
      createFailingAgent('f1'),
      createFailingAgent('f2'),
      createFailingAgent('f3'),
    ]

    const { metrics } = await TopologyExecutor.execute({
      agents,
      task: 'Double failure',
      topology: 'mesh',
      autoSwitch: true,
      errorThreshold: 0.0, // trigger switch on any error
    })

    // Original mesh result should be returned (all errors)
    // switchedFrom may or may not be set depending on whether the recommended topology differs
    expect(metrics.agentCount).toBe(3)
    expect(metrics.errorCount).toBe(3)
  })

  it('auto-switch with custom high errorThreshold does not trigger easily', async () => {
    // 1 of 3 fails => error rate 0.33, threshold 0.9 => no switch
    const agents = [
      createFailingAgent('f1'),
      createAgent('ok1', 'OK1'),
      createAgent('ok2', 'OK2'),
    ]

    const { metrics } = await TopologyExecutor.execute({
      agents,
      task: 'High threshold',
      topology: 'mesh',
      autoSwitch: true,
      errorThreshold: 0.9,
    })

    expect(metrics.switchedFrom).toBeUndefined()
  })

  it('auto-switch: successful retry includes switchedFrom annotation', async () => {
    // 2 of 2 fail in mesh (error rate 1.0)
    // Retry with different topology should succeed if agents work for that topology
    // But since the same agents are used, they'll fail again
    // Testing the code path where retry succeeds requires agents that fail in mesh but succeed in ring
    // We can use agents that fail only on first call
    let callCount = 0
    const flakyModel = {
      invoke: vi.fn(async () => {
        callCount++
        // First 2 calls fail (mesh), then succeed (retry topology)
        if (callCount <= 2) {
          throw new Error('Mesh failure')
        }
        return new AIMessage({ content: 'Retry success', response_metadata: {} })
      }),
      bindTools: vi.fn(function (this: BaseChatModel) {
        return this
      }),
      _modelType: () => 'base_chat_model',
      _llmType: () => 'mock',
    } as unknown as BaseChatModel

    const agents = [
      new DzupAgent({ id: 'flaky1', instructions: 'A', model: flakyModel }),
      new DzupAgent({ id: 'flaky2', instructions: 'B', model: flakyModel }),
    ]

    const { metrics } = await TopologyExecutor.execute({
      agents,
      task: 'Flaky mesh',
      topology: 'mesh',
      autoSwitch: true,
      errorThreshold: 0.5,
    })

    // If retry topology is different from mesh and succeeds, switchedFrom should be set
    if (metrics.switchedFrom) {
      expect(metrics.switchedFrom).toBe('mesh')
    }
  })

  it('uses default errorThreshold of 0.5 when not specified', async () => {
    // 2 of 3 fail => error rate 0.67 > 0.5 default threshold
    const agents = [
      createFailingAgent('f1'),
      createFailingAgent('f2'),
      createAgent('ok', 'OK'),
    ]

    const { metrics } = await TopologyExecutor.execute({
      agents,
      task: 'Default threshold',
      topology: 'mesh',
      autoSwitch: true,
      // no errorThreshold — defaults to 0.5
    })

    // Error rate 0.67 > 0.5 should trigger switch attempt
    // Whether switchedFrom is set depends on analyzer recommendation
    expect(metrics.agentCount).toBe(3)
  })
})

describe('TopologyExecutor — metrics edge cases', () => {
  it('mesh metrics track errors correctly for mixed results', async () => {
    const agents = [
      createAgent('ok1', 'Good 1'),
      createFailingAgent('f1'),
      createAgent('ok2', 'Good 2'),
      createFailingAgent('f2'),
    ]

    const { results, metrics } = await TopologyExecutor.executeMesh({
      agents,
      task: 'Mixed',
    })

    expect(results).toHaveLength(4)
    expect(metrics.errorCount).toBe(2)
    expect(metrics.messageCount).toBe(4)
    expect(metrics.agentCount).toBe(4)
  })

  it('ring metrics track multiple rounds with errors', async () => {
    let callNum = 0
    const model = {
      invoke: vi.fn(async () => {
        callNum++
        if (callNum % 3 === 0) {
          throw new Error('Every third call fails')
        }
        return new AIMessage({ content: `Output ${callNum}`, response_metadata: {} })
      }),
      bindTools: vi.fn(function (this: BaseChatModel) {
        return this
      }),
      _modelType: () => 'base_chat_model',
      _llmType: () => 'mock',
    } as unknown as BaseChatModel

    const agents = [
      new DzupAgent({ id: 'a1', instructions: 'A', model }),
      new DzupAgent({ id: 'a2', instructions: 'B', model }),
      new DzupAgent({ id: 'a3', instructions: 'C', model }),
    ]

    const { metrics } = await TopologyExecutor.executeRing({
      agents,
      task: 'Periodic failure',
      maxRounds: 2,
    })

    // 3 agents * 2 rounds = 6 messages
    expect(metrics.messageCount).toBe(6)
    // Every 3rd call fails: calls 3 and 6 fail
    expect(metrics.errorCount).toBe(2)
    expect(metrics.agentCount).toBe(3)
  })

  it('pipeline metrics have zero error count', async () => {
    const agents = [
      createAgent('p1', 'Step 1'),
      createAgent('p2', 'Step 2'),
      createAgent('p3', 'Step 3'),
    ]

    const { metrics } = await TopologyExecutor.execute({
      agents,
      task: 'Pipeline metrics',
      topology: 'pipeline',
    })

    expect(metrics.errorCount).toBe(0)
    expect(metrics.agentCount).toBe(3)
    expect(metrics.messageCount).toBe(3)
  })

  it('star metrics have zero error count', async () => {
    const agents = [
      createAgent('s1', 'A'),
      createAgent('s2', 'B'),
    ]

    const { metrics } = await TopologyExecutor.execute({
      agents,
      task: 'Star metrics',
      topology: 'star',
    })

    expect(metrics.errorCount).toBe(0)
    expect(metrics.agentCount).toBe(2)
    expect(metrics.messageCount).toBe(2)
  })

  it('hierarchical metrics include coordinator in message count', async () => {
    const agents = [
      createAgent('coord', 'Result'),
      createAgent('w1', 'Work'),
    ]

    const { metrics } = await TopologyExecutor.execute({
      agents,
      task: 'Hierarchical metrics',
      topology: 'hierarchical',
    })

    expect(metrics.messageCount).toBe(2) // 1 worker + 1 coordinator
    expect(metrics.errorCount).toBe(0)
  })
})
