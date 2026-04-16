/**
 * Drizzle-backed implementation of {@link MailboxStore} for persistent
 * inter-agent message storage.
 *
 * Messages are stored in the `agent_mailbox` table with epoch-ms timestamps.
 * TTL enforcement uses SQL filtering on read and a sweep query for
 * {@link deleteExpired}.
 */
import type { MailboxStore, MailMessage, MailboxQuery } from '@dzupagent/agent'
import { eq, and, gt, isNull, asc, sql } from 'drizzle-orm'
import { agentMailbox } from './drizzle-schema.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDrizzle = any

interface MailboxRow {
  id: string
  fromAgent: string
  toAgent: string
  subject: string
  body: Record<string, unknown>
  createdAt: number
  readAt: number | null
  ttlSeconds: number | null
}

function rowToMessage(row: MailboxRow): MailMessage {
  return {
    id: row.id,
    from: row.fromAgent,
    to: row.toAgent,
    subject: row.subject,
    body: row.body,
    createdAt: row.createdAt,
    readAt: row.readAt ?? undefined,
    ttl: row.ttlSeconds ?? undefined,
  }
}

export class DrizzleMailboxStore implements MailboxStore {
  constructor(private readonly db: AnyDrizzle) {}

  async save(message: MailMessage): Promise<void> {
    const id = message.id || crypto.randomUUID()
    await this.db.insert(agentMailbox).values({
      id,
      fromAgent: message.from,
      toAgent: message.to,
      subject: message.subject,
      body: message.body,
      createdAt: message.createdAt,
      readAt: message.readAt ?? null,
      ttlSeconds: message.ttl ?? null,
    })
  }

  async findByRecipient(
    agentId: string,
    query?: MailboxQuery,
  ): Promise<MailMessage[]> {
    const now = Date.now()
    const unreadOnly = query?.unreadOnly ?? true
    const limit = query?.limit ?? 10
    const since = query?.since

    const conditions = [
      eq(agentMailbox.toAgent, agentId),
      // Exclude expired: keep messages where ttl is null OR createdAt + ttl*1000 > now
      sql`(${agentMailbox.ttlSeconds} IS NULL OR ${agentMailbox.createdAt} + ${agentMailbox.ttlSeconds} * 1000 > ${now})`,
    ]

    if (unreadOnly) {
      conditions.push(isNull(agentMailbox.readAt))
    }

    if (since !== undefined) {
      conditions.push(gt(agentMailbox.createdAt, since))
    }

    const rows: MailboxRow[] = await this.db
      .select()
      .from(agentMailbox)
      .where(and(...conditions))
      .orderBy(asc(agentMailbox.createdAt))
      .limit(limit)

    return rows.map(rowToMessage)
  }

  async markRead(messageId: string): Promise<void> {
    await this.db
      .update(agentMailbox)
      .set({ readAt: Date.now() })
      .where(eq(agentMailbox.id, messageId))
  }

  async deleteExpired(): Promise<number> {
    const now = Date.now()
    const result = await this.db
      .delete(agentMailbox)
      .where(
        and(
          sql`${agentMailbox.ttlSeconds} IS NOT NULL`,
          sql`${agentMailbox.createdAt} + ${agentMailbox.ttlSeconds} * 1000 <= ${now}`,
        ),
      )

    // Drizzle returns { rowCount } for delete operations on pg
    return (result as { rowCount?: number }).rowCount ?? 0
  }
}
