/**
 * A2A Push Notification Service.
 *
 * Manages webhook registrations for task events and delivers
 * push notifications with a single retry on transient failures.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A2A push notification event types. */
export type PushNotificationEvent =
  | 'task.status.update'
  | 'task.artifact.update'
  | 'task.completed'
  | 'task.failed'

/** Push notification configuration provided by the client. */
export interface PushNotificationConfig {
  /** Webhook URL to send notifications to. */
  url: string
  /** Optional authentication token for the webhook. */
  token?: string
  /** Events to subscribe to (defaults to all events if omitted). */
  events?: PushNotificationEvent[]
}

/** Push notification payload sent to the webhook. */
export interface PushNotification {
  /** The task ID this notification is for. */
  taskId: string
  /** Event type. */
  event: string
  /** ISO 8601 timestamp. */
  timestamp: string
  /** Event data (task status, artifact, etc.). */
  data: Record<string, unknown>
}

/** Push notification delivery result. */
export interface PushNotificationResult {
  /** Whether the notification was delivered successfully. */
  delivered: boolean
  /** HTTP status code of the webhook response (if any). */
  statusCode?: number
  /** Error message on failure. */
  error?: string
  /** ISO 8601 timestamp of the delivery attempt. */
  attemptedAt: string
}

// ---------------------------------------------------------------------------
// Service configuration
// ---------------------------------------------------------------------------

export interface PushNotificationServiceConfig {
  /** Custom fetch function (for testing). */
  fetch?: typeof globalThis.fetch
  /** Timeout in ms for webhook requests (default: 10000). */
  timeoutMs?: number
}

// ---------------------------------------------------------------------------
// PushNotificationService
// ---------------------------------------------------------------------------

/**
 * Service that manages push notification registrations and delivers
 * webhook notifications for A2A task events.
 *
 * Delivery is fire-and-forget with one retry on 5xx or network errors.
 */
export class PushNotificationService {
  private readonly registrations = new Map<string, PushNotificationConfig>()
  private readonly fetchFn: typeof globalThis.fetch
  private readonly timeoutMs: number

  constructor(config?: PushNotificationServiceConfig) {
    this.fetchFn = config?.fetch ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = config?.timeoutMs ?? 10_000
  }

  /**
   * Register a push notification config for a task.
   * Replaces any existing registration for the same task.
   */
  register(taskId: string, config: PushNotificationConfig): void {
    this.registrations.set(taskId, config)
  }

  /**
   * Unregister push notifications for a task.
   */
  unregister(taskId: string): void {
    this.registrations.delete(taskId)
  }

  /**
   * Get registered config for a task.
   */
  getConfig(taskId: string): PushNotificationConfig | undefined {
    return this.registrations.get(taskId)
  }

  /**
   * Send a push notification for a task event.
   *
   * If the task has no registered config, returns a non-delivered result.
   * Retries once on 5xx or network error.
   */
  async notify(
    taskId: string,
    event: string,
    data: Record<string, unknown>,
  ): Promise<PushNotificationResult> {
    const config = this.registrations.get(taskId)
    if (!config) {
      return {
        delivered: false,
        error: `No push notification config registered for task ${taskId}`,
        attemptedAt: new Date().toISOString(),
      }
    }

    // Check event filter
    if (config.events && config.events.length > 0) {
      if (!config.events.includes(event as PushNotificationEvent)) {
        return {
          delivered: false,
          error: `Event "${event}" is not in the subscribed events list`,
          attemptedAt: new Date().toISOString(),
        }
      }
    }

    const payload: PushNotification = {
      taskId,
      event,
      timestamp: new Date().toISOString(),
      data,
    }

    // Attempt delivery with one retry
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await this.deliverOnce(config, payload)
        if (result.delivered || (result.statusCode !== undefined && result.statusCode < 500)) {
          return result
        }
        // 5xx — retry once
        if (attempt === 0) {
          continue
        }
        return result
      } catch (err: unknown) {
        if (attempt === 0) {
          continue
        }
        return {
          delivered: false,
          error: err instanceof Error ? err.message : String(err),
          attemptedAt: new Date().toISOString(),
        }
      }
    }

    // Should not reach here, but TypeScript needs it
    return {
      delivered: false,
      error: 'Unexpected: retry loop exited without returning',
      attemptedAt: new Date().toISOString(),
    }
  }

  /**
   * Dispose all registrations.
   */
  dispose(): void {
    this.registrations.clear()
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async deliverOnce(
    config: PushNotificationConfig,
    payload: PushNotification,
  ): Promise<PushNotificationResult> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (config.token) {
      headers['Authorization'] = `Bearer ${config.token}`
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await this.fetchFn(config.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      })

      return {
        delivered: response.ok,
        statusCode: response.status,
        error: response.ok ? undefined : `Webhook returned ${response.status}`,
        attemptedAt: new Date().toISOString(),
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
