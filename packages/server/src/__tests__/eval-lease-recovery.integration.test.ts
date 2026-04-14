import { describe, expect, it } from 'vitest'
import { waitForCondition } from '@dzupagent/test-utils'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'
import type { EvalScorer, EvalSuite } from '@dzupagent/evals'
import { InMemoryEvalRunStore } from '../persistence/eval-run-store.js'

function createBaseConfig(): Omit<ForgeServerConfig, 'evals'> {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
  }
}

function req(
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
  description: 'Simple uppercase eval suite for lease recovery tests',
  cases: [
    {
      id: 'case-1',
      input: 'hello',
      expectedOutput: 'HELLO',
    },
  ],
  scorers: [exactMatchScorer],
}

describe('eval lease recovery integration', () => {
  it('does not reclaim a live lease during second-instance startup reconciliation', async () => {
    const store = new InMemoryEvalRunStore()
    let firstExecutions = 0
    let secondExecutions = 0
    let releaseBlockedRun: (() => void) | null = null
    const blockedRun = new Promise<void>((resolve) => {
      releaseBlockedRun = resolve
    })

    const firstApp = createForgeApp({
      ...createBaseConfig(),
      evals: {
        suites: {
          'toy-suite': toySuite,
        },
        executeTarget: async (input, context) => {
          firstExecutions += 1
          if (input === 'hello' && !context?.signal.aborted) {
            await blockedRun
          }

          if (context?.signal.aborted) {
            throw new DOMException('Eval run cancelled', 'AbortError')
          }

          return input.toUpperCase()
        },
        store,
      },
    })

    const createRes = await req(firstApp, 'POST', '/api/evals/runs', { suiteId: 'toy-suite' })
    expect(createRes.status).toBe(202)
    const created = await createRes.json() as { data: { id: string } }

    await waitForCondition(
      async () => {
        const current = await req(firstApp, 'GET', `/api/evals/runs/${created.data.id}`)
        const body = await current.json() as {
          data: {
            status: string
            executionOwner?: { leaseExpiresAt: string }
          }
        }
        return body.data.status === 'running' && body.data.executionOwner?.leaseExpiresAt !== undefined
      },
      { timeoutMs: 5000, description: 'timed out waiting for the first eval run to claim a live lease' },
    )

    const liveRun = await req(firstApp, 'GET', `/api/evals/runs/${created.data.id}`)
    const liveBody = await liveRun.json() as {
      data: {
        executionOwner?: {
          ownerId: string
          claimedAt: string
          leaseExpiresAt: string
        }
      }
    }
    expect(liveBody.data.executionOwner).toBeTruthy()

    const refreshedLease = new Date(Date.now() + 5 * 60 * 1000).toISOString()
    await store.updateRun(created.data.id, {
      executionOwner: {
        ...liveBody.data.executionOwner!,
        leaseExpiresAt: refreshedLease,
      },
    })

    const secondApp = createForgeApp({
      ...createBaseConfig(),
      evals: {
        suites: {
          'toy-suite': toySuite,
        },
        executeTarget: async (input, context) => {
          secondExecutions += 1
          if (context?.signal.aborted) {
            throw new DOMException('Eval run cancelled', 'AbortError')
          }

          return input.toUpperCase()
        },
        store,
      },
    })

    await waitForCondition(
      async () => {
        const current = await req(secondApp, 'GET', `/api/evals/runs/${created.data.id}`)
        const body = await current.json() as {
          data: {
            status: string
            attempts: number
          }
        }
        return body.data.status === 'running' && body.data.attempts === 1 && secondExecutions === 0
      },
      { timeoutMs: 2000, description: 'timed out waiting for the second instance to leave the live lease untouched' },
    )

    expect(firstExecutions).toBe(1)
    expect(secondExecutions).toBe(0)

    releaseBlockedRun?.()

    await waitForCondition(
      async () => {
        const current = await req(firstApp, 'GET', `/api/evals/runs/${created.data.id}`)
        const body = await current.json() as {
          data: {
            status: string
            attempts: number
            attemptHistory?: Array<{ attempt: number; status: string }>
          }
        }
        return body.data.status === 'completed' && body.data.attempts === 1
      },
      { timeoutMs: 5000, description: 'timed out waiting for the eval run to complete' },
    )

    const completed = await req(firstApp, 'GET', `/api/evals/runs/${created.data.id}`)
    const completedBody = await completed.json() as {
      data: {
        status: string
        attempts: number
        executionOwner?: unknown
        attemptHistory?: Array<{ attempt: number; status: string }>
      }
    }

    expect(completedBody.data.status).toBe('completed')
    expect(completedBody.data.attempts).toBe(1)
    expect(completedBody.data.executionOwner).toBeUndefined()
    expect(completedBody.data.attemptHistory).toHaveLength(1)
    expect(completedBody.data.attemptHistory?.[0]?.status).toBe('completed')
    expect(firstExecutions).toBe(1)
    expect(secondExecutions).toBe(0)
  })

  it('reclaims and requeues a stale running lease on second-instance startup', async () => {
    const store = new InMemoryEvalRunStore()
    let firstExecutions = 0
    let secondExecutions = 0
    let releaseBlockedRun: (() => void) | null = null
    let releaseSecondBlockedRun: (() => void) | null = null
    const blockedRun = new Promise<void>((resolve) => {
      releaseBlockedRun = resolve
    })
    const secondBlockedRun = new Promise<void>((resolve) => {
      releaseSecondBlockedRun = resolve
    })

    const firstApp = createForgeApp({
      ...createBaseConfig(),
      evals: {
        suites: {
          'toy-suite': toySuite,
        },
        executeTarget: async (input, context) => {
          firstExecutions += 1
          if (input === 'hello' && !context?.signal.aborted) {
            await blockedRun
          }

          if (context?.signal.aborted) {
            throw new DOMException('Eval run cancelled', 'AbortError')
          }

          return input.toUpperCase()
        },
        store,
      },
    })

    const createRes = await req(firstApp, 'POST', '/api/evals/runs', { suiteId: 'toy-suite' })
    expect(createRes.status).toBe(202)
    const created = await createRes.json() as { data: { id: string } }

    await waitForCondition(
      async () => {
        const current = await req(firstApp, 'GET', `/api/evals/runs/${created.data.id}`)
        const body = await current.json() as {
          data: {
            status: string
            executionOwner?: { leaseExpiresAt: string }
          }
        }
        return body.data.status === 'running' && body.data.executionOwner?.leaseExpiresAt !== undefined
      },
      { timeoutMs: 5000, description: 'timed out waiting for the first eval run to claim a live lease before forcing it stale' },
    )

    const liveRun = await req(firstApp, 'GET', `/api/evals/runs/${created.data.id}`)
    const liveBody = await liveRun.json() as {
      data: {
        executionOwner?: {
          ownerId: string
          claimedAt: string
          leaseExpiresAt: string
        }
      }
    }
    expect(liveBody.data.executionOwner).toBeTruthy()

    const staleLease = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    await store.updateRun(created.data.id, {
      executionOwner: {
        ...liveBody.data.executionOwner!,
        leaseExpiresAt: staleLease,
      },
    })

    const secondApp = createForgeApp({
      ...createBaseConfig(),
      evals: {
        suites: {
          'toy-suite': toySuite,
        },
        executeTarget: async (input, context) => {
          secondExecutions += 1
          if (input === 'hello' && !context?.signal.aborted) {
            await secondBlockedRun
          }

          if (context?.signal.aborted) {
            throw new DOMException('Eval run cancelled', 'AbortError')
          }

          return input.toUpperCase()
        },
        store,
      },
    })

    await waitForCondition(
      async () => {
        const current = await req(secondApp, 'GET', `/api/evals/runs/${created.data.id}`)
        const body = await current.json() as {
          data: {
            status: string
            attempts: number
          }
        }
        return body.data.status === 'running' && body.data.attempts === 2 && secondExecutions === 1
      },
      { timeoutMs: 5000, description: 'timed out waiting for the second instance to reclaim the stale lease' },
    )

    expect(firstExecutions).toBe(1)
    expect(secondExecutions).toBe(1)

    releaseBlockedRun?.()

    await waitForCondition(
      async () => {
        const current = await req(secondApp, 'GET', `/api/evals/runs/${created.data.id}`)
        const body = await current.json() as {
          data: {
            status: string
            attempts: number
          }
        }
        return body.data.status === 'running' && body.data.attempts === 2 && firstExecutions === 1 && secondExecutions === 1
      },
      { timeoutMs: 5000, description: 'timed out waiting for the stale first attempt to fail ownership update' },
    )

    releaseSecondBlockedRun?.()

    await waitForCondition(
      async () => {
        const current = await req(secondApp, 'GET', `/api/evals/runs/${created.data.id}`)
        const body = await current.json() as {
          data: {
            status: string
            attempts: number
            attemptHistory?: Array<{ attempt: number; status: string; recovery?: { reason: string } }>
            recovery?: { reason: string }
          }
        }
        return body.data.status === 'completed' && body.data.attempts === 2
      },
      { timeoutMs: 5000, description: 'timed out waiting for the reclaimed eval run to complete' },
    )

    const completed = await req(secondApp, 'GET', `/api/evals/runs/${created.data.id}`)
    const completedBody = await completed.json() as {
      data: {
        status: string
        attempts: number
        recovery?: { reason: string }
        executionOwner?: unknown
        attemptHistory?: Array<{
          attempt: number
          status: string
          recovery?: { reason: string }
        }>
      }
    }

    expect(completedBody.data.status).toBe('completed')
    expect(completedBody.data.attempts).toBe(2)
    expect(completedBody.data.recovery).toMatchObject({ reason: 'process-restart' })
    expect(completedBody.data.executionOwner).toBeUndefined()
    expect(completedBody.data.attemptHistory).toHaveLength(2)
    expect(completedBody.data.attemptHistory?.[0]).toMatchObject({
      attempt: 1,
      status: 'cancelled',
      recovery: { reason: 'process-restart' },
    })
    expect(completedBody.data.attemptHistory?.[1]).toMatchObject({
      attempt: 2,
      status: 'completed',
      recovery: { reason: 'process-restart' },
    })
    expect(firstExecutions).toBe(1)
    expect(secondExecutions).toBe(1)
  })
})
