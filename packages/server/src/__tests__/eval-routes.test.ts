import { describe, it, expect } from 'vitest'
import { waitForCondition } from '@dzupagent/test-utils'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  MetricsCollector,
  createEventBus,
} from '@dzupagent/core'
import type { EvalScorer, EvalSuite } from '@dzupagent/eval-contracts'
import {
  InMemoryEvalRunStore,
  type EvalRunExecutionOwnershipRecord,
  type EvalRunAttemptRecord,
  type EvalRunRecord,
  type EvalRunStore,
} from '../persistence/eval-run-store.js'

function createReadOnlyConfig(): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    evals: {
      allowReadOnlyMode: true,
      suites: {
        'toy-suite': toySuite,
      },
    },
  }
}

function createActiveConfig(
  executeTarget: (input: string, context?: { signal: AbortSignal }) => Promise<string> | string = async (input) => input.toUpperCase(),
  metrics?: MetricsCollector,
): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    ...(metrics ? { metrics } : {}),
    evals: {
      suites: {
        'toy-suite': toySuite,
      },
      executeTarget,
    },
  }
}

function buildEvalRun(overrides: Partial<EvalRunRecord> & Pick<EvalRunRecord, 'id' | 'status'>): EvalRunRecord {
  const timestamp = overrides.createdAt ?? '2026-03-31T00:00:00.000Z'
  const attemptHistory: EvalRunAttemptRecord[] = overrides.attemptHistory ?? [{
    attempt: Math.max(1, overrides.attempts ?? 1),
    status: overrides.status,
    queuedAt: overrides.queuedAt ?? timestamp,
    ...(overrides.startedAt !== undefined ? { startedAt: overrides.startedAt } : {}),
    ...(overrides.completedAt !== undefined ? { completedAt: overrides.completedAt } : {}),
    ...(overrides.result !== undefined ? { result: overrides.result } : {}),
    ...(overrides.error !== undefined ? { error: overrides.error } : {}),
    ...(overrides.recovery !== undefined ? { recovery: overrides.recovery } : {}),
  }]

  return {
    id: overrides.id,
    suiteId: overrides.suiteId ?? toySuite.name,
    suite: overrides.suite ?? toySuite,
    status: overrides.status,
    createdAt: timestamp,
    queuedAt: overrides.queuedAt ?? timestamp,
    attempts: overrides.attempts ?? attemptHistory.length,
    attemptHistory,
    ...(overrides.startedAt !== undefined ? { startedAt: overrides.startedAt } : {}),
    ...(overrides.completedAt !== undefined ? { completedAt: overrides.completedAt } : {}),
    ...(overrides.result !== undefined ? { result: overrides.result } : {}),
    ...(overrides.error !== undefined ? { error: overrides.error } : {}),
    ...(overrides.recovery !== undefined ? { recovery: overrides.recovery } : {}),
    ...(overrides.executionOwner !== undefined ? { executionOwner: overrides.executionOwner } : {}),
    ...(overrides.metadata !== undefined ? { metadata: overrides.metadata } : {}),
  }
}

function cloneRun(run: EvalRunRecord): EvalRunRecord {
  return JSON.parse(JSON.stringify(run)) as EvalRunRecord
}

class LeaseRaceEvalRunStore implements EvalRunStore {
  private run: EvalRunRecord
  private readonly refreshedLease: EvalRunExecutionOwnershipRecord
  private leaseRefreshInjected = false

  constructor(run: EvalRunRecord) {
    this.run = cloneRun(run)
    const now = Date.now()
    this.refreshedLease = {
      ownerId: 'live-node',
      claimedAt: new Date(now - 1000).toISOString(),
      leaseExpiresAt: new Date(now + 5 * 60 * 1000).toISOString(),
    }
  }

  async saveRun(run: EvalRunRecord): Promise<void> {
    this.run = cloneRun(run)
  }

  async updateRun(runId: string, patch: Partial<EvalRunRecord>): Promise<void> {
    if (runId !== this.run.id) {
      throw new Error(`Eval run "${runId}" not found`)
    }

    this.run = cloneRun({ ...this.run, ...patch })
  }

