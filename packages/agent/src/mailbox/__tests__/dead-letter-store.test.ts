/**
 * Tests for the DLQ integration on AgentMailboxImpl and the
 * {@link InMemoryDeadLetterStore} default implementation.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { AgentMailboxImpl } from '../agent-mailbox.js'
import { InMemoryDeadLetterStore } from '../dead-letter-store.js'
import type { MailboxStore, MailMessage, MailboxQuery } from '../types.js'

/** A store whose save() always throws, used to force DLQ pushes. */
function createFailingStore(errorMessage = 'boom'): MailboxStore & {
  attempts: number
} {
  let attempts = 0
  const api: MailboxStore & { attempts: number } = {
    get attempts() {
      return attempts
    },
    set attempts(v: number) {
      attempts = v
    },
    async save(_msg: MailMessage): Promise<void> {
      attempts++
      throw new Error(errorMessage)
    },
    async findByRecipient(
      _agentId: string,
      _query?: MailboxQuery,
    ): Promise<MailMessage[]> {
      return []
    },
    async markRead(_id: string): Promise<void> {},
    async deleteExpired(): Promise<number> {
      return 0
    },
  }
  return api
}

/**
 * Store that fails the first `failTimes` saves then succeeds thereafter.
 * Lets us test that successful retries never reach the DLQ.
 */
function createFlakyStore(failTimes: number): MailboxStore & {
  attempts: number
  saved: MailMessage[]
} {
  let attempts = 0
  const saved: MailMessage[] = []
  return {
    get attempts() {
      return attempts
    },
    set attempts(v: number) {
      attempts = v
    },
    saved,
    async save(msg: MailMessage): Promise<void> {
      attempts++
      if (attempts <= failTimes) {
        throw new Error(`transient-${attempts}`)
      }
      saved.push(msg)
    },
    async findByRecipient(): Promise<MailMessage[]> {
      return saved
    },
    async markRead(): Promise<void> {},
    async deleteExpired(): Promise<number> {
      return 0
    },
  }
}

describe('InMemoryDeadLetterStore', () => {
  it('list() returns empty initially', async () => {
    const dlq = new InMemoryDeadLetterStore()
    expect(await dlq.list()).toEqual([])
  })

  it('push() adds a dead letter with metadata', async () => {
    const dlq = new InMemoryDeadLetterStore()
    const msg: MailMessage = {
      id: 'm1',
      from: 'a',
      to: 'b',
      subject: 's',
      body: {},
      createdAt: 123,
    }
    await dlq.push(msg, { attempts: 3, lastError: 'fail', ts: 999 })

    const list = await dlq.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.message.id).toBe('m1')
    expect(list[0]!.meta.attempts).toBe(3)
    expect(list[0]!.meta.lastError).toBe('fail')
    expect(list[0]!.meta.ts).toBe(999)
  })

  it('clear() removes all dead letters and returns the count', async () => {
    const dlq = new InMemoryDeadLetterStore()
    await dlq.push(
      { id: '1', from: 'a', to: 'b', subject: 's', body: {}, createdAt: 1 },
      { attempts: 1, lastError: 'x', ts: 1 },
    )
    await dlq.push(
      { id: '2', from: 'a', to: 'b', subject: 's', body: {}, createdAt: 2 },
      { attempts: 1, lastError: 'y', ts: 2 },
    )
    const cleared = await dlq.clear()
    expect(cleared).toBe(2)
    expect(await dlq.list()).toHaveLength(0)
  })

  it('list() returns shallow copies so metadata cannot be mutated', async () => {
    const dlq = new InMemoryDeadLetterStore()
    await dlq.push(
      { id: '1', from: 'a', to: 'b', subject: 's', body: {}, createdAt: 1 },
      { attempts: 1, lastError: 'err', ts: 1 },
    )
    const list1 = await dlq.list()
    list1[0]!.meta.attempts = 999
    const list2 = await dlq.list()
    expect(list2[0]!.meta.attempts).toBe(1)
  })
})

describe('AgentMailboxImpl DLQ integration', () => {
  let dlq: InMemoryDeadLetterStore

  beforeEach(() => {
    dlq = new InMemoryDeadLetterStore()
  })

  it('moves a message to the DLQ after N failed delivery attempts', async () => {
    const store = createFailingStore('store-down')
    const mailbox = new AgentMailboxImpl('agent-a', store, {
      maxDeliveryAttempts: 3,
      deadLetterStore: dlq,
    })

    await expect(
      mailbox.send('agent-b', 'Subject', { hello: 1 }),
    ).rejects.toThrow('store-down')

    expect(store.attempts).toBe(3)
    const list = await dlq.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.message.to).toBe('agent-b')
    expect(list[0]!.meta.attempts).toBe(3)
    expect(list[0]!.meta.lastError).toBe('store-down')
    expect(typeof list[0]!.meta.ts).toBe('number')
  })

  it('honors a custom maxDeliveryAttempts value', async () => {
    const store = createFailingStore('nope')
    const mailbox = new AgentMailboxImpl('agent-a', store, {
      maxDeliveryAttempts: 5,
      deadLetterStore: dlq,
    })

    await expect(
      mailbox.send('agent-b', 'S', {}),
    ).rejects.toThrow('nope')

    expect(store.attempts).toBe(5)
    const list = await dlq.list()
    expect(list[0]!.meta.attempts).toBe(5)
  })

  it('succeeds without DLQ push when a retry ultimately lands', async () => {
    const store = createFlakyStore(2)
    const mailbox = new AgentMailboxImpl('agent-a', store, {
      maxDeliveryAttempts: 3,
      deadLetterStore: dlq,
    })

    const result = await mailbox.send('agent-b', 'S', { n: 1 })
    expect(result.id).toBeDefined()
    expect(store.attempts).toBe(3)
    expect(store.saved).toHaveLength(1)
    expect(await dlq.list()).toHaveLength(0)
  })

  it('rethrows even when no DLQ is configured', async () => {
    const store = createFailingStore('no-dlq')
    const mailbox = new AgentMailboxImpl('agent-a', store, {
      maxDeliveryAttempts: 2,
    })

    await expect(mailbox.send('b', 's', {})).rejects.toThrow('no-dlq')
  })

  it('rejects construction when maxDeliveryAttempts < 1', () => {
    const store = createFailingStore()
    expect(
      () =>
        new AgentMailboxImpl('a', store, {
          maxDeliveryAttempts: 0,
          deadLetterStore: dlq,
        }),
    ).toThrow(/maxDeliveryAttempts/)
  })
})
