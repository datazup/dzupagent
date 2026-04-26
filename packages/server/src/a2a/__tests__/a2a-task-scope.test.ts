/**
 * RF-SEC-05: A2A task owner/tenant scope.
 *
 * Verifies that:
 *   - Tasks are stamped with the authenticated caller's `ownerId` and
 *     `tenantId` on creation (REST + JSON-RPC).
 *   - REST list/get/cancel filter by caller scope; cross-owner access is
 *     reported as 404 (not 403) to avoid existence enumeration.
 *   - JSON-RPC tasks/get and tasks/cancel mirror the same gating with
 *     TASK_NOT_FOUND.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { InMemoryA2ATaskStore } from '../task-handler.js'
import type { A2ATaskStore } from '../task-handler.js'
import { createA2ARoutes } from '../../routes/a2a.js'
import { buildAgentCard } from '../agent-card.js'

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

interface TestKey {
  id: string
  tenantId: string
}

/**
 * Build a Hono app that injects a synthetic apiKey context based on the
 * `X-Test-Key` request header. This mirrors the way the real auth middleware
 * sets `c.set('apiKey', keyMeta)` after validating the bearer token, so the
 * handlers under test exercise the same context shape they see in
 * production.
 */
function buildAppWithKeys(store: A2ATaskStore, keys: Record<string, TestKey>) {
  const agentCard = buildAgentCard({
    name: 'test-server',
    description: 'Test agent server',
    baseUrl: 'http://localhost:4000',
    version: '1.0.0',
    agents: [
      { name: 'test-agent', description: 'A test agent' },
      { name: 'code-agent', description: 'A code agent' },
    ],
  })

  const app = new Hono()
  // Synthetic auth middleware: reads X-Test-Key and sets the apiKey
  // context exactly like the production middleware would.
  app.use('*', async (c, next) => {
    const keyHeader = c.req.header('X-Test-Key')
    if (keyHeader && keys[keyHeader]) {
      c.set('apiKey' as never, keys[keyHeader] as never)
    }
    await next()
  })

  const routes = createA2ARoutes({ agentCard, taskStore: store })
  app.route('', routes)
  return app
}

async function jsonOf<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T
}

// ---------------------------------------------------------------------------
// REST denial tests
// ---------------------------------------------------------------------------

