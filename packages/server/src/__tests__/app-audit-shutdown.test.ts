/**
 * Verifies that when an auditStore is configured, the graceful shutdown
 * drain hook calls ComplianceAuditLogger.flush() before exit so pending
 * fire-and-forget audit writes are not lost on SIGTERM/SIGINT.
 *
 * Acceptance:
 * - flush() is invoked exactly once via the shutdown onDrain hook
 * - the existing onDrain hook from the caller is preserved (composition)
 */
import { describe, expect, it, vi } from 'vitest'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import { GracefulShutdown } from '../lifecycle/graceful-shutdown.js'
import {
  ComplianceAuditLogger,
  InMemoryAgentStore,
  InMemoryAuditStore,
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

describe('createForgeApp audit shutdown wiring', () => {
  it('drains pending audit writes via flush() when shutdown drain hook runs', async () => {
    const calls: string[] = []
    const flushSpy = vi
      .spyOn(ComplianceAuditLogger.prototype, 'flush')
      .mockImplementation(async function (this: ComplianceAuditLogger) {
        calls.push('audit-flush')
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
      auditStore: new InMemoryAuditStore(),
    })
    void app

    const drainHook = (shutdown as unknown as {
      config: { onDrain?: () => Promise<void> }
    }).config.onDrain

    expect(drainHook).toBeTypeOf('function')
    await drainHook?.()

    expect(flushSpy).toHaveBeenCalledTimes(1)
    // Audit flush composed BEFORE the original onDrain by registerShutdownDrainHook.
    expect(calls).toEqual(['audit-flush', 'original'])

    flushSpy.mockRestore()
  })

  it('does not register a drain hook when no shutdown is configured', () => {
    // Smoke test: app should construct cleanly without a shutdown handle.
    const app = createForgeApp({
      ...createBaseConfig(),
      auditStore: new InMemoryAuditStore(),
    })
    expect(app).toBeDefined()
  })
})
