/**
 * Dead-letter store for mail messages that failed delivery.
 *
 * When an outbound message fails to persist after the configured number of
 * retry attempts, it is pushed to a {@link DeadLetterStore} along with
 * metadata describing the failure. Operators can inspect or drain the DLQ
 * to diagnose delivery problems without losing the original payload.
 */
import type { MailMessage } from './types.js'

/** Metadata describing why a message ended up in the DLQ. */
export interface DeadLetterMeta {
  /** Total number of delivery attempts before the message was dead-lettered. */
  attempts: number
  /** Message from the final delivery error (if the error exposed one). */
  lastError: string
  /** Timestamp (epoch-ms) at which the message was dead-lettered. */
  ts: number
}

/** A message stored in the DLQ alongside failure metadata. */
export interface DeadLetter {
  message: MailMessage
  meta: DeadLetterMeta
}

/** Persistence interface for dead-lettered mail. */
export interface DeadLetterStore {
  /** Push a message plus failure metadata onto the DLQ. */
  push(message: MailMessage, meta: DeadLetterMeta): Promise<void>
  /** List all dead letters currently held. */
  list(): Promise<DeadLetter[]>
  /** Drop all dead letters. Returns the count removed. */
  clear(): Promise<number>
}

/** In-memory default implementation of {@link DeadLetterStore}. */
export class InMemoryDeadLetterStore implements DeadLetterStore {
  private readonly entries: DeadLetter[] = []

  async push(message: MailMessage, meta: DeadLetterMeta): Promise<void> {
    this.entries.push({ message, meta })
  }

  async list(): Promise<DeadLetter[]> {
    // Return a shallow copy so external mutations don't corrupt the store.
    return this.entries.map((entry) => ({
      message: entry.message,
      meta: { ...entry.meta },
    }))
  }

  async clear(): Promise<number> {
    const n = this.entries.length
    this.entries.length = 0
    return n
  }
}
