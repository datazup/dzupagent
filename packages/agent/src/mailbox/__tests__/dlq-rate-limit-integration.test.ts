/**
 * Integration test: DLQ + rate-limit together on a single AgentMailboxImpl.
 *
 * Validates that the two guardrails compose cleanly:
 *   - Rate-limit short-circuits *before* delivery is attempted, so a rejected
 *     send never reaches the store and never lands in the DLQ.
 *   - A normal failing send still exhausts retries and ends up in the DLQ
 *     while also consuming rate-limit budget for the sender.
 */
import { describe, it, expect } from 'vitest'
import { AgentMailboxImpl } from '../agent-mailbox.js'
import { InMemoryDeadLetterStore } from '../dead-letter-store.js'
import { RateLimiter, MailRateLimitedError } from '../rate-limiter.js'
import type { MailboxStore, MailMessage, MailboxQuery } from '../types.js'

function createFailingStore(msg = 'down'): MailboxStore & { attempts: number } {
  let attempts = 0
  return {
    get attempts() {
      return attempts
    },
    set attempts(v: number) {
      attempts = v
    },
    async save(_m: MailMessage): Promise<void> {
      attempts++
      throw new Error(msg)
    },
    async findByRecipient(
      _a: string,
      _q?: MailboxQuery,
    ): Promise<MailMessage[]> {
      return []
    },
    async markRead(): Promise<void> {},
    async deleteExpired(): Promise<number> {
      return 0
    },
  }
}

describe('Mailbox DLQ + rate-limit integration', () => {
  it('rate-limit rejection does not touch the DLQ or the store', async () => {
    const store = createFailingStore()
    const dlq = new InMemoryDeadLetterStore()
    const limiter = new RateLimiter({ maxMessages: 1, windowMs: 1_000 })
    const mailbox = new AgentMailboxImpl('sender', store, {
      maxDeliveryAttempts: 3,
      deadLetterStore: dlq,
      rateLimiter: limiter,
    })

    // First call bypasses rate-limit, fails delivery -> lands in DLQ.
    await expect(mailbox.send('rcv', 'first', {})).rejects.toThrow('down')
    expect(store.attempts).toBe(3)
    expect(await dlq.list()).toHaveLength(1)

    // Second call is rejected by rate-limit *before* delivery.
    const storeAttemptsBefore = store.attempts
    await expect(mailbox.send('rcv', 'second', {})).rejects.toBeInstanceOf(
      MailRateLimitedError,
    )

    // Store was not called again; DLQ still has only one entry.
    expect(store.attempts).toBe(storeAttemptsBefore)
    expect(await dlq.list()).toHaveLength(1)
  })

  it('works with independent sender budgets each hitting their own DLQ entry', async () => {
    const store = createFailingStore('nope')
    const dlq = new InMemoryDeadLetterStore()
    const limiter = new RateLimiter({ maxMessages: 1, windowMs: 10_000 })

    const alice = new AgentMailboxImpl('alice', store, {
      maxDeliveryAttempts: 2,
      deadLetterStore: dlq,
      rateLimiter: limiter,
    })
    const bob = new AgentMailboxImpl('bob', store, {
      maxDeliveryAttempts: 2,
      deadLetterStore: dlq,
      rateLimiter: limiter,
    })

    // Each sender gets exactly one successful attempt through the limiter.
    await expect(alice.send('x', 's', {})).rejects.toThrow('nope')
    await expect(bob.send('x', 's', {})).rejects.toThrow('nope')

    // Alice and Bob each exhausted 2 retries -> 4 store attempts total.
    expect(store.attempts).toBe(4)

    const list = await dlq.list()
    expect(list).toHaveLength(2)
    const froms = list.map((e) => e.message.from).sort()
    expect(froms).toEqual(['alice', 'bob'])

    // Rate-limit applies afterwards.
    await expect(alice.send('x', 's', {})).rejects.toBeInstanceOf(
      MailRateLimitedError,
    )
    await expect(bob.send('x', 's', {})).rejects.toBeInstanceOf(
      MailRateLimitedError,
    )

    // No new DLQ entries from rate-limited sends.
    expect(await dlq.list()).toHaveLength(2)
  })
})
