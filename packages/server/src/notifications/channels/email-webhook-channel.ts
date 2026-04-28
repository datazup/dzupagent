/**
 * Email webhook notification channel — sends notifications to an email
 * delivery webhook endpoint (e.g., SendGrid, Mailgun, or custom service).
 *
 * Uses `fetch()` directly — no email SDK dependency.
 */
import {
  fetchWithOutboundUrlPolicy,
  type OutboundUrlSecurityPolicy,
} from '@dzupagent/core'
import type { Notification, NotificationChannel } from '../notifier.js'

export interface EmailWebhookNotificationChannelConfig {
  webhookUrl: string
  /** Optional bearer token secret for the webhook */
  secret?: string
  /** Timeout in ms (default: 5000) */
  timeoutMs?: number
  /** Outbound URL policy. Defaults to public HTTPS destinations only. */
  urlPolicy?: OutboundUrlSecurityPolicy
}

export class EmailWebhookNotificationChannel implements NotificationChannel {
  readonly name = 'email-webhook'
  private readonly webhookUrl: string
  private readonly secret: string | undefined
  private readonly timeoutMs: number
  private readonly urlPolicy: OutboundUrlSecurityPolicy | undefined

  constructor(config: EmailWebhookNotificationChannelConfig) {
    this.webhookUrl = config.webhookUrl
    this.secret = config.secret
    this.timeoutMs = config.timeoutMs ?? 5000
    this.urlPolicy = config.urlPolicy
  }

  async send(notification: Notification): Promise<void> {
    const payload = {
      subject: notification.title,
      body: notification.body,
      priority: notification.priority,
      metadata: notification.metadata,
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    if (this.secret) {
      headers['Authorization'] = `Bearer ${this.secret}`
    }

    await fetchWithOutboundUrlPolicy(this.webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    }, {
      policy: this.urlPolicy,
    })
  }
}
