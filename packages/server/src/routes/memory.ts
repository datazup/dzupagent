/**
 * Memory export/import routes.
 *
 * POST   /api/memory/export  — Export memories as Arrow IPC or JSON
 * POST   /api/memory/import  — Import memories from Arrow IPC or JSON
 * GET    /api/memory/schema  — Return memory frame schema
 *
 * These routes bridge the MCP memory transport handlers from
 * @forgeagent/memory-ipc into the Hono REST API.
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
} from '@forgeagent/memory-ipc'

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
}

export function createMemoryRoutes(config: MemoryRouteConfig): Hono {
  const app = new Hono()
  const arrowMemory = extendMemoryServiceWithArrow(config.memoryService)

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

    const result = await handleExportMemory(input, {
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

    const result = await handleImportMemory(input, {
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

  return app
}
