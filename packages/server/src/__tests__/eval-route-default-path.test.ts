/**
 * MJ-CODE-01 regression — eval route default path.
 *
 * Background: previously `packages/server/src/routes/evals.ts` shipped a
 * `DefaultEvalOrchestrator` that ran when a host supplied an `executeTarget`
 * without an `orchestratorFactory`. That class had divergent lifecycle
 * semantics from the canonical `EvalOrchestrator` in `@dzupagent/evals` —
 * different attempt-count seeding (0 vs 1 + history), no lease ownership,
 * no startup recovery, no atomic state transitions, no requeued counter.
 *
 * This file pins the new behaviour:
 *   1. The route never ships a writable in-route executor.
 *   2. When `executeTarget` is provided without an orchestrator/factory the
 *      route fails fast (forces the canonical implementation to be used).
 *   3. When the canonical `EvalOrchestrator` is wired (the only supported
 *      writable default), the lifecycle covers: execute, cancellation,
 *      stale-run recovery, retry — all under one implementation.
 */
import { describe, it, expect } from 'vitest'
import { waitForCondition } from '@dzupagent/test-utils'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'
import type { EvalScorer, EvalSuite } from '@dzupagent/eval-contracts'
import { EvalOrchestrator } from '@dzupagent/evals'
import {
  InMemoryEvalRunStore,
  type EvalRunRecord,
  type EvalRunAttemptRecord,
} from '../persistence/eval-run-store.js'

const exactMatchScorer: EvalScorer = {
  name: 'exact-match',
  async score(_input, output, reference) {
    const pass = typeof reference === 'string' && output === reference
    return {
      score: pass ? 1 : 0,
      pass,
      reasoning: pass ? 'matched' : `expected ${String(reference)} got ${String(output)}`,
    }
  },
}

const toySuite: EvalSuite = {
  name: 'toy-suite',
  description: 'default-path regression suite',
  cases: [{ id: 'case-1', input: 'hello', expectedOutput: 'HELLO' }],
  scorers: [exactMatchScorer],
}

function baseConfig(): Omit<ForgeServerConfig, 'evals'> {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
  }
}

function defaultPathConfig(
  executeTarget: (input: string, ctx?: { signal: AbortSignal }) => Promise<string> | string = async (
    input,
  ) => input.toUpperCase(),
  store?: InMemoryEvalRunStore,
): ForgeServerConfig {
  // The "default" writable path is now: caller wires the canonical orchestrator
  // factory. There is no other writable default on the server.
  return {
    ...baseConfig(),
    evals: {
      suites: { 'toy-suite': toySuite },
      executeTarget,
      orchestratorFactory: (deps) => new EvalOrchestrator(deps),
      ...(store ? { store } : {}),
    },
  }
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
  if (body !== undefined) init.body = JSON.stringify(body)
  return app.request(path, init)
}

interface RunResponseBody {
  success: boolean
  data: EvalRunRecord & { attemptHistory?: EvalRunAttemptRecord[] }
}

async function fetchRun(
  app: ReturnType<typeof createForgeApp>,
  id: string,
): Promise<RunResponseBody> {
  const res = await app.request(`/api/evals/runs/${id}`)
  return res.json() as Promise<RunResponseBody>
}

