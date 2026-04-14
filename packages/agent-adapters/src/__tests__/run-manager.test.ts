import { describe, it, expect, beforeEach } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import type { DzupEvent, DzupEventBus } from '@dzupagent/core'

import { RunManager } from '../persistence/run-manager.js'
import type { AdapterProviderId, AgentEvent } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectBusEvents(bus: DzupEventBus): DzupEvent[] {
  const events: DzupEvent[] = []
  bus.onAny((e) => events.push(e))
  return events
}

async function* fakeAdapterEvents(
  providerId: AdapterProviderId,
  result: string,
): AsyncGenerator<AgentEvent, void, undefined> {
  yield {
    type: 'adapter:started',
    providerId,
    sessionId: `sess-${providerId}`,
    timestamp: Date.now(),
  }
  yield {
    type: 'adapter:completed',
    providerId,
    sessionId: `sess-${providerId}`,
    result,
    usage: { inputTokens: 100, outputTokens: 50 },
    durationMs: 42,
    timestamp: Date.now(),
  }
}

async function* failingAdapterEvents(
  providerId: AdapterProviderId,
): AsyncGenerator<AgentEvent, void, undefined> {
  yield {
    type: 'adapter:started',
    providerId,
    sessionId: `sess-${providerId}`,
    timestamp: Date.now(),
  }
  yield {
    type: 'adapter:failed',
    providerId,
    error: 'Something went wrong',
    code: 'INTERNAL',
    timestamp: Date.now(),
  }
}

