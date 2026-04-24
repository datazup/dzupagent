import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  ApprovalGate,
  ApprovalRejectedError,
  ApprovalTimeoutError,
  DuplicateApprovalError,
  InMemoryApprovalStateStore,
  PostgresApprovalStateStore,
  UnknownApprovalError,
  type ApprovalOutcome,
  type ApprovalStateStore,
  type SqlClient,
} from '../index.js'

describe('InMemoryApprovalStateStore', () => {
  let store: InMemoryApprovalStateStore

  beforeEach(() => {
    store = new InMemoryApprovalStateStore()
  })

  afterEach(() => {
    store.clear()
  })

  it('resolves poll() with { granted } after grant() is called', async () => {
    await store.createPending('run-1', 'ap-1', { question: 'ok?' })
    const pollPromise = store.poll('run-1', 'ap-1', 5_000)
    await store.grant('run-1', 'ap-1', { approvedBy: 'alice' })
    const outcome = await pollPromise
    expect(outcome).toEqual({ decision: 'granted', response: { approvedBy: 'alice' } })
  })

  it('resolves poll() with { rejected, reason } after reject()', async () => {
    await store.createPending('run-1', 'ap-1', null)
    const pollPromise = store.poll('run-1', 'ap-1', 5_000)
    await store.reject('run-1', 'ap-1', 'policy violation')
    const outcome = await pollPromise
    expect(outcome).toEqual({ decision: 'rejected', reason: 'policy violation' })
  })

  it('returns the cached outcome when poll() is called after grant()', async () => {
    await store.createPending('run-1', 'ap-1', null)
    await store.grant('run-1', 'ap-1', 42)
    const outcome = await store.poll('run-1', 'ap-1', 1_000)
    expect(outcome).toEqual({ decision: 'granted', response: 42 })
  })

  it('rejects poll() with ApprovalTimeoutError after timeoutMs', async () => {
    await store.createPending('run-1', 'ap-1', null)
    await expect(store.poll('run-1', 'ap-1', 20)).rejects.toBeInstanceOf(ApprovalTimeoutError)
  })

  it('throws DuplicateApprovalError when createPending is called twice', async () => {
    await store.createPending('run-1', 'ap-1', null)
    await expect(store.createPending('run-1', 'ap-1', null)).rejects.toBeInstanceOf(
      DuplicateApprovalError,
    )
  })

  it('throws UnknownApprovalError when grant targets an unknown key', async () => {
    await expect(store.grant('run-missing', 'ap-missing')).rejects.toBeInstanceOf(
      UnknownApprovalError,
    )
  })

  it('supports concurrent pollers receiving the same outcome', async () => {
    await store.createPending('run-1', 'ap-1', null)
    const a = store.poll('run-1', 'ap-1', 5_000)
    const b = store.poll('run-1', 'ap-1', 5_000)
    await store.grant('run-1', 'ap-1', 'ok')
    const [oa, ob] = await Promise.all([a, b])
    expect(oa).toEqual({ decision: 'granted', response: 'ok' })
    expect(ob).toEqual(oa)
  })

  it('preserves the payload for later inspection', async () => {
    await store.createPending('run-1', 'ap-1', { question: 'deploy?' })
    expect(store.getPayload('run-1', 'ap-1')).toEqual({ question: 'deploy?' })
  })
})

describe('ApprovalGate', () => {
  it('delegates waitForApproval to the configured store', async () => {
    const store = new InMemoryApprovalStateStore()
    const gate = new ApprovalGate({ store })

    const waitPromise = gate.waitForApproval('run-1', 'ap-1', { plan: 'x' }, 5_000)
    // The gate must have registered the pending request synchronously-ish.
    // Give one microtask for createPending to land.
    await Promise.resolve()
    await gate.grant('run-1', 'ap-1', 'yes')
    await expect(waitPromise).resolves.toEqual({ decision: 'granted', response: 'yes' })
  })

  it('uses defaultTimeoutMs when the per-call timeout is omitted', async () => {
    const store = new InMemoryApprovalStateStore()
    const gate = new ApprovalGate({ store, defaultTimeoutMs: 15 })
    await expect(gate.waitForApproval('run-1', 'ap-1', null)).rejects.toBeInstanceOf(
      ApprovalTimeoutError,
    )
  })

  it('constructs with an in-memory store by default', async () => {
    const gate = new ApprovalGate()
    expect(gate.store).toBeInstanceOf(InMemoryApprovalStateStore)
  })

  it('calls store.grant / store.reject from its matching methods', async () => {
    const fake: ApprovalStateStore = {
      createPending: vi.fn(async () => undefined),
      grant: vi.fn(async () => undefined),
      reject: vi.fn(async () => undefined),
      poll: vi.fn(async (): Promise<ApprovalOutcome> => ({ decision: 'granted' })),
    }
    const gate = new ApprovalGate({ store: fake })
    await gate.grant('r', 'a', { x: 1 })
    await gate.reject('r', 'a', 'no')
    expect(fake.grant).toHaveBeenCalledWith('r', 'a', { x: 1 })
    expect(fake.reject).toHaveBeenCalledWith('r', 'a', 'no')
  })

  it('ApprovalRejectedError has the expected shape', () => {
    const err = new ApprovalRejectedError('run-1', 'ap-1', 'nope')
    expect(err.name).toBe('ApprovalRejectedError')
    expect(err.runId).toBe('run-1')
    expect(err.approvalId).toBe('ap-1')
    expect(err.message).toBe('nope')
  })
})

