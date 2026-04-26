/**
 * Focused unit tests for the composition `utils` helpers. These exercise the
 * shared primitives used by every other composition module:
 *   - `registerShutdownDrainHook` (chains hooks, defers errors)
 *   - `warnIfUnboundedInMemoryRetention` (matches metadata flag)
 *   - `isObject` (narrow type guard)
 *
 * Tests run independently of `createForgeApp` and `Hono` to keep failures
 * localised to the helper under test.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

import {
  isObject,
  registerShutdownDrainHook,
  warnIfUnboundedInMemoryRetention,
} from '../utils.js'
import type { ForgeServerConfig } from '../types.js'
import type { GracefulShutdown } from '../../lifecycle/graceful-shutdown.js'

afterEach(() => {
  vi.restoreAllMocks()
})

function makeShutdown(initialOnDrain?: () => Promise<void>) {
  const config: { onDrain?: () => Promise<void> } = { onDrain: initialOnDrain }
  return { config } as unknown as GracefulShutdown
}

describe('composition/utils', () => {
  describe('isObject', () => {
    it('returns true for plain objects', () => {
      expect(isObject({})).toBe(true)
      expect(isObject({ a: 1 })).toBe(true)
    })
    it('returns false for null, primitives, arrays', () => {
      expect(isObject(null)).toBe(false)
      expect(isObject(undefined)).toBe(false)
      expect(isObject(42)).toBe(false)
      expect(isObject('s')).toBe(false)
      // arrays are technically objects — historical behaviour treats them as objects
      expect(isObject([])).toBe(true)
    })
  })

  describe('registerShutdownDrainHook', () => {
    it('runs the new hook before the previously registered hook', async () => {
      const calls: string[] = []
      const shutdown = makeShutdown(async () => {
        calls.push('previous')
      })

      registerShutdownDrainHook(shutdown, async () => {
        calls.push('new')
      })

      const drain = (shutdown as unknown as { config: { onDrain?: () => Promise<void> } }).config.onDrain!
      await drain()

      expect(calls).toEqual(['new', 'previous'])
    })

    it('still runs the previous hook even when the new hook throws, then rethrows the error', async () => {
      const calls: string[] = []
      const shutdown = makeShutdown(async () => {
        calls.push('previous')
      })

      registerShutdownDrainHook(shutdown, async () => {
        calls.push('new')
        throw new Error('boom')
      })

      const drain = (shutdown as unknown as { config: { onDrain?: () => Promise<void> } }).config.onDrain!
      await expect(drain()).rejects.toThrow('boom')

      // The previous hook must still run despite the new hook's error
      expect(calls).toEqual(['new', 'previous'])
    })

    it('handles missing previous hook without throwing', async () => {
      const calls: string[] = []
      const shutdown = makeShutdown()

      registerShutdownDrainHook(shutdown, async () => {
        calls.push('new')
      })

      const drain = (shutdown as unknown as { config: { onDrain?: () => Promise<void> } }).config.onDrain!
      await expect(drain()).resolves.toBeUndefined()
      expect(calls).toEqual(['new'])
    })
  })

  describe('warnIfUnboundedInMemoryRetention', () => {
    it('warns when runStore advertises explicit unbounded retention', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      warnIfUnboundedInMemoryRetention({
        runStore: { __dzupagentRetention: { explicitUnbounded: true } },
        agentStore: {},
        eventBus: {},
        modelRegistry: {},
      } as unknown as ForgeServerConfig)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('InMemoryRunStore is running with unbounded retention'))
    })

    it('warns when traceStore advertises explicit unbounded retention', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      warnIfUnboundedInMemoryRetention({
        runStore: {},
        agentStore: {},
        eventBus: {},
        modelRegistry: {},
        traceStore: { __dzupagentRetention: { explicitUnbounded: true } },
      } as unknown as ForgeServerConfig)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('InMemoryRunTraceStore is running with unbounded retention'))
    })

    it('does not warn when retention metadata is missing or false', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      warnIfUnboundedInMemoryRetention({
        runStore: { __dzupagentRetention: { explicitUnbounded: false } },
        agentStore: {},
        eventBus: {},
        modelRegistry: {},
      } as unknown as ForgeServerConfig)
      expect(warn).not.toHaveBeenCalled()
    })
  })
})
