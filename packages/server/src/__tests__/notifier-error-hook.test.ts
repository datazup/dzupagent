/**
 * Tests for the Notifier channel-error hook (DZA-HITL-NOTIFY-20261008-P2).
 */
import { describe, it, expect, vi } from 'vitest'
import { Notifier } from '../notifications/notifier.js'
import type { Notification, NotificationChannel } from '../notifications/notifier.js'

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'notif-1',
    tier: 'human-required',
    priority: 'high',
    title: 'Agent Stuck',
    body: 'The agent has been stuck for 5 minutes',
    eventType: 'agent:stuck',
    timestamp: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

function okChannel(name: string): NotificationChannel & { send: ReturnType<typeof vi.fn> } {
  return { name, send: vi.fn().mockResolvedValue(undefined) }
}

function rejectingChannel(name: string, error: unknown): NotificationChannel & { send: ReturnType<typeof vi.fn> } {
  return { name, send: vi.fn().mockRejectedValue(error) }
}

describe('Notifier onChannelError', () => {
  it('reports each failed channel with its name and the notification', async () => {
    const slackError = new Error('slack notification delivery failed: HTTP 500')
    const emailError = new Error('email-webhook notification delivery failed: HTTP 404')
    const onChannelError = vi.fn()
    const notifier = new Notifier({
      channels: [rejectingChannel('slack', slackError), okChannel('ok'), rejectingChannel('email-webhook', emailError)],
      onChannelError,
    })
    const notification = makeNotification()

    await notifier.notify(notification)

    expect(onChannelError).toHaveBeenCalledTimes(2)
    expect(onChannelError).toHaveBeenNthCalledWith(1, slackError, { channel: 'slack', notification })
    expect(onChannelError).toHaveBeenNthCalledWith(2, emailError, { channel: 'email-webhook', notification })
  })

  it('does not call the hook when every channel succeeds', async () => {
    const onChannelError = vi.fn()
    const notifier = new Notifier({ channels: [okChannel('a'), okChannel('b')], onChannelError })

    await notifier.notify(makeNotification())

    expect(onChannelError).not.toHaveBeenCalled()
  })

  it('does not call the hook for notifications filtered by priority', async () => {
    const onChannelError = vi.fn()
    const failing = rejectingChannel('slack', new Error('boom'))
    const notifier = new Notifier({ channels: [failing], minPriority: 'high', onChannelError })

    await notifier.notify(makeNotification({ priority: 'low' }))

    expect(failing.send).not.toHaveBeenCalled()
    expect(onChannelError).not.toHaveBeenCalled()
  })

  it('isolates a synchronously throwing channel so the others still send', async () => {
    const syncError = new Error('sync failure')
    const throwing: NotificationChannel = {
      name: 'throws',
      send: () => {
        throw syncError
      },
    }
    const after = okChannel('after')
    const onChannelError = vi.fn()
    const notifier = new Notifier({ channels: [throwing, after], onChannelError })
    const notification = makeNotification()

    await expect(notifier.notify(notification)).resolves.toBeUndefined()

    expect(after.send).toHaveBeenCalledWith(notification)
    expect(onChannelError).toHaveBeenCalledWith(syncError, { channel: 'throws', notification })
  })

  it('contains a throwing hook and still reports every failure', async () => {
    const onChannelError = vi.fn().mockImplementation(() => {
      throw new Error('hook failure')
    })
    const notifier = new Notifier({
      channels: [rejectingChannel('a', new Error('a')), rejectingChannel('b', new Error('b'))],
      onChannelError,
    })

    await expect(notifier.notify(makeNotification())).resolves.toBeUndefined()

    expect(onChannelError).toHaveBeenCalledTimes(2)
  })

  it('reports failures from channels added with addChannel and via fromEvent', async () => {
    const error = new Error('late channel failure')
    const onChannelError = vi.fn()
    const notifier = new Notifier({ channels: [], onChannelError })
    notifier.addChannel(rejectingChannel('late', error))

    await notifier.fromEvent('agent:failed', { message: 'Agent failed', runId: 'run-1' })

    expect(onChannelError).toHaveBeenCalledTimes(1)
    const [reported, context] = onChannelError.mock.calls[0] as [unknown, { channel: string; notification: Notification }]
    expect(reported).toBe(error)
    expect(context.channel).toBe('late')
    expect(context.notification.eventType).toBe('agent:failed')
    expect(context.notification.runId).toBe('run-1')
  })

  it('stays silent without a hook, as before', async () => {
    const notifier = new Notifier({ channels: [rejectingChannel('slack', new Error('boom')), okChannel('ok')] })

    await expect(notifier.notify(makeNotification())).resolves.toBeUndefined()
    expect(notifier.getHistory()).toHaveLength(1)
  })
})
