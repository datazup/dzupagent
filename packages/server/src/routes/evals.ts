import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { MetricsCollector } from '@dzupagent/core'
import type { EvalSuite } from '@dzupagent/evals'
import {
  InMemoryEvalRunStore,
  type EvalRunStatus,
  type EvalRunStore,
} from '../persistence/eval-run-store.js'
import {
  EvalExecutionUnavailableError,
  EvalOrchestrator,
  EvalRunInvalidStateError,
  type EvalExecutionTarget,
} from '../services/eval-orchestrator.js'

export interface EvalRouteConfig {
  /** Optional label returned by the route for operator diagnostics. */
  serviceName?: string
  /** Optional execution target used to run suites. */
  executeTarget?: EvalExecutionTarget
  /** Explicitly allow read-only mode when no execution target is configured. */
  allowReadOnlyMode?: boolean
  /** Optional in-memory or persistent eval run store. */
  store?: EvalRunStore
  /** Optional metrics collector used for queue visibility hooks. */
  metrics?: MetricsCollector
  /** Optional registry for resolving `suiteId` when a full suite payload is not posted. */
  suites?: Record<string, EvalSuite>
}

interface EvalRunCreateRequest {
  suite?: unknown
  suiteId?: string
  metadata?: Record<string, unknown>
}

interface EvalRunListMeta {
  service: string
  mode: 'active' | 'read-only'
  writable: boolean
  filters: {
    suiteId?: string
    status?: EvalRunStatus
    limit: number
  }
}

const DEFAULT_SERVICE_NAME = 'evals'
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 250
const AVAILABLE_ENDPOINTS = [
  '/api/evals/health',
  '/api/evals/queue/stats',
  '/api/evals/runs',
  '/api/evals/runs/:id',
  '/api/evals/runs/:id/cancel',
  '/api/evals/runs/:id/retry',
] as const

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_LIMIT
  return Math.min(parsed, MAX_LIMIT)
}

