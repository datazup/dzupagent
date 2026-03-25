/**
 * Memory browse routes — list and search memory entries via REST.
 *
 * GET /api/memory-browse/:namespace — List entries with optional search
 * Query params: limit, offset, search, scope (JSON-encoded)
 */
import { Hono } from 'hono'
import type { MemoryServiceLike } from '@forgeagent/memory-ipc'

export interface MemoryBrowseRouteConfig {
  memoryService: MemoryServiceLike
}

export function createMemoryBrowseRoutes(config: MemoryBrowseRouteConfig): Hono {
  const app = new Hono()
  const { memoryService } = config

  // GET /:namespace — List or search entries in a namespace
  app.get('/:namespace', async (c) => {
    const namespace = c.req.param('namespace')
    const limitStr = c.req.query('limit')
    const offsetStr = c.req.query('offset')
    const search = c.req.query('search')
    const scopeStr = c.req.query('scope')

    const limit = limitStr ? Math.min(parseInt(limitStr, 10), 100) : 20
    const offset = offsetStr ? parseInt(offsetStr, 10) : 0

    // Parse scope from query param (JSON-encoded)
    let scope: Record<string, string> = {}
    if (scopeStr) {
      try {
        const parsed: unknown = JSON.parse(scopeStr)
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          scope = parsed as Record<string, string>
        }
      } catch {
        return c.json(
          { error: { code: 'VALIDATION_ERROR', message: 'Invalid scope JSON' } },
          400,
        )
      }
    }

    try {
      let records: Record<string, unknown>[]

      if (search) {
        records = await memoryService.search(namespace, scope, search, limit + offset)
      } else {
        records = await memoryService.get(namespace, scope)
      }

      // Apply offset and limit
      const paged = records.slice(offset, offset + limit)

      const entries = paged.map((record) => ({
        key: typeof record['key'] === 'string' ? record['key'] : undefined,
        value: record,
      }))

      return c.json({
        data: entries,
        total: records.length,
        limit,
        offset,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json(
        { error: { code: 'MEMORY_ERROR', message } },
        500,
      )
    }
  })

  return app
}
