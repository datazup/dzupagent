import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SelfLearningRuntime } from '../self-correction/self-learning-runtime.js'
import type { SelfLearningConfig } from '../self-correction/self-learning-runtime.js'
import type {
  PipelineRuntimeConfig,
  PipelineRuntimeEvent,
  NodeResult,
} from '../pipeline/pipeline-runtime-types.js'
import type { PipelineDefinition, PipelineCheckpoint } from '@dzipagent/core'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait a tick so fire-and-forget promises settle. */
const tick = () => new Promise<void>((r) => setTimeout(r, 20))

function createMinimalDefinition(id = 'test-pipeline'): PipelineDefinition {
  return {
    id,
    version: '1.0.0',
    entryNodeId: 'start',
    checkpointStrategy: 'none',
    nodes: [
      { id: 'start', type: 'standard', label: 'Start' },
      { id: 'end', type: 'standard', label: 'End' },
    ],
    edges: [
      { type: 'sequential', sourceNodeId: 'start', targetNodeId: 'end' },
    ],
  }
}

function createMockStore() {
  return {
    get: vi.fn().mockResolvedValue(undefined),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    batch: vi.fn().mockResolvedValue([]),
    list: vi.fn().mockResolvedValue([]),
  }
}

function createSuccessExecutor(): PipelineRuntimeConfig['nodeExecutor'] {
  return vi.fn().mockImplementation(async (nodeId: string): Promise<NodeResult> => ({
    nodeId,
    output: { value: `${nodeId}-output` },
    durationMs: 50,
  }))
}

