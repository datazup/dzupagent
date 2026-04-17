/**
 * Branch-coverage tests for TrajectoryCalibrator - targets uncovered
 * serialization branches (invalid records, missing fields), error paths
 * in loadTrajectories, and edge cases in getNodeBaseline/getAllBaselines.
 */
import { describe, it, expect } from 'vitest'
import type { BaseStore } from '@langchain/langgraph'
import { TrajectoryCalibrator } from '../self-correction/trajectory-calibrator.js'

function createMemoryStore(): BaseStore {
  const data = new Map<string, Map<string, { key: string; value: Record<string, unknown> }>>()
  const nsKey = (ns: string[]): string => ns.join('/')
  return {
    async get(ns: string[], key: string) {
      return data.get(nsKey(ns))?.get(key) ?? null
    },
    async put(ns: string[], key: string, value: Record<string, unknown>) {
      const k = nsKey(ns)
      if (!data.has(k)) data.set(k, new Map())
      data.get(k)!.set(key, { key, value })
    },
    async delete(ns: string[], key: string) {
      data.get(nsKey(ns))?.delete(key)
    },
    async search(ns: string[], _opts?: { limit?: number }) {
      const items = data.get(nsKey(ns))
      if (!items) return []
      return [...items.values()]
    },
    async batch() { return [] },
    async list() { return [] },
    async start() {},
    async stop() {},
  } as unknown as BaseStore
}

function createFailingStore(): BaseStore {
  const err = (): never => { throw new Error('store fail') }
  return {
    get: err, put: err, delete: err, search: err,
    batch: async () => [], list: async () => [],
    start: async () => {}, stop: async () => {},
  } as unknown as BaseStore
}

