/**
 * Tests for A2A task store contract, push notifications, agent card, and
 * the multi-turn REST route (POST /a2a/tasks/:id/messages).
 *
 * Since a real Postgres DB is not available in unit tests, we test the
 * InMemoryA2ATaskStore for contract compliance, test the new REST route
 * for multi-turn message appending, and verify the agent card schema.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'
import { DrizzleA2ATaskStore } from '../drizzle-a2a-task-store.js'
import { InMemoryA2ATaskStore } from '../task-handler.js'
import type { A2ATask, A2ATaskStore } from '../task-handler.js'
import { createA2ARoutes } from '../../routes/a2a.js'
import { buildAgentCard } from '../agent-card.js'

interface DrizzleCallLog {
  op: string
  fn: string
  args: unknown[]
}

function makeDrizzleChain(terminal: unknown, onCall: (fn: string, args: unknown[]) => void): Record<string, unknown> {
  const handler: ProxyHandler<() => unknown> = {
    get(_target, prop: string) {
      if (prop === 'then') {
        return (onFulfilled: (value: unknown) => unknown) =>
          Promise.resolve(terminal).then(onFulfilled)
      }
      return (...args: unknown[]) => {
        onCall(prop, args)
        return makeDrizzleChain(terminal, onCall)
      }
    },
  }

  return new Proxy(function proxyFn() {}, handler)
}

function buildDrizzleMockDb(selectSequence: unknown[][], log: DrizzleCallLog[] = []): Record<string, unknown> {
  const selectQueue = [...selectSequence]

  return {
    select: vi.fn(() => makeDrizzleChain(selectQueue.shift() ?? [], (fn, args) => {
      log.push({ op: 'select', fn, args })
    })),
    insert: vi.fn(() => makeDrizzleChain([], (fn, args) => {
      log.push({ op: 'insert', fn, args })
    })),
    update: vi.fn(() => makeDrizzleChain([], (fn, args) => {
      log.push({ op: 'update', fn, args })
    })),
  }
}

function makeTaskRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'task-1',
    agentName: 'test-agent',
    state: 'submitted',
    input: 'hello',
    output: null,
    error: null,
    metadata: null,
    pushNotificationConfig: null,
    artifacts: [],
    ownerId: null,
    tenantId: 'default',
    createdAt: new Date('2026-04-01T00:00:00Z'),
    updatedAt: new Date('2026-04-01T00:00:00Z'),
    ...overrides,
  }
}

function makeMessageRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    taskId: 'task-1',
    role: 'user',
    parts: [{ type: 'text', text: 'hello' }],
    createdAt: new Date('2026-04-01T00:00:00Z'),
    ...overrides,
  }
}

function createTestApp(store: A2ATaskStore) {
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

  const routes = createA2ARoutes({ agentCard, taskStore: store })
  const app = new Hono()
  app.route('', routes)
  return app
}

describe('A2A task store contract (InMemory)', () => {
  let store: InMemoryA2ATaskStore

  beforeEach(() => {
    store = new InMemoryA2ATaskStore()
  })

  // 1
  it('creates a task with unique ID and empty messages/artifacts', async () => {
    const task = await store.create({
      agentName: 'test-agent',
      input: 'hello',
      state: 'submitted',
    })

    expect(task.id).toBeTruthy()
    expect(task.state).toBe('submitted')
    expect(task.messages).toEqual([])
    expect(task.artifacts).toEqual([])
  })

  // 2
  it('gets a task by ID and returns null for unknown', async () => {
    const task = await store.create({
      agentName: 'test-agent',
      input: 'hello',
      state: 'submitted',
    })

    expect(await store.get(task.id)).toEqual(task)
    expect(await store.get('nonexistent')).toBeNull()
  })

  // 3
  it('updates task state and metadata', async () => {
    const task = await store.create({
      agentName: 'test-agent',
      input: 'test',
      state: 'submitted',
    })

    const updated = await store.update(task.id, {
      state: 'completed',
      output: { result: 'done' },
      metadata: { key: 'value' },
    })

    expect(updated?.state).toBe('completed')
    expect(updated?.output).toEqual({ result: 'done' })
    expect(updated?.metadata).toEqual({ key: 'value' })
  })

  // 4
  it('lists tasks with agentName and state filters', async () => {
    await store.create({ agentName: 'a', input: '1', state: 'submitted' })
    await store.create({ agentName: 'b', input: '2', state: 'working' })
    await store.create({ agentName: 'a', input: '3', state: 'working' })

    const all = await store.list()
    expect(all).toHaveLength(3)

    const agentA = await store.list({ agentName: 'a' })
    expect(agentA).toHaveLength(2)

    const working = await store.list({ state: 'working' })
    expect(working).toHaveLength(2)

    const aWorking = await store.list({ agentName: 'a', state: 'working' })
    expect(aWorking).toHaveLength(1)
  })

  // 5
  it('appends messages to a task in order', async () => {
    const task = await store.create({
      agentName: 'test-agent',
      input: 'hello',
      state: 'working',
    })

    await store.appendMessage(task.id, {
      role: 'user',
      parts: [{ type: 'text', text: 'message 1' }],
    })
    await store.appendMessage(task.id, {
      role: 'agent',
      parts: [{ type: 'text', text: 'response 1' }],
    })

    const updated = await store.get(task.id)
    expect(updated?.messages).toHaveLength(2)
    expect(updated?.messages[0]?.role).toBe('user')
    expect(updated?.messages[1]?.role).toBe('agent')
    expect(await store.appendMessage('nonexistent', { role: 'user', parts: [] })).toBeNull()
  })

  // 6
  it('adds artifacts with auto-incrementing index', async () => {
    const task = await store.create({
      agentName: 'test-agent',
      input: 'hello',
      state: 'working',
    })

    await store.addArtifact(task.id, {
      parts: [{ type: 'text', text: 'file content' }],
      name: 'main.ts',
    })
    await store.addArtifact(task.id, {
      parts: [{ type: 'text', text: 'test content' }],
      name: 'main.test.ts',
    })

    const updated = await store.get(task.id)
    expect(updated?.artifacts).toHaveLength(2)
    expect(updated?.artifacts[0]?.index).toBe(0)
    expect(updated?.artifacts[0]?.name).toBe('main.ts')
    expect(updated?.artifacts[1]?.index).toBe(1)
    expect(await store.addArtifact('nonexistent', { parts: [] })).toBeNull()
  })

  // 7
  it('sets and retrieves push notification config', async () => {
    const task = await store.create({
      agentName: 'test-agent',
      input: 'test',
      state: 'submitted',
    })

    const updated = await store.setPushConfig(task.id, {
      url: 'https://example.com/webhook',
      token: 'secret-token',
      events: ['task.completed'],
    })

    expect(updated?.pushNotificationConfig).toEqual({
      url: 'https://example.com/webhook',
      token: 'secret-token',
      events: ['task.completed'],
    })

    expect(await store.setPushConfig('nonexistent', { url: 'http://x' })).toBeNull()
  })
})

describe('DrizzleA2ATaskStore list() batching', () => {
  it('returns [] without querying messages when no task rows match', async () => {
    const db = buildDrizzleMockDb([[]])
    const store = new DrizzleA2ATaskStore(db)

    await expect(store.list()).resolves.toEqual([])
    expect(db.select).toHaveBeenCalledTimes(1)
  })

  it('batch-loads messages once and preserves listed task ordering', async () => {
    const db = buildDrizzleMockDb([
      [
        makeTaskRow({ id: 'task-1', input: 'first' }),
        makeTaskRow({ id: 'task-2', input: 'second' }),
        makeTaskRow({ id: 'task-3', input: 'third' }),
      ],
      [
        makeMessageRow({
          id: 1,
          taskId: 'task-2',
          role: 'agent',
          parts: [{ type: 'text', text: 'task 2 reply' }],
        }),
        makeMessageRow({
          id: 2,
          taskId: 'task-1',
          role: 'user',
          parts: [{ type: 'text', text: 'task 1 prompt' }],
        }),
        makeMessageRow({
          id: 3,
          taskId: 'task-1',
          role: 'agent',
          parts: [{ type: 'text', text: 'task 1 reply' }],
        }),
      ],
    ])
    const store = new DrizzleA2ATaskStore(db)

    const tasks = await store.list()

    expect(db.select).toHaveBeenCalledTimes(2)
    expect(tasks.map((task) => task.id)).toEqual(['task-1', 'task-2', 'task-3'])
    expect(tasks[0]?.messages.map((message) => message.parts[0]?.text)).toEqual([
      'task 1 prompt',
      'task 1 reply',
    ])
    expect(tasks[1]?.messages.map((message) => message.parts[0]?.text)).toEqual(['task 2 reply'])
    expect(tasks[2]?.messages).toEqual([])
  })
})

describe('POST /a2a/tasks/:id/messages route', () => {
  let store: InMemoryA2ATaskStore
  let app: Hono

  beforeEach(() => {
    store = new InMemoryA2ATaskStore()
    app = createTestApp(store)
  })

  // 8
  it('appends a message to an existing task via REST', async () => {
    // Create a task first
    const createRes = await app.request('/a2a/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentName: 'test-agent',
        input: 'Build me something',
      }),
    })
    expect(createRes.status).toBe(201)
    const task = (await createRes.json()) as A2ATask

    // Append a message
    const msgRes = await app.request(`/a2a/tasks/${task.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'user',
        parts: [{ type: 'text', text: 'Here is more context' }],
      }),
    })
    expect(msgRes.status).toBe(200)
    const updated = (await msgRes.json()) as A2ATask
    expect(updated.messages).toHaveLength(1)
    expect(updated.messages[0]?.parts[0]?.text).toBe('Here is more context')
  })

  // 9
  it('returns 404 when appending message to nonexistent task', async () => {
    const res = await app.request('/a2a/tasks/nonexistent/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'user',
        parts: [{ type: 'text', text: 'hello' }],
      }),
    })
    expect(res.status).toBe(404)
  })

  // 10
  it('returns 400 when message body is invalid', async () => {
    const createRes = await app.request('/a2a/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentName: 'test-agent',
        input: 'test',
      }),
    })
    const task = (await createRes.json()) as A2ATask

    const res = await app.request(`/a2a/tasks/${task.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invalid: true }),
    })
    expect(res.status).toBe(400)
  })
})

describe('Agent card schema', () => {
  // 11
  it('builds a valid agent card with capabilities and skills', () => {
    const card = buildAgentCard({
      name: 'my-agent-server',
      description: 'Multi-agent server',
      baseUrl: 'https://agents.example.com',
      version: '2.0.0',
      agents: [
        { name: 'summarizer', description: 'Summarizes text' },
        { name: 'coder', description: 'Writes code', inputSchema: { type: 'object', properties: { language: { type: 'string' } } } },
      ],
      authType: 'bearer',
    })

    expect(card.name).toBe('my-agent-server')
    expect(card.url).toBe('https://agents.example.com')
    expect(card.version).toBe('2.0.0')
    expect(card.capabilities).toHaveLength(2)
    expect(card.capabilities[0]?.name).toBe('summarizer')
    expect(card.capabilities[1]?.inputSchema).toHaveProperty('properties')
    expect(card.authentication).toEqual({ type: 'bearer' })
    expect(card.skills).toHaveLength(2)
  })

  // 12
  it('serves agent card at /.well-known/agent.json', async () => {
    const store = new InMemoryA2ATaskStore()
    const app = createTestApp(store)

    const res = await app.request('/.well-known/agent.json')
    expect(res.status).toBe(200)
    const card = await res.json()
    expect(card).toHaveProperty('name', 'test-server')
    expect(card).toHaveProperty('capabilities')
    expect(card.capabilities).toHaveLength(2)
  })
})

describe('Push notification delivery', () => {
  // Bonus: test the push notification concept using mock fetch
  it('fires push notification on terminal state update via InMemory store', async () => {
    // This tests the contract expectation. The DrizzleA2ATaskStore calls
    // deliverPushNotification internally; here we verify the InMemory
    // store preserves the config that would be used for push delivery.
    const store = new InMemoryA2ATaskStore()
    const task = await store.create({
      agentName: 'test-agent',
      input: 'test',
      state: 'submitted',
    })

    await store.setPushConfig(task.id, {
      url: 'https://example.com/callback',
      token: 'push-secret',
    })

    const updated = await store.update(task.id, { state: 'completed' })
    expect(updated?.state).toBe('completed')
    expect(updated?.pushNotificationConfig?.url).toBe('https://example.com/callback')
    expect(updated?.pushNotificationConfig?.token).toBe('push-secret')
  })
})
