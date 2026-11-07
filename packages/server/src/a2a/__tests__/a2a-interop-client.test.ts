/**
 * A2A-05: independent-client interoperability for the DzupAgent A2A surface.
 *
 * The client below is written from the protocol alone: plain `node:http` over a real
 * socket (the repository lint bans raw `fetch`) and JSON-RPC 2.0 envelopes. It imports nothing from DzupAgent's own
 * client, types or helpers, so a defect shared by both sides of an in-repo helper
 * cannot hide. Protocol constants are literals taken from the JSON-RPC 2.0 and A2A
 * specifications. Dialect under test: card at `/.well-known/agent.json`, methods
 * `tasks/send`, `tasks/get`, `tasks/cancel` on `POST /a2a`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

const textMessage = (text: string) => ({ role: 'user', parts: [{ type: 'text', text }] })

describe('A2A independent-client interoperability (DzupAgent server)', () => {
  let server: ServerType
  let base = ''

  beforeAll(async () => {
    const app = new Hono()
    // Same shape the production auth middleware leaves on the context.
    app.use('*', async (c, next) => {
      const key = c.req.header('x-test-key')
      if (key) c.set('apiKey' as never, { id: key, tenantId: `tenant-${key}` } as never)
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
    const capabilities = body['capabilities'] as Array<Record<string, unknown>>
    expect(capabilities.map((entry) => entry['name'])).toEqual(['echo-agent'])
  })

  it('drives tasks/send, tasks/get and tasks/cancel as a plain JSON-RPC client', async () => {
    const client = new RawClient(base, { 'x-test-key': 'alice' })
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
    const client = new RawClient(base, { 'x-test-key': 'alice' })
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
    const client = new RawClient(base, { 'x-test-key': 'alice' })
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

  it('does not reveal another caller\'s task: cross-owner reads look like unknown tasks', async () => {
    const alice = new RawClient(base, { 'x-test-key': 'alice' })
    const bob = new RawClient(base, { 'x-test-key': 'bob' })
    const task = (await alice.call('tasks/send', { message: textMessage('private'), agentName: 'echo-agent' }))
      .result as { id: string }
    expect((await bob.call('tasks/get', { id: task.id })).error?.code).toBe(A2A_TASK_NOT_FOUND)
    expect((await bob.call('tasks/cancel', { id: task.id })).error?.code).toBe(A2A_TASK_NOT_FOUND)
    expect((await alice.call('tasks/get', { id: task.id })).result).toBeDefined()
  })

  it('records the dialect gap against v0.3.0: message/send and /.well-known/agent-card.json are not served', async () => {
    const client = new RawClient(base, { 'x-test-key': 'alice' })
    expect((await client.call('message/send', { message: textMessage('hi') })).error?.code).toBe(JSONRPC_METHOD_NOT_FOUND)
    expect((await client.card('/.well-known/agent-card.json')).status).toBe(404)
  })
})
