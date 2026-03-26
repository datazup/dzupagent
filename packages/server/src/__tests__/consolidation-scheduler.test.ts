/**
 * Tests for ConsolidationScheduler.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ConsolidationScheduler } from '../runtime/consolidation-scheduler.js'
import type { ConsolidationTask, ConsolidationReport } from '../runtime/consolidation-scheduler.js'

function createMockTask(report?: Partial<ConsolidationReport>): ConsolidationTask {
  return {
    run: vi.fn(async (): Promise<ConsolidationReport> => ({
      recordsProcessed: report?.recordsProcessed ?? 10,
      pruned: report?.pruned ?? 2,
      merged: report?.merged ?? 3,
      durationMs: report?.durationMs ?? 100,
    })),
  }
}

describe('ConsolidationScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs consolidation task on start when idle', async () => {
    const task = createMockTask()
    const scheduler = new ConsolidationScheduler({
      task,
      intervalMs: 60_000,
      idleThresholdMs: 0, // no idle wait
    })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(10)

    expect(task.run).toHaveBeenCalledOnce()
    await scheduler.stop()
  })

  it('skips consolidation when active runs exist', async () => {
    const task = createMockTask()
    const scheduler = new ConsolidationScheduler({
      task,
      intervalMs: 60_000,
      idleThresholdMs: 0,
      activeRunCount: () => 3, // 3 active runs
    })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(10)

    expect(task.run).not.toHaveBeenCalled()
    await scheduler.stop()
  })

  it('respects idle threshold', async () => {
    const task = createMockTask()
    const scheduler = new ConsolidationScheduler({
      task,
      intervalMs: 1000,
      idleThresholdMs: 5000,
    })

    scheduler.start()
    // Immediately after start, idleDuration is ~0 which is < 5000
    await vi.advanceTimersByTimeAsync(10)
    expect(task.run).not.toHaveBeenCalled()

    // Advance past idle threshold
    await vi.advanceTimersByTimeAsync(6000)
    expect(task.run).toHaveBeenCalled()
    await scheduler.stop()
  })

  it('does not exceed maxConcurrent', async () => {
    let resolveTask: (() => void) | null = null
    const slowTask: ConsolidationTask = {
      run: vi.fn(() => new Promise<ConsolidationReport>((resolve) => {
        resolveTask = () => resolve({ recordsProcessed: 1, pruned: 0, merged: 0, durationMs: 50 })
      })),
    }

    const scheduler = new ConsolidationScheduler({
      task: slowTask,
      intervalMs: 100,
      idleThresholdMs: 0,
      maxConcurrent: 1,
    })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(10) // first tick starts
    expect(slowTask.run).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(200) // second tick fires but blocked
    expect(slowTask.run).toHaveBeenCalledTimes(1) // still 1

    resolveTask!()
    await vi.advanceTimersByTimeAsync(10)
    await scheduler.stop()
  })

  it('status() reports scheduler state', async () => {
    const task = createMockTask()
    const scheduler = new ConsolidationScheduler({
      task,
      intervalMs: 60_000,
      idleThresholdMs: 0,
    })

    expect(scheduler.status()).toEqual({
      running: false,
      activeConsolidations: 0,
      lastRunAt: null,
    })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(10)

    const status = scheduler.status()
    expect(status.running).toBe(true)
    expect(status.lastRunAt).toBeInstanceOf(Date)
    await scheduler.stop()
  })

  it('stop() clears the timer and aborts', async () => {
    const task = createMockTask()
    const scheduler = new ConsolidationScheduler({
      task,
      intervalMs: 1000,
      idleThresholdMs: 0,
    })

    scheduler.start()
    // Let the initial tick complete
    await vi.advanceTimersByTimeAsync(10)

    // Switch to real timers for stop() which uses real setTimeout internally
    vi.useRealTimers()
    await scheduler.stop()
    vi.useFakeTimers()

    expect(scheduler.status().running).toBe(false)
    const callCount = (task.run as ReturnType<typeof vi.fn>).mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    // No more calls after stop
    expect((task.run as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callCount)
  })
})
