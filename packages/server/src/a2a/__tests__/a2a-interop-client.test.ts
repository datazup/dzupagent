/**
 * A2A-05: independent-client interoperability for the DzupAgent A2A surface.
 *
 * The client below is written from the protocol alone: plain `node:http` over a real
 * socket (the repository lint bans raw `fetch`) and JSON-RPC 2.0 envelopes. It imports nothing from DzupAgent's own
 * client, types or helpers, so a defect shared by both sides of an in-repo helper
 * cannot hide. Protocol constants are literals taken from the JSON-RPC 2.0 and A2A
 * specifications. Dialects under test: the legacy one (card at `/.well-known/agent.json`, methods
 * `tasks/send`, `tasks/get`, `tasks/cancel` on `POST /a2a`) and A2A v0.3.0 (card at
 * `/.well-known/agent-card.json`, method `message/send`; A2A-05-SERVER-V030-20261108-R1).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Hono } from 'hono'
import { InMemoryA2ATaskStore } from '../task-handler.js'
import { createA2ARoutes } from '../../routes/a2a.js'
import { buildAgentCard } from '../agent-card.js'

const JSONRPC_PARSE_ERROR = -32700
const JSONRPC_INVALID_REQUEST = -32600
const JSONRPC_METHOD_NOT_FOUND = -32601
const JSONRPC_INVALID_PARAMS = -32602
const A2A_TASK_NOT_FOUND = -32001
const A2A_TASK_NOT_CANCELABLE = -32002
const A2A_CONTENT_TYPE_NOT_SUPPORTED = -32005

interface Envelope {
  jsonrpc: string
  id: unknown
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

interface Wire {
  status: number
  type: string | null
  text: string
}

/** One HTTP exchange over a real socket, with no DzupAgent code on the client side. */
function exchange(url: string, method: 'GET' | 'POST', headers: Record<string, string>, body?: string): Promise<Wire> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          type: typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : null,
          text: Buffer.concat(chunks).toString('utf8'),
        })
      )
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

class RawClient {
  private nextId = 1
  constructor(
    private readonly base: string,
    private readonly headers: Record<string, string> = {}
  ) {}

  async card(path = '/.well-known/agent.json'): Promise<{ status: number; type: string | null; body: Record<string, unknown> }> {
    const res = await exchange(`${this.base}${path}`, 'GET', this.headers)
    const body = res.status === 200 ? (JSON.parse(res.text) as Record<string, unknown>) : {}
    return { status: res.status, type: res.type, body }
  }

  async call(method: string, params?: Record<string, unknown>): Promise<Envelope> {
    const id = this.nextId++
    const res = await exchange(
      `${this.base}/a2a`,
      'POST',
      { 'content-type': 'application/json', ...this.headers },
      JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })
    )
    expect(res.status).toBe(200)
    const body = JSON.parse(res.text) as Envelope
    expect(body.jsonrpc).toBe('2.0')
    expect(body.id).toBe(id)
    return body
  }

  async raw(body: string): Promise<{ status: number; json: unknown }> {
    const res = await exchange(`${this.base}/a2a`, 'POST', { 'content-type': 'application/json', ...this.headers }, body)
    return { status: res.status, json: JSON.parse(res.text) }
  }
}

/** Credentials as the fixture middleware reads them: an owner (key id) and a tenant, independently. */
const as = (owner: string, tenant: string) => ({ 'x-test-owner': owner, 'x-test-tenant': tenant })

const textMessage = (text: string) => ({ role: 'user', parts: [{ type: 'text', text }] })

/** A message as an A2A v0.3.0 client writes it. */
const v030Message = (text: string, messageId: string) => ({
  kind: 'message',
  messageId,
  role: 'user',
  parts: [{ kind: 'text', text }],
})

