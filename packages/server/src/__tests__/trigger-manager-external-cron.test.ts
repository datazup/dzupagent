/**
 * P4 HA scheduling — TriggerManager cron-path rewire.
 *
 * In an HA deployment the durable store-backed ScheduleTickWorker is the single
 * source of truth for time-based firing, so TriggerManager must NOT spin its
 * own per-process per-cron setInterval (which would make every node fire the
 * same cron). The `externalCronSource` option suppresses the per-cron timers
 * while leaving webhook and chain triggers — fired on demand — untouched.
 *
 * Default construction (no option) preserves the legacy per-process cron
 * timers, covered by trigger-manager.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { TriggerManager } from '../triggers/trigger-manager.js'
import type {
  CronTriggerConfig,
  WebhookTriggerConfig,
  ChainTriggerConfig,
} from '../triggers/trigger-manager.js'

function makeCron(overrides: Partial<CronTriggerConfig> = {}): CronTriggerConfig {
  return {
    id: 'cron-1',
    type: 'cron',
    agentId: 'agent-1',
    schedule: '*/1 * * * *',
    enabled: true,
    ...overrides,
  }
}

describe('TriggerManager — externalCronSource (P4 claim-tick rewire)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does NOT fire cron triggers on an interval when externalCronSource is set', () => {
    vi.useFakeTimers()
    const onTrigger = vi.fn().mockResolvedValue(undefined)
    const manager = new TriggerManager(onTrigger, { externalCronSource: true })
    manager.register(makeCron({ id: 'c1' }))
    manager.start()
    vi.advanceTimersByTime(120_000)
    expect(onTrigger).not.toHaveBeenCalled()
    manager.stop()
  })

  it('register-after-start also installs no cron timer under externalCronSource', () => {
    vi.useFakeTimers()
    const onTrigger = vi.fn().mockResolvedValue(undefined)
    const manager = new TriggerManager(onTrigger, { externalCronSource: true })
    manager.start()
    manager.register(makeCron({ id: 'c1' }))
    vi.advanceTimersByTime(120_000)
    expect(onTrigger).not.toHaveBeenCalled()
    manager.stop()
  })

  it('still fires webhook triggers on demand under externalCronSource', async () => {
    const onTrigger = vi.fn().mockResolvedValue(undefined)
    const manager = new TriggerManager(onTrigger, { externalCronSource: true })
    const wh: WebhookTriggerConfig = {
      id: 'wh-1',
      type: 'webhook',
      agentId: 'a',
      enabled: true,
    }
    manager.register(wh)
    await manager.fireWebhook('wh-1', { k: 'v' })
    expect(onTrigger).toHaveBeenCalledTimes(1)
  })

  it('still fires chain triggers under externalCronSource', async () => {
    const onTrigger = vi.fn().mockResolvedValue(undefined)
    const manager = new TriggerManager(onTrigger, { externalCronSource: true })
    const chain: ChainTriggerConfig = {
      id: 'ch-1',
      type: 'chain',
      agentId: 'b',
      afterAgentId: 'a',
      enabled: true,
    }
    manager.register(chain)
    await manager.notifyCompletion('a')
    expect(onTrigger).toHaveBeenCalledTimes(1)
  })
})
