export { Notifier, classifyEvent, logNotificationChannelError } from './notifier.js'
export type {
  Notification,
  NotificationChannel,
  NotificationChannelErrorContext,
  NotifierConfig,
  NotificationTier,
  NotificationPriority,
} from './notifier.js'
export { WebhookChannel } from './channels/webhook-channel.js'
export type { WebhookChannelConfig } from './channels/webhook-channel.js'
export { ConsoleChannel } from './channels/console-channel.js'
export {
  escalationEventToNotification,
  createEscalationNotificationHandler,
} from './escalation-notifications.js'
export type {
  EscalationEventLike,
  EscalationNotificationContext,
  EscalationNotificationHandlerOptions,
} from './escalation-notifications.js'
