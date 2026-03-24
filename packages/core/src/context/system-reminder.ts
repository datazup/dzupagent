/**
 * System reminder injector — periodically re-injects key instructions
 * into the conversation to prevent instruction-forgetting during long sessions.
 *
 * Inspired by Claude Code's `<system-reminder>` pattern.
 *
 * @example
 * ```ts
 * const injector = new SystemReminderInjector({
 *   intervalMessages: 15,
 *   reminders: [
 *     { id: 'rules', content: 'TypeScript strict, no any, ESM modules' },
 *     { id: 'task', content: 'Current task: auth implementation',
 *       condition: (s) => s.phase === 'auth' },
 *   ],
 * })
 *
 * // In the message preparation pipeline:
 * const reminders = injector.getReminders(messages.length, agentState)
 * if (reminders) messages.push(reminders)
 * ```
 */

export interface ReminderContent {
  /** Unique identifier for this reminder */
  id: string
  /** Content to re-inject (markdown text) */
  content: string
  /** Only inject when condition returns true (default: always inject) */
  condition?: (state: Record<string, unknown>) => boolean
}

export interface SystemReminderConfig {
  /** Re-inject every N messages (default: 15) */
  intervalMessages: number
  /** Reminder content blocks */
  reminders: ReminderContent[]
  /** XML tag name for wrapping reminders (default: 'system-reminder') */
  tagName?: string
}

export class SystemReminderInjector {
  private messagesSinceLastInjection = 0
  private readonly config: SystemReminderConfig

  constructor(config: SystemReminderConfig) {
    this.config = {
      intervalMessages: config.intervalMessages,
      reminders: config.reminders,
      tagName: config.tagName ?? 'system-reminder',
    }
  }

  /**
   * Record that a message was processed. Returns a reminder string
   * if it's time to inject, or null otherwise.
   */
  tick(state?: Record<string, unknown>): string | null {
    this.messagesSinceLastInjection++

    if (this.messagesSinceLastInjection < this.config.intervalMessages) {
      return null
    }

    return this.buildReminder(state)
  }

  /**
   * Force-generate a reminder regardless of the interval.
   * Useful for injecting at session start.
   */
  forceReminder(state?: Record<string, unknown>): string | null {
    return this.buildReminder(state)
  }

  /** Reset the message counter (e.g., after context compression) */
  reset(): void {
    this.messagesSinceLastInjection = 0
  }

  private buildReminder(state?: Record<string, unknown>): string | null {
    const tag = this.config.tagName!
    const applicable = this.config.reminders.filter(
      r => !r.condition || (state && r.condition(state)),
    )

    if (applicable.length === 0) return null

    this.messagesSinceLastInjection = 0

    return applicable
      .map(r => `<${tag}>\n${r.content}\n</${tag}>`)
      .join('\n\n')
  }
}
