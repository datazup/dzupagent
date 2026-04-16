/**
 * Mailbox types for inter-agent messaging.
 *
 * Provides the foundational interfaces for asynchronous message passing
 * between agents: mail messages, storage, queries, and per-agent mailboxes.
 */

/** A single message sent between agents. */
export interface MailMessage {
  /** Unique message identifier. */
  id: string
  /** Sender agent ID. */
  from: string
  /** Recipient agent ID. */
  to: string
  /** Human-readable subject line. */
  subject: string
  /** Arbitrary structured payload. */
  body: Record<string, unknown>
  /** Creation timestamp in epoch milliseconds. */
  createdAt: number
  /** Timestamp when the message was read (epoch ms), undefined if unread. */
  readAt?: number
  /** Time-to-live in seconds. `undefined` means the message never expires. */
  ttl?: number
}

/** Query parameters for retrieving messages from a mailbox. */
export interface MailboxQuery {
  /** Maximum number of messages to return. Defaults to 10. */
  limit?: number
  /** If true, only return unread messages. Defaults to true. */
  unreadOnly?: boolean
  /** Only return messages created after this epoch-ms timestamp. */
  since?: number
}

/**
 * Persistence layer for mail messages.
 *
 * Implementations include in-memory (W11-T12) and Drizzle-backed (W11-T15).
 */
export interface MailboxStore {
  /** Persist a message. */
  save(message: MailMessage): Promise<void>
  /** Retrieve messages addressed to `agentId`, filtered by `query`. */
  findByRecipient(agentId: string, query?: MailboxQuery): Promise<MailMessage[]>
  /** Mark a single message as read (sets `readAt`). */
  markRead(messageId: string): Promise<void>
  /** Delete messages whose TTL has expired. Returns the count of deleted messages. */
  deleteExpired(): Promise<number>
}

/**
 * Per-agent mailbox facade.
 *
 * Wraps a {@link MailboxStore} and scopes all operations to a single agent.
 */
export interface AgentMailbox {
  /** The agent ID this mailbox belongs to. */
  readonly agentId: string
  /** Send a message to another agent. Returns the created {@link MailMessage}. */
  send(to: string, subject: string, body: Record<string, unknown>): Promise<MailMessage>
  /** Receive messages addressed to this agent. */
  receive(query?: MailboxQuery): Promise<MailMessage[]>
  /**
   * Subscribe to incoming messages in real time.
   * @returns An unsubscribe function that removes the handler.
   */
  subscribe(handler: (message: MailMessage) => void | Promise<void>): () => void
  /** Acknowledge (mark as read) a message by ID. */
  ack(messageId: string): Promise<void>
}