// ---------------------------------------------------------------------------
// PostgresApprovalStateStore — uses a mock SqlClient so no real DB is needed
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory simulator of the approval_requests table. Implements
 * just enough SQL-shape matching to exercise the store's logic.
 */
class FakeSqlClient implements SqlClient {
  rows = new Map<string, {
    runId: string
    approvalId: string
    status: 'pending' | 'granted' | 'rejected'
    payload: unknown
    response: unknown
    reason: string | null
  }>()

  private key(runId: string, approvalId: string) {
    return `${runId}::${approvalId}`
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: T[] }> {
    const [a, b, c] = params
    if (sql.startsWith('INSERT INTO')) {
      const k = this.key(a as string, b as string)
      if (this.rows.has(k)) return { rows: [] as T[] }
      this.rows.set(k, {
        runId: a as string,
        approvalId: b as string,
        status: 'pending',
        payload: JSON.parse(c as string),
        response: null,
        reason: null,
      })
      return { rows: [{ '?column?': 1 } as unknown as T] }
    }
    if (sql.includes("status = 'granted'") && sql.startsWith('UPDATE')) {
      const k = this.key(a as string, b as string)
      const row = this.rows.get(k)
      if (!row || row.status !== 'pending') return { rows: [] }
      row.status = 'granted'
      row.response = JSON.parse(c as string)
      return { rows: [{ '?column?': 1 } as unknown as T] }
    }
    if (sql.includes("status = 'rejected'") && sql.startsWith('UPDATE')) {
      const k = this.key(a as string, b as string)
      const row = this.rows.get(k)
      if (!row || row.status !== 'pending') return { rows: [] }
      row.status = 'rejected'
      row.reason = c as string
      return { rows: [{ '?column?': 1 } as unknown as T] }
    }
    if (sql.startsWith('SELECT status')) {
      const k = this.key(a as string, b as string)
      const row = this.rows.get(k)
      if (!row) return { rows: [] }
      return {
        rows: [
          { status: row.status, response: row.response, reason: row.reason } as unknown as T,
        ],
      }
    }
    throw new Error(`Unsupported SQL in FakeSqlClient: ${sql}`)
  }
}

describe('PostgresApprovalStateStore', () => {
  it('grant() resolves a poll() that started first (simulated DB)', async () => {
    const client = new FakeSqlClient()
    const store = new PostgresApprovalStateStore(client, { pollIntervalMs: 10 })
    await store.createPending('run-1', 'ap-1', { q: 'go?' })

    const pollPromise = store.poll('run-1', 'ap-1', 2_000)
    // Fire the grant shortly after so the poll loop sees the transition.
    setTimeout(() => {
      void store.grant('run-1', 'ap-1', { by: 'alice' })
    }, 30)
    await expect(pollPromise).resolves.toEqual({
      decision: 'granted',
      response: { by: 'alice' },
    })
  })

  it('reject() surfaces the reason through poll()', async () => {
    const client = new FakeSqlClient()
    const store = new PostgresApprovalStateStore(client, { pollIntervalMs: 10 })
    await store.createPending('run-1', 'ap-1', null)
    const pollPromise = store.poll('run-1', 'ap-1', 2_000)
    setTimeout(() => {
      void store.reject('run-1', 'ap-1', 'not safe')
    }, 30)
    await expect(pollPromise).resolves.toEqual({ decision: 'rejected', reason: 'not safe' })
  })

  it('poll() times out with ApprovalTimeoutError', async () => {
    const client = new FakeSqlClient()
    const store = new PostgresApprovalStateStore(client, { pollIntervalMs: 10 })
    await store.createPending('run-1', 'ap-1', null)
    await expect(store.poll('run-1', 'ap-1', 40)).rejects.toBeInstanceOf(ApprovalTimeoutError)
  })

  it('createPending on a duplicate throws DuplicateApprovalError', async () => {
    const client = new FakeSqlClient()
    const store = new PostgresApprovalStateStore(client)
    await store.createPending('run-1', 'ap-1', null)
    await expect(store.createPending('run-1', 'ap-1', null)).rejects.toBeInstanceOf(
      DuplicateApprovalError,
    )
  })

  it('grant on an unknown key throws UnknownApprovalError', async () => {
    const client = new FakeSqlClient()
    const store = new PostgresApprovalStateStore(client)
    await expect(store.grant('no-such', 'nope')).rejects.toBeInstanceOf(UnknownApprovalError)
  })
})
