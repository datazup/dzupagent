/**
 * Unit tests for TriggerManager — lifecycle, webhook fire, and chain triggers.
 *
 * Cron timers are avoided by registering triggers *before* start() so we can
 * test timer creation/teardown without letting any interval tick, then calling
 * stop() to confirm timers are cleared. Real-time interval tests use vi.useFakeTimers()
 * where the interval must actually fire.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { secureLogger } from '@dzupagent/core/utils'
import { TriggerManager } from '../triggers/trigger-manager.js'
import type { CronTriggerConfig, WebhookTriggerConfig, ChainTriggerConfig } from '../triggers/trigger-manager.js'

function makeCron(overrides: Partial<CronTriggerConfig> = {}): CronTriggerConfig {
  return {
    id: 'cron-1',
    type: 'cron',
    agentId: 'agent-1',
    schedule: '*/5 * * * *',
    enabled: true,
    ...overrides,
  }
}

function makeWebhook(overrides: Partial<WebhookTriggerConfig> = {}): WebhookTriggerConfig {
  return {
    id: 'wh-1',
    type: 'webhook',
    agentId: 'agent-2',
    enabled: true,
    ...overrides,
  }
}

function makeChain(overrides: Partial<ChainTriggerConfig> = {}): ChainTriggerConfig {
  return {
    id: 'chain-1',
    type: 'chain',
    agentId: 'agent-b',
    afterAgentId: 'agent-a',
    enabled: true,
    ...overrides,
  }
}

