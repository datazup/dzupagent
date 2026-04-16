/**
 * Integration test: two AgentMailboxImpl instances sharing one InMemoryMailboxStore.
 *
 * Validates the full send -> receive -> ack -> re-check flow between agents,
 * and the HTTP route layer if Hono is available.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import { InMemoryMailboxStore } from '../in-memory-mailbox-store.js'
import { AgentMailboxImpl } from '../agent-mailbox.js'
import type { MailMessage } from '../types.js'

describe('Mailbox integration', () => {
  let store: InMemoryMailboxStore
  let agentA: AgentMailboxImpl
  let agentB: AgentMailboxImpl

  beforeEach(() => {
    store = new InMemoryMailboxStore()
    const eventBus = createEventBus()
    agentA = new AgentMailboxImpl('agent-a', store, eventBus)
    agentB = new AgentMailboxImpl('agent-b', store, eventBus)
  })

  it('agent A sends a message that agent B receives', async () => {
    const sent = await agentA.send('agent-b', 'Task', { action: 'compile' })

    expect(sent.from).toBe('agent-a')
    expect(sent.to).toBe('agent-b')

    const inbox = await agentB.receive()
    expect(inbox).toHaveLength(1)
    expect(inbox[0]!.id).toBe(sent.id)
    expect(inbox[0]!.subject).toBe('Task')
    expect(inbox[0]!.body).toEqual({ action: 'compile' })
  })

  it('agent B acks the message, then re-check returns empty', async () => {
    const sent = await agentA.send('agent-b', 'Task', { action: 'compile' })

    // Agent B receives and acks
    const inbox = await agentB.receive()
    expect(inbox).toHaveLength(1)

    await agentB.ack(sent.id)

    // Default query is unreadOnly: true, so acked message is excluded
    const afterAck = await agentB.receive()
    expect(afterAck).toHaveLength(0)
  })

  it('agent B can still see acked messages with unreadOnly: false', async () => {
    const sent = await agentA.send('agent-b', 'Info', { data: 'report' })
    await agentB.ack(sent.id)

    const all = await agentB.receive({ unreadOnly: false })
    expect(all).toHaveLength(1)
    expect(all[0]!.readAt).toBeDefined()
  })

  it('messages from A to B are not visible to A', async () => {
    await agentA.send('agent-b', 'Only for B', { secret: true })

    const agentAInbox = await agentA.receive()
    expect(agentAInbox).toHaveLength(0)
  })

  it('subscribe notifies agent B in real time when A sends', async () => {
    const received: MailMessage[] = []
    agentB.subscribe((msg) => {
      received.push(msg)
    })

    await agentA.send('agent-b', 'Live', { ping: true })

    expect(received).toHaveLength(1)
    expect(received[0]!.subject).toBe('Live')
    expect(received[0]!.from).toBe('agent-a')
  })

  it('multiple messages maintain correct ordering', async () => {
    await agentA.send('agent-b', 'First', { order: 1 })
    await agentA.send('agent-b', 'Second', { order: 2 })
    await agentA.send('agent-b', 'Third', { order: 3 })

    const inbox = await agentB.receive()
    expect(inbox).toHaveLength(3)
    expect(inbox.map((m) => m.subject)).toEqual(['First', 'Second', 'Third'])
  })

  it('bidirectional conversation works', async () => {
    // A sends to B
    await agentA.send('agent-b', 'Request', { question: 'status?' })

    // B receives, then replies
    const bInbox = await agentB.receive()
    expect(bInbox).toHaveLength(1)

    await agentB.send('agent-a', 'Response', { answer: 'all good' })

    // A receives the reply
    const aInbox = await agentA.receive()
    expect(aInbox).toHaveLength(1)
    expect(aInbox[0]!.from).toBe('agent-b')
    expect(aInbox[0]!.body).toEqual({ answer: 'all good' })
  })

  it('TTL expiry works end-to-end', async () => {
    // Send a message with very short TTL that is already expired
    const msg: MailMessage = {
      id: 'ttl-msg',
      from: 'agent-a',
      to: 'agent-b',
      subject: 'Ephemeral',
      body: { temp: true },
      createdAt: Date.now() - 5000,
      ttl: 1, // 1 second TTL, but createdAt is 5 seconds ago
    }
    await store.save(msg)

    // deleteExpired should remove it before any read triggers lazy expiry
    const deleted = await store.deleteExpired()
    expect(deleted).toBe(1)

    // Agent B should not see the expired message
    const inbox = await agentB.receive()
    expect(inbox).toHaveLength(0)
  })
})
