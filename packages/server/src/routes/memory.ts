/**
 * Memory export/import routes.
 *
 * POST   /api/memory/export  — Export memories as Arrow IPC or JSON
 * POST   /api/memory/import  — Import memories from Arrow IPC or JSON
 * GET    /api/memory/schema  — Return memory frame schema
 * GET    /api/memory/analytics/*  — DuckDB-powered memory analytics
 *
 * These routes bridge the MCP memory transport handlers from
 * @dzupagent/memory-ipc into the Hono REST API.
 */
import { Hono } from 'hono'
import {
  handleExportMemory,
  handleImportMemory,
  handleMemorySchema,
  exportMemoryInputSchema,
  importMemoryInputSchema,
  extendMemoryServiceWithArrow,
  type MemoryServiceLike,
  type ImportStrategy,
} from '@dzupagent/memory-ipc'
import {
  getAnalytics,
  isDuckDBError,
  analyticsResultToJson,
} from './analytics-handler.js'
import {
  applyAuthoritativeScope,
  type MemoryTenantScopeConfig,
} from './memory-tenant-scope.js'

/**
 * Duck-type check for ZodError without importing zod directly.
 * Zod v4 uses `issues` (not `errors`), and `name === 'ZodError'`.
 */
function isZodError(err: unknown): err is Error & { issues: Array<{ message: string }> } {
  if (!(err instanceof Error)) return false
  if (err.name === 'ZodError') return true
  // Zod v3 compat: check for `errors` array
  if ('errors' in err && Array.isArray((err as Record<string, unknown>)['errors'])) return true
  return false
}

/** Extract validation messages from a ZodError (v3 or v4). */
function zodErrorMessage(err: Error & { issues?: Array<{ message: string }>; errors?: Array<{ message: string }> }): string {
  const items = err.issues ?? err.errors
  if (items && items.length > 0) {
    return items.map((e) => e.message).join('; ')
  }
  return err.message
}

export interface MemoryRouteConfig {
  memoryService: MemoryServiceLike
  /** Tenant scoping config (MJ-SEC-04). Defaults to auth-middleware-based resolution. */
  tenantScope?: MemoryTenantScopeConfig
}