describe('A2A task scope (REST) — RF-SEC-05', () => {
  let store: InMemoryA2ATaskStore
  let app: ReturnType<typeof buildAppWithKeys>

  const keyAlice: TestKey = { id: 'key-alice', tenantId: 'alice-tenant' }
  const keyBob: TestKey = { id: 'key-bob', tenantId: 'bob-tenant' }

  beforeEach(() => {
    store = new InMemoryA2ATaskStore()
    app = buildAppWithKeys(store, { alice: keyAlice, bob: keyBob })
  })

  // -----------------------------------------------------------------------
  // POST /a2a/tasks stamps owner + tenant
  // -----------------------------------------------------------------------

  it('stamps ownerId and tenantId from the authenticated caller', async () => {
    const res = await app.request('/a2a/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Test-Key': 'alice',
      },
      body: JSON.stringify({ agentName: 'test-agent', input: 'hello' }),
    })
    expect(res.status).toBe(201)
    const task = await jsonOf<{ id: string; ownerId: string; tenantId: string }>(res)
    expect(task.ownerId).toBe('key-alice')
    expect(task.tenantId).toBe('alice-tenant')
  })

  // -----------------------------------------------------------------------
  // Cross-owner list returns only the caller's tasks
  // -----------------------------------------------------------------------

  it("does not list another caller's tasks", async () => {
    // Alice creates two tasks
    await app.request('/a2a/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Test-Key': 'alice' },
      body: JSON.stringify({ agentName: 'test-agent', input: 'a1' }),
    })
    await app.request('/a2a/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Test-Key': 'alice' },
      body: JSON.stringify({ agentName: 'test-agent', input: 'a2' }),
    })

    // Bob creates one
    await app.request('/a2a/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Test-Key': 'bob' },
      body: JSON.stringify({ agentName: 'test-agent', input: 'b1' }),
    })

    // Bob lists — should see only his own task
    const res = await app.request('/a2a/tasks', {
      method: 'GET',
      headers: { 'X-Test-Key': 'bob' },
    })
    expect(res.status).toBe(200)
    const body = await jsonOf<{ tasks: Array<{ ownerId: string; input: unknown }> }>(res)
    expect(body.tasks).toHaveLength(1)
    expect(body.tasks[0]?.ownerId).toBe('key-bob')
    expect(body.tasks[0]?.input).toBe('b1')
  })

  // -----------------------------------------------------------------------
  // Cross-owner get returns 404
  // -----------------------------------------------------------------------

  it("returns 404 when fetching another caller's task", async () => {
    const create = await app.request('/a2a/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Test-Key': 'alice' },
      body: JSON.stringify({ agentName: 'test-agent', input: 'secret' }),
    })
    const aliceTask = await jsonOf<{ id: string }>(create)

    const fetch = await app.request(`/a2a/tasks/${aliceTask.id}`, {
      method: 'GET',
      headers: { 'X-Test-Key': 'bob' },
    })
    expect(fetch.status).toBe(404)
    const err = await jsonOf<{ error: { code: string } }>(fetch)
    expect(err.error.code).toBe('NOT_FOUND')

    // Sanity check: alice can still see her own task
    const own = await app.request(`/a2a/tasks/${aliceTask.id}`, {
      method: 'GET',
      headers: { 'X-Test-Key': 'alice' },
    })
    expect(own.status).toBe(200)
  })

  // -----------------------------------------------------------------------
  // Cross-owner cancel returns 404
  // -----------------------------------------------------------------------

  it("returns 404 when cancelling another caller's task", async () => {
    const create = await app.request('/a2a/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Test-Key': 'alice' },
      body: JSON.stringify({ agentName: 'test-agent', input: 'do not cancel me' }),
    })
    const aliceTask = await jsonOf<{ id: string }>(create)

    // Bob attempts to cancel — must look like a missing task
    const cancel = await app.request(`/a2a/tasks/${aliceTask.id}/cancel`, {
      method: 'POST',
      headers: { 'X-Test-Key': 'bob' },
    })
    expect(cancel.status).toBe(404)
    const err = await jsonOf<{ error: { code: string } }>(cancel)
    expect(err.error.code).toBe('NOT_FOUND')

    // Alice's task must still be cancellable (i.e. not actually cancelled).
    const stillSubmitted = await store.get(aliceTask.id)
    expect(stillSubmitted?.state).toBe('submitted')

    // Alice cancels her own task — should succeed
    const ownCancel = await app.request(`/a2a/tasks/${aliceTask.id}/cancel`, {
      method: 'POST',
      headers: { 'X-Test-Key': 'alice' },
    })
    expect(ownCancel.status).toBe(200)
    const cancelled = await store.get(aliceTask.id)
    expect(cancelled?.state).toBe('cancelled')
  })

  // -----------------------------------------------------------------------
  // Cross-owner appendMessage returns 404
  // -----------------------------------------------------------------------

  it("returns 404 when appending a message to another caller's task", async () => {
    const create = await app.request('/a2a/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Test-Key': 'alice' },
      body: JSON.stringify({ agentName: 'test-agent', input: 'hello' }),
    })
    const aliceTask = await jsonOf<{ id: string }>(create)

    const res = await app.request(`/a2a/tasks/${aliceTask.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Test-Key': 'bob' },
      body: JSON.stringify({
        role: 'user',
        parts: [{ type: 'text', text: 'I am not Alice' }],
      }),
    })
    expect(res.status).toBe(404)
    const err = await jsonOf<{ error: { code: string } }>(res)
    expect(err.error.code).toBe('NOT_FOUND')
  })

  // -----------------------------------------------------------------------
  // Same-owner-different-tenant is also rejected
  // -----------------------------------------------------------------------

  it('rejects same-owner-different-tenant access', async () => {
    // Tasks stamped under tenant-1; caller is in tenant-2 with a fresh id.
    const aliceA: TestKey = { id: 'shared-id', tenantId: 'tenant-1' }
    const aliceB: TestKey = { id: 'shared-id', tenantId: 'tenant-2' }
    const localStore = new InMemoryA2ATaskStore()
    const localApp = buildAppWithKeys(localStore, { a: aliceA, b: aliceB })

    const create = await localApp.request('/a2a/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Test-Key': 'a' },
      body: JSON.stringify({ agentName: 'test-agent', input: 'cross tenant' }),
    })
    const created = await jsonOf<{ id: string; tenantId: string }>(create)
    expect(created.tenantId).toBe('tenant-1')

    const fetch = await localApp.request(`/a2a/tasks/${created.id}`, {
      method: 'GET',
      headers: { 'X-Test-Key': 'b' },
    })
    expect(fetch.status).toBe(404)
  })

  // -----------------------------------------------------------------------
  // Unauthenticated callers see legacy single-tenant behaviour
  // -----------------------------------------------------------------------

  it('preserves library default when no apiKey context is present', async () => {
    // No X-Test-Key on either request — apiKey context is never set.
    const create = await app.request('/a2a/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentName: 'test-agent', input: 'hi' }),
    })
    expect(create.status).toBe(201)
    const task = await jsonOf<{ id: string; ownerId: string | null }>(create)
    expect(task.ownerId).toBeNull()

    const fetch = await app.request(`/a2a/tasks/${task.id}`, { method: 'GET' })
    expect(fetch.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// JSON-RPC denial tests
// ---------------------------------------------------------------------------

describe('A2A task scope (JSON-RPC) — RF-SEC-05', () => {
  let store: InMemoryA2ATaskStore
  let app: ReturnType<typeof buildAppWithKeys>

  const keyAlice: TestKey = { id: 'jr-alice', tenantId: 'alice-tenant' }
  const keyBob: TestKey = { id: 'jr-bob', tenantId: 'bob-tenant' }

  beforeEach(() => {
    store = new InMemoryA2ATaskStore()
    app = buildAppWithKeys(store, { alice: keyAlice, bob: keyBob })
  })

  it('stamps ownerId/tenantId on tasks/send', async () => {
    const res = await app.request('/a2a', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Test-Key': 'alice' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/send',
        params: {
          agentName: 'test-agent',
          message: { role: 'user', parts: [{ type: 'text', text: 'hello' }] },
        },
      }),
    })
    expect(res.status).toBe(200)
    const body = await jsonOf<{ result: { id: string; ownerId: string; tenantId: string } }>(res)
    expect(body.result.ownerId).toBe('jr-alice')
    expect(body.result.tenantId).toBe('alice-tenant')
  })

  it("returns TASK_NOT_FOUND when fetching another caller's task via tasks/get", async () => {
    // Alice creates a task via JSON-RPC
    const create = await app.request('/a2a', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Test-Key': 'alice' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/send',
        params: {
          agentName: 'test-agent',
          message: { role: 'user', parts: [{ type: 'text', text: 'classified' }] },
        },
      }),
    })
    const aliceTask = await jsonOf<{ result: { id: string } }>(create)

    // Bob attempts tasks/get
    const fetch = await app.request('/a2a', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Test-Key': 'bob' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tasks/get',
        params: { id: aliceTask.result.id },
      }),
    })
    const body = await jsonOf<{ error: { code: number; message: string } }>(fetch)
    // A2A_ERRORS.TASK_NOT_FOUND === -32001
    expect(body.error.code).toBe(-32001)
  })

  it("returns TASK_NOT_FOUND when cancelling another caller's task via tasks/cancel", async () => {
    const create = await app.request('/a2a', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Test-Key': 'alice' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/send',
        params: {
          agentName: 'test-agent',
          message: { role: 'user', parts: [{ type: 'text', text: 'mine' }] },
        },
      }),
    })
    const aliceTask = await jsonOf<{ result: { id: string } }>(create)

    const cancel = await app.request('/a2a', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Test-Key': 'bob' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tasks/cancel',
        params: { id: aliceTask.result.id },
      }),
    })
    const body = await jsonOf<{ error: { code: number } }>(cancel)
    expect(body.error.code).toBe(-32001)

    // Alice's task must still be in the original state.
    const persisted = await store.get(aliceTask.result.id)
    expect(persisted?.state).toBe('submitted')
  })
})
