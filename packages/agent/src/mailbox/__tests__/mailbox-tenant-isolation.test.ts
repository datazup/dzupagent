import { describe, expect, it } from 'vitest'
import {
  createEventBus,
  type DzupEvent,
} from '@dzupagent/core'
import { installEventBus } from '../../agent/event-bus-installer.js'
import type { DzupAgentConfig } from '../../agent/agent-types.js'
import { AgentMailboxImpl } from '../agent-mailbox.js'
import { InMemoryMailboxStore } from '../in-memory-mailbox-store.js'
import type { MailMessage } from '../types.js'

class RecordingMailboxStore extends InMemoryMailboxStore {
  readonly savedMessages: MailMessage[] = []

  override async save(message: MailMessage): Promise<void> {
    this.savedMessages.push(message)
    await super.save(message)
  }
}

function scopedMailbox(
  agentId: string,
  tenantId: string,
  store: InMemoryMailboxStore,
  eventBus = createEventBus(),
): AgentMailboxImpl {
  return new AgentMailboxImpl(agentId, store, {
    eventBus,
    tenantScope: { mode: 'scoped', tenantId },
  })
}

describe('T2-6B mailbox facade tenant isolation', () => {
  it('stamps the exact tenant on the returned, stored, and emitted message', async () => {
    const store = new RecordingMailboxStore()
    const eventBus = createEventBus()
    const events: Array<Extract<DzupEvent, { type: 'mail:received' }>> = []
    eventBus.on('mail:received', (event) => events.push(event))
    const sender = scopedMailbox('shared-sender', '  tenant-a  ', store, eventBus)

    const sent = await sender.send('shared-recipient', 'shared-subject', {
      value: 'tenant-a',
    })

    expect(sent.tenantId).toBe('tenant-a')
    expect(store.savedMessages[0]?.tenantId).toBe('tenant-a')
    expect(events).toHaveLength(1)
    expect(events[0]?.message.tenantId).toBe('tenant-a')
  })

  it('keeps colliding sender and recipient IDs isolated on receive', async () => {
    const store = new InMemoryMailboxStore()
    const tenantA = scopedMailbox('shared-sender', 'tenant-a', store)
    const tenantB = scopedMailbox('shared-sender', 'tenant-b', store)
    const recipientA = scopedMailbox('shared-recipient', 'tenant-a', store)
    const recipientB = scopedMailbox('shared-recipient', 'tenant-b', store)

    await tenantA.send('shared-recipient', 'shared-subject', { owner: 'tenant-a' })
    await tenantB.send('shared-recipient', 'shared-subject', { owner: 'tenant-b' })

    await expect(recipientA.receive()).resolves.toMatchObject([
      { tenantId: 'tenant-a', body: { owner: 'tenant-a' } },
    ])
    await expect(recipientB.receive()).resolves.toMatchObject([
      { tenantId: 'tenant-b', body: { owner: 'tenant-b' } },
    ])
  })

  it('cannot acknowledge another tenant message by a known ID', async () => {
    const store = new InMemoryMailboxStore()
    const tenantBSender = scopedMailbox('shared-sender', 'tenant-b', store)
    const recipientA = scopedMailbox('shared-recipient', 'tenant-a', store)
    const recipientB = scopedMailbox('shared-recipient', 'tenant-b', store)
    const tenantBMessage = await tenantBSender.send(
      'shared-recipient',
      'shared-subject',
      { owner: 'tenant-b' },
    )

    await recipientA.ack(tenantBMessage.id)

    const tenantBInbox = await recipientB.receive({ unreadOnly: false })
    expect(tenantBInbox).toHaveLength(1)
    expect(tenantBInbox[0]?.id).toBe(tenantBMessage.id)
    expect(tenantBInbox[0]?.readAt).toBeUndefined()
  })

  it('filters subscriptions by both recipient and tenant', async () => {
    const store = new InMemoryMailboxStore()
    const eventBus = createEventBus()
    const recipientA = scopedMailbox(
      'shared-recipient',
      'tenant-a',
      store,
      eventBus,
    )
    const recipientB = scopedMailbox(
      'shared-recipient',
      'tenant-b',
      store,
      eventBus,
    )
    const senderB = scopedMailbox('shared-sender', 'tenant-b', store, eventBus)
    const receivedA: MailMessage[] = []
    const receivedB: MailMessage[] = []
    recipientA.subscribe((message) => receivedA.push(message))
    recipientB.subscribe((message) => receivedB.push(message))

    await senderB.send('shared-recipient', 'shared-subject', { owner: 'tenant-b' })

    expect(receivedA).toEqual([])
    expect(receivedB).toHaveLength(1)
    expect(receivedB[0]?.tenantId).toBe('tenant-b')
  })

  it('preserves same-tenant subscription delivery and unsubscribe behavior', async () => {
    const store = new InMemoryMailboxStore()
    const eventBus = createEventBus()
    const sender = scopedMailbox('shared-sender', 'tenant-a', store, eventBus)
    const recipient = scopedMailbox(
      'shared-recipient',
      'tenant-a',
      store,
      eventBus,
    )
    const received: MailMessage[] = []
    const unsubscribe = recipient.subscribe((message) => received.push(message))

    await sender.send('shared-recipient', 'first', { sequence: 1 })
    unsubscribe()
    await sender.send('shared-recipient', 'second', { sequence: 2 })

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ subject: 'first', tenantId: 'tenant-a' })
  })

  it('rejects a blank scoped tenant before store or event effects', () => {
    const store = new RecordingMailboxStore()
    const eventBus = createEventBus()
    const events: DzupEvent[] = []
    eventBus.onAny((event) => events.push(event))

    expect(
      () => new AgentMailboxImpl('shared-agent', store, {
        eventBus,
        tenantScope: { mode: 'scoped', tenantId: '   ' },
      }),
    ).toThrow(/tenantId.*non-empty/i)
    expect(store.savedMessages).toEqual([])
    expect(events).toEqual([])
  })

  it('keeps omitted and explicit legacy callers inside the default tenant', async () => {
    const store = new InMemoryMailboxStore()
    const eventBus = createEventBus()
    const sender = new AgentMailboxImpl('shared-sender', store, eventBus)
    const recipient = new AgentMailboxImpl('shared-recipient', store, {
      eventBus,
      tenantScope: { mode: 'legacy-default' },
    })

    const sent = await sender.send('shared-recipient', 'legacy', { owner: 'default' })

    expect(sent.tenantId).toBe('default')
    await expect(recipient.receive()).resolves.toMatchObject([
      { id: sent.id, tenantId: 'default' },
    ])
  })

  it('propagates DzupAgent mailbox tenant config into the installed facade', async () => {
    const store = new RecordingMailboxStore()
    const eventBus = createEventBus()
    const config = {
      id: 'configured-agent',
      instructions: 'mailbox tenant wiring test',
      model: 'test/model',
      mailbox: {
        store,
        eventBus,
        tenantScope: { mode: 'scoped', tenantId: 'tenant-a' },
      },
    } satisfies DzupAgentConfig

    const wiring = installEventBus(
      'shared-sender',
      config,
      undefined,
      () => 0,
    )
    const sent = await wiring.mailbox?.send(
      'shared-recipient',
      'configured',
      { owner: 'tenant-a' },
    )

    expect(sent?.tenantId).toBe('tenant-a')
    expect(store.savedMessages[0]?.tenantId).toBe('tenant-a')
  })
})
