import { describe, expect, it } from 'vitest'
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
import { EvalOrchestrator } from '@dzupagent/evals'

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

function createBaseConfig(overrides: Partial<ForgeServerConfig> = {}): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    evals: {
      suites: {
        'toy-suite': toySuite,
      },
      executeTarget: async (input) => input.toUpperCase(),
      orchestratorFactory: (deps) => new EvalOrchestrator(deps),
    },
    ...overrides,
  }
}

describe('eval metrics precedence wiring', () => {
  it('preserves eval-specific metrics when top-level metrics are absent', async () => {
    const evalMetrics = new MetricsCollector()
    const app = createForgeApp(createBaseConfig({
      evals: {
        suites: {
          'toy-suite': toySuite,
        },
        executeTarget: async (input) => input.toUpperCase(),
        orchestratorFactory: (deps) => new EvalOrchestrator(deps),
        metrics: evalMetrics,
      },
    }))

    const res = await req(app, 'POST', '/api/evals/runs', { suiteId: 'toy-suite' })
    expect(res.status).toBe(202)

    expect(evalMetrics.get('forge_eval_queue_enqueued_total')).toBe(1)

    await waitForCondition(
      async () => {
        const current = await app.request('/api/evals/runs')
        const body = await current.json() as {
          data: Array<{ status: string }>
        }
        return body.data[0]?.status === 'completed'
      },
      { timeoutMs: 5000, description: 'timed out waiting for eval run completion' },
    )
  })

  it('falls back to top-level metrics when eval-specific metrics are omitted', async () => {
    const topLevelMetrics = new MetricsCollector()
    const app = createForgeApp(createBaseConfig({
      metrics: topLevelMetrics,
      evals: {
        suites: {
          'toy-suite': toySuite,
        },
        executeTarget: async (input) => input.toUpperCase(),
        orchestratorFactory: (deps) => new EvalOrchestrator(deps),
      },
    }))

    const res = await req(app, 'POST', '/api/evals/runs', { suiteId: 'toy-suite' })
    expect(res.status).toBe(202)

    expect(topLevelMetrics.get('forge_eval_queue_enqueued_total')).toBe(1)

    await waitForCondition(
      async () => {
        const current = await app.request('/api/evals/runs')
        const body = await current.json() as {
          data: Array<{ status: string }>
        }
        return body.data[0]?.status === 'completed'
      },
      { timeoutMs: 5000, description: 'timed out waiting for eval run completion' },
    )
  })

  it('counts AbortError failures as failed queue metrics', async () => {
    const evalMetrics = new MetricsCollector()
    const app = createForgeApp(createBaseConfig({
      evals: {
        suites: {
          'toy-suite': toySuite,
        },
        executeTarget: async () => {
          throw new DOMException('Eval run cancelled', 'AbortError')
        },
        orchestratorFactory: (deps) => new EvalOrchestrator(deps),
        metrics: evalMetrics,
      },
    }))

    const res = await req(app, 'POST', '/api/evals/runs', { suiteId: 'toy-suite' })
    expect(res.status).toBe(202)

    await waitForCondition(
      async () => {
        const current = await app.request('/api/evals/runs')
        const body = await current.json() as {
          data: Array<{ status: string }>
        }
        return body.data[0]?.status === 'failed'
      },
      { timeoutMs: 5000, description: 'timed out waiting for aborting eval run failure' },
    )

    expect(evalMetrics.get('forge_eval_queue_failed_total')).toBe(1)
    expect(evalMetrics.get('forge_eval_queue_cancelled_total')).toBeUndefined()
  })
})
