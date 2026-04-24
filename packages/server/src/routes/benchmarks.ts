import { Hono } from 'hono'
import type {
  BenchmarkOrchestratorLike,
  BenchmarkRunArtifactRecord,
  BenchmarkRunStore,
  BenchmarkSuite,
} from '@dzupagent/eval-contracts'
import { InMemoryBenchmarkRunStore } from '../persistence/benchmark-run-store.js'

/**
 * Factory for a `BenchmarkOrchestratorLike`. Injected so the server does not
 * take a runtime dependency on `@dzupagent/evals`. Hosts typically construct
 * `new BenchmarkOrchestrator({ ... })` from `@dzupagent/evals` inside this
 * factory.
 */
export type BenchmarkOrchestratorFactory = (deps: {
  suites: Record<string, BenchmarkSuite>
  executeTarget: (
    targetId: string,
    input: string,
    metadata?: Record<string, unknown>,
  ) => Promise<string>
  allowNonStrictExecution?: boolean
  store: BenchmarkRunStore
}) => BenchmarkOrchestratorLike

export interface BenchmarkRouteConfig {
  executeTarget: (
    targetId: string,
    input: string,
    metadata?: Record<string, unknown>,
  ) => Promise<string>
  /** Explicitly allow non-strict benchmark fallback behavior. */
  allowNonStrictExecution?: boolean
  /**
   * Registry of benchmark suites the host wants exposed over HTTP. The server
   * no longer ships the default evals suite bundle (that coupling was part of
   * the MC-A02 layer-inversion fix); hosts that want the canonical suites
   * should import them from `@dzupagent/evals` and pass them here.
   */
  suites?: Record<string, BenchmarkSuite>
  store?: BenchmarkRunStore
  /** Pre-constructed orchestrator. Takes precedence over `orchestratorFactory`. */
  orchestrator?: BenchmarkOrchestratorLike
  /**
   * Factory for constructing a benchmark orchestrator. When provided, the
   * server composes the orchestrator on startup. When neither `orchestrator`
   * nor `orchestratorFactory` is supplied the routes throw 503 on write
   * endpoints while still serving read endpoints from the store.
   */
  orchestratorFactory?: BenchmarkOrchestratorFactory
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 250

function parseLimit(raw: string | undefined): { limit: number; invalid: boolean } {
  if (raw === undefined) {
    return { limit: DEFAULT_LIMIT, invalid: false }
  }

  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { limit: DEFAULT_LIMIT, invalid: true }
  }

  return {
    limit: Math.min(MAX_LIMIT, parsed),
    invalid: false,
  }
}

interface BenchmarkRunCursor {
  createdAt: string
  id: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((entry) => typeof entry === 'string')
}

function parseArtifact(raw: unknown): { artifact?: BenchmarkRunArtifactRecord; invalid: boolean } {
  if (raw === undefined) {
    return { artifact: undefined, invalid: false }
  }

  if (!isStringRecord(raw)) {
    return { artifact: undefined, invalid: true }
  }

  const artifact = raw as Record<string, string>
  const requiredKeys: Array<keyof BenchmarkRunArtifactRecord> = [
    'suiteVersion',
    'datasetHash',
    'promptConfigVersion',
    'buildSha',
    'modelProfile',
  ]

  if (!requiredKeys.every((key) => typeof artifact[key] === 'string' && artifact[key].trim().length > 0)) {
    return { artifact: undefined, invalid: true }
  }

  const typedArtifact = artifact as unknown as BenchmarkRunArtifactRecord
  return {
    artifact: typedArtifact,
    invalid: false,
  }
}

function parseCursor(raw: string | undefined): { cursor: string | undefined; invalid: boolean } {
  if (raw === undefined) {
    return { cursor: undefined, invalid: false }
  }

  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
    if (!isPlainObject(parsed)) {
      return { cursor: undefined, invalid: true }
    }

    const cursor = parsed as Partial<BenchmarkRunCursor>
    if (typeof cursor.createdAt !== 'string' || typeof cursor.id !== 'string') {
      return { cursor: undefined, invalid: true }
    }

    return { cursor: raw, invalid: false }
  } catch {
    return { cursor: undefined, invalid: true }
  }
}

function buildValidationError(message: string) {
  return { code: 'VALIDATION_ERROR', message }
}

