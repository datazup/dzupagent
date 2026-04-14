import type { Notification, NotificationChannel } from '../notifier.js'

/**
 * Console notification channel — logs notifications to stdout for development.
 */
export class ConsoleChannel implements NotificationChannel {
  readonly name = 'console'

  async send(notification: Notification): Promise<void> {
    const prefix = notification.tier === 'human-required' ? '[HUMAN]' : '[AGENT]'
    const tag = `[${notification.priority.toUpperCase()}]`
     
    console.log(
      `${prefix} ${tag} ${notification.title} — ${notification.body}`,
      notification.runId ? `(run: ${notification.runId})` : '',
    )
  }
}