export function createMemoryRoutes(config: MemoryRouteConfig): Hono {
  const app = new Hono()
  const arrowMemory = extendMemoryServiceWithArrow(config.memoryService)
  const { tenantScope } = config

  // POST /export — Export memories as Arrow IPC or JSON
  app.post('/export', async (c) => {
    const body: unknown = await c.req.json()

    let input: ReturnType<typeof exportMemoryInputSchema.parse>
    try {
      input = exportMemoryInputSchema.parse(body)
    } catch (err: unknown) {
      if (isZodError(err)) {
        return c.json(
          { error: { code: 'VALIDATION_ERROR', message: zodErrorMessage(err) } },
          400,
        )
      }
      throw err
    }

    // MJ-SEC-04: override caller-supplied scope with authenticated tenant identity.
    const safeScope = applyAuthoritativeScope(c, input.scope ?? {}, tenantScope)
    const result = await handleExportMemory({ ...input, scope: safeScope }, {
      exportFrame: (ns, scope, opts) => arrowMemory.exportFrame(ns, scope, opts),
    })
    return c.json({ data: result })
  })

  // POST /import — Import memories from Arrow IPC or JSON
  app.post('/import', async (c) => {
    const body: unknown = await c.req.json()

    let input: ReturnType<typeof importMemoryInputSchema.parse>
    try {
      input = importMemoryInputSchema.parse(body)
    } catch (err: unknown) {
      if (isZodError(err)) {
        return c.json(
          { error: { code: 'VALIDATION_ERROR', message: zodErrorMessage(err) } },
          400,
        )
      }
      throw err
    }

    // MJ-SEC-04: override caller-supplied scope with authenticated tenant identity.
    const safeScope = applyAuthoritativeScope(c, input.scope ?? {}, tenantScope)
    const result = await handleImportMemory({ ...input, scope: safeScope }, {
      importFrame: (ns, scope, table, strategy) =>
        arrowMemory.importFrame(ns, scope, table, strategy as ImportStrategy | undefined),
    })
    return c.json({ data: result })
  })

  // GET /schema — Return memory frame schema
  app.get('/schema', (c) => {
    const result = handleMemorySchema()
    return c.json({ data: result })
  })

  // ── Analytics routes ─────────────────────────────────────

  /**
   * Helper: parse namespace/scope from query params and export as Arrow Table.
   */
  async function getMemoryTableFromQuery(c: {
    req: { query(name: string): string | undefined }
  }) {
    const namespace = c.req.query('namespace') ?? 'lessons'
    let scope: Record<string, string> = {}
    const scopeStr = c.req.query('scope')
    if (scopeStr) {
      try {
        const parsed: unknown = JSON.parse(scopeStr)
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          scope = parsed as Record<string, string>
        }
      } catch {
        // Use empty scope on parse failure
      }
    }
    return arrowMemory.exportFrame(namespace, scope, { limit: 10_000 })
  }

  // GET /analytics/decay-trends?window=hour|day|week&namespace=...&scope=...
  app.get('/analytics/decay-trends', async (c) => {
    try {
      const analytics = await getAnalytics()
      const window = c.req.query('window')
      const bucketSize: 'hour' | 'day' | 'week' =
        window === 'hour' || window === 'day' || window === 'week'
          ? window
          : 'day'
      const table = await getMemoryTableFromQuery(c)
      const result = await analytics.decayTrends(table, bucketSize)
      return c.json({ data: analyticsResultToJson(result) })
    } catch (err: unknown) {
      if (isDuckDBError(err)) {
        return c.json(
          { error: { code: 'DUCKDB_UNAVAILABLE', message: 'DuckDB-WASM is not installed. Analytics features require @duckdb/duckdb-wasm.' } },
          503,
        )
      }
      throw err
    }
  })

  // GET /analytics/namespace-stats?namespace=...&scope=...
  app.get('/analytics/namespace-stats', async (c) => {
    try {
      const analytics = await getAnalytics()
      const table = await getMemoryTableFromQuery(c)
      const result = await analytics.namespaceStats(table)
      return c.json({ data: analyticsResultToJson(result) })
    } catch (err: unknown) {
      if (isDuckDBError(err)) {
        return c.json(
          { error: { code: 'DUCKDB_UNAVAILABLE', message: 'DuckDB-WASM is not installed. Analytics features require @duckdb/duckdb-wasm.' } },
          503,
        )
      }
      throw err
    }
  })

  // GET /analytics/expiring?horizonMs=86400000&namespace=...&scope=...
  app.get('/analytics/expiring', async (c) => {
    const horizonStr = c.req.query('horizonMs')
    const horizonMs = horizonStr ? parseInt(horizonStr, 10) : 86_400_000
    if (isNaN(horizonMs) || horizonMs <= 0) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'horizonMs must be a positive integer' } },
        400,
      )
    }
    try {
      const analytics = await getAnalytics()
      const table = await getMemoryTableFromQuery(c)
      const result = await analytics.expiringMemories(table, horizonMs)
      return c.json({ data: analyticsResultToJson(result) })
    } catch (err: unknown) {
      if (isDuckDBError(err)) {
        return c.json(
          { error: { code: 'DUCKDB_UNAVAILABLE', message: 'DuckDB-WASM is not installed. Analytics features require @duckdb/duckdb-wasm.' } },
          503,
        )
      }
      throw err
    }
  })

  // GET /analytics/agent-performance?namespace=...&scope=...
  app.get('/analytics/agent-performance', async (c) => {
    try {
      const analytics = await getAnalytics()
      const table = await getMemoryTableFromQuery(c)
      const result = await analytics.agentPerformance(table)
      return c.json({ data: analyticsResultToJson(result) })
    } catch (err: unknown) {
      if (isDuckDBError(err)) {
        return c.json(
          { error: { code: 'DUCKDB_UNAVAILABLE', message: 'DuckDB-WASM is not installed. Analytics features require @duckdb/duckdb-wasm.' } },
          503,
        )
      }
      throw err
    }
  })

  // GET /analytics/usage-patterns?bucketMs=3600000&namespace=...&scope=...
  app.get('/analytics/usage-patterns', async (c) => {
    const bucketStr = c.req.query('bucketMs')
    const bucketMs = bucketStr ? parseInt(bucketStr, 10) : 3_600_000
    if (isNaN(bucketMs) || bucketMs <= 0) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'bucketMs must be a positive integer' } },
        400,
      )
    }
    try {
      const analytics = await getAnalytics()
      const table = await getMemoryTableFromQuery(c)
      const result = await analytics.usagePatterns(table, bucketMs)
      return c.json({ data: analyticsResultToJson(result) })
    } catch (err: unknown) {
      if (isDuckDBError(err)) {
        return c.json(
          { error: { code: 'DUCKDB_UNAVAILABLE', message: 'DuckDB-WASM is not installed. Analytics features require @duckdb/duckdb-wasm.' } },
          503,
        )
      }
      throw err
    }
  })

  // GET /analytics/duplicates?prefixLength=50&namespace=...&scope=...
  app.get('/analytics/duplicates', async (c) => {
    const prefixStr = c.req.query('prefixLength')
    const prefixLength = prefixStr ? parseInt(prefixStr, 10) : 50
    if (isNaN(prefixLength) || prefixLength <= 0) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'prefixLength must be a positive integer' } },
        400,
      )
    }
    try {
      const analytics = await getAnalytics()
      const table = await getMemoryTableFromQuery(c)
      const result = await analytics.duplicateCandidates(table, prefixLength)
      return c.json({ data: analyticsResultToJson(result) })
    } catch (err: unknown) {
      if (isDuckDBError(err)) {
        return c.json(
          { error: { code: 'DUCKDB_UNAVAILABLE', message: 'DuckDB-WASM is not installed. Analytics features require @duckdb/duckdb-wasm.' } },
          503,
        )
      }
      throw err
    }
  })

  return app
}
