/**
 * Unit tests for HumanContactTimeoutScheduler.
 *
 * The scheduler polls the run store on a fixed interval; here we use
 * vi.useFakeTimers() to control time precisely and inject an InMemoryRunStore
 * so there are no side-effects on real storage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InMemoryRunStore } from '@dzupagent/core'
import { HumanContactTimeoutScheduler } from '../lifecycle/human-contact-timeout.js'

function pastIso(offsetMs = 1000): string {
  return new Date(Date.now() - offsetMs).toISOString()
}

function futureIso(offsetMs = 60_000): string {
  return new Date(Date.now() + offsetMs).toISOString()
}

describe('HumanContactTimeoutScheduler', () => {
  let runStore: InMemoryRunStore
  let scheduler: HumanContactTimeoutScheduler

  beforeEach(() => {
    vi.useFakeTimers()
    runStore = new InMemoryRunStore()
    scheduler = new HumanContactTimeoutScheduler(runStore, { checkIntervalMs: 1_000 })
  })

  afterEach(() => {
    scheduler.stop()
    vi.useRealTimers()
  })

  // --- lifecycle ---

  describe('start / stop', () => {
    it('start() begins polling at the configured interval', async () => {
      const listSpy = vi.spyOn(runStore, 'list').mockResolvedValue([])
      scheduler.start()
      // Before any tick: 0 calls
      expect(listSpy).not.toHaveBeenCalled()
      // After one tick: 2 calls (suspended + awaiting_approval)
      await vi.advanceTimersByTimeAsync(1_001)
      expect(listSpy).toHaveBeenCalledTimes(2)
    })

    it('start() is idempotent — calling it twice does not double the poll rate', async () => {
      const listSpy = vi.spyOn(runStore, 'list').mockResolvedValue([])
      scheduler.start()
      scheduler.start() // second call must be no-op
      await vi.advanceTimersByTimeAsync(1_001)
      expect(listSpy).toHaveBeenCalledTimes(2) // 2 for status query, not 4
    })

    it('stop() prevents further polling', async () => {
      const listSpy = vi.spyOn(runStore, 'list').mockResolvedValue([])
      scheduler.start()
      scheduler.stop()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(listSpy).not.toHaveBeenCalled()
    })

    it('stop() is safe to call when not started', () => {
      expect(() => scheduler.stop()).not.toThrow()
    })
  })

  // --- expired contact resumption ---

  describe('checkExpiredContacts — expired contacts', () => {
    it('updates expired suspended run to running with humanContactTimedOut=true', async () => {
      const run = await runStore.create({ agentId: 'a1', input: 'x' })
      await runStore.update(run.id, {
        status: 'suspended',
        metadata: { humanContactExpiresAt: pastIso(5_000) },
      })

      await scheduler.checkExpiredContacts()

      const updated = await runStore.get(run.id)
      expect(updated?.status).toBe('running')
      expect((updated?.metadata as Record<string, unknown>)?.['humanContactTimedOut']).toBe(true)
    })

    it('attaches the default fallback value when none is configured', async () => {
      const run = await runStore.create({ agentId: 'a1', input: 'x' })
      await runStore.update(run.id, {
        status: 'suspended',
        metadata: { humanContactExpiresAt: pastIso() },
      })

      await scheduler.checkExpiredContacts()

      const updated = await runStore.get(run.id)
      expect((updated?.metadata as Record<string, unknown>)?.['humanContactFallback']).toEqual({
        timeout: true,
      })
    })

    it('uses a custom fallback value when configured', async () => {
      const customScheduler = new HumanContactTimeoutScheduler(runStore, {
        checkIntervalMs: 1_000,
        defaultFallback: { skipped: true, reason: 'timeout' },
      })

      const run = await runStore.create({ agentId: 'a1', input: 'x' })
      await runStore.update(run.id, {
        status: 'suspended',
        metadata: { humanContactExpiresAt: pastIso() },
      })

      await customScheduler.checkExpiredContacts()

      const updated = await runStore.get(run.id)
      expect((updated?.metadata as Record<string, unknown>)?.['humanContactFallback']).toEqual({
        skipped: true,
        reason: 'timeout',
      })
    })

    it('also processes awaiting_approval runs with expired contacts', async () => {
      const run = await runStore.create({ agentId: 'a1', input: 'x' })
      await runStore.update(run.id, {
        status: 'awaiting_approval',
        metadata: { humanContactExpiresAt: pastIso() },
      })

      await scheduler.checkExpiredContacts()

      const updated = await runStore.get(run.id)
      expect(updated?.status).toBe('running')
      expect((updated?.metadata as Record<string, unknown>)?.['humanContactTimedOut']).toBe(true)
    })
  })

  // --- non-expired contacts are left alone ---

  describe('checkExpiredContacts — non-expired contacts', () => {
    it('does not change a suspended run whose timeout is in the future', async () => {
      const run = await runStore.create({ agentId: 'a1', input: 'x' })
      await runStore.update(run.id, {
        status: 'suspended',
        metadata: { humanContactExpiresAt: futureIso() },
      })

      await scheduler.checkExpiredContacts()

      const updated = await runStore.get(run.id)
      expect(updated?.status).toBe('suspended')
      expect((updated?.metadata as Record<string, unknown>)?.['humanContactTimedOut']).toBeUndefined()
    })

    it('does not change a suspended run with no humanContactExpiresAt', async () => {
      const run = await runStore.create({ agentId: 'a1', input: 'x' })
      await runStore.update(run.id, { status: 'suspended', metadata: { foo: 'bar' } })

      await scheduler.checkExpiredContacts()

      const updated = await runStore.get(run.id)
      expect(updated?.status).toBe('suspended')
    })

    it('does not change a completed run (not in suspended/awaiting_approval list)', async () => {
      const run = await runStore.create({ agentId: 'a1', input: 'x' })
      await runStore.update(run.id, {
        status: 'completed',
        metadata: { humanContactExpiresAt: pastIso() },
      })

      await scheduler.checkExpiredContacts()

      // Status unchanged; still completed (the store list() filters by status)
      const updated = await runStore.get(run.id)
      expect(updated?.status).toBe('completed')
    })
  })

  // --- error resilience ---

  describe('error resilience', () => {
    it('does not throw when the run store list() rejects', async () => {
      vi.spyOn(runStore, 'list').mockRejectedValue(new Error('DB unavailable'))
      await expect(scheduler.checkExpiredContacts()).resolves.not.toThrow()
    })

    it('continues polling after a transient store error', async () => {
      let callCount = 0
      vi.spyOn(runStore, 'list').mockImplementation(() => {
        callCount++
        if (callCount === 1) return Promise.reject(new Error('transient'))
        return Promise.resolve([])
      })

      scheduler.start()
      // First tick: both queries fail on call 1
      await vi.advanceTimersByTimeAsync(1_001)
      // Second tick: queries succeed
      await vi.advanceTimersByTimeAsync(1_001)
      // Should have made more calls after the error
      expect(callCount).toBeGreaterThan(1)
    })
  })
})
