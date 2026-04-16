/**
 * In-memory implementation of {@link MailboxStore}.
 *
 * Uses a Map<agentId, MailMessage[]> for FIFO per-recipient queues.
 * TTL enforcement is lazy: expired messages are filtered out on read
 * and can be bulk-purged via {@link deleteExpired}.
 */
import { randomUUID } from 'node:crypto'
import type { MailMessage, MailboxQuery, MailboxStore } from './types.js'

function isExpired(msg: MailMessage, now: number): boolean {
  return msg.ttl !== undefined && now > msg.createdAt + msg.ttl * 1000
}

export class InMemoryMailboxStore implements MailboxStore {
  private readonly mailboxes = new Map<string, MailMessage[]>()

  async save(message: MailMessage): Promise<void> {
    if (!message.id) {
      message.id = randomUUID()
    }

    const queue = this.mailboxes.get(message.to)
    if (queue) {
      queue.push(message)
    } else {
      this.mailboxes.set(message.to, [message])
    }
  }

  async findByRecipient(
    agentId: string,
    query?: MailboxQuery,
  ): Promise<MailMessage[]> {
    const now = Date.now()
    const queue = this.mailboxes.get(agentId)
    if (!queue) return []

    const unreadOnly = query?.unreadOnly ?? true
    const limit = query?.limit ?? 10
    const since = query?.since

    // Filter out expired messages in-place (lazy expiry)
    for (let i = queue.length - 1; i >= 0; i--) {
      if (isExpired(queue[i]!, now)) {
        queue.splice(i, 1)
      }
    }

    const results: MailMessage[] = []
    for (const msg of queue) {
      if (unreadOnly && msg.readAt !== undefined) continue
      if (since !== undefined && msg.createdAt <= since) continue
      results.push(msg)
      if (results.length >= limit) break
    }

    return results
  }

  async markRead(messageId: string): Promise<void> {
    for (const queue of this.mailboxes.values()) {
      for (const msg of queue) {
        if (msg.id === messageId) {
          msg.readAt = Date.now()
          return
        }
      }
    }
  }

  async deleteExpired(): Promise<number> {
    const now = Date.now()
    let count = 0

    for (const [agentId, queue] of this.mailboxes) {
      const before = queue.length
      const filtered = queue.filter((msg) => !isExpired(msg, now))
      count += before - filtered.length
      if (filtered.length === 0) {
        this.mailboxes.delete(agentId)
      } else {
        this.mailboxes.set(agentId, filtered)
      }
    }

    return count
  }
}
