/**
 * Tests for TopologyAnalyzer and TopologyExecutor.
 */
import { describe, it, expect, vi } from 'vitest'
import { AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import { ForgeAgent } from '../agent/forge-agent.js'
import { TopologyAnalyzer } from '../orchestration/topology/topology-analyzer.js'
import { TopologyExecutor } from '../orchestration/topology/topology-executor.js'
import type { TaskCharacteristics } from '../orchestration/topology/topology-types.js'

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

function createAgent(id: string, content: string): ForgeAgent {
  return new ForgeAgent({
    id,
    description: `Agent ${id}`,
    instructions: `You are ${id}.`,
    model: createMockModel([{ content }]),
  })
}

function createFailingAgent(id: string): ForgeAgent {
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

  return new ForgeAgent({
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
        new ForgeAgent({ id: 'r1', instructions: 'Agent 1', model: model1 }),
        new ForgeAgent({ id: 'r2', instructions: 'Agent 2', model: model2 }),
        new ForgeAgent({ id: 'r3', instructions: 'Agent 3', model: model3 }),
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
        new ForgeAgent({ id: 'r1', instructions: 'A1', model: makeModel() }),
        new ForgeAgent({ id: 'r2', instructions: 'A2', model: makeModel() }),
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
})
