import { describe, it, expect, beforeEach } from 'vitest'
import type { BaseStore } from '@langchain/langgraph'
import {
  TrajectoryCalibrator,
  type StepReward,
  type TrajectoryRecord,
} from '../self-correction/trajectory-calibrator.js'

// ---------------------------------------------------------------------------
// In-memory BaseStore mock
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory BaseStore for testing. Matches the subset of the
 * BaseStore API used by TrajectoryCalibrator (get, put, search, delete).
 */
function createMemoryStore(): BaseStore {
  const data = new Map<string, Map<string, { key: string; value: Record<string, unknown> }>>()

  function nsKey(namespace: string[]): string {
    return namespace.join('/')
  }

  return {
    async get(namespace: string[], key: string) {
      const ns = data.get(nsKey(namespace))
      return ns?.get(key) ?? null
    },
    async put(namespace: string[], key: string, value: Record<string, unknown>) {
      const k = nsKey(namespace)
      if (!data.has(k)) data.set(k, new Map())
      data.get(k)!.set(key, { key, value })
    },
    async delete(namespace: string[], key: string) {
      const ns = data.get(nsKey(namespace))
      if (ns) ns.delete(key)
    },
    async search(namespace: string[], _options?: { limit?: number }) {
      const ns = data.get(nsKey(namespace))
      if (!ns) return []
      return Array.from(ns.values())
    },
    // batch/list not used — stubs
    async batch(_ops: unknown[]) { return [] },
    async list(_prefix: string[]) { return [] },
    async start() { /* noop */ },
    async stop() { /* noop */ },
  } as unknown as BaseStore
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(overrides: Partial<StepReward> = {}): StepReward {
  return {
    nodeId: 'gen_backend',
    runId: `run_${Math.random().toString(36).slice(2, 8)}`,
    qualityScore: 0.85,
    durationMs: 1200,
    tokenCost: 500,
    errorCount: 0,
    timestamp: new Date(),
    ...overrides,
  }
}

function makeTrajectory(overrides: Partial<TrajectoryRecord> = {}): TrajectoryRecord {
  const runId = overrides.runId ?? `run_${Math.random().toString(36).slice(2, 8)}`
  return {
    runId,
    steps: overrides.steps ?? [
      makeStep({ runId, nodeId: 'plan', qualityScore: 0.9 }),
      makeStep({ runId, nodeId: 'gen_backend', qualityScore: 0.85 }),
      makeStep({ runId, nodeId: 'gen_frontend', qualityScore: 0.8 }),
    ],
    overallScore: 0.85,
    taskType: 'feature_gen',
    timestamp: new Date(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TrajectoryCalibrator', () => {
  let store: BaseStore
  let calibrator: TrajectoryCalibrator

  beforeEach(() => {
    store = createMemoryStore()
    calibrator = new TrajectoryCalibrator({ store })
  })

  // ---- Record and retrieve steps ------------------------------------------

  describe('recordStep', () => {
    it('records a step and it can be found via getNodeBaseline', async () => {
      const step = makeStep({ nodeId: 'gen_backend', qualityScore: 0.9 })
      await calibrator.recordStep(step)

      // Store a trajectory so taskType filtering works
      await calibrator.storeTrajectory(
        makeTrajectory({ runId: step.runId, taskType: 'feature_gen', steps: [step] }),
      )

      const baseline = await calibrator.getNodeBaseline('gen_backend', 'feature_gen')
      expect(baseline.count).toBe(1)
      expect(baseline.average).toBeCloseTo(0.9, 2)
    })

    it('records multiple steps for the same node', async () => {
      const scores = [0.8, 0.9, 0.7, 0.85, 0.95]
      for (const score of scores) {
        const step = makeStep({ nodeId: 'validate', qualityScore: score })
        await calibrator.recordStep(step)
        await calibrator.storeTrajectory(
          makeTrajectory({ runId: step.runId, taskType: 'test', steps: [step] }),
        )
      }

      const baseline = await calibrator.getNodeBaseline('validate', 'test')
      expect(baseline.count).toBe(5)
      const expectedAvg = scores.reduce((a, b) => a + b, 0) / scores.length
      expect(baseline.average).toBeCloseTo(expectedAvg, 2)
    })
  })

  // ---- Detect suboptimal --------------------------------------------------

  describe('detectSuboptimal', () => {
    async function seedHistory(
      cal: TrajectoryCalibrator,
      nodeId: string,
      taskType: string,
      scores: number[],
    ) {
      for (const score of scores) {
        const step = makeStep({ nodeId, qualityScore: score })
        await cal.recordStep(step)
        await cal.storeTrajectory(
          makeTrajectory({ runId: step.runId, taskType, steps: [step] }),
        )
      }
    }

    it('flags suboptimal when score is significantly below baseline', async () => {
      // Baseline ~0.9 average. Threshold = 0.9 * 0.85 = 0.765
      await seedHistory(calibrator, 'gen_backend', 'feature_gen', [0.9, 0.88, 0.92, 0.91, 0.89])

      const result = await calibrator.detectSuboptimal('gen_backend', 0.5, 'feature_gen')
      expect(result.isSuboptimal).toBe(true)
      expect(result.baseline).toBeGreaterThan(0.85)
      expect(result.currentScore).toBe(0.5)
      expect(result.deviation).toBeGreaterThan(0)
      expect(result.suggestion).toContain('gen_backend')
      expect(result.suggestion).toContain('below average')
    })

    it('does NOT flag suboptimal when score is at or above threshold', async () => {
      await seedHistory(calibrator, 'gen_backend', 'feature_gen', [0.9, 0.88, 0.92, 0.91, 0.89])

      // 0.85 is above 0.9 * 0.85 = 0.765
      const result = await calibrator.detectSuboptimal('gen_backend', 0.85, 'feature_gen')
      expect(result.isSuboptimal).toBe(false)
      expect(result.suggestion).toBeUndefined()
    })

    it('returns not suboptimal when insufficient history', async () => {
      // Only 3 data points, default minHistorySize is 5
      await seedHistory(calibrator, 'gen_backend', 'feature_gen', [0.9, 0.85, 0.88])

      const result = await calibrator.detectSuboptimal('gen_backend', 0.1, 'feature_gen')
      expect(result.isSuboptimal).toBe(false)
      expect(result.deviation).toBe(0)
    })

    it('returns not suboptimal for unknown node', async () => {
      const result = await calibrator.detectSuboptimal('nonexistent', 0.3, 'feature_gen')
      expect(result.isSuboptimal).toBe(false)
    })
  })

  // ---- Store and retrieve trajectories ------------------------------------

  describe('storeTrajectory / getAllBaselines', () => {
    it('stores a trajectory and retrieves baselines from its steps', async () => {
      const traj = makeTrajectory({
        runId: 'run_1',
        taskType: 'feature_gen',
        overallScore: 0.85,
        steps: [
          makeStep({ runId: 'run_1', nodeId: 'plan', qualityScore: 0.9 }),
          makeStep({ runId: 'run_1', nodeId: 'gen_backend', qualityScore: 0.8 }),
        ],
      })

      await calibrator.storeTrajectory(traj)

      const baselines = await calibrator.getAllBaselines('feature_gen')
      expect(baselines.size).toBe(2)
      expect(baselines.get('plan')?.average).toBeCloseTo(0.9, 2)
      expect(baselines.get('gen_backend')?.average).toBeCloseTo(0.8, 2)
    })

    it('aggregates multiple trajectories for the same task type', async () => {
      await calibrator.storeTrajectory(makeTrajectory({
        runId: 'run_1',
        taskType: 'feature_gen',
        steps: [makeStep({ runId: 'run_1', nodeId: 'plan', qualityScore: 0.8 })],
      }))
      await calibrator.storeTrajectory(makeTrajectory({
        runId: 'run_2',
        taskType: 'feature_gen',
        steps: [makeStep({ runId: 'run_2', nodeId: 'plan', qualityScore: 1.0 })],
      }))

      const baselines = await calibrator.getAllBaselines('feature_gen')
      expect(baselines.get('plan')?.average).toBeCloseTo(0.9, 2)
      expect(baselines.get('plan')?.count).toBe(2)
    })

    it('does not mix task types in baselines', async () => {
      await calibrator.storeTrajectory(makeTrajectory({
        runId: 'run_a',
        taskType: 'feature_gen',
        steps: [makeStep({ runId: 'run_a', nodeId: 'plan', qualityScore: 0.9 })],
      }))
      await calibrator.storeTrajectory(makeTrajectory({
        runId: 'run_b',
        taskType: 'code_review',
        steps: [makeStep({ runId: 'run_b', nodeId: 'plan', qualityScore: 0.5 })],
      }))

      const featureBaselines = await calibrator.getAllBaselines('feature_gen')
      expect(featureBaselines.get('plan')?.average).toBeCloseTo(0.9, 2)

      const reviewBaselines = await calibrator.getAllBaselines('code_review')
      expect(reviewBaselines.get('plan')?.average).toBeCloseTo(0.5, 2)
    })
  })

  // ---- Node baseline calculation ------------------------------------------

  describe('getNodeBaseline', () => {
    it('returns zero average and count for unknown node', async () => {
      const baseline = await calibrator.getNodeBaseline('nonexistent')
      expect(baseline.average).toBe(0)
      expect(baseline.count).toBe(0)
    })

    it('returns correct average across multiple steps', async () => {
      const scores = [0.7, 0.8, 0.9]
      for (const score of scores) {
        await calibrator.recordStep(makeStep({ nodeId: 'test_node', qualityScore: score }))
      }

      // Without taskType filter, should return all
      const baseline = await calibrator.getNodeBaseline('test_node')
      expect(baseline.count).toBe(3)
      expect(baseline.average).toBeCloseTo(0.8, 2)
    })
  })

  // ---- Clear --------------------------------------------------------------

  describe('clear', () => {
    it('removes all trajectory data', async () => {
      const traj = makeTrajectory({ runId: 'run_clear', taskType: 'test' })
      await calibrator.storeTrajectory(traj)
      for (const step of traj.steps) {
        await calibrator.recordStep(step)
      }

      await calibrator.clear()

      const baselines = await calibrator.getAllBaselines('test')
      expect(baselines.size).toBe(0)
    })
  })

  // ---- Custom config ------------------------------------------------------

  describe('custom configuration', () => {
    it('respects custom minHistorySize', async () => {
      const custom = new TrajectoryCalibrator({
        store,
        minHistorySize: 2,
      })

      // Seed 2 data points
      for (const score of [0.9, 0.85]) {
        const step = makeStep({ nodeId: 'node_x', qualityScore: score })
        await custom.recordStep(step)
        await custom.storeTrajectory(
          makeTrajectory({ runId: step.runId, taskType: 'test', steps: [step] }),
        )
      }

      // With minHistorySize=2, this should now detect
      const result = await custom.detectSuboptimal('node_x', 0.3, 'test')
      expect(result.isSuboptimal).toBe(true)
    })

    it('respects custom suboptimalThreshold', async () => {
      const strict = new TrajectoryCalibrator({
        store,
        suboptimalThreshold: 0.95, // Very strict — flag if below 95% of baseline
        minHistorySize: 2,
      })

      for (const score of [0.9, 0.9]) {
        const step = makeStep({ nodeId: 'strict_node', qualityScore: score })
        await strict.recordStep(step)
        await strict.storeTrajectory(
          makeTrajectory({ runId: step.runId, taskType: 'test', steps: [step] }),
        )
      }

      // 0.84 < 0.9 * 0.95 = 0.855 → suboptimal
      const result = await strict.detectSuboptimal('strict_node', 0.84, 'test')
      expect(result.isSuboptimal).toBe(true)
    })

    it('respects custom maxTrajectories and prunes old records', async () => {
      const limited = new TrajectoryCalibrator({
        store,
        maxTrajectories: 3,
      })

      // Store 5 trajectories with increasing timestamps
      for (let i = 0; i < 5; i++) {
        await limited.storeTrajectory(makeTrajectory({
          runId: `run_prune_${i}`,
          taskType: 'prune_test',
          timestamp: new Date(Date.now() + i * 1000),
          steps: [makeStep({ runId: `run_prune_${i}`, nodeId: 'n', qualityScore: 0.8 })],
        }))
      }

      // getAllBaselines should only see steps from the 3 most recent trajectories
      const baselines = await limited.getAllBaselines('prune_test')
      const nodeBaseline = baselines.get('n')
      // After pruning, only 3 trajectories remain
      expect(nodeBaseline?.count).toBeLessThanOrEqual(3)
    })

    it('uses custom namespace', async () => {
      const custom = new TrajectoryCalibrator({
        store,
        namespace: ['custom', 'ns'],
      })

      const step = makeStep({ nodeId: 'ns_test', qualityScore: 0.75 })
      await custom.recordStep(step)

      const baseline = await custom.getNodeBaseline('ns_test')
      expect(baseline.count).toBe(1)
      expect(baseline.average).toBeCloseTo(0.75, 2)

      // Default calibrator should NOT see it
      const defaultBaseline = await calibrator.getNodeBaseline('ns_test')
      expect(defaultBaseline.count).toBe(0)
    })
  })
})
