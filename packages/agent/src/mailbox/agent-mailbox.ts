/**
 * Concrete implementation of {@link AgentMailbox}.
 *
 * Wraps a {@link MailboxStore} and scopes all operations to a single agent.
 * Optionally integrates with {@link DzupEventBus} for real-time notifications.
 */
import { randomUUID } from 'node:crypto'
import type { DzupEventBus } from '@dzupagent/core'
import type { AgentMailbox, MailboxQuery, MailboxStore, MailMessage } from './types.js'

export class AgentMailboxImpl implements AgentMailbox {
  readonly agentId: string
  private readonly store: MailboxStore
  private readonly eventBus?: DzupEventBus

  constructor(agentId: string, store: MailboxStore, eventBus?: DzupEventBus) {
    this.agentId = agentId
    this.store = store
    this.eventBus = eventBus
  }

  async send(
    to: string,
    subject: string,
    body: Record<string, unknown>,
  ): Promise<MailMessage> {
    const message: MailMessage = {
      id: randomUUID(),
      from: this.agentId,
      to,
      subject,
      body,
      createdAt: Date.now(),
    }

    await this.store.save(message)

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
        handler(event.message as MailMessage)
      }
    })
  }

  async ack(messageId: string): Promise<void> {
    return this.store.markRead(messageId)
  }
}
