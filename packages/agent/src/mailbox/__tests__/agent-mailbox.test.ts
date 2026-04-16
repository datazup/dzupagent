/**
 * Unit tests for AgentMailboxImpl.
 *
 * Covers: send, receive, ack, subscribe, unsubscribe, and error cases.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createEventBus, type DzupEventBus } from '@dzupagent/core'
import { AgentMailboxImpl } from '../agent-mailbox.js'
import type { MailboxStore, MailMessage, MailboxQuery } from '../types.js'

/** Minimal mock MailboxStore for isolating AgentMailboxImpl behavior. */
function createMockStore(): MailboxStore & {
  savedMessages: MailMessage[]
  markedReadIds: string[]
} {
  const savedMessages: MailMessage[] = []
  const markedReadIds: string[] = []

  return {
    savedMessages,
    markedReadIds,
    async save(message: MailMessage): Promise<void> {
      savedMessages.push(message)
    },
    async findByRecipient(agentId: string, query?: MailboxQuery): Promise<MailMessage[]> {
      return savedMessages.filter((m) => m.to === agentId)
    },
    async markRead(messageId: string): Promise<void> {
      markedReadIds.push(messageId)
    },
    async deleteExpired(): Promise<number> {
      return 0
    },
  }
}

describe('AgentMailboxImpl', () => {
  let store: ReturnType<typeof createMockStore>
  let eventBus: DzupEventBus
  let mailbox: AgentMailboxImpl

  beforeEach(() => {
    store = createMockStore()
    eventBus = createEventBus()
    mailbox = new AgentMailboxImpl('agent-a', store, eventBus)
  })

  describe('send()', () => {
    it('creates a message with correct fields', async () => {
      const result = await mailbox.send('agent-b', 'Hello', { greeting: 'hi' })

      expect(result.from).toBe('agent-a')
      expect(result.to).toBe('agent-b')
      expect(result.subject).toBe('Hello')
      expect(result.body).toEqual({ greeting: 'hi' })
      expect(typeof result.createdAt).toBe('number')
    })

    it('returns the created message with an id', async () => {
      const result = await mailbox.send('agent-b', 'Test', { data: 1 })

      expect(result.id).toBeDefined()
      expect(typeof result.id).toBe('string')
      expect(result.id.length).toBeGreaterThan(0)
    })

    it('persists the message to the store', async () => {
      await mailbox.send('agent-b', 'Stored', { x: true })

      expect(store.savedMessages).toHaveLength(1)
      expect(store.savedMessages[0]!.subject).toBe('Stored')
    })

    it('emits a mail:received event on the event bus', async () => {
      const events: unknown[] = []
      eventBus.on('mail:received', (e) => events.push(e))

      await mailbox.send('agent-b', 'Event Test', { payload: 42 })

      expect(events).toHaveLength(1)
      const evt = events[0] as { type: string; message: { to: string; subject: string } }
      expect(evt.type).toBe('mail:received')
      expect(evt.message.to).toBe('agent-b')
      expect(evt.message.subject).toBe('Event Test')
    })
  })

  describe('receive()', () => {
    it('returns messages for this agent', async () => {
      // Pre-populate store with a message addressed to agent-a
      store.savedMessages.push({
        id: 'msg-1',
        from: 'agent-b',
        to: 'agent-a',
        subject: 'Reply',
        body: { info: 'data' },
        createdAt: Date.now(),
      })

      const results = await mailbox.receive()
      expect(results).toHaveLength(1)
      expect(results[0]!.id).toBe('msg-1')
    })

    it('passes query through to store', async () => {
      const findSpy = vi.spyOn(store, 'findByRecipient')
      const query: MailboxQuery = { limit: 5, unreadOnly: false, since: 1000 }

      await mailbox.receive(query)

      expect(findSpy).toHaveBeenCalledWith('agent-a', query)
    })
  })

  describe('ack()', () => {
    it('calls markRead on the store', async () => {
      await mailbox.ack('msg-42')

      expect(store.markedReadIds).toContain('msg-42')
    })
  })

  describe('subscribe()', () => {
    it('throws if no event bus was provided', () => {
      const noBusMailbox = new AgentMailboxImpl('agent-a', store)

      expect(() => noBusMailbox.subscribe(() => {})).toThrow(
        'subscribe() requires an event bus',
      )
    })

    it('receives events emitted via event bus for this agent', async () => {
      const received: MailMessage[] = []
      mailbox.subscribe((msg) => {
        received.push(msg)
      })

      // Simulate an incoming mail event for agent-a
      eventBus.emit({
        type: 'mail:received',
        message: {
          id: 'msg-99',
          from: 'agent-c',
          to: 'agent-a',
          subject: 'Subscribed',
          body: { test: true },
          createdAt: Date.now(),
        },
      })

      // Event bus handlers run synchronously in this implementation
      expect(received).toHaveLength(1)
      expect(received[0]!.id).toBe('msg-99')
      expect(received[0]!.subject).toBe('Subscribed')
    })

    it('does not receive events addressed to other agents', () => {
      const received: MailMessage[] = []
      mailbox.subscribe((msg) => {
        received.push(msg)
      })

      eventBus.emit({
        type: 'mail:received',
        message: {
          id: 'msg-other',
          from: 'agent-c',
          to: 'agent-x',
          subject: 'Not for me',
          body: {},
          createdAt: Date.now(),
        },
      })

      expect(received).toHaveLength(0)
    })

    it('unsubscribe function stops receiving events', () => {
      const received: MailMessage[] = []
      const unsub = mailbox.subscribe((msg) => {
        received.push(msg)
      })

      // First event should be received
      eventBus.emit({
        type: 'mail:received',
        message: {
          id: 'msg-before',
          from: 'agent-c',
          to: 'agent-a',
          subject: 'Before unsub',
          body: {},
          createdAt: Date.now(),
        },
      })
      expect(received).toHaveLength(1)

      // Unsubscribe
      unsub()

      // Second event should NOT be received
      eventBus.emit({
        type: 'mail:received',
        message: {
          id: 'msg-after',
          from: 'agent-c',
          to: 'agent-a',
          subject: 'After unsub',
          body: {},
          createdAt: Date.now(),
        },
      })
      expect(received).toHaveLength(1)
    })
  })
})