async function* throwingAdapterEvents(): AsyncGenerator<AgentEvent, void, undefined> {
  throw new Error('Adapter exploded')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RunManager', () => {
  let manager: RunManager
  let bus: DzupEventBus
  let emitted: DzupEvent[]

  beforeEach(() => {
    bus = createEventBus()
    emitted = collectBusEvents(bus)
    manager = new RunManager({ eventBus: bus })
  })

  describe('createRun', () => {
    it('creates a run in pending status', () => {
      const run = manager.createRun({ prompt: 'Fix bug' })

      expect(run.status).toBe('pending')
      expect(run.runId).toBeDefined()
      expect(run.input.prompt).toBe('Fix bug')
      expect(run.createdAt).toBeInstanceOf(Date)
    })

    it('stores the task descriptor', () => {
      const run = manager.createRun(
        { prompt: 'Write tests' },
        { prompt: 'Write tests', tags: ['testing'] },
      )

      expect(run.task).toBeDefined()
      expect(run.task!.tags).toContain('testing')
    })
  })

  describe('startRun', () => {
    it('transitions to executing', () => {
      const run = manager.createRun({ prompt: 'Go' })

      manager.startRun(run.runId, 'claude')

      const updated = manager.getRun(run.runId)
      expect(updated!.status).toBe('executing')
      expect(updated!.providerId).toBe('claude')
      expect(updated!.startedAt).toBeInstanceOf(Date)
    })

    it('throws for unknown run ID', () => {
      expect(() => manager.startRun('fake-id', 'claude')).toThrow('Run "fake-id" not found')
    })
  })

  describe('completeRun', () => {
    it('transitions to completed with result', () => {
      const run = manager.createRun({ prompt: 'Go' })
      manager.startRun(run.runId, 'codex')

      manager.completeRun(run.runId, 'All done', { inputTokens: 200, outputTokens: 100 })

      const updated = manager.getRun(run.runId)!
      expect(updated.status).toBe('completed')
      expect(updated.result).toBe('All done')
      expect(updated.usage!.inputTokens).toBe(200)
      expect(updated.completedAt).toBeInstanceOf(Date)
      expect(updated.durationMs).toBeGreaterThanOrEqual(0)
    })
  })

  describe('failRun', () => {
    it('transitions to failed', () => {
      const run = manager.createRun({ prompt: 'Go' })
      manager.startRun(run.runId, 'gemini')

      manager.failRun(run.runId, 'Timeout exceeded')

      const updated = manager.getRun(run.runId)!
      expect(updated.status).toBe('failed')
      expect(updated.error).toBe('Timeout exceeded')
      expect(updated.completedAt).toBeInstanceOf(Date)
    })
  })

  describe('cancelRun', () => {
    it('transitions to cancelled', () => {
      const run = manager.createRun({ prompt: 'Go' })
      manager.startRun(run.runId, 'claude')

      manager.cancelRun(run.runId)

      const updated = manager.getRun(run.runId)!
      expect(updated.status).toBe('cancelled')
      expect(updated.completedAt).toBeInstanceOf(Date)
    })
  })

  describe('getRun', () => {
    it('returns run by ID', () => {
      const run = manager.createRun({ prompt: 'Test' })
      const found = manager.getRun(run.runId)
      expect(found).toBeDefined()
      expect(found!.runId).toBe(run.runId)
    })

    it('returns undefined for unknown ID', () => {
      expect(manager.getRun('nope')).toBeUndefined()
    })
  })

  describe('listRuns', () => {
    it('returns all runs when no status filter', () => {
      manager.createRun({ prompt: 'A' })
      manager.createRun({ prompt: 'B' })

      const runs = manager.listRuns()
      expect(runs).toHaveLength(2)
    })

    it('filters by status', () => {
      const r1 = manager.createRun({ prompt: 'A' })
      manager.createRun({ prompt: 'B' })
      manager.startRun(r1.runId, 'claude')

      const executing = manager.listRuns('executing')
      expect(executing).toHaveLength(1)
      expect(executing[0]!.runId).toBe(r1.runId)

      const pending = manager.listRuns('pending')
      expect(pending).toHaveLength(1)
    })
  })

  describe('getStats', () => {
    it('computes aggregate stats', () => {
      const r1 = manager.createRun({ prompt: 'A' })
      const r2 = manager.createRun({ prompt: 'B' })
      const r3 = manager.createRun({ prompt: 'C' })

      manager.startRun(r1.runId, 'claude')
      manager.completeRun(r1.runId, 'OK')

      manager.startRun(r2.runId, 'claude')
      manager.failRun(r2.runId, 'Error')

      manager.startRun(r3.runId, 'codex')
      manager.completeRun(r3.runId, 'OK')

      const stats = manager.getStats()

      expect(stats.totalRuns).toBe(3)
      expect(stats.byStatus.completed).toBe(2)
      expect(stats.byStatus.failed).toBe(1)
      expect(stats.successRate).toBeCloseTo(2 / 3, 2)
      expect(stats.byProvider['claude']).toBeDefined()
      expect(stats.byProvider['claude']!.runs).toBe(2)
      expect(stats.byProvider['codex']).toBeDefined()
      expect(stats.byProvider['codex']!.runs).toBe(1)
    })

    it('handles empty runs', () => {
      const stats = manager.getStats()
      expect(stats.totalRuns).toBe(0)
      expect(stats.successRate).toBe(0)
      expect(stats.avgDurationMs).toBe(0)
    })
  })

  describe('prune', () => {
    it('removes old completed runs exceeding maxCompletedRuns', () => {
      const mgr = new RunManager({ maxCompletedRuns: 2 })

      for (let i = 0; i < 5; i++) {
        const run = mgr.createRun({ prompt: `Task ${i}` })
        mgr.startRun(run.runId, 'claude')
        mgr.completeRun(run.runId, `Result ${i}`)
      }

      const pruned = mgr.prune()

      expect(pruned).toBe(3)
      expect(mgr.listRuns().length).toBe(2)
    })

    it('does not prune when under limit', () => {
      const mgr = new RunManager({ maxCompletedRuns: 10 })

      const run = mgr.createRun({ prompt: 'Only one' })
      mgr.startRun(run.runId, 'claude')
      mgr.completeRun(run.runId, 'Done')

      const pruned = mgr.prune()
      expect(pruned).toBe(0)
    })

    it('does not prune executing runs', () => {
      const mgr = new RunManager({ maxCompletedRuns: 0 })

      const run = mgr.createRun({ prompt: 'Running' })
      mgr.startRun(run.runId, 'claude')

      const pruned = mgr.prune()
      expect(pruned).toBe(0)
      expect(mgr.listRuns()).toHaveLength(1)
    })
  })

  describe('trackRun', () => {
    it('wraps events and transitions run lifecycle', async () => {
      const run = manager.createRun({ prompt: 'Track me' })
      const source = fakeAdapterEvents('claude', 'Tracked result')

      const events: AgentEvent[] = []
      for await (const event of manager.trackRun(run.runId, source)) {
        events.push(event)
      }

      expect(events).toHaveLength(2)
      expect(events[0]!.type).toBe('adapter:started')
      expect(events[1]!.type).toBe('adapter:completed')

      const updated = manager.getRun(run.runId)!
      expect(updated.status).toBe('completed')
      expect(updated.result).toBe('Tracked result')
      expect(updated.providerId).toBe('claude')
    })

    it('handles failed events', async () => {
      const run = manager.createRun({ prompt: 'Will fail' })
      const source = failingAdapterEvents('gemini')

      const events: AgentEvent[] = []
      for await (const event of manager.trackRun(run.runId, source)) {
        events.push(event)
      }

      const updated = manager.getRun(run.runId)!
      expect(updated.status).toBe('failed')
      expect(updated.error).toBe('Something went wrong')
    })

    it('marks run as failed on thrown error', async () => {
      const run = manager.createRun({ prompt: 'Explode' })
      const source = throwingAdapterEvents()

      const events: AgentEvent[] = []
      await expect(async () => {
        for await (const event of manager.trackRun(run.runId, source)) {
          events.push(event)
        }
      }).rejects.toThrow('Adapter exploded')

      const updated = manager.getRun(run.runId)!
      expect(updated.status).toBe('failed')
      expect(updated.error).toBe('Adapter exploded')
    })
  })

  describe('event bus integration', () => {
    it('emits events on the bus for lifecycle transitions', () => {
      const run = manager.createRun({ prompt: 'Test events' })
      manager.startRun(run.runId, 'claude')
      manager.completeRun(run.runId, 'Done')

      // Should have emitted: pending, executing, completed
      expect(emitted.length).toBe(3)
    })

    it('works without event bus', () => {
      const mgr = new RunManager()
      const run = mgr.createRun({ prompt: 'No bus' })
      mgr.startRun(run.runId, 'claude')
      mgr.completeRun(run.runId, 'Done')

      expect(mgr.getRun(run.runId)!.status).toBe('completed')
    })
  })
})