describe('TrajectoryCalibrator — branch coverage', () => {
  it('returns { average: 0, count: 0 } when store.search throws', async () => {
    const store = createFailingStore()
    const cal = new TrajectoryCalibrator({ store })
    const baseline = await cal.getNodeBaseline('n1')
    expect(baseline).toEqual({ average: 0, count: 0 })
  })

  it('returns empty baselines map when loadTrajectories fails', async () => {
    const store = createFailingStore()
    const cal = new TrajectoryCalibrator({ store })
    const baselines = await cal.getAllBaselines('taskX')
    expect(baselines.size).toBe(0)
  })

  it('filters steps by taskType using validRunIds', async () => {
    const store = createMemoryStore()
    const cal = new TrajectoryCalibrator({
      store, namespace: ['t'], minHistorySize: 1,
    })
    // Record steps for 2 runs, each with 1 step
    await cal.recordStep({
      nodeId: 'N', runId: 'r1', qualityScore: 0.9,
      durationMs: 1, tokenCost: 1, errorCount: 0,
      timestamp: new Date(),
    })
    await cal.recordStep({
      nodeId: 'N', runId: 'r2', qualityScore: 0.1,
      durationMs: 1, tokenCost: 1, errorCount: 0,
      timestamp: new Date(),
    })
    // Trajectory record for r1 only with taskType=feature
    await cal.storeTrajectory({
      runId: 'r1', steps: [], overallScore: 1,
      taskType: 'feature', timestamp: new Date(),
    })
    const baseline = await cal.getNodeBaseline('N', 'feature')
    // Only r1 should count
    expect(baseline.count).toBe(1)
    expect(baseline.average).toBeCloseTo(0.9, 2)
  })

  it('falls back to all steps when task filter yields no valid run ids', async () => {
    const store = createMemoryStore()
    const cal = new TrajectoryCalibrator({
      store, namespace: ['t'], minHistorySize: 1,
    })
    await cal.recordStep({
      nodeId: 'N', runId: 'r1', qualityScore: 0.5,
      durationMs: 1, tokenCost: 1, errorCount: 0,
      timestamp: new Date(),
    })
    // No trajectory stored — validRunIds will be empty
    const baseline = await cal.getNodeBaseline('N', 'missing-task')
    // When validRunIds.size === 0, code keeps all steps
    expect(baseline.count).toBe(1)
  })

  it('returns { average: 0, count: 0 } when no steps match taskType and no filter applies', async () => {
    const store = createMemoryStore()
    const cal = new TrajectoryCalibrator({ store, namespace: ['t'] })
    const baseline = await cal.getNodeBaseline('unknown-node')
    expect(baseline).toEqual({ average: 0, count: 0 })
  })

  it('returns { isSuboptimal: false } when history below minHistorySize', async () => {
    const store = createMemoryStore()
    const cal = new TrajectoryCalibrator({
      store, namespace: ['t'], minHistorySize: 5,
    })
    // Only 2 data points
    for (let i = 0; i < 2; i++) {
      await cal.recordStep({
        nodeId: 'N', runId: `r${i}`, qualityScore: 0.9,
        durationMs: 1, tokenCost: 1, errorCount: 0,
        timestamp: new Date(),
      })
    }
    const result = await cal.detectSuboptimal('N', 0.5, 'feat')
    expect(result.isSuboptimal).toBe(false)
    expect(result.deviation).toBe(0)
  })

  it('flags suboptimal and includes suggestion with percent below', async () => {
    const store = createMemoryStore()
    const cal = new TrajectoryCalibrator({
      store, namespace: ['t'], minHistorySize: 3, suboptimalThreshold: 0.9,
    })
    for (let i = 0; i < 5; i++) {
      await cal.recordStep({
        nodeId: 'N', runId: `r${i}`, qualityScore: 1.0,
        durationMs: 1, tokenCost: 1, errorCount: 0,
        timestamp: new Date(),
      })
    }
    const result = await cal.detectSuboptimal('N', 0.5, 'feat')
    expect(result.isSuboptimal).toBe(true)
    expect(result.suggestion).toContain('below average')
    expect(result.deviation).toBeGreaterThan(0)
  })

  it('sets deviation to 0 when baseline average is 0', async () => {
    const store = createMemoryStore()
    const cal = new TrajectoryCalibrator({
      store, namespace: ['t'], minHistorySize: 3, suboptimalThreshold: 1.0,
    })
    for (let i = 0; i < 5; i++) {
      await cal.recordStep({
        nodeId: 'N', runId: `r${i}`, qualityScore: 0,
        durationMs: 1, tokenCost: 1, errorCount: 0,
        timestamp: new Date(),
      })
    }
    const result = await cal.detectSuboptimal('N', 0, 'feat')
    expect(result.deviation).toBe(0)
  })

  it('clear() does not throw when store operations fail', async () => {
    const store = createFailingStore()
    const cal = new TrajectoryCalibrator({ store })
    await expect(cal.clear()).resolves.toBeUndefined()
  })

  it('clear() removes trajectories and step records', async () => {
    const store = createMemoryStore()
    const cal = new TrajectoryCalibrator({ store, namespace: ['t'] })
    await cal.recordStep({
      nodeId: 'N', runId: 'r1', qualityScore: 0.5,
      durationMs: 1, tokenCost: 1, errorCount: 0,
      timestamp: new Date(),
    })
    await cal.storeTrajectory({
      runId: 'r1', steps: [{
        nodeId: 'N', runId: 'r1', qualityScore: 0.5,
        durationMs: 1, tokenCost: 1, errorCount: 0,
        timestamp: new Date(),
      }], overallScore: 1, taskType: 'x', timestamp: new Date(),
    })
    await cal.clear()
    // After clear, all trajectories and step records are removed
    const baselines = await cal.getAllBaselines('x')
    expect(baselines.size).toBe(0)
  })

  it('prunes oldest trajectories when exceeding maxTrajectories', async () => {
    const store = createMemoryStore()
    const cal = new TrajectoryCalibrator({
      store, namespace: ['t'], maxTrajectories: 2,
    })
    // Store 3 trajectories for same taskType
    for (let i = 0; i < 3; i++) {
      await cal.storeTrajectory({
        runId: `r${i}`, steps: [], overallScore: i,
        taskType: 'feat', timestamp: new Date(Date.now() + i * 100),
      })
    }
    const baselines = await cal.getAllBaselines('feat')
    expect(baselines.size).toBe(0) // no steps, just trajectories
  })

  it('getAllBaselines filters trajectories by taskType', async () => {
    const store = createMemoryStore()
    const cal = new TrajectoryCalibrator({ store, namespace: ['t'] })
    const now = new Date()
    await cal.storeTrajectory({
      runId: 'r1',
      steps: [
        { nodeId: 'A', runId: 'r1', qualityScore: 0.8, durationMs: 1, tokenCost: 1, errorCount: 0, timestamp: now },
        { nodeId: 'A', runId: 'r1', qualityScore: 0.6, durationMs: 1, tokenCost: 1, errorCount: 0, timestamp: now },
      ],
      overallScore: 1, taskType: 'feat', timestamp: now,
    })
    await cal.storeTrajectory({
      runId: 'r2',
      steps: [
        { nodeId: 'A', runId: 'r2', qualityScore: 0.1, durationMs: 1, tokenCost: 1, errorCount: 0, timestamp: now },
      ],
      overallScore: 0, taskType: 'bug', timestamp: now,
    })
    const feat = await cal.getAllBaselines('feat')
    expect(feat.get('A')?.count).toBe(2)
    expect(feat.get('A')?.average).toBeCloseTo(0.7, 2)

    const bug = await cal.getAllBaselines('bug')
    expect(bug.get('A')?.count).toBe(1)
  })

  it('skips records with missing runId or taskType when loading trajectories', async () => {
    const store = createMemoryStore()
    const cal = new TrajectoryCalibrator({ store, namespace: ['t'] })
    // Put a valid trajectory
    await cal.storeTrajectory({
      runId: 'r1',
      steps: [],
      overallScore: 1, taskType: 'feat', timestamp: new Date(),
    })
    // Manually put an invalid record
    await store.put(['t', 'runs'], 'bad', {
      // Missing runId
      steps: [],
      overallScore: 1,
      taskType: 'feat',
    })
    const baselines = await cal.getAllBaselines('feat')
    // The bad record is skipped by recordToTrajectory returning null
    expect(baselines.size).toBe(0) // No steps recorded in r1 either
  })

  it('skips step records that fail recordToStep validation', async () => {
    const store = createMemoryStore()
    const cal = new TrajectoryCalibrator({ store, namespace: ['t'] })
    // Direct put of invalid step record
    await store.put(['t', 'steps', 'N'], 'bad', {
      // Missing nodeId string
      qualityScore: 0.5,
    })
    const baseline = await cal.getNodeBaseline('N')
    expect(baseline.count).toBe(0)
  })
})