describe('A2A independent-client interoperability (DzupAgent server)', () => {
  let server: ServerType
  let base = ''

  beforeAll(async () => {
    const app = new Hono()
    // Same shape the production auth middleware leaves on the context.
    app.use('*', async (c, next) => {
      const owner = c.req.header('x-test-owner')
      const tenant = c.req.header('x-test-tenant')
      if (owner && tenant) c.set('apiKey' as never, { id: owner, tenantId: tenant } as never)
      await next()
    })
    const agentCard = buildAgentCard({
      name: 'interop-server',
      description: 'Interop fixture',
      baseUrl: 'http://localhost',
      version: '1.2.3',
      agents: [{ name: 'echo-agent', description: 'Echoes input' }],
    })
    app.route('', createA2ARoutes({ agentCard, taskStore: new InMemoryA2ATaskStore() }))
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => {
        base = `http://127.0.0.1:${info.port}`
        resolve()
      })
    })
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('discovers a well-formed agent card without credentials', async () => {
    const { status, type, body } = await new RawClient(base).card()
    expect(status).toBe(200)
    expect(type).toMatch(/application\/json/)
    expect(body).toMatchObject({ name: 'interop-server', version: '1.2.3' })
    expect(typeof body['url']).toBe('string')
    expect(body['capabilities']).toEqual([
      { name: 'echo-agent', description: 'Echoes input', inputSchema: { type: 'object', properties: {} } },
    ])
  })

  it('drives tasks/send, tasks/get and tasks/cancel as a plain JSON-RPC client', async () => {
    const client = new RawClient(base, as('alice', 'tenant-1'))
    const sent = await client.call('tasks/send', { message: textMessage('hello'), agentName: 'echo-agent' })
    expect(sent.error).toBeUndefined()
    const task = sent.result as { id: string; state: string }
    expect(typeof task.id).toBe('string')
    expect(task.state).toBe('submitted')

    const fetched = await client.call('tasks/get', { id: task.id })
    expect((fetched.result as { id: string }).id).toBe(task.id)

    const cancelled = await client.call('tasks/cancel', { id: task.id })
    expect((cancelled.result as { state: string }).state).toBe('cancelled')

    const again = await client.call('tasks/get', { id: task.id })
    expect((again.result as { state: string }).state).toBe('cancelled')

    const second = await client.call('tasks/cancel', { id: task.id })
    expect(second.error?.code).toBe(A2A_TASK_NOT_CANCELABLE)
  })

  it('reports JSON-RPC errors with the specified codes', async () => {
    const client = new RawClient(base, as('alice', 'tenant-1'))
    expect((await client.call('tasks/nope')).error?.code).toBe(JSONRPC_METHOD_NOT_FOUND)
    expect((await client.call('tasks/send', { agentName: 'echo-agent' })).error?.code).toBe(JSONRPC_INVALID_PARAMS)
    expect((await client.call('tasks/get', {})).error?.code).toBe(JSONRPC_INVALID_PARAMS)
    expect((await client.call('tasks/get', { id: 'no-such-task' })).error?.code).toBe(A2A_TASK_NOT_FOUND)
    expect(((await client.raw('{not json')).json as Envelope).error?.code).toBe(JSONRPC_PARSE_ERROR)
    expect(((await client.raw('{"jsonrpc":"1.0","id":1,"method":"tasks/get"}')).json as Envelope).error?.code).toBe(
      JSONRPC_INVALID_REQUEST
    )
  })

  it('answers a batch with one response per request, matched by id', async () => {
    const client = new RawClient(base, as('alice', 'tenant-1'))
    const { json } = await client.raw(
      JSON.stringify([
        { jsonrpc: '2.0', id: 'a', method: 'tasks/send', params: { message: textMessage('batch'), agentName: 'echo-agent' } },
        { jsonrpc: '2.0', id: 'b', method: 'tasks/get', params: { id: 'missing' } },
      ])
    )
    const responses = json as Envelope[]
    expect(responses.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(responses[0]?.result).toBeDefined()
    expect(responses[1]?.error?.code).toBe(A2A_TASK_NOT_FOUND)
  })

  it('does not reveal another caller\'s task: a different owner or a different tenant sees an unknown task', async () => {
    const alice = new RawClient(base, as('alice', 'tenant-1'))
    const task = (await alice.call('tasks/send', { message: textMessage('private'), agentName: 'echo-agent' }))
      .result as { id: string }
    const sameTenantOtherOwner = new RawClient(base, as('bob', 'tenant-1'))
    const sameOwnerOtherTenant = new RawClient(base, as('alice', 'tenant-2'))
    for (const intruder of [sameTenantOtherOwner, sameOwnerOtherTenant]) {
      expect((await intruder.call('tasks/get', { id: task.id })).error?.code).toBe(A2A_TASK_NOT_FOUND)
      expect((await intruder.call('tasks/cancel', { id: task.id })).error?.code).toBe(A2A_TASK_NOT_FOUND)
    }
    const owned = (await alice.call('tasks/get', { id: task.id })).result as { id: string; state: string }
    expect([owned.id, owned.state]).toEqual([task.id, 'submitted'])
  })

  it('serves an A2A v0.3.0 agent card at /.well-known/agent-card.json without credentials', async () => {
    const { status, type, body } = await new RawClient(base).card('/.well-known/agent-card.json')
    expect(status).toBe(200)
    expect(type).toMatch(/application\/json/)
    expect(body).toEqual({
      protocolVersion: '0.3.0',
      name: 'interop-server',
      description: 'Interop fixture',
      url: 'http://localhost/a2a',
      preferredTransport: 'JSONRPC',
      version: '1.2.3',
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [{ id: 'echo-agent', name: 'echo-agent', description: 'Echoes input', tags: [] }],
    })
  })

  it('message/send creates a task and answers with a v0.3.0 Task whose history holds the message just sent', async () => {
    const client = new RawClient(base, as('alice', 'tenant-1'))
    const sent = await client.call('message/send', { message: v030Message('hello', 'client-msg-1'), metadata: { agentName: 'echo-agent' } })
    expect(sent.error).toBeUndefined()
    const task = sent.result as Record<string, unknown>
    const id = task['id'] as string
    expect(task).toEqual({
      kind: 'task',
      id,
      contextId: id,
      status: { state: 'submitted', timestamp: expect.any(String) },
      history: [{ kind: 'message', messageId: `${id}-m0`, role: 'user', parts: [{ kind: 'text', text: 'hello' }] }],
      artifacts: [],
      metadata: { agentName: 'echo-agent' },
    })
    // The same task is visible through the legacy dialect, so the two share one store.
    expect(((await client.call('tasks/get', { id })).result as { agentName: string }).agentName).toBe('echo-agent')
  })

  it('message/send echoes a supplied contextId and accepts data parts', async () => {
    const client = new RawClient(base, as('alice', 'tenant-1'))
    const message = { ...v030Message('x', 'm-ctx'), contextId: 'ctx-7', parts: [{ kind: 'data', data: { a: 1 } }] }
    const task = (await client.call('message/send', { message })).result as { contextId: string; history: unknown[] }
    expect(task.contextId).toBe('ctx-7')
    expect(task.history).toEqual([expect.objectContaining({ parts: [{ kind: 'data', data: { a: 1 } }] })])
  })

  it('message/send reports an unknown taskId as task not found, never as a new task', async () => {
    const client = new RawClient(base, as('alice', 'tenant-1'))
    const before = (await client.call('tasks/get', { id: 'a2a-task-never' })).error?.code
    expect(before).toBe(A2A_TASK_NOT_FOUND)
    const reply = await client.call('message/send', { message: { ...v030Message('hi', 'm-unknown'), taskId: 'a2a-task-never' } })
    expect(reply.error?.code).toBe(A2A_TASK_NOT_FOUND)
    expect((await client.call('tasks/get', { id: 'a2a-task-never' })).error?.code).toBe(A2A_TASK_NOT_FOUND)
  })

  it('message/send does not reveal or touch another owner\'s or tenant\'s task', async () => {
    const alice = new RawClient(base, as('alice', 'tenant-1'))
    const task = (await alice.call('message/send', { message: v030Message('mine', 'm-a') })).result as { id: string }
    for (const headers of [as('bob', 'tenant-1'), as('alice', 'tenant-2'), as('bob', 'tenant-2')]) {
      const other = new RawClient(base, headers)
      const reply = await other.call('message/send', { message: { ...v030Message('intrude', 'm-x'), taskId: task.id } })
      expect(reply.error?.code).toBe(A2A_TASK_NOT_FOUND)
    }
    const owned = (await alice.call('tasks/get', { id: task.id })).result as { messages: unknown[] }
    expect(owned.messages).toHaveLength(1)
  })

  it('message/send refuses file parts and malformed messages with the specified codes', async () => {
    const client = new RawClient(base, as('alice', 'tenant-1'))
    const file = { ...v030Message('x', 'm-f'), parts: [{ kind: 'file', file: { uri: 'https://example.invalid/f' } }] }
    expect((await client.call('message/send', { message: file })).error?.code).toBe(A2A_CONTENT_TYPE_NOT_SUPPORTED)
    const { messageId: _omitted, ...noId } = v030Message('x', 'm-n')
    for (const message of [
      noId,
      { ...v030Message('x', 'm-r'), role: 'system' },
      { ...v030Message('x', 'm-e'), parts: [] },
      { ...v030Message('x', 'm-t'), parts: [{ kind: 'text' }] },
      { ...v030Message('x', 'm-u'), parts: [{ kind: 'video' }] },
      'not an object',
    ]) {
      expect((await client.call('message/send', { message })).error?.code).toBe(JSONRPC_INVALID_PARAMS)
    }
    expect((await client.call('message/send')).error?.code).toBe(JSONRPC_INVALID_PARAMS)
    expect((await client.call('message/send', {})).error?.code).toBe(JSONRPC_INVALID_PARAMS)
  })
})