  async updateRunIf(
    runId: string,
    predicate: (run: EvalRunRecord) => boolean,
    patch: Partial<EvalRunRecord>,
  ): Promise<boolean> {
    if (runId !== this.run.id) {
      throw new Error(`Eval run "${runId}" not found`)
    }

    if (!this.leaseRefreshInjected) {
      this.leaseRefreshInjected = true
      this.run = cloneRun({
        ...this.run,
        executionOwner: this.refreshedLease,
      })
    }

    const current = cloneRun(this.run)
    if (!predicate(current)) {
      return false
    }

    this.run = cloneRun({ ...this.run, ...patch })
    return true
  }

  async getRun(runId: string): Promise<EvalRunRecord | null> {
    if (runId !== this.run.id) {
      return null
    }

    return cloneRun(this.run)
  }

  async listRuns(filter?: { suiteId?: string; status?: EvalRunRecord['status']; limit?: number }): Promise<EvalRunRecord[]> {
    const runs = [cloneRun(this.run)]
    return runs
      .filter((current) => filter?.suiteId === undefined || current.suiteId === filter.suiteId)
      .filter((current) => filter?.status === undefined || current.status === filter.status)
      .slice(0, filter?.limit ?? 50)
  }

  async listAllRuns(): Promise<EvalRunRecord[]> {
    return [cloneRun(this.run)]
  }
}

interface EvalRunResponseAttempt {
  attempt: number
  status: string
  queuedAt: string
  startedAt?: string
  completedAt?: string
  result?: {
    suiteId: string
    aggregateScore: number
    passRate: number
  }
  error?: {
    code: string
    message: string
  }
  recovery?: {
    previousStatus: 'running'
    previousStartedAt?: string
    recoveredAt: string
    reason: 'process-restart'
  }
}

interface EvalRunResponseData {
  id: string
  suiteId: string
  status: string
  queuedAt?: string
  startedAt?: string
  completedAt?: string
  attempts?: number
  attemptHistory?: EvalRunResponseAttempt[]
  recovery?: {
    previousStatus: 'running'
    previousStartedAt?: string
    recoveredAt: string
    reason: 'process-restart'
  }
  executionOwner?: EvalRunExecutionOwnershipRecord
  result?: {
    suiteId: string
    aggregateScore: number
    passRate: number
  }
  error?: {
    code: string
    message: string
  }
  metadata?: Record<string, unknown>
}

async function req(
  app: ReturnType<typeof createForgeApp>,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
  }
  return app.request(path, init)
}

const exactMatchScorer: EvalScorer = {
  name: 'exact-match',
  async score(input, output, reference) {
    const pass = typeof reference === 'string' && output === reference
    return {
      score: pass ? 1 : 0,
      pass,
      reasoning: pass
        ? `Matched expected output for "${input}"`
        : `Expected "${reference ?? ''}" but received "${output}"`,
    }
  },
}

const toySuite: EvalSuite = {
  name: 'toy-suite',
  description: 'Simple uppercase eval suite for route tests',
  cases: [
    {
      id: 'case-1',
      input: 'hello',
      expectedOutput: 'HELLO',
    },
  ],
  scorers: [exactMatchScorer],
}

async function getRun(
  app: ReturnType<typeof createForgeApp>,
  runId: string,
): Promise<{
  response: Response
  body: {
    success: boolean
    data: EvalRunResponseData
  }
}> {
  const response = await app.request(`/api/evals/runs/${runId}`)
  const body = await response.json() as {
    success: boolean
    data: EvalRunResponseData
  }

  return { response, body }
}

