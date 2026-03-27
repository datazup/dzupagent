import { randomUUID } from 'node:crypto'

export type NotificationTier = 'agent-handled' | 'human-required'
export type NotificationPriority = 'low' | 'normal' | 'high' | 'critical'

const PRIORITY_ORDER: Record<NotificationPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
}

export interface Notification {
  id: string
  tier: NotificationTier
  priority: NotificationPriority
  title: string
  body: string
  /** Source event type */
  eventType: string
  /** Related run ID if applicable */
  runId?: string
  /** Related agent ID if applicable */
  agentId?: string
  /** Additional metadata */
  metadata?: Record<string, unknown>
  timestamp: Date
}

export interface NotificationChannel {
  name: string
  /** Send a notification through this channel */
  send(notification: Notification): Promise<void>
}

export interface NotifierConfig {
  /** Registered notification channels */
  channels: NotificationChannel[]
  /** Only send notifications at or above this priority (default: 'low') */
  minPriority?: NotificationPriority
  /** Custom event-to-notification mapper */
  eventMapper?: (eventType: string, eventData: Record<string, unknown>) => Notification | null
}

/** Tier-1 events the agent can handle itself */
const TIER1_NORMAL: ReadonlySet<string> = new Set([
  'ci:failed',
  'tool:error',
  'step:failed',
])

/** Tier-2 events requiring human attention */
const TIER2_MAP: ReadonlyMap<string, NotificationPriority> = new Map([
  ['agent:stuck', 'high'],
  ['budget:exceeded', 'high'],
  ['approval:requested', 'critical'],
  ['agent:failed', 'critical'],
])

/**
 * Classify an event into a notification tier and priority.
 */
export function classifyEvent(eventType: string): { tier: NotificationTier; priority: NotificationPriority } {
  if (TIER1_NORMAL.has(eventType)) {
    return { tier: 'agent-handled', priority: 'normal' }
  }
  const tier2Priority = TIER2_MAP.get(eventType)
  if (tier2Priority) {
    return { tier: 'human-required', priority: tier2Priority }
  }
  return { tier: 'agent-handled', priority: 'low' }
}

const MAX_HISTORY = 100

/**
 * Notification dispatcher — routes events to appropriate channels.
 */
export class Notifier {
  private readonly channels: NotificationChannel[]
  private readonly minPriority: NotificationPriority
  private readonly eventMapper?: NotifierConfig['eventMapper']
  private readonly history: Notification[] = []

  constructor(config: NotifierConfig) {
    this.channels = [...config.channels]
    this.minPriority = config.minPriority ?? 'low'
    this.eventMapper = config.eventMapper
  }

  /** Dispatch a notification to all registered channels */
  async notify(notification: Notification): Promise<void> {
    if (PRIORITY_ORDER[notification.priority] < PRIORITY_ORDER[this.minPriority]) {
      return
    }
    this.history.push(notification)
    if (this.history.length > MAX_HISTORY) {
      this.history.shift()
    }
    await Promise.allSettled(
      this.channels.map((ch) => ch.send(notification)),
    )
  }

  /** Convert a DzipEvent to a notification and dispatch it */
  async fromEvent(eventType: string, eventData: Record<string, unknown>): Promise<void> {
    let notification: Notification | null = null

    if (this.eventMapper) {
      notification = this.eventMapper(eventType, eventData)
    }

    if (!notification) {
      const { tier, priority } = classifyEvent(eventType)
      notification = {
        id: randomUUID(),
        tier,
        priority,
        title: eventType.replace(/:/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        body: (eventData['message'] as string | undefined) ?? `Event: ${eventType}`,
        eventType,
        runId: eventData['runId'] as string | undefined,
        agentId: eventData['agentId'] as string | undefined,
        metadata: eventData,
        timestamp: new Date(),
      }
    }

    await this.notify(notification)
  }

  /** Add a channel dynamically */
  addChannel(channel: NotificationChannel): void {
    this.channels.push(channel)
  }

  /** Get notification history (in-memory, limited to last 100) */
  getHistory(): Notification[] {
    return [...this.history]
  }
}