/**
 * In-process app with store access: the states and artifacts a socket client cannot create on its own, and the
 * proof that the legacy surface is unchanged. Expected bytes are literals captured from an unmodified checkout of
 * DzupAgent base 98e8e37ab9854395cff9867985f5c68df403a48a with the same fixture and a fixed clock.
 */
describe('A2A v0.3.0 message/send with store access', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function build(extra: Partial<Parameters<typeof createA2ARoutes>[0]> = {}) {
    const store = new InMemoryA2ATaskStore()
    const app = new Hono()
    const agentCard = buildAgentCard({
      name: 'interop-server',
      description: 'Interop fixture',
      baseUrl: 'http://localhost',
      version: '1.2.3',
      agents: [{ name: 'echo-agent', description: 'Echoes input' }],
    })
    app.route('', createA2ARoutes({ agentCard, taskStore: store, ...extra }))
    const post = async (body: unknown) =>
      (await app.request('/a2a', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).text()
    return { app, store, post }
  }

  it('continues an input-required task: working state, populated history with synthesized ids, populated artifacts', async () => {
    const { store, post } = build()
    const created = await store.create({ agentName: 'echo-agent', input: 'q', state: 'input-required', ownerId: null, tenantId: null })
    await store.appendMessage(created.id, { role: 'agent', parts: [{ type: 'text', text: 'which one?' }] })
    await store.addArtifact(created.id, { name: 'draft', parts: [{ type: 'text', text: 'v1' }] })
    const reply = JSON.parse(await post({
      jsonrpc: '2.0', id: 9, method: 'message/send', params: { message: { ...v030Message('the first', 'm-c'), taskId: created.id } },
    })) as { result: Record<string, unknown> }
    expect(reply.result).toEqual({
      kind: 'task',
      id: created.id,
      contextId: created.id,
      status: { state: 'working', timestamp: expect.any(String) },
      history: [
        { kind: 'message', messageId: `${created.id}-m0`, role: 'agent', parts: [{ kind: 'text', text: 'which one?' }] },
        { kind: 'message', messageId: `${created.id}-m1`, role: 'user', parts: [{ kind: 'text', text: 'the first' }] },
      ],
      artifacts: [{ artifactId: `${created.id}-a0`, name: 'draft', parts: [{ kind: 'text', text: 'v1' }] }],
    })
  })

  it('hands a new task to the host callback exactly as tasks/send does', async () => {
    const seen: string[] = []
    const { post } = build({ onTaskSubmitted: async (task) => { seen.push(`${task.agentName}:${String(task.input)}`) } })
    await post({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: v030Message('ping', 'm-cb'), metadata: { agentName: 'echo-agent' } } })
    expect(seen).toEqual(['echo-agent:ping'])
  })

  it('leaves the legacy surface byte for byte as at the base', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00.000Z') })
    const { app, post } = build()
    const card = await (await app.request('/.well-known/agent.json')).text()
    const sent = await post({ jsonrpc: '2.0', id: 1, method: 'tasks/send', params: { agentName: 'echo-agent', message: { role: 'user', parts: [{ type: 'text', text: 'hello' }] } } })
    const got = await post({ jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { id: 'a2a-task-1' } })
    expect(card).toBe(BASE_CARD)
    expect(sent).toBe(BASE_SENT)
    expect(got).toBe(BASE_GOT)
  })
})

const BASE_CARD = '{"name":"interop-server","description":"Interop fixture","url":"http://localhost","version":"1.2.3","capabilities":[{"name":"echo-agent","description":"Echoes input","inputSchema":{"type":"object","properties":{}}}],"skills":[{"name":"echo-agent","description":"Echoes input"}]}'
const BASE_SENT = '{"jsonrpc":"2.0","id":1,"result":{"agentName":"echo-agent","input":"hello","state":"submitted","ownerId":null,"tenantId":null,"id":"a2a-task-1","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z","messages":[],"artifacts":[]}}'
const BASE_GOT = '{"jsonrpc":"2.0","id":2,"result":{"agentName":"echo-agent","input":"hello","state":"submitted","ownerId":null,"tenantId":null,"id":"a2a-task-1","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z","messages":[{"role":"user","parts":[{"type":"text","text":"hello"}]}],"artifacts":[]}}'
