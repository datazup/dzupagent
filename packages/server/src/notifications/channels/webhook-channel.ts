import { createHmac } from 'node:crypto'
import {
  fetchWithOutboundUrlPolicy,
  type OutboundUrlSecurityPolicy,
} from '@dzupagent/core'
import type { Notification, NotificationChannel } from '../notifier.js'

export interface WebhookChannelConfig {
  url: string
  /** Optional secret for HMAC signing */
  secret?: string
  /** Timeout in ms (default: 5000) */
  timeoutMs?: number
  /** Outbound URL policy. Defaults to public HTTPS destinations only. */
  urlPolicy?: OutboundUrlSecurityPolicy
}

/**
 * Webhook notification channel — sends notifications to an HTTP endpoint.
 */
export class WebhookChannel implements NotificationChannel {
  readonly name = 'webhook'
  private readonly url: string
  private readonly secret: string | undefined
  private readonly timeoutMs: number
  private readonly urlPolicy: OutboundUrlSecurityPolicy | undefined

  constructor(config: WebhookChannelConfig) {
    this.url = config.url
    this.secret = config.secret
    this.timeoutMs = config.timeoutMs ?? 5000
    this.urlPolicy = config.urlPolicy
  }

  async send(notification: Notification): Promise<void> {
    const body = JSON.stringify(notification)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }

    if (this.secret) {
      const signature = createHmac('sha256', this.secret).update(body).digest('hex')
      headers['X-Signature'] = signature
    }

    await fetchWithOutboundUrlPolicy(this.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    }, {
      policy: this.urlPolicy,
    })
  }
}