describe('TriggerManager', () => {
  let onTrigger: ReturnType<typeof vi.fn>
  let manager: TriggerManager

  beforeEach(() => {
    onTrigger = vi.fn().mockResolvedValue(undefined)
    manager = new TriggerManager(onTrigger)
  })

  afterEach(() => {
    manager.stop()
    vi.useRealTimers()
  })

  // --- register / list ---

  describe('register / list', () => {
    it('registers a trigger and returns it from list()', () => {
      manager.register(makeCron())
      const all = manager.list()
      expect(all).toHaveLength(1)
      expect(all[0]?.id).toBe('cron-1')
    })

    it('registering multiple triggers accumulates in list()', () => {
      manager.register(makeCron({ id: 'c1' }))
      manager.register(makeWebhook({ id: 'w1' }))
      manager.register(makeChain({ id: 'ch1' }))
      expect(manager.list()).toHaveLength(3)
    })

    it('re-registering with same id replaces the previous entry', () => {
      manager.register(makeCron({ id: 'c1', agentId: 'old' }))
      manager.register(makeCron({ id: 'c1', agentId: 'new' }))
      const all = manager.list()
      expect(all).toHaveLength(1)
      expect(all[0]?.agentId).toBe('new')
    })
  })

  // --- unregister ---

  describe('unregister', () => {
    it('removes the trigger from list()', () => {
      manager.register(makeCron({ id: 'c1' }))
      manager.register(makeWebhook({ id: 'w1' }))
      manager.unregister('c1')
      const ids = manager.list().map((t) => t.id)
      expect(ids).not.toContain('c1')
      expect(ids).toContain('w1')
    })

    it('unregistering a cron trigger that was started clears its timer', () => {
      vi.useFakeTimers()
      manager.register(makeCron({ id: 'c1', schedule: '*/1 * * * *' }))
      manager.start()
      // The interval is now running; unregister should clearInterval
      manager.unregister('c1')
      expect(manager.list()).toHaveLength(0)
      // Advancing time past the interval should NOT fire onTrigger
      vi.advanceTimersByTime(120_000)
      expect(onTrigger).not.toHaveBeenCalled()
    })

    it('unregistering an unknown id is a no-op', () => {
      expect(() => manager.unregister('does-not-exist')).not.toThrow()
    })
  })

  // --- enable / disable ---

  describe('enable / disable', () => {
    it('enable() sets trigger.enabled = true', () => {
      manager.register(makeCron({ id: 'c1', enabled: false }))
      manager.enable('c1')
      const t = manager.list().find((x) => x.id === 'c1')
      expect(t?.enabled).toBe(true)
    })

    it('disable() sets trigger.enabled = false', () => {
      manager.register(makeCron({ id: 'c1', enabled: true }))
      manager.disable('c1')
      const t = manager.list().find((x) => x.id === 'c1')
      expect(t?.enabled).toBe(false)
    })

    it('disabling a running cron trigger stops the timer', () => {
      vi.useFakeTimers()
      manager.register(makeCron({ id: 'c1', schedule: '*/1 * * * *' }))
      manager.start()
      manager.disable('c1')
      vi.advanceTimersByTime(120_000)
      expect(onTrigger).not.toHaveBeenCalled()
    })

    it('enable/disable on unknown id is a no-op', () => {
      expect(() => manager.enable('x')).not.toThrow()
      expect(() => manager.disable('x')).not.toThrow()
    })
  })

  // --- start / stop ---

  describe('start / stop', () => {
    it('start() causes cron triggers to fire on their interval', () => {
      vi.useFakeTimers()
      // */1 * * * * = every 1 minute = 60_000ms
      manager.register(makeCron({ id: 'c1', schedule: '*/1 * * * *' }))
      manager.start()
      vi.advanceTimersByTime(60_001)
      expect(onTrigger).toHaveBeenCalledTimes(1)
      expect(onTrigger).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }))
    })

    it('stop() halts all cron timers so no further calls occur', () => {
      vi.useFakeTimers()
      manager.register(makeCron({ id: 'c1', schedule: '*/1 * * * *' }))
      manager.start()
      manager.stop()
      vi.advanceTimersByTime(120_000)
      expect(onTrigger).not.toHaveBeenCalled()
    })

    it('registering a cron trigger after start() immediately starts its timer', () => {
      vi.useFakeTimers()
      manager.start()
      manager.register(makeCron({ id: 'c1', schedule: '*/1 * * * *' }))
      vi.advanceTimersByTime(60_001)
      expect(onTrigger).toHaveBeenCalledTimes(1)
    })

    it('disabled cron triggers registered before start() do not fire', () => {
      vi.useFakeTimers()
      manager.register(makeCron({ id: 'c1', schedule: '*/1 * * * *', enabled: false }))
      manager.start()
      vi.advanceTimersByTime(120_000)
      expect(onTrigger).not.toHaveBeenCalled()
    })
  })

  // --- fireWebhook ---

  describe('fireWebhook', () => {
    it('fires onTrigger for an enabled webhook trigger', async () => {
      manager.register(makeWebhook({ id: 'wh-1' }))
      await manager.fireWebhook('wh-1', { userId: 'u1' })
      expect(onTrigger).toHaveBeenCalledTimes(1)
      const called = onTrigger.mock.calls[0]?.[0] as WebhookTriggerConfig & { input?: unknown }
      expect(called.input).toEqual({ userId: 'u1' })
    })

    it('merges payload into trigger.input when provided', async () => {
      manager.register(makeWebhook({ id: 'wh-1', input: { defaultKey: 'x' } }))
      await manager.fireWebhook('wh-1', { override: 'y' })
      const called = onTrigger.mock.calls[0]?.[0] as { input?: unknown }
      // payload replaces input field entirely (spread semantics)
      expect(called.input).toEqual({ override: 'y' })
    })

    it('does not fire when trigger is disabled', async () => {
      manager.register(makeWebhook({ id: 'wh-1', enabled: false }))
      await manager.fireWebhook('wh-1', {})
      expect(onTrigger).not.toHaveBeenCalled()
    })

    it('does not fire for unknown trigger id', async () => {
      await manager.fireWebhook('no-such-trigger')
      expect(onTrigger).not.toHaveBeenCalled()
    })

    it('does not fire for a cron trigger via fireWebhook', async () => {
      manager.register(makeCron({ id: 'c1' }))
      await manager.fireWebhook('c1')
      expect(onTrigger).not.toHaveBeenCalled()
    })

    it('fires without a payload when none is provided', async () => {
      manager.register(makeWebhook({ id: 'wh-1', input: 'original' }))
      await manager.fireWebhook('wh-1')
      const called = onTrigger.mock.calls[0]?.[0] as { input?: unknown }
      expect(called.input).toBe('original')
    })
  })

  // --- notifyCompletion (chain triggers) ---

  describe('notifyCompletion', () => {
    it('fires chain triggers whose afterAgentId matches', async () => {
      manager.register(makeChain({ id: 'ch-1', afterAgentId: 'agent-a' }))
      await manager.notifyCompletion('agent-a')
      expect(onTrigger).toHaveBeenCalledTimes(1)
      expect(onTrigger).toHaveBeenCalledWith(expect.objectContaining({ id: 'ch-1' }))
    })

    it('does not fire chain triggers with a different afterAgentId', async () => {
      manager.register(makeChain({ id: 'ch-1', afterAgentId: 'agent-b' }))
      await manager.notifyCompletion('agent-a')
      expect(onTrigger).not.toHaveBeenCalled()
    })

    it('does not fire disabled chain triggers', async () => {
      manager.register(makeChain({ id: 'ch-1', afterAgentId: 'agent-a', enabled: false }))
      await manager.notifyCompletion('agent-a')
      expect(onTrigger).not.toHaveBeenCalled()
    })

    it('fires multiple chain triggers that share the same afterAgentId', async () => {
      manager.register(makeChain({ id: 'ch-1', afterAgentId: 'agent-a', agentId: 'b' }))
      manager.register(makeChain({ id: 'ch-2', afterAgentId: 'agent-a', agentId: 'c' }))
      await manager.notifyCompletion('agent-a')
      expect(onTrigger).toHaveBeenCalledTimes(2)
    })
  })

  // --- rejecting onTrigger (DZUPAGENT-ERR-M-91) ---

  describe('rejecting onTrigger', () => {
    it('a rejecting cron callback logs once per tick and never rejects unhandled', async () => {
      vi.useFakeTimers()
      const unhandled = vi.fn()
      process.on('unhandledRejection', unhandled)
      const log = vi.spyOn(secureLogger, 'error').mockImplementation(() => undefined)
      const onError = vi.fn()
      try {
        const failing = vi.fn().mockRejectedValue(new TypeError('db down at 10.0.0.4'))
        manager = new TriggerManager(failing, { onTriggerError: onError })
        manager.register(makeCron({ schedule: '*/5 * * * *' }))
        manager.start()

        await vi.advanceTimersByTimeAsync(5 * 60_000)
        await vi.advanceTimersByTimeAsync(5 * 60_000)

        expect(failing).toHaveBeenCalledTimes(2)
        const entries = log.mock.calls
          .map(([entry]) => entry as { operation?: string })
          .filter((entry) => entry.operation === 'trigger.fire_failed')
        expect(entries).toHaveLength(2)
        expect(entries[0]).toMatchObject({ triggerId: 'cron-1', triggerType: 'cron', errorClass: 'TypeError' })
        expect(JSON.stringify(entries)).not.toContain('10.0.0.4')
        expect(onError).toHaveBeenCalledTimes(2)

        vi.useRealTimers()
        await new Promise((r) => setImmediate(r))
        expect(unhandled).not.toHaveBeenCalled()
      } finally {
        process.off('unhandledRejection', unhandled)
      }
    })

    it('a rejecting webhook callback is logged with the trigger id and still rejects to the caller', async () => {
      const log = vi.spyOn(secureLogger, 'error').mockImplementation(() => undefined)
      manager = new TriggerManager(vi.fn().mockRejectedValue(new Error('boom')))
      manager.register(makeWebhook())

      await expect(manager.fireWebhook('wh-1')).rejects.toThrow('boom')
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ operation: 'trigger.fire_failed', triggerId: 'wh-1' }))
    })

    it('each rejecting chain trigger is logged', async () => {
      const log = vi.spyOn(secureLogger, 'error').mockImplementation(() => undefined)
      manager = new TriggerManager(vi.fn().mockRejectedValue(new Error('boom')))
      manager.register(makeChain({ id: 'c1' }))
      manager.register(makeChain({ id: 'c2' }))

      await expect(manager.notifyCompletion('agent-a')).rejects.toThrow('boom')
      await new Promise((r) => setImmediate(r))
      const ids = log.mock.calls.map(([entry]) => (entry as { triggerId?: string }).triggerId)
      expect(ids).toEqual(expect.arrayContaining(['c1', 'c2']))
    })
  })
})
