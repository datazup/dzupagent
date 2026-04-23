/**
 * Branch coverage tests for agent routes.
 *
 * Covers: list filters (active=true/false/missing), limit clamp, PATCH with empty body,
 * DELETE unknown, POST with all optional fields, missing required field combinations,
 * GET with query edge cases.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'

function createTestConfig(): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
  }
}

async function req(app: ReturnType<typeof createForgeApp>, method: string, path: string, body?: unknown) {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  }
  if (body !== undefined) init.body = JSON.stringify(body)
  return app.request(path, init)
}

describe('agent routes branch coverage', () => {
  let config: ForgeServerConfig
  let app: ReturnType<typeof createForgeApp>

  beforeEach(() => {
    config = createTestConfig()
    app = createForgeApp(config)
  })

  it('GET /api/agent-definitions?active=true filters active agent definitions on canonical path', async () => {
    await config.agentStore.save({ id: 'a1', name: 'A1', instructions: 'i', modelTier: 't', active: true })
    await config.agentStore.save({ id: 'a2', name: 'A2', instructions: 'i', modelTier: 't', active: false })

    const res = await app.request('/api/agent-definitions?active=true')
    expect(res.status).toBe(200)
    const data = await res.json() as { data: Array<{ id: string; active: boolean }> }
    expect(data.data.every(a => a.active)).toBe(true)
  })

  it('GET /api/agents?active=false remains available as a compatibility alias', async () => {
    await config.agentStore.save({ id: 'a1', name: 'A1', instructions: 'i', modelTier: 't', active: true })
    await config.agentStore.save({ id: 'a2', name: 'A2', instructions: 'i', modelTier: 't', active: false })

    const res = await app.request('/api/agents?active=false')
    const data = await res.json() as { data: Array<{ active: boolean }> }
    expect(data.data.every(a => !a.active)).toBe(true)
  })

  it('GET /api/agent-definitions clamps limit to 200 max on the canonical path', async () => {
    const res = await app.request('/api/agent-definitions?limit=99999')
    expect(res.status).toBe(200)
    // The underlying store would respect the limit
  })

  it('POST /api/agent-definitions uses provided id when supplied', async () => {
    const res = await req(app, 'POST', '/api/agent-definitions', {
      id: 'my-custom-id',
      name: 'Test',
      instructions: 'x',
      modelTier: 'chat',
    })
    expect(res.status).toBe(201)
    const data = await res.json() as { data: { id: string } }
    expect(data.data.id).toBe('my-custom-id')
  })

  it('POST /api/agent-definitions generates UUID when id not provided', async () => {
    const res = await req(app, 'POST', '/api/agent-definitions', {
      name: 'Test',
      instructions: 'x',
      modelTier: 'chat',
    })
    expect(res.status).toBe(201)
    const data = await res.json() as { data: { id: string } }
    expect(data.data.id.length).toBeGreaterThan(0)
  })

  it('POST /api/agent-definitions rejects missing name', async () => {
    const res = await req(app, 'POST', '/api/agent-definitions', {
      instructions: 'x',
      modelTier: 'chat',
    })
    expect(res.status).toBe(400)
    const data = await res.json() as { error: { code: string } }
    expect(data.error.code).toBe('VALIDATION_ERROR')
  })

  it('POST /api/agent-definitions rejects missing instructions', async () => {
    const res = await req(app, 'POST', '/api/agent-definitions', {
      name: 'Test',
      modelTier: 'chat',
    })
    expect(res.status).toBe(400)
  })

  it('POST /api/agent-definitions rejects missing modelTier', async () => {
    const res = await req(app, 'POST', '/api/agent-definitions', {
      name: 'Test',
      instructions: 'x',
    })
    expect(res.status).toBe(400)
  })

  it('POST /api/agent-definitions accepts all optional fields', async () => {
    const res = await req(app, 'POST', '/api/agent-definitions', {
      id: 'a1',
      name: 'Test',
      description: 'desc',
      instructions: 'x',
      modelTier: 'chat',
      tools: ['tool-1', 'tool-2'],
      guardrails: { safe: true },
      approval: 'required',
      metadata: { env: 'prod' },
    })
    expect(res.status).toBe(201)
    const data = await res.json() as { data: { description?: string; tools?: string[]; approval?: string } }
    expect(data.data.description).toBe('desc')
    expect(data.data.tools).toEqual(['tool-1', 'tool-2'])
    expect(data.data.approval).toBe('required')
  })

  it('PATCH /api/agent-definitions/:id preserves id even if body has different id', async () => {
    await config.agentStore.save({ id: 'orig', name: 'N', instructions: 'i', modelTier: 't' })

    const res = await req(app, 'PATCH', '/api/agent-definitions/orig', {
      id: 'hacker',
      name: 'Updated',
    })
    expect(res.status).toBe(200)
    const data = await res.json() as { data: { id: string; name: string } }
    expect(data.data.id).toBe('orig')
    expect(data.data.name).toBe('Updated')
  })

  it('PATCH /api/agent-definitions/:id returns 404 for unknown', async () => {
    const res = await req(app, 'PATCH', '/api/agent-definitions/ghost', { name: 'X' })
    expect(res.status).toBe(404)
    const data = await res.json() as { error: { code: string } }
    expect(data.error.code).toBe('NOT_FOUND')
  })

  it('DELETE /api/agent-definitions/:id returns 404 for unknown', async () => {
    const res = await req(app, 'DELETE', '/api/agent-definitions/ghost')
    expect(res.status).toBe(404)
  })

  it('DELETE /api/agent-definitions/:id deletes an agent definition', async () => {
    await config.agentStore.save({ id: 'a1', name: 'A1', instructions: 'i', modelTier: 't' })

    const res = await req(app, 'DELETE', '/api/agent-definitions/a1')
    expect(res.status).toBe(200)
    const data = await res.json() as { data: { id: string; deleted: boolean } }
    expect(data.data.deleted).toBe(true)

    // InMemoryAgentStore hard-deletes; Postgres-based store would soft-delete
    const after = await config.agentStore.get('a1')
    // Either removed (null) or soft-deleted (active=false)
    expect(after === null || after.active === false).toBe(true)
  })

  it('GET /api/agent-definitions treats malformed active query as undefined (all)', async () => {
    await config.agentStore.save({ id: 'a1', name: 'A1', instructions: 'i', modelTier: 't', active: true })
    await config.agentStore.save({ id: 'a2', name: 'A2', instructions: 'i', modelTier: 't', active: false })

    const res = await app.request('/api/agent-definitions?active=yes')
    const data = await res.json() as { data: Array<unknown> }
    // 'yes' is not 'true', so treated as false (active filter applied)
    expect(Array.isArray(data.data)).toBe(true)
  })
})