describe('Eval routes', () => {
  it('requires an execution target unless read-only mode is explicitly enabled', () => {
    expect(() => createForgeApp({
      runStore: new InMemoryRunStore(),
      agentStore: new InMemoryAgentStore(),
      eventBus: createEventBus(),
      modelRegistry: new ModelRegistry(),
      evals: {
        suites: {
          'toy-suite': toySuite,
        },
      },
    })).toThrow('allowReadOnlyMode')
  })

  it('exposes eval health metadata and read-only run listing when no executor is wired', async () => {
    const app = createForgeApp(createReadOnlyConfig())

    const healthRes = await app.request('/api/evals/health')
    expect(healthRes.status).toBe(200)
    const healthBody = await healthRes.json() as {
      success: boolean
      data: {
        service: string
        status: string
        mode: string
        writable: boolean
        endpoints: string[]
      }
    }

    expect(healthBody.success).toBe(true)
    expect(healthBody.data.service).toBe('evals')
    expect(healthBody.data.status).toBe('ready')
    expect(healthBody.data.mode).toBe('read-only')
    expect(healthBody.data.writable).toBe(false)
    expect(healthBody.data.endpoints).toEqual([
      '/api/evals/health',
      '/api/evals/queue/stats',
      '/api/evals/runs',
      '/api/evals/runs/:id',
      '/api/evals/runs/:id/cancel',
      '/api/evals/runs/:id/retry',
    ])

    const listRes = await app.request('/api/evals/runs')
    expect(listRes.status).toBe(200)
    const listBody = await listRes.json() as {
      success: boolean
      data: unknown[]
      count: number
      meta: {
        service: string
        mode: string
        writable: boolean
      }
    }

    expect(listBody.success).toBe(true)
    expect(listBody.data).toEqual([])
    expect(listBody.count).toBe(0)
    expect(listBody.meta).toMatchObject({
      service: 'evals',
      mode: 'read-only',
      writable: false,
      filters: {
        limit: 50,
      },
    })
  })

  it('reports eval queue stats and metrics for pending and active runs', async () => {
    let releaseBlockedCase: (() => void) | null = null
    const blockedCase = new Promise<void>((resolve) => {
      releaseBlockedCase = resolve
    })
    const metrics = new MetricsCollector()

    const app = createForgeApp(createActiveConfig(async (input, context) => {
      if (input === 'hello' && !context?.signal.aborted) {
        await blockedCase
      }

      if (context?.signal.aborted) {
        throw new DOMException('Eval run cancelled', 'AbortError')
      }

      return input.toUpperCase()
    }, metrics))

    const firstRes = await req(app, 'POST', '/api/evals/runs', { suiteId: 'toy-suite' })
    expect(firstRes.status).toBe(202)
    const firstRun = await firstRes.json() as { data: { id: string } }

    await waitForCondition(
      async () => {
        const current = await getRun(app, firstRun.data.id)
        return current.body.data.status === 'running'
      },
      { timeoutMs: 5000, description: 'timed out waiting for first eval run to start running' },
    )

    const secondRes = await req(app, 'POST', '/api/evals/runs', { suiteId: 'toy-suite' })
    expect(secondRes.status).toBe(202)
    const secondRun = await secondRes.json() as { data: { id: string } }

    await waitForCondition(
      async () => {
        const first = await getRun(app, firstRun.data.id)
        const second = await getRun(app, secondRun.data.id)
        return first.body.data.status === 'running' && second.body.data.status === 'queued'
      },
      { timeoutMs: 5000, description: 'timed out waiting for eval queue to show pending work' },
    )

    const statsRes = await app.request('/api/evals/queue/stats')
    expect(statsRes.status).toBe(200)
    const statsBody = await statsRes.json() as {
      success: boolean
      data: {
        service: string
        mode: string
        writable: boolean
        queue: {
          pending: number
          active: number
          oldestPendingAgeMs: number | null
          enqueued: number
          started: number
          completed: number
          failed: number
          cancelled: number
          retried: number
          recovered: number
          requeued: number
        }
      }
    }

    expect(statsBody.success).toBe(true)
    expect(statsBody.data.service).toBe('evals')
    expect(statsBody.data.mode).toBe('active')
    expect(statsBody.data.writable).toBe(true)
    expect(statsBody.data.queue.pending).toBe(1)
    expect(statsBody.data.queue.active).toBe(1)
    expect(statsBody.data.queue.oldestPendingAgeMs).not.toBeNull()
    expect(statsBody.data.queue.oldestPendingAgeMs!).toBeGreaterThanOrEqual(0)
    expect(statsBody.data.queue.enqueued).toBe(2)
    expect(statsBody.data.queue.started).toBe(1)
    expect(statsBody.data.queue.completed).toBe(0)
    expect(metrics.get('forge_eval_queue_enqueued_total')).toBe(2)
    expect(metrics.get('forge_eval_queue_started_total')).toBe(1)
    expect(metrics.get('forge_eval_queue_pending')).toBe(1)
    expect(metrics.get('forge_eval_queue_active')).toBe(1)
    expect(metrics.get('forge_eval_queue_oldest_pending_age_ms')).toBeGreaterThanOrEqual(0)

    releaseBlockedCase?.()

    await waitForCondition(
      async () => {
        const first = await getRun(app, firstRun.data.id)
        const second = await getRun(app, secondRun.data.id)
        return first.body.data.status === 'completed' && second.body.data.status === 'completed'
      },
      { timeoutMs: 5000, description: 'timed out waiting for eval queue to drain' },
    )

    const drainedStats = await app.request('/api/evals/queue/stats')
    expect(drainedStats.status).toBe(200)
    const drainedBody = await drainedStats.json() as {
      data: {
        queue: {
          pending: number
          active: number
          oldestPendingAgeMs: number | null
          enqueued: number
          started: number
          completed: number
        }
      }
    }

    expect(drainedBody.data.queue.pending).toBe(0)
    expect(drainedBody.data.queue.active).toBe(0)
    expect(drainedBody.data.queue.oldestPendingAgeMs).toBeNull()
    expect(drainedBody.data.queue.enqueued).toBe(2)
    expect(drainedBody.data.queue.started).toBe(2)
    expect(drainedBody.data.queue.completed).toBe(2)
    expect(metrics.get('forge_eval_queue_completed_total')).toBe(2)
    expect(metrics.get('forge_eval_queue_pending')).toBe(0)
    expect(metrics.get('forge_eval_queue_active')).toBe(0)
  })

  it('claims execution ownership once across shared-store instances', async () => {
    const store = new InMemoryEvalRunStore()
    let firstInstanceExecutions = 0
    let secondInstanceExecutions = 0
    let releaseBlockedCase: (() => void) | null = null
    const blockedCase = new Promise<void>((resolve) => {
      releaseBlockedCase = resolve
    })

    const firstConfig = createActiveConfig(async (input, context) => {
      firstInstanceExecutions += 1
      if (input === 'hello' && !context?.signal.aborted) {
        await blockedCase
      }

      if (context?.signal.aborted) {
        throw new DOMException('Eval run cancelled', 'AbortError')
      }

      return input.toUpperCase()
    })
    firstConfig.evals = {
      ...firstConfig.evals,
      store,
    }

    const firstApp = createForgeApp(firstConfig)
    const createRes = await req(firstApp, 'POST', '/api/evals/runs', { suiteId: 'toy-suite' })
    expect(createRes.status).toBe(202)
    const created = await createRes.json() as {
      data: {
        id: string
        status: string
        executionOwner?: EvalRunExecutionOwnershipRecord
      }
    }

    await waitForCondition(
      async () => {
        const current = await getRun(firstApp, created.data.id)
        return current.body.data.status === 'running'
          && current.body.data.executionOwner?.ownerId !== undefined
      },
      { timeoutMs: 5000, description: 'timed out waiting for eval run ownership claim' },
    )

    const firstRunning = await getRun(firstApp, created.data.id)
    expect(firstRunning.body.data.status).toBe('running')
    expect(firstRunning.body.data.executionOwner).toMatchObject({
      ownerId: expect.any(String),
      claimedAt: expect.any(String),
      leaseExpiresAt: expect.any(String),
    })
    expect(firstInstanceExecutions).toBe(1)

    const secondConfig = createActiveConfig(async (input, context) => {
      secondInstanceExecutions += 1
      if (context?.signal.aborted) {
        throw new DOMException('Eval run cancelled', 'AbortError')
      }

      return input.toUpperCase()
    })
    secondConfig.evals = {
      ...secondConfig.evals,
      store,
    }

    const secondApp = createForgeApp(secondConfig)

    await waitForCondition(
      async () => {
        const current = await getRun(secondApp, created.data.id)
        return current.body.data.status === 'running' && secondInstanceExecutions === 0
      },
      { timeoutMs: 1000, description: 'second instance should not duplicate an owned run' },
    )

    releaseBlockedCase?.()

    await waitForCondition(
      async () => {
        const current = await getRun(firstApp, created.data.id)
        return current.body.data.status === 'completed'
      },
      { timeoutMs: 5000, description: 'timed out waiting for shared-store eval completion' },
    )

    const completed = await getRun(firstApp, created.data.id)
    expect(completed.body.data.status).toBe('completed')
    expect(completed.body.data.executionOwner).toBeUndefined()
    expect(completed.body.data.attemptHistory).toHaveLength(1)
    expect(firstInstanceExecutions).toBe(1)
    expect(secondInstanceExecutions).toBe(0)
  })

  it('returns 503 for eval execution attempts in read-only mode', async () => {
    const app = createForgeApp(createReadOnlyConfig())
    const res = await req(app, 'POST', '/api/evals/runs', { suiteId: 'toy-suite' })

    expect(res.status).toBe(503)
    const body = await res.json() as {
      success: boolean
      error: {
        code: string
        message: string
      }
    }

    expect(body.success).toBe(false)
    expect(body.error.code).toBe('EVAL_EXECUTION_UNAVAILABLE')
    expect(body.error.message).toContain('read-only mode')
  })

  it('rejects non-object metadata payloads with a validation error', async () => {
    const app = createForgeApp(createActiveConfig())
    for (const metadata of [null, [], 42, 'invalid']) {
      const res = await req(app, 'POST', '/api/evals/runs', {
        suiteId: 'toy-suite',
        metadata,
      })

      expect(res.status).toBe(400)
      const body = await res.json() as {
        success: boolean
        error: { code: string; message: string }
      }
      expect(body.success).toBe(false)
      expect(body.error.code).toBe('VALIDATION_ERROR')
      expect(body.error.message).toContain('metadata')
    }
  })

  it('does not reclaim a running run when a live lease appears during startup reconciliation', async () => {
    const runningRun = buildEvalRun({
      id: 'running-race-run',
      status: 'running',
      createdAt: '2026-03-30T08:00:00.000Z',
      queuedAt: '2026-03-30T08:00:00.000Z',
      startedAt: '2026-03-30T08:05:00.000Z',
      attempts: 1,
      executionOwner: {
        ownerId: 'dead-node',
        claimedAt: '2026-03-30T08:05:00.000Z',
        leaseExpiresAt: '2026-03-30T08:06:00.000Z',
      },
    })
    const store = new LeaseRaceEvalRunStore(runningRun)

    const app = createForgeApp({
      ...createActiveConfig(),
      evals: {
        suites: {
          'toy-suite': toySuite,
        },
        executeTarget: async (input) => input.toUpperCase(),
        store,
      },
    })

    await waitForCondition(
      async () => {
        const current = await store.getRun(runningRun.id)
        return current?.status === 'running'
          && current.executionOwner?.ownerId === 'live-node'
      },
      { timeoutMs: 5000, description: 'timed out waiting for startup reconciliation lease race to settle' },
    )

    const current = await store.getRun(runningRun.id)
    expect(current?.status).toBe('running')
    expect(current?.queuedAt).toBe('2026-03-30T08:00:00.000Z')
    expect(current?.attempts).toBe(1)
    expect(current?.recovery).toBeUndefined()
    expect(current?.executionOwner?.ownerId).toBe('live-node')
  })

  it('rejects inline suite payloads with a validation error', async () => {
    const app = createForgeApp(createActiveConfig())
    const res = await req(app, 'POST', '/api/evals/runs', {
      suite: {
        name: 'inline-suite',
        cases: [{ id: 'c1', input: 'hello' }],
        scorers: [{ name: 'inline' }],
      },
    })

    expect(res.status).toBe(400)
    const body = await res.json() as {
      success: boolean
      error: { code: string; message: string }
    }
    expect(body.success).toBe(false)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toContain('Inline suite payloads')
  })

  it('queues eval runs asynchronously and transitions them to completed', async () => {
    const app = createForgeApp(createActiveConfig())

    const createRes = await req(app, 'POST', '/api/evals/runs', { suiteId: 'toy-suite' })
    expect(createRes.status).toBe(202)
    const created = await createRes.json() as {
      success: boolean
      data: {
        id: string
        suiteId: string
        status: string
        queuedAt: string
        startedAt?: string
        completedAt?: string
        result?: {
          suiteId: string
          aggregateScore: number
          passRate: number
        }
      }
    }

    expect(created.success).toBe(true)
    expect(created.data.suiteId).toBe('toy-suite')
    expect(created.data.status).toBe('queued')
    expect(created.data.queuedAt).toBeTruthy()
    expect(created.data.startedAt).toBeUndefined()
    expect(created.data.attemptHistory).toHaveLength(1)
    expect(created.data.attemptHistory?.[0]?.status).toBe('queued')

    const createdRun = await getRun(app, created.data.id)
    expect(createdRun.response.status).toBe(200)
    expect(['queued', 'running']).toContain(createdRun.body.data.status)

    await waitForCondition(
      async () => {
        const current = await getRun(app, created.data.id)
        return current.body.data.status === 'completed'
      },
      { timeoutMs: 5000, description: 'timed out waiting for eval run completion' },
    )

    const completedRun = await getRun(app, created.data.id)
    expect(completedRun.body.data.status).toBe('completed')
    expect(completedRun.body.data.startedAt).toBeTruthy()
    expect(completedRun.body.data.completedAt).toBeTruthy()
    expect(completedRun.body.data.attemptHistory).toHaveLength(1)
    expect(completedRun.body.data.attemptHistory?.[0]?.status).toBe('completed')
    expect(completedRun.body.data.attemptHistory?.[0]?.startedAt).toBeTruthy()
    expect(completedRun.body.data.attemptHistory?.[0]?.completedAt).toBeTruthy()
    expect(completedRun.body.data.result?.suiteId).toBe('toy-suite')
    expect(completedRun.body.data.result?.aggregateScore).toBe(1)
    expect(completedRun.body.data.result?.passRate).toBe(1)

    const completedList = await app.request('/api/evals/runs?suiteId=toy-suite&status=completed')
    expect(completedList.status).toBe(200)
    const completedListBody = await completedList.json() as {
      success: boolean
      count: number
      data: Array<{ id: string; suiteId: string; status: string }>
    }
    expect(completedListBody.success).toBe(true)
    expect(completedListBody.count).toBe(1)
    expect(completedListBody.data[0]?.id).toBe(created.data.id)
    expect(completedListBody.data[0]?.status).toBe('completed')
  })

  it('cancels a running eval run and preserves the cancelled terminal state', async () => {
    let releaseBlockedCase: (() => void) | null = null
    const blockedCase = new Promise<void>((resolve) => {
      releaseBlockedCase = resolve
    })

    const app = createForgeApp(createActiveConfig(async (input, context) => {
      if (input === 'hello') {
        await blockedCase
      }

      if (context?.signal.aborted) {
        throw new DOMException('Eval run cancelled', 'AbortError')
      }

      return input.toUpperCase()
    }))

    const createRes = await req(app, 'POST', '/api/evals/runs', { suiteId: 'toy-suite' })
    expect(createRes.status).toBe(202)
    const created = await createRes.json() as {
      data: { id: string; status: string }
    }

    await waitForCondition(
      async () => {
        const current = await getRun(app, created.data.id)
        return current.body.data.status === 'running'
      },
      { timeoutMs: 5000, description: 'timed out waiting for eval run to start running' },
    )

    const cancelRes = await req(app, 'POST', `/api/evals/runs/${created.data.id}/cancel`)
    expect(cancelRes.status).toBe(200)
    const cancelled = await cancelRes.json() as {
      success: boolean
      data: { id: string; status: string; completedAt?: string }
    }

    expect(cancelled.success).toBe(true)
    expect(cancelled.data.id).toBe(created.data.id)
    expect(cancelled.data.status).toBe('cancelled')
    expect(cancelled.data.completedAt).toBeTruthy()
    expect(cancelled.data.attemptHistory).toHaveLength(1)
    expect(cancelled.data.attemptHistory?.[0]?.status).toBe('cancelled')
    expect(cancelled.data.attemptHistory?.[0]?.startedAt).toBeTruthy()

    releaseBlockedCase?.()

    await waitForCondition(
      async () => {
        const current = await getRun(app, created.data.id)
        return current.body.data.status === 'cancelled'
      },
      { timeoutMs: 5000, description: 'timed out waiting for cancelled status to settle' },
    )

    const cancelledRun = await getRun(app, created.data.id)
    expect(cancelledRun.body.data.status).toBe('cancelled')
    expect(cancelledRun.body.data.result).toBeUndefined()
    expect(cancelledRun.body.data.attemptHistory).toHaveLength(1)
    expect(cancelledRun.body.data.attemptHistory?.[0]?.status).toBe('cancelled')
    expect(cancelledRun.body.data.attemptHistory?.[0]?.startedAt).toBeTruthy()

    const cancelledList = await app.request('/api/evals/runs?status=cancelled')
    expect(cancelledList.status).toBe(200)
    const cancelledListBody = await cancelledList.json() as {
      success: boolean
      count: number
      data: Array<{ id: string; status: string }>
    }
    expect(cancelledListBody.success).toBe(true)
    expect(cancelledListBody.count).toBe(1)
    expect(cancelledListBody.data[0]?.id).toBe(created.data.id)
    expect(cancelledListBody.data[0]?.status).toBe('cancelled')
  })

  it('retries a failed eval run back into the queue and completes it on the next attempt', async () => {
    let attemptCount = 0
    const app = createForgeApp(createActiveConfig(async (input) => {
      attemptCount++
      if (attemptCount === 1) {
        throw new Error('boom')
      }

      return input.toUpperCase()
    }))

    const createRes = await req(app, 'POST', '/api/evals/runs', { suiteId: 'toy-suite' })
    expect(createRes.status).toBe(202)
    const created = await createRes.json() as {
      data: { id: string; status: string }
    }
    expect(created.data.status).toBe('queued')

    await waitForCondition(
      async () => {
        const current = await getRun(app, created.data.id)
        return current.body.data.status === 'failed'
      },
      { timeoutMs: 5000, description: 'timed out waiting for eval run failure' },
    )

    const failedRun = await getRun(app, created.data.id)
    expect(failedRun.body.data.status).toBe('failed')
    expect(failedRun.body.data.error?.code).toBe('Error')
    expect(failedRun.body.data.completedAt).toBeTruthy()
    expect(failedRun.body.data.attemptHistory).toHaveLength(1)
    expect(failedRun.body.data.attemptHistory?.[0]?.status).toBe('failed')
    expect(failedRun.body.data.attemptHistory?.[0]?.startedAt).toBeTruthy()
    expect(attemptCount).toBe(1)

    const retryRes = await req(app, 'POST', `/api/evals/runs/${created.data.id}/retry`)
    expect(retryRes.status).toBe(202)
    const retried = await retryRes.json() as {
      success: boolean
      data: { id: string; status: string; queuedAt?: string }
    }
    expect(retried.success).toBe(true)
    expect(retried.data.id).toBe(created.data.id)
    expect(retried.data.status).toBe('queued')
    expect(retried.data.queuedAt).toBeTruthy()
    expect(retried.data.attemptHistory).toHaveLength(2)
    expect(retried.data.attemptHistory?.[0]?.status).toBe('failed')
    expect(retried.data.attemptHistory?.[1]?.status).toBe('queued')

    await waitForCondition(
      async () => {
        const current = await getRun(app, created.data.id)
        return current.body.data.status === 'completed'
      },
      { timeoutMs: 5000, description: 'timed out waiting for retried eval run completion' },
    )

    const completedRun = await getRun(app, created.data.id)
    expect(completedRun.body.data.status).toBe('completed')
    expect(completedRun.body.data.result?.aggregateScore).toBe(1)
    expect(completedRun.body.data.result?.passRate).toBe(1)
    expect(completedRun.body.data.attemptHistory).toHaveLength(2)
    expect(completedRun.body.data.attemptHistory?.[0]?.status).toBe('failed')
    expect(completedRun.body.data.attemptHistory?.[1]?.status).toBe('completed')
    expect(completedRun.body.data.attemptHistory?.[1]?.startedAt).toBeTruthy()
    expect(attemptCount).toBe(2)
  })

  it('reconciles persisted queued and running eval runs on startup', async () => {
    const store = new InMemoryEvalRunStore()
    const queuedRun = buildEvalRun({
      id: 'queued-run',
      status: 'queued',
      createdAt: '2026-03-30T09:00:00.000Z',
      queuedAt: '2026-03-30T09:00:00.000Z',
    })
    const runningRun = buildEvalRun({
      id: 'running-run',
      status: 'running',
      createdAt: '2026-03-30T08:00:00.000Z',
      queuedAt: '2026-03-30T08:00:00.000Z',
      startedAt: '2026-03-30T08:05:00.000Z',
      attempts: 1,
      executionOwner: {
        ownerId: 'dead-node',
        claimedAt: '2026-03-30T08:05:00.000Z',
        leaseExpiresAt: '2026-03-30T08:06:00.000Z',
      },
      metadata: { source: 'pre-restart' },
    })

    await store.saveRun(queuedRun)
    await store.saveRun(runningRun)

    const config = createActiveConfig()
    config.evals = {
      ...config.evals,
      store,
      executeTarget: async (input) => input.toUpperCase(),
    }

    const app = createForgeApp(config)

    await waitForCondition(
      async () => {
        const queued = await getRun(app, queuedRun.id)
        const running = await getRun(app, runningRun.id)
        return queued.body.data.status === 'completed' && running.body.data.status === 'completed'
      },
      { timeoutMs: 5000, description: 'timed out waiting for recovered eval runs to complete' },
    )

    const recoveredQueued = await getRun(app, queuedRun.id)
    expect(recoveredQueued.body.data.status).toBe('completed')
    expect(recoveredQueued.body.data.attempts).toBe(1)
    expect(recoveredQueued.body.data.attemptHistory).toHaveLength(1)
    expect(recoveredQueued.body.data.attemptHistory?.[0]?.status).toBe('completed')
    expect(recoveredQueued.body.data.recovery).toBeUndefined()

    const recoveredRunning = await getRun(app, runningRun.id)
    expect(recoveredRunning.body.data.status).toBe('completed')
    expect(recoveredRunning.body.data.queuedAt).not.toBe('2026-03-30T08:00:00.000Z')
    expect(recoveredRunning.body.data.queuedAt).toBe(recoveredRunning.body.data.attemptHistory?.[1]?.queuedAt)
    expect(recoveredRunning.body.data.attempts).toBe(2)
    expect(recoveredRunning.body.data.attemptHistory).toHaveLength(2)
    expect(recoveredRunning.body.data.attemptHistory?.[0]?.status).toBe('cancelled')
    expect(recoveredRunning.body.data.attemptHistory?.[1]?.status).toBe('completed')
    expect(recoveredRunning.body.data.attemptHistory?.[1]?.startedAt).toBeTruthy()
    expect(recoveredRunning.body.data.attemptHistory?.[0]?.recovery).toMatchObject({
      previousStatus: 'running',
      previousStartedAt: '2026-03-30T08:05:00.000Z',
      reason: 'process-restart',
    })
    expect(recoveredRunning.body.data.attemptHistory?.[1]?.recovery).toMatchObject({
      previousStatus: 'running',
      previousStartedAt: '2026-03-30T08:05:00.000Z',
      reason: 'process-restart',
    })
    expect(recoveredRunning.body.data.recovery).toMatchObject({
      previousStatus: 'running',
      previousStartedAt: '2026-03-30T08:05:00.000Z',
      reason: 'process-restart',
    })
    expect(recoveredRunning.body.data.executionOwner).toBeUndefined()
    expect(recoveredRunning.body.data.metadata).toMatchObject({
      source: 'pre-restart',
      recovery: expect.objectContaining({
        previousStatus: 'running',
        reason: 'process-restart',
      }),
    })
  })
})
