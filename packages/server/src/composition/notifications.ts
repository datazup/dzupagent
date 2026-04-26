/**
 * Auto-registration of escalation notification channels from environment
 * variables. This intentionally lives in the composition layer (not in the
 * Notifier itself) so that hosts that prefer programmatic registration can
 * skip env-driven defaults entirely by leaving the variables unset.
 *
 * Recognised env vars:
 *   - SLACK_NOTIFICATION_WEBHOOK_URL          → SlackNotificationChannel
 *   - EMAIL_NOTIFICATION_WEBHOOK_URL          → EmailWebhookNotificationChannel
 *   - EMAIL_NOTIFICATION_WEBHOOK_SECRET       → optional HMAC secret for above
 */
import type { ForgeServerConfig } from './types.js'
import { SlackNotificationChannel } from '../notifications/channels/slack-channel.js'
import { EmailWebhookNotificationChannel } from '../notifications/channels/email-webhook-channel.js'

export function registerEnvNotificationChannels(runtimeConfig: ForgeServerConfig): void {
  if (!runtimeConfig.notifier) {
    return
  }

  const slackUrl = process.env['SLACK_NOTIFICATION_WEBHOOK_URL']
  if (slackUrl) {
    runtimeConfig.notifier.addChannel(new SlackNotificationChannel({ webhookUrl: slackUrl }))
  }

  const emailUrl = process.env['EMAIL_NOTIFICATION_WEBHOOK_URL']
  if (emailUrl) {
    runtimeConfig.notifier.addChannel(
      new EmailWebhookNotificationChannel({
        webhookUrl: emailUrl,
        secret: process.env['EMAIL_NOTIFICATION_WEBHOOK_SECRET'],
      }),
    )
  }
}