function parseStrict(raw: unknown): { strict?: boolean; invalid: boolean } {
  if (raw === undefined) {
    return { strict: undefined, invalid: false }
  }

  if (typeof raw !== 'boolean') {
    return { strict: undefined, invalid: true }
  }

  return { strict: raw, invalid: false }
}

/**
 * Fallback orchestrator used when the host doesn't supply a concrete one.
 * Write endpoints throw 503; read endpoints proxy directly to the store.
 */
class ReadOnlyBenchmarkOrchestrator implements BenchmarkOrchestratorLike {
  constructor(private readonly store: BenchmarkRunStore) {}

  async runSuite(): Promise<never> {
    throw new Error('Benchmark orchestrator is not configured on this server')
  }

  async getRun(runId: string) {
    return this.store.getRun(runId)
  }

  async listRuns(filter?: Parameters<BenchmarkRunStore['listRuns']>[0]) {
    return this.store.listRuns(filter)
  }

  async compareRuns(): Promise<never> {
    throw new Error('Benchmark orchestrator is not configured on this server')
  }

  async setBaseline(): Promise<never> {
    throw new Error('Benchmark orchestrator is not configured on this server')
  }

  async getBaseline(suiteId: string, targetId: string) {
    return this.store.getBaseline(suiteId, targetId)
  }

  async listBaselines(filter?: { suiteId?: string; targetId?: string }) {
    return this.store.listBaselines(filter)
  }
}

export function createBenchmarkRoutes(config: BenchmarkRouteConfig): Hono {
  const app = new Hono()
  const store = config.store ?? new InMemoryBenchmarkRunStore()
  const suites = config.suites ?? {}

  let orchestrator: BenchmarkOrchestratorLike
  if (config.orchestrator) {
    orchestrator = config.orchestrator
  } else if (config.orchestratorFactory) {
    const factoryDeps: Parameters<BenchmarkOrchestratorFactory>[0] = {
      suites,
      executeTarget: config.executeTarget,
      store,
    }
    if (config.allowNonStrictExecution !== undefined) {
      factoryDeps.allowNonStrictExecution = config.allowNonStrictExecution
    }
    orchestrator = config.orchestratorFactory(factoryDeps)
  } else {
    orchestrator = new ReadOnlyBenchmarkOrchestrator(store)
  }

  app.get('/runs', async (c) => {
    const suiteId = c.req.query('suiteId') || undefined
    const targetId = c.req.query('targetId') || undefined
    const rawLimit = c.req.query('limit') || undefined
    const rawCursor = c.req.query('cursor') || undefined
    const { limit, invalid } = parseLimit(rawLimit)
    const { cursor, invalid: invalidCursor } = parseCursor(rawCursor)

    if (invalid || invalidCursor) {
      return c.json({
        success: false,
        error: buildValidationError(
          invalid ? 'limit must be a positive integer' : 'cursor must be a valid pagination cursor',
        ),
      }, 400)
    }

    const page = await orchestrator.listRuns({ suiteId, targetId, limit, cursor })
    return c.json({
      success: true,
      data: page.data,
      count: page.data.length,
      meta: {
        service: 'benchmarks',
        filters: {
          ...(suiteId ? { suiteId } : {}),
          ...(targetId ? { targetId } : {}),
          limit,
        },
        pagination: {
          ...(cursor ? { cursor } : {}),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        },
      },
    })
  })

  app.post('/runs', async (c) => {
    try {
      const body = await c.req.json<{
        suiteId: string
        targetId: string
        strict?: unknown
        metadata?: Record<string, unknown>
        artifact?: unknown
      }>()
      if (!body.suiteId || !body.targetId) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'suiteId and targetId are required' } }, 400)
      }

      const { artifact, invalid } = parseArtifact(body.artifact)
      if (invalid) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'artifact must include suiteVersion, datasetHash, promptConfigVersion, buildSha, and modelProfile' } }, 400)
      }

      const strict = parseStrict(body.strict)
      if (strict.invalid) {
        return c.json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'strict must be a boolean when provided',
          },
        }, 400)
      }

      const run = await orchestrator.runSuite({
        suiteId: body.suiteId,
        targetId: body.targetId,
        strict: strict.strict,
        metadata: body.metadata,
        ...(artifact ? { artifact } : {}),
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
