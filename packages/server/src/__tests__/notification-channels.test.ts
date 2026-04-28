/**
 * Tests for Slack and email webhook notification channels.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { SlackNotificationChannel } from '../notifications/channels/slack-channel.js'
import { EmailWebhookNotificationChannel } from '../notifications/channels/email-webhook-channel.js'
import { WebhookChannel } from '../notifications/channels/webhook-channel.js'
import { Notifier } from '../notifications/notifier.js'
import type { Notification } from '../notifications/notifier.js'

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'notif-1',
    tier: 'human-required',
    priority: 'high',
    title: 'Agent Stuck',
    body: 'The agent has been stuck for 5 minutes',
    eventType: 'agent:stuck',
    runId: 'run-123',
    agentId: 'agent-1',
    metadata: { key: 'value' },
    timestamp: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

describe('SlackNotificationChannel', () => {
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // 1
  it('sends correctly formatted Slack message with blocks', async () => {
    const channel = new SlackNotificationChannel({
      webhookUrl: 'https://hooks.slack.com/services/test',
    })

    const notification = makeNotification({ priority: 'high' })
    await channel.send(notification)

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, options] = mockFetch.mock.calls[0]!
    expect(url).toBe('https://hooks.slack.com/services/test')
    expect(options.method).toBe('POST')

    const body = JSON.parse(options.body as string)
    // Should have the text field and blocks array
    expect(body.text).toContain('Agent Stuck')
    expect(body.blocks).toHaveLength(3)
    // Header block
    expect(body.blocks[0].type).toBe('header')
    expect(body.blocks[0].text.text).toContain('Agent Stuck')
    // Section block with body
    expect(body.blocks[1].type).toBe('section')
    expect(body.blocks[1].text.text).toBe('The agent has been stuck for 5 minutes')
    // Context block with priority
    expect(body.blocks[2].type).toBe('context')
  })

  // 2
  it('includes priority emoji in the message', async () => {
    const channel = new SlackNotificationChannel({
      webhookUrl: 'https://hooks.slack.com/test',
    })

    // High priority should have red circle emoji
    await channel.send(makeNotification({ priority: 'high' }))
    const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string)
    expect(body.text).toContain('\u{1F534}') // Red circle

    mockFetch.mockClear()

    // Low priority should have white circle emoji
    await channel.send(makeNotification({ priority: 'low' }))
    const lowBody = JSON.parse(mockFetch.mock.calls[0]![1].body as string)
    expect(lowBody.text).toContain('\u26AA') // White circle
  })
})

describe('EmailWebhookNotificationChannel', () => {
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // 3
  it('sends correct JSON payload to webhook URL', async () => {
    const channel = new EmailWebhookNotificationChannel({
      webhookUrl: 'https://email.example.com/send',
      urlPolicy: { resolveDns: false },
    })

    const notification = makeNotification()
    await channel.send(notification)

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, options] = mockFetch.mock.calls[0]!
    expect(url).toBe('https://email.example.com/send')

    const body = JSON.parse(options.body as string)
    expect(body).toEqual({
      subject: 'Agent Stuck',
      body: 'The agent has been stuck for 5 minutes',
      priority: 'high',
      metadata: { key: 'value' },
    })
  })

  // 4
  it('includes Authorization header when secret is set', async () => {
    const channel = new EmailWebhookNotificationChannel({
      webhookUrl: 'https://email.example.com/send',
      secret: 'my-secret-token',
      urlPolicy: { resolveDns: false },
    })

    await channel.send(makeNotification())

    const [, options] = mockFetch.mock.calls[0]!
    expect(options.headers['Authorization']).toBe('Bearer my-secret-token')
  })

  // 5
  it('omits Authorization header when no secret', async () => {
    const channel = new EmailWebhookNotificationChannel({
      webhookUrl: 'https://email.example.com/send',
      urlPolicy: { resolveDns: false },
    })

    await channel.send(makeNotification())

    const [, options] = mockFetch.mock.calls[0]!
    expect(options.headers['Authorization']).toBeUndefined()
  })
})

describe('WebhookChannel outbound URL policy', () => {
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects private webhook destinations before fetching', async () => {
    const channel = new WebhookChannel({
      url: 'https://127.0.0.1/hook',
    })

    await expect(channel.send(makeNotification())).rejects.toThrow('Outbound URL rejected')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('revalidates webhook redirects before following them', async () => {
    mockFetch.mockResolvedValueOnce(new Response('', {
      status: 302,
      headers: { location: 'https://127.0.0.1/hook' },
    }))

    const channel = new WebhookChannel({
      url: 'https://hooks.example.com/start',
      urlPolicy: {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      },
    })

    await expect(channel.send(makeNotification())).rejects.toThrow('Outbound URL rejected')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

describe('Notifier priority filtering', () => {
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // 6
  it('filters notifications below minimum priority', async () => {
    const slackChannel = new SlackNotificationChannel({
      webhookUrl: 'https://hooks.slack.com/test',
    })

    const notifier = new Notifier({
      channels: [slackChannel],
      minPriority: 'high',
    })

    // Low priority — should be filtered
    await notifier.notify(makeNotification({ priority: 'low' }))
    expect(mockFetch).not.toHaveBeenCalled()

    // Normal priority — should be filtered
    await notifier.notify(makeNotification({ priority: 'normal' }))
    expect(mockFetch).not.toHaveBeenCalled()

    // High priority — should pass through
    await notifier.notify(makeNotification({ priority: 'high' }))
    expect(mockFetch).toHaveBeenCalledTimes(1)

    // Critical priority — should pass through
    await notifier.notify(makeNotification({ priority: 'critical' }))
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})
