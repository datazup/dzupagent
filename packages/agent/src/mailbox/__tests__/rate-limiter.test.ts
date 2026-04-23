/**
 * Tests for the sliding-window {@link RateLimiter} and its integration
 * into {@link AgentMailboxImpl.send()}.
 */
import { describe, it, expect } from 'vitest'
import { AgentMailboxImpl } from '../agent-mailbox.js'
import { InMemoryMailboxStore } from '../in-memory-mailbox-store.js'
import {
  RateLimiter,
  MailRateLimitedError,
  DEFAULT_RATE_LIMIT,
} from '../rate-limiter.js'

describe('RateLimiter', () => {
  it('uses documented defaults when no config is supplied', () => {
    const limiter = new RateLimiter()
    // Allow up to 10 calls for the same sender.
    for (let i = 0; i < DEFAULT_RATE_LIMIT.maxMessages; i++) {
      expect(limiter.isAllowed('s1')).toBe(true)
    }
    expect(limiter.isAllowed('s1')).toBe(false)
  })

  it('allows up to M messages and rejects M+1 inside the window', () => {
    const limiter = new RateLimiter({ maxMessages: 3, windowMs: 1000 })

    expect(limiter.isAllowed('alice')).toBe(true)
    expect(limiter.isAllowed('alice')).toBe(true)
    expect(limiter.isAllowed('alice')).toBe(true)
    expect(limiter.isAllowed('alice')).toBe(false)
  })

  it('tracks senders independently', () => {
    const limiter = new RateLimiter({ maxMessages: 2, windowMs: 1000 })

    expect(limiter.isAllowed('alice')).toBe(true)
    expect(limiter.isAllowed('alice')).toBe(true)
    expect(limiter.isAllowed('alice')).toBe(false)

    // Bob has his own budget.
    expect(limiter.isAllowed('bob')).toBe(true)
    expect(limiter.isAllowed('bob')).toBe(true)
    expect(limiter.isAllowed('bob')).toBe(false)
  })

  it('allows new calls after the window slides forward', () => {
    let now = 1_000_000
    const limiter = new RateLimiter({
      maxMessages: 2,
      windowMs: 500,
      now: () => now,
    })

    expect(limiter.isAllowed('s')).toBe(true) // t=0
    expect(limiter.isAllowed('s')).toBe(true) // t=0
    expect(limiter.isAllowed('s')).toBe(false)

    // Advance past the window — earlier timestamps expire.
    now += 501
    expect(limiter.isAllowed('s')).toBe(true)
    expect(limiter.isAllowed('s')).toBe(true)
    expect(limiter.isAllowed('s')).toBe(false)
  })

  it('currentCount reflects only in-window timestamps', () => {
    let now = 0
    const limiter = new RateLimiter({
      maxMessages: 5,
      windowMs: 100,
      now: () => now,
    })
    limiter.isAllowed('x')
    limiter.isAllowed('x')
    expect(limiter.currentCount('x')).toBe(2)
    now += 101
    expect(limiter.currentCount('x')).toBe(0)
  })

  it('reset() clears tracking for a single sender', () => {
    const limiter = new RateLimiter({ maxMessages: 1, windowMs: 10_000 })
    expect(limiter.isAllowed('a')).toBe(true)
    expect(limiter.isAllowed('a')).toBe(false)
    limiter.reset('a')
    expect(limiter.isAllowed('a')).toBe(true)
  })

  it('reset() with no arg clears every sender', () => {
    const limiter = new RateLimiter({ maxMessages: 1, windowMs: 10_000 })
    limiter.isAllowed('a')
    limiter.isAllowed('b')
    limiter.reset()
    expect(limiter.isAllowed('a')).toBe(true)
    expect(limiter.isAllowed('b')).toBe(true)
  })

  it('rejects invalid config', () => {
    expect(() => new RateLimiter({ maxMessages: 0, windowMs: 1 })).toThrow()
    expect(() => new RateLimiter({ maxMessages: 1, windowMs: 0 })).toThrow()
  })
})

describe('AgentMailboxImpl rate-limit integration', () => {
  it('allows up to M messages then throws MailRateLimitedError on M+1', async () => {
    const store = new InMemoryMailboxStore()
    const limiter = new RateLimiter({ maxMessages: 2, windowMs: 1_000 })
    const mailbox = new AgentMailboxImpl('sender', store, {
      rateLimiter: limiter,
    })

    await mailbox.send('rcv', 's', { n: 1 })
    await mailbox.send('rcv', 's', { n: 2 })

    await expect(
      mailbox.send('rcv', 's', { n: 3 }),
    ).rejects.toBeInstanceOf(MailRateLimitedError)
  })

  it('exposes sender id and window config on the error', async () => {
    const store = new InMemoryMailboxStore()
    const limiter = new RateLimiter({ maxMessages: 1, windowMs: 500 })
    const mailbox = new AgentMailboxImpl('agent-x', store, {
      rateLimiter: limiter,
    })

    await mailbox.send('r', 's', {})
    try {
      await mailbox.send('r', 's', {})
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(MailRateLimitedError)
      const e = err as MailRateLimitedError
      expect(e.senderId).toBe('agent-x')
      expect(e.maxMessages).toBe(1)
      expect(e.windowMs).toBe(500)
    }
  })

  it('does not persist the message when rate-limited', async () => {
    const store = new InMemoryMailboxStore()
    const limiter = new RateLimiter({ maxMessages: 1, windowMs: 1_000 })
    const sender = new AgentMailboxImpl('s', store, { rateLimiter: limiter })
    // Receiver doesn't need the rate limiter.
    const receiver = new AgentMailboxImpl('rcv', store)

    await sender.send('rcv', 'ok', {})
    await expect(sender.send('rcv', 'rejected', {})).rejects.toThrow(
      MailRateLimitedError,
    )

    const inbox = await receiver.receive()
    expect(inbox).toHaveLength(1)
    expect(inbox[0]!.subject).toBe('ok')
  })
})
