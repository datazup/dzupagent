/**
 * DZUPAGENT-ERR-H-82: PostgresRunQueue outcome handling against a scripted
 * database double (no live PostgreSQL).
 *
 * - A `completed` write that fails after the processor succeeded must never
 *   re-queue the job (`status = 'pending'`).
 * - A claim-renewal error aborts the job with one structured warn log.
 * - A failing `handleFailure` is logged, not left as an unhandled rejection.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { secureLogger } from '@dzupagent/core/utils'
import { PostgresRunQueue } from '../queue/postgres-run-queue.js'

const dialect = new PgDialect()

type Kind = 'claim' | 'renew' | 'completed' | 'pending' | 'failed' | 'other'

function classify(text: string): Kind {
  if (text.includes("SET status = 'claimed'")) return 'claim'
  if (text.includes("SET status = 'completed'")) return 'completed'
  if (text.includes("SET status = 'pending'")) return 'pending'
  if (text.includes("SET status = 'failed'")) return 'failed'
  if (text.includes('SET claimed_at = now()')) return 'renew'
  return 'other'
}

const JOB_ROW = {
  id: 'job-1',
  run_id: 'run-1',
  agent_id: 'agent-1',
  input: {},
  metadata: null,
  tenant_id: 'default',
  priority: 0,
  attempts: 1,
  status: 'claimed',
  claimed_at: new Date(),
  claimed_by: 'w',
  error: null,
  created_at: new Date(),
  updated_at: new Date(),
}

function makeDb(handlers: Partial<Record<Kind, () => Promise<unknown>>>) {
  const calls: Kind[] = []
  let claimed = false
  const db = {
    async execute(statement: SQL): Promise<unknown> {
      const kind = classify(dialect.sqlToQuery(statement).sql)
      calls.push(kind)
      if (kind === 'claim') {
        if (claimed) return []
        claimed = true
        return [JOB_ROW]
      }
      const handler = handlers[kind]
      return handler ? handler() : []
    },
  }
  return { db, calls }
}

function makeQueue(db: { execute(statement: SQL): Promise<unknown> }, extra: Record<string, unknown> = {}) {
  return new PostgresRunQueue({
    db,
    workerId: 'w',
    pollIntervalMs: 0,
    concurrency: 1,
    fairScheduling: false,
    maxRetries: 3,
    ...extra,
  })
}

describe('PostgresRunQueue outcome handling (DZUPAGENT-ERR-H-82)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('never resets a succeeded job to pending when persisting completed fails', async () => {
    const warn = vi.spyOn(secureLogger, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(secureLogger, 'error').mockImplementation(() => undefined)
    const { db, calls } = makeDb({ completed: () => Promise.reject(new Error('connection reset')) })
    const queue = makeQueue(db)
    const processor = vi.fn(async () => undefined)
    queue.start(processor)

    await queue._poll()
    await queue.stop()

    expect(processor).toHaveBeenCalledOnce()
    expect(calls.filter((k) => k === 'completed')).toHaveLength(3)
    expect(calls).not.toContain('pending')
    expect(calls).not.toContain('failed')
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'run-queue.postgres.complete',
      jobId: 'job-1',
    }))
    expect(error).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'run-queue.postgres.settle',
      jobId: 'job-1',
      error: 'connection reset',
    }))
  })

  it('recovers when a completed write succeeds on retry', async () => {
    vi.spyOn(secureLogger, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(secureLogger, 'error').mockImplementation(() => undefined)
    let failures = 1
    const { db, calls } = makeDb({
      completed: () => (failures-- > 0 ? Promise.reject(new Error('blip')) : Promise.resolve([])),
    })
    const queue = makeQueue(db)
    queue.start(async () => undefined)

    await queue._poll()
    await queue.stop()

    expect(calls.filter((k) => k === 'completed')).toHaveLength(2)
    expect(calls).not.toContain('pending')
    expect(error).not.toHaveBeenCalled()
  })

  it('still re-queues a job whose processor failed', async () => {
    const { db, calls } = makeDb({})
    const queue = makeQueue(db)
    queue.start(async () => { throw new Error('processor failed') })

    await queue._poll()
    await queue.stop()

    expect(calls).toContain('pending')
    expect(calls).not.toContain('completed')
  })

  it('logs a renewal error once with the job id and aborts the job', async () => {
    const warn = vi.spyOn(secureLogger, 'warn').mockImplementation(() => undefined)
    const { db, calls } = makeDb({ renew: () => Promise.reject(new Error('db unreachable')) })
    const queue = makeQueue(db, { claimTimeoutMs: 30 })
    let aborted = false
    queue.start((_job, signal) => new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => {
        aborted = true
        resolve()
      }, { once: true })
    }))

    await queue._poll()
    await queue.stop()

    expect(aborted).toBe(true)
    const renewLogs = warn.mock.calls.filter(([entry]) =>
      typeof entry === 'object' && entry !== null
      && (entry as { operation?: string }).operation === 'run-queue.postgres.renew')
    expect(renewLogs).toHaveLength(1)
    expect(renewLogs[0]?.[0]).toMatchObject({
      jobId: 'job-1',
      runId: 'run-1',
      attempt: 1,
      errorClass: 'Error',
      error: 'db unreachable',
    })
    // Lost ownership: the stale worker writes no outcome.
    expect(calls).not.toContain('completed')
    expect(calls).not.toContain('pending')
  })

  it('logs a failing handleFailure instead of leaving an unhandled rejection', async () => {
    const error = vi.spyOn(secureLogger, 'error').mockImplementation(() => undefined)
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const { db } = makeDb({ pending: () => Promise.reject(new Error('db down')) })
      const queue = makeQueue(db)
      queue.start(async () => { throw new Error('processor failed') })

      await queue._poll()
      // Let the dispatch chain settle without stop() attaching a handler.
      await new Promise((resolve) => setTimeout(resolve, 20))
      await queue.stop()

      expect(unhandled).not.toHaveBeenCalled()
      expect(error).toHaveBeenCalledWith(expect.objectContaining({
        operation: 'run-queue.postgres.settle',
        jobId: 'job-1',
        error: 'db down',
      }))
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})
