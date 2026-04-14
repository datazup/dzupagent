import { afterEach, describe, expect, it, vi } from 'vitest'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import { ConsolidationScheduler } from '../runtime/consolidation-scheduler.js'
import { GracefulShutdown } from '../lifecycle/graceful-shutdown.js'
import {
  InMemoryAgentStore,
  InMemoryRunStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'

function createBaseConfig(overrides: Partial<ForgeServerConfig> = {}): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createForgeApp consolidation shutdown wiring', () => {
  it('composes scheduler stop into shutdown onDrain without dropping the existing hook', async () => {
    const calls: string[] = []
    const originalStop = ConsolidationScheduler.prototype.stop
    const stopSpy = vi.spyOn(ConsolidationScheduler.prototype, 'stop').mockImplementation(function (this: ConsolidationScheduler) {
      calls.push('stop')
      return originalStop.call(this)
    })

    const shutdown = new GracefulShutdown({
      drainTimeoutMs: 1_000,
      runStore: new InMemoryRunStore(),
      eventBus: createEventBus(),
      onDrain: async () => {
        calls.push('original')
      },
    })

    const app = createForgeApp({
      ...createBaseConfig(),
      shutdown,
      consolidation: {
        task: {
          run: async () => ({
            recordsProcessed: 0,
            pruned: 0,
            merged: 0,
            durationMs: 0,
          }),
        },
        intervalMs: 60_000,
        idleThresholdMs: Number.MAX_SAFE_INTEGER,
        maxConcurrent: 1,
        eventBus: createEventBus(),
      },
    })

    void app

    const drainHook = (shutdown as unknown as {
      config: { onDrain?: () => Promise<void> }
    }).config.onDrain

    expect(drainHook).toBeTypeOf('function')

    await drainHook?.()

    expect(stopSpy).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['stop', 'original'])
  })
})
