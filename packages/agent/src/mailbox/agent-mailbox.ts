/**
 * Concrete implementation of {@link AgentMailbox}.
 *
 * Wraps a {@link MailboxStore} and scopes all operations to a single agent.
 * Optionally integrates with {@link DzupEventBus} for real-time notifications.
 *
 * Supports two operational guardrails:
 *   - Per-sender rate limiting via {@link RateLimiter} — `send()` throws
 *     {@link MailRateLimitedError} when the caller exceeds the configured
 *     sliding-window quota.
 *   - Dead-letter queuing via {@link DeadLetterStore} — when `store.save()`
 *     throws, delivery is retried up to `maxDeliveryAttempts` times; if the
 *     final attempt still fails, the message is pushed to the DLQ and the
 *     original error is rethrown.
 */
import { randomUUID } from 'node:crypto'
import type { DzupEventBus } from '@dzupagent/core'
import type { AgentMailbox, MailboxQuery, MailboxStore, MailMessage } from './types.js'
import type { DeadLetterStore } from './dead-letter-store.js'
import type { RateLimiter } from './rate-limiter.js'
import { MailRateLimitedError } from './rate-limiter.js'

/** Options accepted by {@link AgentMailboxImpl}. */
export interface AgentMailboxOptions {
  eventBus?: DzupEventBus
  /**
   * Total number of delivery (store.save) attempts before a message is
   * moved to the DLQ. Must be >= 1. Defaults to 3.
   */
  maxDeliveryAttempts?: number
  /** Dead-letter store for messages that exhaust retries. */
  deadLetterStore?: DeadLetterStore
  /**
   * Optional rate limiter. When provided, `send()` checks `isAllowed(from)`
   * before persisting and throws {@link MailRateLimitedError} on rejection.
   */
  rateLimiter?: RateLimiter
}

const DEFAULT_MAX_DELIVERY_ATTEMPTS = 3

export class AgentMailboxImpl implements AgentMailbox {
  readonly agentId: string
  private readonly store: MailboxStore
  private readonly eventBus?: DzupEventBus
  private readonly maxDeliveryAttempts: number
  private readonly deadLetterStore?: DeadLetterStore
  private readonly rateLimiter?: RateLimiter

  /**
   * @param agentId  The agent this mailbox belongs to.
   * @param store    Backing persistence for mail.
   * @param eventBusOrOptions  Either a raw {@link DzupEventBus} (legacy
   *                 two-argument constructor shape) or an
   *                 {@link AgentMailboxOptions} object.
   */
  constructor(
    agentId: string,
    store: MailboxStore,
    eventBusOrOptions?: DzupEventBus | AgentMailboxOptions,
  ) {
    this.agentId = agentId
    this.store = store

    const options = normalizeOptions(eventBusOrOptions)
    this.eventBus = options.eventBus
    this.deadLetterStore = options.deadLetterStore
    this.rateLimiter = options.rateLimiter
    this.maxDeliveryAttempts =
      options.maxDeliveryAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS

    if (this.maxDeliveryAttempts < 1) {
      throw new Error(
        'AgentMailboxImpl: maxDeliveryAttempts must be >= 1',
      )
    }
  }

  async send(
    to: string,
    subject: string,
    body: Record<string, unknown>,
  ): Promise<MailMessage> {
    if (this.rateLimiter && !this.rateLimiter.isAllowed(this.agentId)) {
      // Rate-limit check is based on the sender (this mailbox owner).
      // We reject before constructing/persisting the message.
      throw new MailRateLimitedError(
        this.agentId,
        // Expose configured values via the limiter for better error messages.
        // Fall back to 0 if reflection is unavailable (never expected).
        (this.rateLimiter as unknown as { maxMessages?: number })
          .maxMessages ?? 0,
        (this.rateLimiter as unknown as { windowMs?: number }).windowMs ?? 0,
      )
    }

    const message: MailMessage = {
      id: randomUUID(),
      from: this.agentId,
      to,
      subject,
      body,
      createdAt: Date.now(),
    }

    await this.deliverWithRetry(message)

    if (this.eventBus) {
      this.eventBus.emit({
        type: 'mail:received',
        message: {
          id: message.id,
          from: message.from,
          to: message.to,
          subject: message.subject,
          body: message.body,
          createdAt: message.createdAt,
        },
      })
    }

    return message
  }

  async receive(query?: MailboxQuery): Promise<MailMessage[]> {
    return this.store.findByRecipient(this.agentId, query)
  }

  subscribe(handler: (message: MailMessage) => void | Promise<void>): () => void {
    if (!this.eventBus) {
      throw new Error('subscribe() requires an event bus')
    }

    return this.eventBus.on('mail:received', (event) => {
      if (event.message.to === this.agentId) {
        void handler(event.message as MailMessage)
      }
    })
  }

  async ack(messageId: string): Promise<void> {
    return this.store.markRead(messageId)
  }

  /**
   * Attempt to persist `message` up to `maxDeliveryAttempts` times.
   * On final failure, push to the DLQ (if configured) and rethrow.
   */
  private async deliverWithRetry(message: MailMessage): Promise<void> {
    let lastError: unknown
    for (let attempt = 1; attempt <= this.maxDeliveryAttempts; attempt++) {
      try {
        await this.store.save(message)
        return
      } catch (err) {
        lastError = err
      }
    }

    if (this.deadLetterStore) {
      await this.deadLetterStore.push(message, {
        attempts: this.maxDeliveryAttempts,
        lastError: extractErrorMessage(lastError),
        ts: Date.now(),
      })
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(extractErrorMessage(lastError))
  }
}

function normalizeOptions(
  input: DzupEventBus | AgentMailboxOptions | undefined,
): AgentMailboxOptions {
  if (input === undefined) return {}
  if (isEventBusLike(input)) {
    return { eventBus: input }
  }
  return input
}

function isEventBusLike(value: unknown): value is DzupEventBus {
  // DzupEventBus exposes `emit` and `on`; a plain options object won't.
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { emit?: unknown }).emit === 'function' &&
    typeof (value as { on?: unknown }).on === 'function'
  )
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
