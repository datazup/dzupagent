/**
 * Slack notification channel — sends notifications to a Slack incoming webhook.
 *
 * Uses the Slack Block Kit format for rich message rendering.
 * No Slack SDK dependency — uses the shared outbound URL policy.
 */
import { fetchWithOutboundUrlPolicy, type OutboundUrlSecurityPolicy } from '@dzupagent/core/security'
import type { Notification, NotificationChannel } from '../notifier.js'

export interface SlackNotificationChannelConfig {
  webhookUrl: string
  /** Timeout in ms (default: 5000) */
  timeoutMs?: number
  /** Outbound URL policy. Defaults to public HTTPS destinations only. */
  urlPolicy?: OutboundUrlSecurityPolicy
  /** Fetch implementation (default: global fetch). URL policy still applies. */
  fetchImpl?: typeof fetch
}

const PRIORITY_EMOJI: Record<string, string> = {
  critical: '\u{1F534}',
  high: '\u{1F534}',
  normal: '\u{1F7E1}',
  low: '\u26AA',
}

export class SlackNotificationChannel implements NotificationChannel {
  readonly name = 'slack'
  private readonly webhookUrl: string
  private readonly timeoutMs: number
  private readonly urlPolicy: OutboundUrlSecurityPolicy | undefined
  private readonly fetchImpl: typeof fetch | undefined

  constructor(config: SlackNotificationChannelConfig) {
    this.webhookUrl = config.webhookUrl
    this.timeoutMs = config.timeoutMs ?? 5000
    this.urlPolicy = config.urlPolicy
    this.fetchImpl = config.fetchImpl
  }

  async send(notification: Notification): Promise<void> {
    const emoji = PRIORITY_EMOJI[notification.priority] ?? '\u26AA'
    const blocks = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${emoji} ${notification.title}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: notification.body,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `*Priority:* ${notification.priority} | *Tier:* ${notification.tier}`,
          },
          ...(notification.runId
            ? [{ type: 'mrkdwn' as const, text: `*Run:* ${notification.runId}` }]
            : []),
        ],
      },
    ]

    const body = JSON.stringify({
      text: `${emoji} ${notification.title}`,
      blocks,
    })

    const response = await fetchWithOutboundUrlPolicy(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    }, {
      policy: this.urlPolicy,
      fetchImpl: this.fetchImpl,
    })
    // The webhook URL is itself a credential — report the status only.
    if (!response.ok) {
      throw new Error(`${this.name} notification delivery failed: HTTP ${response.status}`)
    }
  }
}
