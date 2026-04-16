/**
 * Unit tests for InMemoryMailboxStore.
 *
 * Covers: save, findByRecipient (FIFO, limit, unreadOnly, since, TTL),
 * markRead, deleteExpired, and empty-mailbox edge case.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { InMemoryMailboxStore } from '../in-memory-mailbox-store.js'
import type { MailMessage } from '../types.js'

function makeMessage(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: overrides.id ?? `msg-${Math.random().toString(36).slice(2, 8)}`,
    from: overrides.from ?? 'sender',
    to: overrides.to ?? 'recipient',
    subject: overrides.subject ?? 'test subject',
    body: overrides.body ?? { data: 'hello' },
    createdAt: overrides.createdAt ?? Date.now(),
    readAt: overrides.readAt,
    ttl: overrides.ttl,
  }
}

describe('InMemoryMailboxStore', () => {
  let store: InMemoryMailboxStore

  beforeEach(() => {
    store = new InMemoryMailboxStore()
  })

  describe('save() and findByRecipient()', () => {
    it('stores a message and retrieves it by recipient', async () => {
      const msg = makeMessage({ id: 'msg-1', to: 'agent-b' })
      await store.save(msg)

      const results = await store.findByRecipient('agent-b')
      expect(results).toHaveLength(1)
      expect(results[0]!.id).toBe('msg-1')
      expect(results[0]!.subject).toBe('test subject')
    })

    it('returns messages in FIFO order', async () => {
      const msg1 = makeMessage({ id: 'first', to: 'agent-b', createdAt: 1000 })
      const msg2 = makeMessage({ id: 'second', to: 'agent-b', createdAt: 2000 })
      const msg3 = makeMessage({ id: 'third', to: 'agent-b', createdAt: 3000 })

      await store.save(msg1)
      await store.save(msg2)
      await store.save(msg3)

      const results = await store.findByRecipient('agent-b')
      expect(results.map((m) => m.id)).toEqual(['first', 'second', 'third'])
    })

    it('respects limit parameter (default 10)', async () => {
      // Insert 15 messages
      for (let i = 0; i < 15; i++) {
        await store.save(makeMessage({ id: `msg-${i}`, to: 'agent-b', createdAt: i }))
      }

      // Default limit = 10
      const defaultResults = await store.findByRecipient('agent-b')
      expect(defaultResults).toHaveLength(10)

      // Explicit limit = 3
      const limited = await store.findByRecipient('agent-b', { limit: 3 })
      expect(limited).toHaveLength(3)
    })

    it('filters unread only by default (unreadOnly: true)', async () => {
      const unread = makeMessage({ id: 'unread-1', to: 'agent-b' })
      const read = makeMessage({ id: 'read-1', to: 'agent-b', readAt: Date.now() })

      await store.save(unread)
      await store.save(read)

      const results = await store.findByRecipient('agent-b')
      expect(results).toHaveLength(1)
      expect(results[0]!.id).toBe('unread-1')
    })

    it('returns all messages when unreadOnly is false', async () => {
      const unread = makeMessage({ id: 'unread-1', to: 'agent-b' })
      const read = makeMessage({ id: 'read-1', to: 'agent-b', readAt: Date.now() })

      await store.save(unread)
      await store.save(read)

      const results = await store.findByRecipient('agent-b', { unreadOnly: false })
      expect(results).toHaveLength(2)
    })

    it('respects since filter', async () => {
      const old = makeMessage({ id: 'old', to: 'agent-b', createdAt: 1000 })
      const recent = makeMessage({ id: 'recent', to: 'agent-b', createdAt: 5000 })

      await store.save(old)
      await store.save(recent)

      const results = await store.findByRecipient('agent-b', { since: 2000 })
      expect(results).toHaveLength(1)
      expect(results[0]!.id).toBe('recent')
    })
  })

  describe('TTL expiry', () => {
    it('filters out expired messages on read', async () => {
      const now = Date.now()
      // TTL of 1 second, created 2 seconds ago => expired
      const expired = makeMessage({
        id: 'expired',
        to: 'agent-b',
        createdAt: now - 2000,
        ttl: 1,
      })
      // TTL of 60 seconds, created just now => still valid
      const valid = makeMessage({
        id: 'valid',
        to: 'agent-b',
        createdAt: now,
        ttl: 60,
      })

      await store.save(expired)
      await store.save(valid)

      const results = await store.findByRecipient('agent-b')
      expect(results).toHaveLength(1)
      expect(results[0]!.id).toBe('valid')
    })
  })

  describe('markRead()', () => {
    it('sets readAt on the message', async () => {
      const msg = makeMessage({ id: 'msg-1', to: 'agent-b' })
      await store.save(msg)

      expect(msg.readAt).toBeUndefined()

      await store.markRead('msg-1')

      // After marking read, unreadOnly query should exclude it
      const unread = await store.findByRecipient('agent-b')
      expect(unread).toHaveLength(0)

      // But unreadOnly: false should still include it with readAt set
      const all = await store.findByRecipient('agent-b', { unreadOnly: false })
      expect(all).toHaveLength(1)
      expect(all[0]!.readAt).toBeDefined()
      expect(typeof all[0]!.readAt).toBe('number')
    })
  })

  describe('deleteExpired()', () => {
    it('removes expired messages and returns count', async () => {
      const now = Date.now()
      const expired1 = makeMessage({
        id: 'exp-1',
        to: 'agent-b',
        createdAt: now - 5000,
        ttl: 1,
      })
      const expired2 = makeMessage({
        id: 'exp-2',
        to: 'agent-b',
        createdAt: now - 5000,
        ttl: 2,
      })
      const valid = makeMessage({
        id: 'valid',
        to: 'agent-b',
        createdAt: now,
        ttl: 3600,
      })

      await store.save(expired1)
      await store.save(expired2)
      await store.save(valid)

      const count = await store.deleteExpired()
      expect(count).toBe(2)

      // Only valid message remains
      const remaining = await store.findByRecipient('agent-b')
      expect(remaining).toHaveLength(1)
      expect(remaining[0]!.id).toBe('valid')
    })
  })

  describe('empty mailbox', () => {
    it('returns empty array for unknown agent', async () => {
      const results = await store.findByRecipient('nonexistent-agent')
      expect(results).toEqual([])
    })
  })

  describe('save() auto-assigns id', () => {
    it('assigns an id if message has no id', async () => {
      const msg = makeMessage({ to: 'agent-b' })
      msg.id = ''

      await store.save(msg)

      const results = await store.findByRecipient('agent-b')
      expect(results).toHaveLength(1)
      expect(results[0]!.id).toBeTruthy()
    })
  })
})