function parseRunStatus(raw: string | undefined): EvalRunStatus | null {
  if (!raw) return null
  switch (raw) {
    case 'queued':
    case 'running':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return raw
    default:
      return null
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function buildValidationError(message: string) {
  return { code: 'VALIDATION_ERROR', message }
}

function buildNotFoundError(message: string) {
  return { code: 'NOT_FOUND', message }
}

function buildExecutionUnavailableError(message: string) {
  return { code: 'EVAL_EXECUTION_UNAVAILABLE', message }
}

function buildInvalidStateError(message: string) {
  return { code: 'INVALID_STATE', message }
}

interface EvalRouteErrorResponse {
  status: ContentfulStatusCode
  error: { code: string; message: string }
}

function mapEvalRouteError(error: unknown): EvalRouteErrorResponse {
  if (error instanceof EvalExecutionUnavailableError) {
    return {
      status: 503,
      error: buildExecutionUnavailableError(error.message),
    }
  }

  if (error instanceof EvalRunInvalidStateError) {
    return {
      status: 400,
      error: buildInvalidStateError(error.message),
    }
  }

  if (error instanceof Error && error.message.includes('not found')) {
    return {
      status: 404,
      error: buildNotFoundError(error.message),
    }
  }

  return {
    status: 500,
    error: {
      code: 'EVAL_RUN_FAILED',
      message: error instanceof Error ? error.message : String(error),
    },
  }
}

export function createEvalRoutes(config: EvalRouteConfig = {}): Hono {
  const app = new Hono()
  const serviceName = config.serviceName ?? DEFAULT_SERVICE_NAME
  const store = config.store ?? new InMemoryEvalRunStore()
  const orchestrator = new EvalOrchestrator({
    store,
    executeTarget: config.executeTarget,
    allowReadOnlyMode: config.allowReadOnlyMode,
    metrics: config.metrics,
  })
  const mode: 'active' | 'read-only' = orchestrator.canExecute() ? 'active' : 'read-only'

  function resolveSuite(body: EvalRunCreateRequest): EvalSuite | null {
    if (body.suiteId) {
      const resolved = config.suites?.[body.suiteId]
      return resolved ?? null
    }

    if (body.suite !== undefined) {
      throw new Error(
        'Inline suite payloads are not supported over HTTP; provide suiteId for a server-registered suite',
      )
    }

    return null
  }

  app.get('/health', (c) => {
    return c.json({
      success: true,
      data: {
        service: serviceName,
        status: 'ready',
        mode,
        writable: orchestrator.canExecute(),
        endpoints: [...AVAILABLE_ENDPOINTS],
      },
    })
  })

  app.get('/queue/stats', async (c) => {
    const stats = await orchestrator.getQueueStats()
    return c.json({
      success: true,
      data: {
        service: serviceName,
        mode,
        writable: orchestrator.canExecute(),
        queue: stats,
      },
    })
  })

  app.get('/runs', async (c) => {
    const suiteId = c.req.query('suiteId') || undefined
    const status = parseRunStatus(c.req.query('status') || undefined)
    const limit = parseLimit(c.req.query('limit') || undefined)

    if (c.req.query('status') && status === null) {
      return c.json({
        success: false,
        error: buildValidationError(
          'status must be one of queued, running, completed, failed, or cancelled',
        ),
      }, 400)
    }

    const runs = await orchestrator.listRuns({ suiteId, status: status ?? undefined, limit })
    const meta: EvalRunListMeta = {
      service: serviceName,
      mode,
      writable: orchestrator.canExecute(),
      filters: {
        ...(suiteId ? { suiteId } : {}),
        ...(status ? { status } : {}),
        limit,
      },
    }

    return c.json({
      success: true,
      data: runs,
      count: runs.length,
      meta,
    })
  })

  app.get('/runs/:id', async (c) => {
    const run = await orchestrator.getRun(c.req.param('id'))
    if (!run) {
      return c.json({
        success: false,
        error: buildNotFoundError('Eval run not found'),
      }, 404)
    }

    return c.json({ success: true, data: run })
  })

  app.post('/runs', async (c) => {
    let body: EvalRunCreateRequest
    try {
      body = await c.req.json<EvalRunCreateRequest>()
    } catch {
      return c.json({
        success: false,
        error: buildValidationError('Request body must be valid JSON'),
      }, 400)
    }

    if (body.metadata !== undefined && !isPlainObject(body.metadata)) {
      return c.json({
        success: false,
        error: buildValidationError('metadata must be a plain object when provided'),
      }, 400)
    }

    let suite: EvalSuite | null
    try {
      suite = resolveSuite(body)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return c.json({ success: false, error: buildValidationError(message) }, 400)
    }

    if (!suite) {
      if (body.suiteId) {
        return c.json({
          success: false,
          error: buildNotFoundError(`Eval suite "${body.suiteId}" not found`),
        }, 404)
      }

      return c.json({
        success: false,
        error: buildValidationError('suite or suiteId is required'),
      }, 400)
    }

    if (!orchestrator.canExecute()) {
      return c.json({
        success: false,
        error: buildExecutionUnavailableError(
          'Eval execution target is not configured. This server is running in read-only mode.',
        ),
      }, 503)
    }

    try {
      const run = await orchestrator.queueRun({
        suite,
        metadata: body.metadata,
      })
      return c.json({ success: true, data: run }, 202)
    } catch (error) {
      const mapped = mapEvalRouteError(error)
      return c.json({
        success: false,
        error: mapped.error,
      }, mapped.status)
    }
  })

  app.post('/runs/:id/cancel', async (c) => {
    const id = c.req.param('id')
    const run = await orchestrator.getRun(id)
    if (!run) {
      return c.json({
        success: false,
        error: buildNotFoundError('Eval run not found'),
      }, 404)
    }

    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      return c.json({
        success: false,
        error: buildInvalidStateError(`Cannot cancel eval run in ${run.status} state`),
      }, 400)
    }

    try {
      const cancelled = await orchestrator.cancelRun(id)
      return c.json({ success: true, data: cancelled })
    } catch (error) {
      const mapped = mapEvalRouteError(error)
      return c.json({
        success: false,
        error: mapped.error,
      }, mapped.status)
    }
  })

  app.post('/runs/:id/retry', async (c) => {
    const id = c.req.param('id')
    const run = await orchestrator.getRun(id)
    if (!run) {
      return c.json({
        success: false,
        error: buildNotFoundError('Eval run not found'),
      }, 404)
    }

    if (run.status !== 'failed') {
      return c.json({
        success: false,
        error: buildInvalidStateError(`Cannot retry eval run in ${run.status} state`),
      }, 400)
    }

    try {
      const retried = await orchestrator.retryRun(id)
      return c.json({ success: true, data: retried }, 202)
    } catch (error) {
      const mapped = mapEvalRouteError(error)
      return c.json({
        success: false,
        error: mapped.error,
      }, mapped.status)
    }
  })

  return app
}
