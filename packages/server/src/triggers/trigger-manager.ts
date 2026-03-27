/**
 * Trigger manager — scheduled (cron), webhook, and chain triggers for agent runs.
 *
 * Cron uses simple interval-based scheduling with basic cron expression parsing.
 * Webhook triggers fire on demand via HTTP.
 * Chain triggers fire when a specified agent completes a run.
 */

export type TriggerType = 'cron' | 'webhook' | 'chain'

export interface TriggerConfig {
  id: string
  type: TriggerType
  agentId: string
  input?: unknown
  enabled: boolean
  metadata?: Record<string, unknown>
}

export interface CronTriggerConfig extends TriggerConfig {
  type: 'cron'
  /** Cron expression — supports basic patterns like "* /5 * * * *" (every 5 min) */
  schedule: string
}

export interface WebhookTriggerConfig extends TriggerConfig {
  type: 'webhook'
  /** Optional shared secret for HMAC validation */
  secret?: string
}

export interface ChainTriggerConfig extends TriggerConfig {
  type: 'chain'
  /** Trigger fires when this agent completes a run */
  afterAgentId: string
}

type AnyTrigger = CronTriggerConfig | WebhookTriggerConfig | ChainTriggerConfig

/**
 * Parse a basic cron expression to an interval in milliseconds.
 * Supports: "* /N * * * *" (every N minutes) and full wildcard "* * * * *" (every minute).
 * For unsupported patterns, defaults to 60000ms (1 minute).
 */
function cronToIntervalMs(schedule: string): number {
  const parts = schedule.trim().split(/\s+/)
  if (parts.length < 5) return 60_000

  const minutePart = parts[0]!
  // Every N minutes: */N
  const stepMatch = minutePart.match(/^\*\/(\d+)$/)
  if (stepMatch) {
    const n = parseInt(stepMatch[1]!, 10)
    return Math.max(n, 1) * 60_000
  }

  // Specific minute: run every hour at that minute — approximate with 3600s
  const specificMinute = parseInt(minutePart, 10)
  if (!isNaN(specificMinute)) {
    return 3_600_000
  }

  // Wildcard: every minute
  return 60_000
}

export class TriggerManager {
  private triggers: Map<string, AnyTrigger> = new Map()
  private cronTimers: Map<string, ReturnType<typeof setInterval>> = new Map()
  private started = false

  constructor(private readonly onTrigger: (trigger: TriggerConfig) => Promise<void>) {}

  register(trigger: AnyTrigger): void {
    this.triggers.set(trigger.id, trigger)
    if (this.started && trigger.enabled && trigger.type === 'cron') {
      this.startCronTimer(trigger)
    }
  }

  unregister(id: string): void {
    this.stopCronTimer(id)
    this.triggers.delete(id)
  }

  enable(id: string): void {
    const trigger = this.triggers.get(id)
    if (!trigger) return
    trigger.enabled = true
    if (this.started && trigger.type === 'cron') {
      this.startCronTimer(trigger)
    }
  }

  disable(id: string): void {
    const trigger = this.triggers.get(id)
    if (!trigger) return
    trigger.enabled = false
    this.stopCronTimer(id)
  }

  list(): TriggerConfig[] {
    return [...this.triggers.values()]
  }

  /** Start all enabled cron timers. */
  start(): void {
    this.started = true
    for (const trigger of this.triggers.values()) {
      if (trigger.enabled && trigger.type === 'cron') {
        this.startCronTimer(trigger)
      }
    }
  }

  /** Stop all cron timers. */
  stop(): void {
    this.started = false
    for (const id of this.cronTimers.keys()) {
      this.stopCronTimer(id)
    }
  }

  /** Fire a webhook trigger by ID, optionally merging payload into input. */
  async fireWebhook(triggerId: string, payload?: unknown): Promise<void> {
    const trigger = this.triggers.get(triggerId)
    if (!trigger || trigger.type !== 'webhook' || !trigger.enabled) return
    const merged: TriggerConfig = payload
      ? { ...trigger, input: payload }
      : trigger
    await this.onTrigger(merged)
  }

  /** Notify completion of an agent run — fires matching chain triggers. */
  async notifyCompletion(agentId: string): Promise<void> {
    const chains = [...this.triggers.values()].filter(
      (t): t is ChainTriggerConfig =>
        t.type === 'chain' && t.enabled && t.afterAgentId === agentId,
    )
    await Promise.all(chains.map((t) => this.onTrigger(t)))
  }

  // --- Private helpers ---

  private startCronTimer(trigger: AnyTrigger): void {
    if (trigger.type !== 'cron') return
    this.stopCronTimer(trigger.id)
    const intervalMs = cronToIntervalMs(trigger.schedule)
    const timer = setInterval(() => {
      if (trigger.enabled) {
        void this.onTrigger(trigger)
      }
    }, intervalMs)
    // Allow the process to exit even if timers are pending
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }
    this.cronTimers.set(trigger.id, timer)
  }

  private stopCronTimer(id: string): void {
    const timer = this.cronTimers.get(id)
    if (timer) {
      clearInterval(timer)
      this.cronTimers.delete(id)
    }
  }
}