describe('eval route default path (MJ-CODE-01)', () => {
  it('refuses to construct an in-route executor when only executeTarget is supplied', () => {
    // The previous DefaultEvalOrchestrator path would silently run with a
    // divergent lifecycle. The new contract: fail fast and demand the
    // canonical orchestrator from @dzupagent/evals.
    expect(() =>
      createForgeApp({
        ...baseConfig(),
        evals: {
          suites: { 'toy-suite': toySuite },
          executeTarget: async (input) => input.toUpperCase(),
        },
      }),
    ).toThrow(/orchestrator(Factory)?/)
  })

  it('falls back to read-only mode when no orchestrator and no executor are wired', async () => {
    const app = createForgeApp({
      ...baseConfig(),
      evals: {
        allowReadOnlyMode: true,
        suites: { 'toy-suite': toySuite },
      },
    })

    const health = await app.request('/api/evals/health')
    const healthBody = await health.json() as {
      data: { mode: string; writable: boolean }
    }
    expect(healthBody.data.mode).toBe('read-only')
    expect(healthBody.data.writable).toBe(false)

    const post = await req(app, 'POST', '/api/evals/runs', { suiteId: 'toy-suite' })
    expect(post.status).toBe(503)
  })

  it('default writable path executes an eval through the canonical orchestrator', async () => {
    const app = createForgeApp(defaultPathConfig())
    const create = await req(app, 'POST', '/api/evals/runs', { suiteId: 'toy-suite' })
    expect(create.status).toBe(202)
    const created = await create.json() as { data: EvalRunRecord }

    // Canonical orchestrator semantics: attempts seeded to 1 (not 0),
    // attemptHistory present from the start.
    expect(created.data.attempts).toBe(1)
    expect(created.data.attemptHistory).toHaveLength(1)
    expect(created.data.attemptHistory?.[0]?.status).toBe('queued')

    await waitForCondition(
      async () => (await fetchRun(app, created.data.id)).data.status === 'completed',
      { timeoutMs: 5000, description: 'default-path eval did not complete' },
    )

    const completed = await fetchRun(app, created.data.id)
    expect(completed.data.status).toBe('completed')
    expect(completed.data.attempts).toBe(1)
    expect(completed.data.attemptHistory).toHaveLength(1)
    expect(completed.data.attemptHistory?.[0]?.status).toBe('completed')
  })

  it('default writable path cancels in-flight runs with canonical attempt-history', async () => {
    let release: (() => void) | null = null
    const blocker = new Promise<void>((resolve) => { release = resolve })
    const app = createForgeApp(defaultPathConfig(async (input, ctx) => {
      if (input === 'hello') await blocker
      if (ctx?.signal.aborted) throw new DOMException('aborted', 'AbortError')
      return input.toUpperCase()
    }))

    const create = await req(app, 'POST', '/api/evals/runs', { suiteId: 'toy-suite' })
    const created = await create.json() as { data: EvalRunRecord }

    await waitForCondition(
      async () => (await fetchRun(app, created.data.id)).data.status === 'running',
      { timeoutMs: 5000, description: 'run never started' },
    )

    const cancel = await req(app, 'POST', `/api/evals/runs/${created.data.id}/cancel`)
    expect(cancel.status).toBe(200)
    const cancelled = await cancel.json() as { data: EvalRunRecord }
    expect(cancelled.data.status).toBe('cancelled')
    // Canonical orchestrator preserves the in-flight attempt and stamps the
    // cancellation onto its attemptHistory entry rather than overwriting state.
    expect(cancelled.data.attemptHistory).toHaveLength(1)
    expect(cancelled.data.attemptHistory?.[0]?.status).toBe('cancelled')
    expect(cancelled.data.attemptHistory?.[0]?.startedAt).toBeTruthy()

    release?.()
  })

  it('default writable path recovers stale running runs via startup reconciliation', async () => {
    const sharedStore = new InMemoryEvalRunStore()
    const stale: EvalRunRecord = {
      id: 'stale-run',
      suiteId: 'toy-suite',
      suite: toySuite,
      status: 'running',
      createdAt: '2026-03-30T08:00:00.000Z',
      queuedAt: '2026-03-30T08:00:00.000Z',
      startedAt: '2026-03-30T08:05:00.000Z',
      attempts: 1,
      attemptHistory: [{
        attempt: 1,
        status: 'running',
        queuedAt: '2026-03-30T08:00:00.000Z',
        startedAt: '2026-03-30T08:05:00.000Z',
      }],
      executionOwner: {
        ownerId: 'previous-process',
        claimedAt: '2026-03-30T08:05:00.000Z',
        leaseExpiresAt: '2026-03-30T08:06:00.000Z', // expired
      },
    }
    await sharedStore.saveRun(stale)

    const app = createForgeApp(defaultPathConfig(async (input) => input.toUpperCase(), sharedStore))

    await waitForCondition(
      async () => {
        const r = await sharedStore.getRun(stale.id)
        return r?.status === 'completed'
      },
      { timeoutMs: 5000, description: 'stale run was not recovered + completed' },
    )

    const recovered = await sharedStore.getRun(stale.id)
    // Canonical recovery semantics: attempts incremented, history records
    // the cancelled-on-recovery entry plus the new completed attempt, and
    // the recovery record is preserved.
    expect(recovered?.attempts).toBe(2)
    expect(recovered?.attemptHistory).toHaveLength(2)
    expect(recovered?.attemptHistory?.[0]?.status).toBe('cancelled')
    expect(recovered?.attemptHistory?.[0]?.recovery?.reason).toBe('process-restart')
    expect(recovered?.attemptHistory?.[1]?.status).toBe('completed')
    expect(recovered?.executionOwner).toBeUndefined()
  })

  it('default writable path retry uses canonical attempt-increment semantics', async () => {
    let calls = 0
    const app = createForgeApp(defaultPathConfig(async (input) => {
      calls++
      if (calls === 1) throw new Error('first attempt fails')
      return input.toUpperCase()
    }))

    const create = await req(app, 'POST', '/api/evals/runs', { suiteId: 'toy-suite' })
    const created = await create.json() as { data: EvalRunRecord }

    await waitForCondition(
      async () => (await fetchRun(app, created.data.id)).data.status === 'failed',
      { timeoutMs: 5000, description: 'run did not fail' },
    )

    const retry = await req(app, 'POST', `/api/evals/runs/${created.data.id}/retry`)
    expect(retry.status).toBe(202)
    const retried = await retry.json() as { data: EvalRunRecord }
    // Canonical retry: attempts increments to 2, attemptHistory grows, no
    // counter reset. The old DefaultEvalOrchestrator merely flipped state
    // back to 'queued' and re-ran with attempt=1.
    expect(retried.data.attempts).toBe(2)
    expect(retried.data.attemptHistory).toHaveLength(2)
    expect(retried.data.attemptHistory?.[0]?.status).toBe('failed')
    expect(retried.data.attemptHistory?.[1]?.status).toBe('queued')

    await waitForCondition(
      async () => (await fetchRun(app, created.data.id)).data.status === 'completed',
      { timeoutMs: 5000, description: 'retried run did not complete' },
    )

    const final = await fetchRun(app, created.data.id)
    expect(final.data.attempts).toBe(2)
    expect(final.data.attemptHistory).toHaveLength(2)
    expect(final.data.attemptHistory?.[1]?.status).toBe('completed')
  })

  it('exposes queue counters consistent with the canonical implementation', async () => {
    const app = createForgeApp(defaultPathConfig())
    await req(app, 'POST', '/api/evals/runs', { suiteId: 'toy-suite' })

    await waitForCondition(
      async () => {
        const stats = await (await app.request('/api/evals/queue/stats')).json() as {
          data: { queue: { completed: number } }
        }
        return stats.data.queue.completed >= 1
      },
      { timeoutMs: 5000, description: 'queue counters never advanced' },
    )

    const stats = await (await app.request('/api/evals/queue/stats')).json() as {
      data: { queue: { enqueued: number; started: number; completed: number; requeued: number; recovered: number } }
    }
    expect(stats.data.queue.enqueued).toBe(1)
    expect(stats.data.queue.started).toBe(1)
    expect(stats.data.queue.completed).toBe(1)
    expect(stats.data.queue.requeued).toBe(0)
    expect(stats.data.queue.recovered).toBe(0)
  })
})
