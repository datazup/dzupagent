/**
 * Tests for mapping hitl-kit escalation events onto notification channels.
 * No real network: channels receive an injected fetch.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  escalationEventToNotification,
  createEscalationNotificationHandler,
} from '../notifications/escalation-notifications.js'
import type { EscalationEventLike } from '../notifications/escalation-notifications.js'
import { Notifier } from '../notifications/notifier.js'
import type { Notification, NotificationChannel } from '../notifications/notifier.js'
import { SlackNotificationChannel } from '../notifications/channels/slack-channel.js'
import { EmailWebhookNotificationChannel } from '../notifications/channels/email-webhook-channel.js'

const CONTEXT = { approvalId: 'appr-1', runId: 'run-9', agentId: 'agent-3' }
const AT = Date.parse('2026-10-08T10:00:00Z')

function recordingChannel(): NotificationChannel & { sent: Notification[] } {
  const sent: Notification[] = []
  return {
    name: 'recording',
    sent,
    async send(notification) {
      sent.push(notification)
    },
  }
}

describe('escalationEventToNotification', () => {
  it('maps level 0 start to a high-priority human-required notification', () => {
    const n = escalationEventToNotification(
      { type: 'level_started', level: 0, approvers: ['alice', 'bob'], at: AT, deadline: AT + 60_000 },
      CONTEXT,
    )
    expect(n).toMatchObject({
      id: 'appr-1:level_started:0',
      tier: 'human-required',
      priority: 'high',
      eventType: 'approval:escalation_level_started',
      runId: 'run-9',
      agentId: 'agent-3',
    })
    expect(n.timestamp.getTime()).toBe(AT)
    expect(n.body).toContain('alice, bob')
    expect(n.body).toContain('2026-10-08T10:01:00.000Z')
    expect(n.metadata).toEqual({
      approvalId: 'appr-1',
      level: 0,
      approvers: ['alice', 'bob'],
      deadline: AT + 60_000,
    })
  })

  it('raises an escalated level start to critical', () => {
    const n = escalationEventToNotification(
      { type: 'level_started', level: 1, approvers: ['carol'], at: AT, deadline: AT + 1000 },
      CONTEXT,
    )
    expect(n.priority).toBe('critical')
    expect(n.title).toContain('escalated')
  })

  it('maps a level timeout to high priority', () => {
    const n = escalationEventToNotification({ type: 'level_timed_out', level: 0, at: AT }, CONTEXT)
    expect(n).toMatchObject({
      id: 'appr-1:level_timed_out:0',
      tier: 'human-required',
      priority: 'high',
      eventType: 'approval:escalation_timed_out',
    })
  })

  it('maps a decision to normal priority and keeps the free-text reason out', () => {
    const n = escalationEventToNotification(
      {
        type: 'decided',
        level: 1,
        approverId: 'carol',
        decision: 'rejected',
        reason: 'sensitive free text',
        at: AT,
      },
      CONTEXT,
    )
    expect(n).toMatchObject({
      id: 'appr-1:decided:1',
      tier: 'agent-handled',
      priority: 'normal',
      eventType: 'approval:escalation_decided',
    })
    expect(n.body).toContain('rejected')
    expect(n.body).toContain('carol')
    expect(JSON.stringify(n)).not.toContain('sensitive free text')
  })

  it('maps exhaustion to critical with the applied action', () => {
    const n = escalationEventToNotification(
      { type: 'exhausted', action: 'reject', decision: 'rejected', at: AT },
      CONTEXT,
    )
    expect(n).toMatchObject({
      id: 'appr-1:exhausted:final',
      tier: 'human-required',
      priority: 'critical',
      eventType: 'approval:escalation_exhausted',
      metadata: { approvalId: 'appr-1', action: 'reject', decision: 'rejected' },
    })
  })

  it('omits runId and agentId when the context has none', () => {
    const n = escalationEventToNotification(
      { type: 'level_timed_out', level: 0, at: AT },
      { approvalId: 'appr-2' },
    )
    expect(n.runId).toBeUndefined()
    expect(n.agentId).toBeUndefined()
  })
})

describe('createEscalationNotificationHandler', () => {
  it('dispatches each engine event through the notifier', async () => {
    const channel = recordingChannel()
    const notifier = new Notifier({ channels: [channel] })
    const onEvent = createEscalationNotificationHandler(notifier, CONTEXT)

    const events: EscalationEventLike[] = [
      { type: 'level_started', level: 0, approvers: ['alice'], at: AT, deadline: AT + 10 },
      { type: 'level_timed_out', level: 0, at: AT + 10 },
      { type: 'exhausted', action: 'reject', decision: 'rejected', at: AT + 10 },
    ]
    for (const event of events) {
      expect(onEvent(event)).toBeUndefined()
    }
    await vi.waitFor(() => expect(channel.sent).toHaveLength(3))
    expect(channel.sent.map((n) => n.eventType)).toEqual([
      'approval:escalation_level_started',
      'approval:escalation_timed_out',
      'approval:escalation_exhausted',
    ])
  })

  it('never throws into the engine and reports async failures to onError', async () => {
    const failure = new Error('notifier down')
    const notifier = { notify: vi.fn().mockRejectedValue(failure) }
    const onError = vi.fn()
    const onEvent = createEscalationNotificationHandler(notifier, CONTEXT, { onError })

    expect(() => onEvent({ type: 'level_timed_out', level: 0, at: AT })).not.toThrow()
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure))
  })

  it('swallows async failures when no onError is given', async () => {
    const notifier = { notify: vi.fn().mockRejectedValue(new Error('down')) }
    const onEvent = createEscalationNotificationHandler(notifier, CONTEXT)
    expect(() => onEvent({ type: 'level_timed_out', level: 0, at: AT })).not.toThrow()
    await vi.waitFor(() => expect(notifier.notify).toHaveBeenCalledTimes(1))
  })

  it('delivers escalation to Slack and email webhooks through an injected fetch', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }))
    const slack = new SlackNotificationChannel({
      webhookUrl: 'https://hooks.slack.example/services/ref',
      urlPolicy: { resolveDns: false },
      fetchImpl,
    })
    const email = new EmailWebhookNotificationChannel({
      webhookUrl: 'https://mail.example/send',
      urlPolicy: { resolveDns: false },
      fetchImpl,
    })
    const globalFetch = vi.fn()
    vi.stubGlobal('fetch', globalFetch)

    const notifier = new Notifier({ channels: [slack, email], minPriority: 'high' })
    const onEvent = createEscalationNotificationHandler(notifier, CONTEXT)
    onEvent({ type: 'level_started', level: 1, approvers: ['carol'], at: AT, deadline: AT + 5 })
    // Below minPriority: Notifier drops it synchronously, before any await.
    onEvent({ type: 'decided', level: 1, approverId: 'carol', decision: 'granted', at: AT + 1 })

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2))
    expect(notifier.getHistory().map((n) => n.eventType)).toEqual([
      'approval:escalation_level_started',
    ])
    expect(globalFetch).not.toHaveBeenCalled()
    const urls = fetchImpl.mock.calls.map((call) => (call as unknown as [string])[0]).sort()
    expect(urls).toEqual(['https://hooks.slack.example/services/ref', 'https://mail.example/send'])
  })
})