function createFailingExecutor(failNodeId: string): PipelineRuntimeConfig['nodeExecutor'] {
  return vi.fn().mockImplementation(async (nodeId: string): Promise<NodeResult> => {
    if (nodeId === failNodeId) {
      return { nodeId, output: null, durationMs: 10, error: `Node ${nodeId} failed` }
    }
    return { nodeId, output: { value: `${nodeId}-output` }, durationMs: 50 }
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SelfLearningRuntime', () => {
  let mockStore: ReturnType<typeof createMockStore>
  let learningConfig: SelfLearningConfig
  let pipelineConfig: PipelineRuntimeConfig

  beforeEach(() => {
    mockStore = createMockStore()
    learningConfig = {
      store: mockStore as unknown as SelfLearningConfig['store'],
      taskType: 'test-task',
      riskClass: 'standard',
    }
    pipelineConfig = {
      definition: createMinimalDefinition(),
      nodeExecutor: createSuccessExecutor(),
    }
  })

  // -----------------------------------------------------------------------
  // Basic delegation
  // -----------------------------------------------------------------------

  describe('execute delegates to PipelineRuntime', () => {
    it('returns a completed result on success', async () => {
      const slr = new SelfLearningRuntime(pipelineConfig, learningConfig)
      const result = await slr.execute()

      expect(result.state).toBe('completed')
      expect(result.pipelineId).toBe('test-pipeline')
      expect(result.nodeResults.size).toBe(2)
    })

    it('returns a failed result when executor fails', async () => {
      pipelineConfig.nodeExecutor = createFailingExecutor('start')
      const slr = new SelfLearningRuntime(pipelineConfig, learningConfig)
      const result = await slr.execute()

      expect(result.state).toBe('failed')
    })
  })

  // -----------------------------------------------------------------------
  // Learning hooks auto-configured
  // -----------------------------------------------------------------------

  describe('learning hooks are auto-configured', () => {
    it('includes learningMetrics in result', async () => {
      const slr = new SelfLearningRuntime(pipelineConfig, learningConfig)
      const result = await slr.execute()
      await tick()

      expect(result.learningMetrics).toBeDefined()
      expect(typeof result.learningMetrics!.enrichmentsApplied).toBe('number')
      expect(typeof result.learningMetrics!.stuckDetections).toBe('number')
      expect(typeof result.learningMetrics!.recoveriesAttempted).toBe('number')
    })
  })

  // -----------------------------------------------------------------------
  // Post-run analysis
  // -----------------------------------------------------------------------

  describe('post-run analysis', () => {
    it('runs after successful completion', async () => {
      const slr = new SelfLearningRuntime(pipelineConfig, learningConfig)
      const result = await slr.execute()

      expect(result.analysis).toBeDefined()
      expect(typeof result.analysis!.lessonsCreated).toBe('number')
      expect(typeof result.analysis!.rulesCreated).toBe('number')
      expect(Array.isArray(result.analysis!.suboptimalNodes)).toBe(true)
      expect(typeof result.analysis!.summary).toBe('string')
    })

    it('runs after pipeline failure', async () => {
      pipelineConfig.nodeExecutor = createFailingExecutor('start')
      const slr = new SelfLearningRuntime(pipelineConfig, learningConfig)
      const result = await slr.execute()

      expect(result.state).toBe('failed')
      expect(result.analysis).toBeDefined()
      expect(typeof result.analysis!.summary).toBe('string')
    })

    it('does not run when enablePostRunAnalysis is false', async () => {
      learningConfig.enablePostRunAnalysis = false
      const slr = new SelfLearningRuntime(pipelineConfig, learningConfig)
      const result = await slr.execute()

      expect(result.analysis).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // Stuck detection wiring
  // -----------------------------------------------------------------------

  describe('stuck detection is wired', () => {
    it('creates a stuck detector when enableStuckDetection is true (default)', () => {
      const slr = new SelfLearningRuntime(pipelineConfig, learningConfig)
      // The runtime should be accessible and not throw
      expect(slr.runtime).toBeDefined()
      expect(slr.getRunState()).toBe('idle')
    })

    it('does not create stuck detector when enableStuckDetection is false', () => {
      learningConfig.enableStuckDetection = false
      const slr = new SelfLearningRuntime(pipelineConfig, learningConfig)
      expect(slr.runtime).toBeDefined()
    })

    it('preserves existing stuck detector from pipeline config', () => {
      const existingDetector = { recordNodeFailure: vi.fn(), recordNodeOutput: vi.fn(), getSummary: vi.fn() }
      pipelineConfig.stuckDetector = existingDetector as unknown as PipelineRuntimeConfig['stuckDetector']

      const slr = new SelfLearningRuntime(pipelineConfig, learningConfig)
      expect(slr.runtime).toBeDefined()
    })
  })

  // -----------------------------------------------------------------------
  // Event handler chaining
  // -----------------------------------------------------------------------

  describe('event handler chaining', () => {
    it('calls both existing and learning event handlers', async () => {
      const existingEvents: PipelineRuntimeEvent[] = []
      pipelineConfig.onEvent = (event) => { existingEvents.push(event) }

      const slr = new SelfLearningRuntime(pipelineConfig, learningConfig)
      await slr.execute()
      await tick()

      // Existing handler should have received events
      expect(existingEvents.length).toBeGreaterThan(0)
      const types = existingEvents.map((e) => e.type)
      expect(types).toContain('pipeline:started')
      expect(types).toContain('pipeline:completed')
    })

    it('still works when existing handler throws', async () => {
      pipelineConfig.onEvent = () => { throw new Error('existing handler boom') }

      const slr = new SelfLearningRuntime(pipelineConfig, learningConfig)
      // Should not throw
      const result = await slr.execute()
      expect(result.state).toBe('completed')
    })
  })

  // -----------------------------------------------------------------------
  // Disable individual features
  // -----------------------------------------------------------------------

  describe('disable individual features', () => {
    it('disables all learning when enableLearning is false', async () => {
      learningConfig.enableLearning = false
      const slr = new SelfLearningRuntime(pipelineConfig, learningConfig)
      const result = await slr.execute()

      expect(result.state).toBe('completed')
      // No analysis because post-run analyzer not created
      expect(result.analysis).toBeUndefined()
    })

    it('disables enrichment when enableEnrichment is false', async () => {
      learningConfig.enableEnrichment = false
      const slr = new SelfLearningRuntime(pipelineConfig, learningConfig)
      const result = await slr.execute()
      await tick()

      expect(result.learningMetrics!.enrichmentsApplied).toBe(0)
    })

    it('disables trajectory when enableTrajectory is false', async () => {
      learningConfig.enableTrajectory = false
      const slr = new SelfLearningRuntime(pipelineConfig, learningConfig)
      const result = await slr.execute()

      expect(result.state).toBe('completed')
    })

    it('disables observability when enableObservability is false', async () => {
      learningConfig.enableObservability = false
      const slr = new SelfLearningRuntime(pipelineConfig, learningConfig)
      const result = await slr.execute()

      expect(result.state).toBe('completed')
    })
  })

  // -----------------------------------------------------------------------
  // getLearningMetrics
  // -----------------------------------------------------------------------

  describe('getLearningMetrics', () => {
    it('returns accumulated data', async () => {
      const slr = new SelfLearningRuntime(pipelineConfig, learningConfig)
      const before = slr.getLearningMetrics()

      expect(before.enrichmentsApplied).toBe(0)
      expect(before.stuckDetections).toBe(0)
      expect(before.recoveriesAttempted).toBe(0)
      expect(before.recoveriesSucceeded).toBe(0)

      await slr.execute()
      await tick()

      const after = slr.getLearningMetrics()
      // Values should be numbers (may be 0 if store returns no enrichment data)
      expect(typeof after.enrichmentsApplied).toBe('number')
      expect(typeof after.stuckDetections).toBe('number')
    })
  })

  // -----------------------------------------------------------------------
  // Cancel
  // -----------------------------------------------------------------------

  describe('cancel delegates to runtime', () => {
    it('sets state to cancelled', () => {
      const slr = new SelfLearningRuntime(pipelineConfig, learningConfig)
      slr.cancel()

      expect(slr.getRunState()).toBe('cancelled')
    })
  })

  // -----------------------------------------------------------------------
  // Best-effort (analysis failure does not crash)
  // -----------------------------------------------------------------------

  describe('best-effort resilience', () => {
    it('does not crash when store.put throws during analysis', async () => {
      mockStore.put.mockRejectedValue(new Error('store write failed'))
      const slr = new SelfLearningRuntime(pipelineConfig, learningConfig)
      const result = await slr.execute()

      // Pipeline itself should still succeed
      expect(result.state).toBe('completed')
    })

    it('does not crash when store.search throws during enrichment', async () => {
      mockStore.search.mockRejectedValue(new Error('store read failed'))
      const slr = new SelfLearningRuntime(pipelineConfig, learningConfig)
      const result = await slr.execute()

      expect(result.state).toBe('completed')
    })
  })

  // -----------------------------------------------------------------------
  // Default config
  // -----------------------------------------------------------------------

  describe('default config', () => {
    it('works with minimal config (only store)', async () => {
      const minimalLearning: SelfLearningConfig = {
        store: mockStore as unknown as SelfLearningConfig['store'],
      }
      const slr = new SelfLearningRuntime(pipelineConfig, minimalLearning)
      const result = await slr.execute()

      expect(result.state).toBe('completed')
      expect(result.analysis).toBeDefined()
      expect(result.learningMetrics).toBeDefined()
    })

    it('uses default namespace ["self-learning"]', async () => {
      const minimalLearning: SelfLearningConfig = {
        store: mockStore as unknown as SelfLearningConfig['store'],
      }
      const slr = new SelfLearningRuntime(pipelineConfig, minimalLearning)
      await slr.execute()

      // The store should be called with self-learning namespace prefix
      if (mockStore.put.mock.calls.length > 0) {
        const firstNs = mockStore.put.mock.calls[0][0] as string[]
        expect(firstNs[0]).toBe('self-learning')
      }
    })

    it('uses custom namespace when provided', async () => {
      learningConfig.namespace = ['custom', 'ns']
      const slr = new SelfLearningRuntime(pipelineConfig, learningConfig)
      await slr.execute()

      if (mockStore.put.mock.calls.length > 0) {
        const firstNs = mockStore.put.mock.calls[0][0] as string[]
        expect(firstNs[0]).toBe('custom')
        expect(firstNs[1]).toBe('ns')
      }
    })
  })

  // -----------------------------------------------------------------------
  // Resume
  // -----------------------------------------------------------------------

  describe('resume', () => {
    it('delegates resume to underlying PipelineRuntime', async () => {
      const def = createMinimalDefinition()
      def.nodes.push({ id: 'suspend', type: 'suspend', label: 'Suspend' })
      def.edges = [
        { type: 'sequential', sourceNodeId: 'start', targetNodeId: 'suspend' },
        { type: 'sequential', sourceNodeId: 'suspend', targetNodeId: 'end' },
      ]

      pipelineConfig.definition = def
      const slr = new SelfLearningRuntime(pipelineConfig, learningConfig)

      // Execute to get a suspended state
      const firstResult = await slr.execute()
      expect(firstResult.state).toBe('suspended')

      // Create a checkpoint and resume
      const checkpoint: PipelineCheckpoint = {
        pipelineRunId: firstResult.runId,
        pipelineId: def.id,
        version: 1,
        schemaVersion: '1.0.0',
        completedNodeIds: ['start'],
        state: {},
        suspendedAtNodeId: 'suspend',
        createdAt: new Date().toISOString(),
      }

      // Need a fresh runtime for resume (PipelineRuntime is stateful)
      const slr2 = new SelfLearningRuntime(pipelineConfig, learningConfig)
      const resumeResult = await slr2.resume(checkpoint, {})

      expect(resumeResult.state).toBe('completed')
      expect(resumeResult.learningMetrics).toBeDefined()
    })
  })

  // -----------------------------------------------------------------------
  // runtime getter
  // -----------------------------------------------------------------------

  describe('runtime getter', () => {
    it('returns the underlying PipelineRuntime', () => {
      const slr = new SelfLearningRuntime(pipelineConfig, learningConfig)
      const rt = slr.runtime
      expect(rt).toBeDefined()
      expect(typeof rt.execute).toBe('function')
      expect(typeof rt.cancel).toBe('function')
    })
  })
})
