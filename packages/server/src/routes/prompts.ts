/**
 * Prompt version CRUD routes — create, list, get, update, publish, rollback, and delete prompt versions.
 *
 * A prompt version captures a named, typed template with a version counter and
 * status lifecycle (draft → published → archived). Multiple versions can exist
 * per promptId; only one may be in published state at a time.
 */
import { Hono } from 'hono'
import type { PromptStore, PromptStatus } from '../prompts/prompt-store.js'

export interface PromptRouteConfig {
  promptStore: PromptStore
}

export function createPromptRoutes(config: PromptRouteConfig): Hono {
  const app = new Hono()

  // --- Create prompt version ---
  app.post('/', async (c) => {
    const body = await c.req.json<{
      id?: string
      promptId?: string
      name: string
      type: string
      category?: string
      content: string
      status?: PromptStatus
      ownerId?: string
      ownerType?: 'agent' | 'persona'
      metadata?: Record<string, unknown>
    }>()

    if (!body.name || !body.type || !body.content) {
      return c.json(
        { error: { code: 'BAD_REQUEST', message: 'name, type, and content are required' } },
        400,
      )
    }

    const id = body.id ?? crypto.randomUUID()
    const promptId = body.promptId ?? id

    // Derive next version number for this promptId
    const existing = await config.promptStore.list()
    const siblings = existing.filter((r) => r.promptId === promptId)
    const version = siblings.length > 0 ? Math.max(...siblings.map((r) => r.version)) + 1 : 1

    const record = await config.promptStore.save({
      id,
      promptId,
      name: body.name,
      type: body.type,
      category: body.category ?? null,
      content: body.content,
      version,
      status: body.status ?? 'draft',
      ownerId: body.ownerId ?? null,
      ownerType: body.ownerType ?? null,
      metadata: body.metadata ?? null,
    })

    return c.json(record, 201)
  })

  // --- List prompt versions ---
  app.get('/', async (c) => {
    const { type, category, status } = c.req.query()
    const prompts = await config.promptStore.list({
      type: type || undefined,
      category: category || undefined,
      status: (status as PromptStatus) || undefined,
    })
    return c.json({ prompts })
  })

  // --- Get active published version for a promptId ---
  app.get('/active/:promptId', async (c) => {
    const record = await config.promptStore.getActive(c.req.param('promptId'))
    if (!record) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'No published version found' } }, 404)
    }
    return c.json(record)
  })

  // --- Get specific prompt version ---
  app.get('/:id', async (c) => {
    const record = await config.promptStore.get(c.req.param('id'))
    if (!record) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Prompt version not found' } }, 404)
    }
    return c.json(record)
  })

  // --- Update prompt version metadata (draft only) ---
  app.put('/:id', async (c) => {
    const body = await c.req.json<{
      name?: string
      content?: string
      category?: string
      ownerId?: string
      ownerType?: 'agent' | 'persona'
      metadata?: Record<string, unknown>
    }>()

    const existing = await config.promptStore.get(c.req.param('id'))
    if (!existing) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Prompt version not found' } }, 404)
    }
    if (existing.status !== 'draft') {
      return c.json(
        { error: { code: 'CONFLICT', message: 'Only draft versions can be updated' } },
        409,
      )
    }

    const updated = await config.promptStore.update(c.req.param('id'), body)
    return c.json(updated)
  })

  // --- Publish a version ---
  app.post('/:id/publish', async (c) => {
    const record = await config.promptStore.get(c.req.param('id'))
    if (!record) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Prompt version not found' } }, 404)
    }
    if (record.status === 'archived') {
      return c.json(
        { error: { code: 'CONFLICT', message: 'Archived versions cannot be published directly — use rollback' } },
        409,
      )
    }

    const published = await config.promptStore.publish(c.req.param('id'))
    return c.json(published)
  })

  // --- Rollback to a prior version ---
  app.post('/rollback/:promptId', async (c) => {
    const body = await c.req.json<{ targetId: string }>()
    if (!body.targetId) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'targetId is required' } }, 400)
    }

    const target = await config.promptStore.get(body.targetId)
    if (!target || target.promptId !== c.req.param('promptId')) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Target version not found for this promptId' } }, 404)
    }

    const result = await config.promptStore.rollback(c.req.param('promptId'), body.targetId)
    return c.json(result)
  })

  // --- Delete a draft version ---
  app.delete('/:id', async (c) => {
    const deleted = await config.promptStore.delete(c.req.param('id'))
    if (!deleted) {
      return c.json(
        { error: { code: 'CONFLICT', message: 'Prompt not found or is published (cannot delete published versions)' } },
        409,
      )
    }
    return c.json({ deleted: true })
  })

  return app
}
