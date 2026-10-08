/**
 * Email webhook notification channel — sends notifications to an email
 * delivery webhook endpoint (e.g., SendGrid, Mailgun, or custom service).
 *
 * Uses the shared outbound URL policy — no email SDK dependency.
 */
import { fetchWithOutboundUrlPolicy, type OutboundUrlSecurityPolicy } from '@dzupagent/core/security'
import type { Notification, NotificationChannel } from '../notifier.js'

export interface EmailWebhookNotificationChannelConfig {
  webhookUrl: string
  /** Optional bearer token secret for the webhook */
  secret?: string
  /** Timeout in ms (default: 5000) */
  timeoutMs?: number
  /** Outbound URL policy. Defaults to public HTTPS destinations only. */
  urlPolicy?: OutboundUrlSecurityPolicy
  /** Fetch implementation (default: global fetch). URL policy still applies. */
  fetchImpl?: typeof fetch
}

export class EmailWebhookNotificationChannel implements NotificationChannel {
  readonly name = 'email-webhook'
  private readonly webhookUrl: string
  private readonly secret: string | undefined
  private readonly timeoutMs: number
  private readonly urlPolicy: OutboundUrlSecurityPolicy | undefined
  private readonly fetchImpl: typeof fetch | undefined

  constructor(config: EmailWebhookNotificationChannelConfig) {
    this.webhookUrl = config.webhookUrl
    this.secret = config.secret
    this.timeoutMs = config.timeoutMs ?? 5000
    this.urlPolicy = config.urlPolicy
    this.fetchImpl = config.fetchImpl
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

    const response = await fetchWithOutboundUrlPolicy(this.webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    }, {
      policy: this.urlPolicy,
      fetchImpl: this.fetchImpl,
    })
    // Report the status only — the URL may carry a token.
    if (!response.ok) {
      throw new Error(`${this.name} notification delivery failed: HTTP ${response.status}`)
    }
  }
}
