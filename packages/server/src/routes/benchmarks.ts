import { Hono } from 'hono'
import type { BenchmarkSuite } from '@dzipagent/evals'
import {
  CODE_GEN_SUITE,
  QA_SUITE,
  TOOL_USE_SUITE,
  MULTI_TURN_SUITE,
  VECTOR_SEARCH_SUITE,
} from '@dzipagent/evals'
import {
  InMemoryBenchmarkRunStore,
  type BenchmarkRunStore,
} from '../persistence/benchmark-run-store.js'
import { BenchmarkOrchestrator } from '../services/benchmark-orchestrator.js'

export interface BenchmarkRouteConfig {
  executeTarget: (
    targetId: string,
    input: string,
    metadata?: Record<string, unknown>,
  ) => Promise<string>
  suites?: Record<string, BenchmarkSuite>
  store?: BenchmarkRunStore
}

function defaultSuites(): Record<string, BenchmarkSuite> {
  const suites = [CODE_GEN_SUITE, QA_SUITE, TOOL_USE_SUITE, MULTI_TURN_SUITE, VECTOR_SEARCH_SUITE]
  return Object.fromEntries(suites.map((s) => [s.id, s]))
}

export function createBenchmarkRoutes(config: BenchmarkRouteConfig): Hono {
  const app = new Hono()
  const orchestrator = new BenchmarkOrchestrator({
    suites: config.suites ?? defaultSuites(),
    executeTarget: config.executeTarget,
    store: config.store ?? new InMemoryBenchmarkRunStore(),
  })

  app.post('/runs', async (c) => {
    try {
      const body = await c.req.json<{
        suiteId: string
        targetId: string
        strict?: boolean
        metadata?: Record<string, unknown>
      }>()
      if (!body.suiteId || !body.targetId) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'suiteId and targetId are required' } }, 400)
      }

      const run = await orchestrator.runSuite({
        suiteId: body.suiteId,
        targetId: body.targetId,
        strict: body.strict,
        metadata: body.metadata,
      })

      return c.json({ data: run }, 201)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = message.includes('not found') ? 404 : 400
      return c.json({ error: { code: 'BENCHMARK_RUN_FAILED', message } }, status)
    }
  })

  app.get('/runs/:id', async (c) => {
    const run = await orchestrator.getRun(c.req.param('id'))
    if (!run) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Benchmark run not found' } }, 404)
    }
    return c.json({ data: run })
  })

  app.post('/compare', async (c) => {
    try {
      const body = await c.req.json<{
        currentRunId: string
        previousRunId?: string
      }>()
      if (!body.currentRunId) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'currentRunId is required' } }, 400)
      }

      if (body.previousRunId) {
        const compared = await orchestrator.compareRuns(body.currentRunId, body.previousRunId)
        return c.json({ data: compared })
      }

      const currentRun = await orchestrator.getRun(body.currentRunId)
      if (!currentRun) {
        return c.json({ error: { code: 'NOT_FOUND', message: 'Current run not found' } }, 404)
      }
      const baseline = await orchestrator.getBaseline(currentRun.suiteId, currentRun.targetId)
      if (!baseline) {
        return c.json({ error: { code: 'NOT_FOUND', message: 'No baseline found for suite/target' } }, 404)
      }
      const compared = await orchestrator.compareRuns(currentRun.id, baseline.runId)
      return c.json({ data: compared })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = message.includes('not found') ? 404 : 400
      return c.json({ error: { code: 'BENCHMARK_COMPARE_FAILED', message } }, status)
    }
  })

  app.get('/baselines', async (c) => {
    const suiteId = c.req.query('suiteId')
    const targetId = c.req.query('targetId')
    const baselines = await orchestrator.listBaselines({
      suiteId: suiteId ?? undefined,
      targetId: targetId ?? undefined,
    })
    return c.json({ data: baselines, count: baselines.length })
  })

  app.put('/baselines/:suiteId', async (c) => {
    try {
      const suiteId = c.req.param('suiteId')
      const body = await c.req.json<{ targetId: string; runId: string }>()
      if (!suiteId || !body.targetId || !body.runId) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'suiteId, targetId and runId are required' } }, 400)
      }
      const baseline = await orchestrator.setBaseline({
        suiteId,
        targetId: body.targetId,
        runId: body.runId,
      })
      return c.json({ data: baseline })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = message.includes('not found') ? 404 : 400
      return c.json({ error: { code: 'BASELINE_UPDATE_FAILED', message } }, status)
    }
  })

  return app
}

