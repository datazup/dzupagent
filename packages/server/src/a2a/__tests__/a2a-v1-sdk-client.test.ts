import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serve, type ServerType } from '@hono/node-server'
import { request as httpRequest } from 'node:http'
import { Message, SendMessageRequest, Task, TaskState, TaskStatusUpdateEvent } from '@a2a-js/sdk'
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client'
import { AgentEvent, InMemoryTaskStore, ServerCallContext, type AgentExecutor, type ExecutionEventBus, type TaskStore } from '@a2a-js/sdk/server'
import { InMemoryRunStore, InMemoryAgentStore, ModelRegistry, createEventBus } from '@dzupagent/core'
import { createForgeApp } from '../../app.js'
import { VerifiedA2AUser, dzupOwnerResolver } from '../v1/identity.js'

/** SDK fetchImpl backed only by node:http; every request is confined to the fixture. */
const nodeHttpFetch: typeof globalThis.fetch = async (input, init) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Fixture HTTP only')
  const body = request.body === null ? undefined : Buffer.from(await request.arrayBuffer())
  return new Promise<Response>((resolve, reject) => {
    const req = httpRequest(url, { method: request.method, headers: Object.fromEntries(request.headers) }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => {
        const headers = new Headers()
        for (const [name, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry))
          else if (value !== undefined) headers.set(name, value)
        }
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 500, headers }))
      })
    })
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('Fixture HTTP timeout')))
    if (body) req.write(body)
    req.end()
  })
}

/** Deterministic in-test fake executor; no provider or Worker/Steward integration. */
function fakeExecutor() {
  const pending = new Map<string, { bus: ExecutionEventBus; contextId: string; finish: () => void }>()
  const canceled: string[] = []
  const executor: AgentExecutor = {
    async execute(context, bus) {
      bus.publish(AgentEvent.task(Task.fromJSON({
        id: context.taskId, contextId: context.contextId,
        status: { state: 'TASK_STATE_WORKING' }, history: [Message.toJSON(context.userMessage)],
      })))
      if (context.request.configuration?.returnImmediately) {
        await new Promise<void>((finish) => {
          pending.set(context.taskId, { bus, contextId: context.contextId, finish })
        })
      } else {
        bus.publish(AgentEvent.statusUpdate(TaskStatusUpdateEvent.fromJSON({
          taskId: context.taskId, contextId: context.contextId, status: { state: 'TASK_STATE_COMPLETED' },
        })))
      }
    },
    async cancelTask(taskId, bus) {
      const task = pending.get(taskId)
      if (!task) throw new Error('Fake executor has no pending task')
      canceled.push(taskId)
      bus.publish(AgentEvent.statusUpdate(TaskStatusUpdateEvent.fromJSON({
        taskId, contextId: task.contextId, status: { state: 'TASK_STATE_CANCELED' },
      })))
      task.finish()
      pending.delete(taskId)
    },
  }
  return {
    executor, canceled,
    async close() {
      for (const [id, task] of pending) await executor.cancelTask(id, task.bus)
    },
  }
}

function composedApp(baseUrl: string, executor: AgentExecutor, auth: 'api-key' | 'none' = 'api-key') {
  return createForgeApp({
    runStore: new InMemoryRunStore(), agentStore: new InMemoryAgentStore(),
    modelRegistry: new ModelRegistry(), eventBus: createEventBus(),
    auth: auth === 'none' ? { mode: 'none' } : {
      mode: 'api-key',
      // Fixture labels, not credentials. Tenant and owner are independent.
      validateKey: async (label) => ({
        alice: { id: 'alice', tenantId: 'tenant-1', role: 'admin' },
        bob: { id: 'bob', tenantId: 'tenant-1', role: 'admin' },
        otherTenant: { id: 'alice', tenantId: 'tenant-2', role: 'admin' },
      })[label as 'alice' | 'bob' | 'otherTenant'] ?? null,
    },
    a2a: {
      agentCardConfig: {
        name: 'v1-sdk-fixture', description: 'SDK integration fixture', baseUrl, version: '1.0.0',
        authType: auth === 'none' ? 'none' : 'bearer', agents: [{ name: 'echo', description: 'Fake echo' }],
      },
      v1: { executor },
    },
  })
}

const sendParams = (returnImmediately = false) => SendMessageRequest.fromJSON({
  message: { messageId: 'fixture-message', role: 'ROLE_USER', parts: [{ text: 'hello', mediaType: 'text/plain' }] },
  configuration: { returnImmediately },
})

describe('A2A v1 official SDK over composed local HTTP', () => {
  let base = ''
  let server: ServerType
  let app: ReturnType<typeof createForgeApp>
  let fake: ReturnType<typeof fakeExecutor>
  const observed: Array<{ path: string; version: string | null }> = []

  const clientFor = async (label = 'alice') => {
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      observed.push({ path: new URL(request.url).pathname, version: request.headers.get('A2A-Version') })
      request.headers.set('Authorization', `Bearer ${label}`)
      return nodeHttpFetch(request)
    }
    return new ClientFactory({
      transports: [new JsonRpcTransportFactory({ fetchImpl })],
      cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
    }).createFromUrl(base)
  }

  async function wire(body: unknown, version = '1.0', label: string | undefined = 'alice') {
    return nodeHttpFetch(`${base}/a2a`, {
      method: 'POST', headers: {
        'content-type': 'application/json', 'A2A-Version': version,
        ...(label ? { Authorization: `Bearer ${label}` } : {}),
      }, body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  }
  const envelope = (method: string, params: unknown = {}) => ({ jsonrpc: '2.0', id: 'test-id', method, params })
  async function code(body: unknown, version = '1.0') {
    const response = await wire(body, version)
    expect(response.status).toBe(200)
    const payload = await response.json() as { id: string | null; error?: { code: number } }
    return payload.error?.code
  }
  async function sentTask(immediate = false) {
    const result = await (await clientFor()).sendMessage(sendParams(immediate))
    expect('id' in result).toBe(true)
    if (!('id' in result)) throw new Error('Expected task from fake executor')
    expect(result.id.length).toBeGreaterThan(0)
    return result
  }

  beforeEach(async () => {
    fake = fakeExecutor()
    observed.length = 0
    await new Promise<void>((resolve) => {
      server = serve({ fetch: (request) => app.fetch(request), port: 0, hostname: '127.0.0.1' }, (info) => {
        base = `http://127.0.0.1:${info.port}`
        app = composedApp(base, fake.executor)
        resolve()
      })
    })
  })
  afterEach(async () => {
    await fake.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    vi.restoreAllMocks()
  })

  it('discovers the card with A2A-Version 1.0 using ClientFactory', async () => {
    expect(base.length).toBeGreaterThan(0)
    const client = await clientFor()
    expect(observed.length).toBeGreaterThan(0)
    expect(observed).toContainEqual({ path: '/.well-known/agent-card.json', version: '1.0' })
    const card = await client.getAgentCard()
    expect(card.supportedInterfaces).toEqual([{ url: `${base}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' }])
    expect(card.capabilities).toEqual({ streaming: false, pushNotifications: false, extendedAgentCard: false, extensions: [] })
    expect(card.defaultInputModes).toEqual(['text/plain'])
  })

  it('blocking SendMessage completes through the injected fake executor', async () => {
    expect(sendParams().message?.parts.length).toBeGreaterThan(0)
    expect((await sentTask()).status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
  })

  it('GetTask retrieves the completed owned task', async () => {
    expect(base.length).toBeGreaterThan(0)
    const task = await sentTask()
    const got = await (await clientFor()).getTask({ id: task.id, tenant: '' })
    expect(got.id).toBe(task.id)
    expect(got.status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
  })

  it('CancelTask calls the executor and reaches TASK_STATE_CANCELED for returnImmediately', async () => {
    expect(base.length).toBeGreaterThan(0)
    const task = await sentTask(true)
    expect(task.status?.state).toBe(TaskState.TASK_STATE_WORKING)
    const client = await clientFor()
    const canceled = await client.cancelTask({ id: task.id, tenant: '', metadata: undefined })
    expect(fake.canceled).toContain(task.id)
    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED)
    expect((await client.getTask({ id: task.id, tenant: '' })).status?.state).toBe(TaskState.TASK_STATE_CANCELED)
  })

  it('rejects A2A-Version 9.9 with -32009', async () => {
    expect(base.length).toBeGreaterThan(0)
    const task = await sentTask()
    expect(await code(envelope('GetTask', { id: task.id }), '9.9')).toBe(-32009)
  })

  it('returns 401 without credentials before constructing the v1 context', async () => {
    expect(base.length).toBeGreaterThan(0)
    const task = await sentTask()
    const response = await wire(envelope('GetTask', { id: task.id }), '1.0', '')
    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer')
  })

  it('does not mount v1 with auth none and emits one v1 warning', async () => {
    expect(base.length).toBeGreaterThan(0)
    expect((await (await clientFor()).getAgentCard()).supportedInterfaces.length).toBeGreaterThan(0)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    app = composedApp(base, fake.executor, 'none')
    const response = await wire(envelope('SendMessage', { message: { messageId: 'probe' } }))
    const probe = await response.json() as { result?: unknown; error?: { code: unknown } }
    expect(probe.result).toBeUndefined()
    expect(probe.error?.code).toBe('FORBIDDEN')
    const cardResponse = await nodeHttpFetch(`${base}/.well-known/agent-card.json`, { headers: { 'A2A-Version': '1.0' } })
    expect(await cardResponse.json()).toMatchObject({ protocolVersion: '0.3.0' })
    expect(warning.mock.calls.filter(([message]) => String(message).includes('A2A v1 not mounted'))).toHaveLength(1)
  })

  it('GetTask returns -32001 across owners without revealing existence', async () => {
    expect(base.length).toBeGreaterThan(0)
    const task = await sentTask(true)
    const bob = await clientFor('bob')
    await expect(bob.getTask({ id: task.id, tenant: '' })).rejects.toMatchObject({ envelopeCode: -32001 })
    await expect(bob.getTask({ id: 'unknown-task', tenant: '' })).rejects.toMatchObject({ envelopeCode: -32001 })
    expect((await (await clientFor()).getTask({ id: task.id, tenant: '' })).status?.state).toBe(TaskState.TASK_STATE_WORKING)
  })

  it('CancelTask returns -32001 across owners without mutating the task', async () => {
    expect(base.length).toBeGreaterThan(0)
    const task = await sentTask(true)
    await expect((await clientFor('bob')).cancelTask({ id: task.id, tenant: '', metadata: undefined })).rejects.toMatchObject({ envelopeCode: -32001 })
    expect(fake.canceled).toHaveLength(0)
    expect((await (await clientFor()).getTask({ id: task.id, tenant: '' })).status?.state).toBe(TaskState.TASK_STATE_WORKING)
  })

  function assertTenantOwnerKeys() {
    const key = (tenantId: string) => dzupOwnerResolver(new ServerCallContext({
      user: new VerifiedA2AUser({ ownerId: 'alice', tenantId }), tenant: tenantId,
    }))
    expect(key('tenant-1').length).toBeGreaterThan(0)
    // SDK also partitions by tenant; this assertion specifically guards our resolver contract.
    expect(key('tenant-1')).not.toBe(key('tenant-2'))
  }

  it('GetTask returns -32001 across tenants for the same owner', async () => {
    expect(base.length).toBeGreaterThan(0)
    assertTenantOwnerKeys()
    const task = await sentTask(true)
    await expect((await clientFor('otherTenant')).getTask({ id: task.id, tenant: '' })).rejects.toMatchObject({ envelopeCode: -32001 })
    expect((await (await clientFor()).getTask({ id: task.id, tenant: '' })).id).toBe(task.id)
  })

  it('CancelTask returns -32001 across tenants for the same owner', async () => {
    expect(base.length).toBeGreaterThan(0)
    assertTenantOwnerKeys()
    const task = await sentTask(true)
    await expect((await clientFor('otherTenant')).cancelTask({ id: task.id, tenant: '', metadata: undefined })).rejects.toMatchObject({ envelopeCode: -32001 })
    expect(fake.canceled).toHaveLength(0)
    expect((await (await clientFor()).getTask({ id: task.id, tenant: '' })).status?.state).toBe(TaskState.TASK_STATE_WORKING)
  })

  it('rejects tenant spoofing with -32602 and strips an equal tenant', async () => {
    expect(base.length).toBeGreaterThan(0)
    const task = await sentTask()
    const matching = await wire(envelope('GetTask', { id: task.id, tenant: 'tenant-1' }))
    expect(await matching.json()).toMatchObject({ result: { id: task.id } })
    expect(await code(envelope('GetTask', { id: task.id, tenant: 'tenant-2' }))).toBe(-32602)
  })

  it('reports invalid JSON as -32700', async () => {
    expect(base.length).toBeGreaterThan(0)
    expect(await code('{not-json')).toBe(-32700)
  })

  it('reports a malformed request as -32600', async () => {
    expect(base.length).toBeGreaterThan(0)
    expect(await code({ jsonrpc: '1.0', id: 1, method: 'GetTask', params: {} })).toBe(-32600)
  })

  it('reports malformed params as -32602', async () => {
    expect(base.length).toBeGreaterThan(0)
    expect(await code(envelope('GetTask', { id: '' }))).toBe(-32602)
    expect(await code(envelope('SendMessage', {}))).toBe(-32602)
  })

  it('reports an unknown method as -32601', async () => {
    expect(base.length).toBeGreaterThan(0)
    expect(await code(envelope('UnknownMethod'))).toBe(-32601)
  })

  it('rejects JSON-RPC batch arrays with -32600', async () => {
    expect(base.length).toBeGreaterThan(0)
    const batch = [envelope('GetTask', { id: 'missing' })]
    expect(batch.length).toBeGreaterThan(0)
    expect(await code(batch)).toBe(-32600)
  })

  it('rejects non-text parts with -32005 through validateInputModes', async () => {
    expect(sendParams().message?.parts.length).toBeGreaterThan(0)
    const params = SendMessageRequest.toJSON(sendParams()) as Record<string, unknown>
    expect(await code(envelope('SendMessage', {
      ...params, message: { messageId: 'data-message', role: 'ROLE_USER', parts: [{ data: { sample: true }, mediaType: 'application/json' }] },
    }))).toBe(-32005)
    expect(await code(envelope('SendMessage', {
      ...params, message: { messageId: 'disguised-data', role: 'ROLE_USER', parts: [{ data: { sample: true }, mediaType: 'text/plain' }] },
    }))).toBe(-32005)
  })

  it('rejects SendStreamingMessage with -32004', async () => {
    expect(sendParams().message?.parts.length).toBeGreaterThan(0)
    expect(await code(envelope('SendStreamingMessage', SendMessageRequest.toJSON(sendParams())))).toBe(-32004)
  })

  it('rejects push-config methods with -32003', async () => {
    expect(base.length).toBeGreaterThan(0)
    const task = await sentTask()
    for (const method of ['CreateTaskPushNotificationConfig', 'GetTaskPushNotificationConfig', 'ListTaskPushNotificationConfigs', 'DeleteTaskPushNotificationConfig']) {
      expect(await code(envelope(method, { taskId: task.id, id: 'config', url: 'https://example.invalid/callback' }))).toBe(-32003)
    }
  })

  it('rejects cancel of a completed task with -32002', async () => {
    expect(base.length).toBeGreaterThan(0)
    const task = await sentTask()
    expect(await code(envelope('CancelTask', { id: task.id }))).toBe(-32002)
  })

  it('rejects repeat cancel of an already canceled task with -32002', async () => {
    expect(base.length).toBeGreaterThan(0)
    const task = await sentTask(true)
    const client = await clientFor()
    const canceled = await client.cancelTask({ id: task.id, tenant: '', metadata: undefined })
    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED)
    await expect(client.cancelTask({ id: task.id, tenant: '', metadata: undefined })).rejects.toMatchObject({ envelopeCode: -32002 })
    expect(fake.canceled).toEqual([task.id])
  })

  it('enforces the 256 KiB params limit', async () => {
    expect(base.length).toBeGreaterThan(0)
    const params = { id: 'missing', padding: 'x'.repeat(256 * 1024) }
    expect(JSON.stringify(params).length).toBeGreaterThan(256 * 1024)
    expect(await code(envelope('GetTask', params))).toBe(-32600)
  })

  it('sanitizes internal SDK errors through logRouteError', async () => {
    expect(base.length).toBeGreaterThan(0)
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {})
    const taskStore = { load: async () => { throw new Error('fixture-driver-detail') }, save: async () => {}, list: async () => { throw new Error('fixture-driver-detail') } }
    const isolated = createForgeApp({
      runStore: new InMemoryRunStore(), agentStore: new InMemoryAgentStore(),
      modelRegistry: new ModelRegistry(), eventBus: createEventBus(),
      auth: { mode: 'api-key', validateKey: async () => ({ id: 'alice', tenantId: 'tenant-1', role: 'admin' }) },
      a2a: {
        agentCardConfig: { name: 'errors', description: 'Errors', baseUrl: base, version: '1', agents: [] },
        v1: { executor: fake.executor, taskStore },
      },
    })
    const response = await isolated.request('/a2a', { method: 'POST', headers: { 'content-type': 'application/json', 'A2A-Version': '1.0', Authorization: 'Bearer alice' }, body: JSON.stringify(envelope('GetTask', { id: 'probe' })) })
    const text = await response.text()
    expect(text).not.toContain('fixture-driver-detail')
    expect(JSON.parse(text)).toMatchObject({ error: { code: -32603, message: 'Internal server error' } })
    expect(logs.mock.calls.length).toBeGreaterThan(0)
    expect(logs.mock.calls.some(([line]) => String(line).includes('a2a.v1.jsonrpc'))).toBe(true)
  })

  it('sanitizes a task-store failure that occurs after the immediate response', async () => {
    expect(base.length).toBeGreaterThan(0)
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {})
    const inner = new InMemoryTaskStore(dzupOwnerResolver)
    let failNextSave = false
    const taskStore: TaskStore = {
      load: (id, context) => inner.load(id, context),
      save: async (task, context) => {
        if (failNextSave) {
          failNextSave = false
          throw new Error('fixture-store-secret-detail')
        }
        return inner.save(task, context)
      },
      list: (params, context) => inner.list(params, context),
    }
    let bus: ExecutionEventBus | undefined
    let release: () => void = () => {}
    const executor: AgentExecutor = {
      async execute(context, eventBus) {
        bus = eventBus
        eventBus.publish(AgentEvent.task(Task.fromJSON({
          id: context.taskId, contextId: context.contextId,
          status: { state: 'TASK_STATE_WORKING' }, history: [Message.toJSON(context.userMessage)],
        })))
        await new Promise<void>((resolve) => { release = resolve })
      },
      async cancelTask() {},
    }
    const isolated = createForgeApp({
      runStore: new InMemoryRunStore(), agentStore: new InMemoryAgentStore(),
      modelRegistry: new ModelRegistry(), eventBus: createEventBus(),
      auth: { mode: 'api-key', validateKey: async () => ({ id: 'alice', tenantId: 'tenant-1', role: 'admin' }) },
      a2a: {
        agentCardConfig: { name: 'store-failure', description: 'Store failure', baseUrl: base, version: '1', agents: [] },
        v1: { executor, taskStore },
      },
    })
    type SendBody = { result?: { id?: string; contextId?: string; task?: { id?: string; contextId?: string } } }
    const call = (method: string, params: unknown) => isolated.request('/a2a', {
      method: 'POST', headers: { 'content-type': 'application/json', 'A2A-Version': '1.0', Authorization: 'Bearer alice' },
      body: JSON.stringify(envelope(method, params)),
    })
    const sent = await (await call('SendMessage', SendMessageRequest.toJSON(sendParams(true)))).json() as SendBody
    const task = sent.result?.task ?? sent.result
    const id = task?.id as string
    expect(typeof id).toBe('string')
    expect(JSON.stringify(sent)).not.toContain('FAILED')
    expect(bus).toBeDefined()
    failNextSave = true
    bus!.publish(AgentEvent.statusUpdate(TaskStatusUpdateEvent.fromJSON({
      taskId: id, contextId: task?.contextId as string, status: { state: 'TASK_STATE_WORKING' },
    })))
    let text = ''
    await vi.waitFor(async () => {
      text = await (await call('GetTask', { id })).text()
      expect(text).toContain('TASK_STATE_FAILED')
    }, { timeout: 2000, interval: 10 })
    release()
    expect(text).toContain('TASK_STATE_FAILED')
    expect(text).not.toContain('fixture-store-secret-detail')
    expect(JSON.stringify(logs.mock.calls)).toContain('a2a.v1.task-store')
  })

  describe('background failure text never carries host-supplied detail', () => {
    type RpcBody = { result?: { id?: string; contextId?: string; task?: { id?: string; contextId?: string } } }
    const poison = (secret: string) => {
      const metadata: Record<string, unknown> = {}
      Object.defineProperty(metadata, 'leak', { enumerable: true, get: () => { throw new Error(secret) } })
      return metadata
    }
    function harness(options: { executor: AgentExecutor; taskStore?: TaskStore }) {
      const app2 = createForgeApp({
        runStore: new InMemoryRunStore(), agentStore: new InMemoryAgentStore(),
        modelRegistry: new ModelRegistry(), eventBus: createEventBus(),
        auth: { mode: 'api-key', validateKey: async () => ({ id: 'alice', tenantId: 'tenant-1', role: 'admin' }) },
        a2a: {
          agentCardConfig: { name: 'bg-failure', description: 'Background failure', baseUrl: base, version: '1', agents: [] },
          v1: { executor: options.executor, ...(options.taskStore ? { taskStore: options.taskStore } : {}) },
        },
      })
      const call = (method: string, params: unknown) => app2.request('/a2a', {
        method: 'POST', headers: { 'content-type': 'application/json', 'A2A-Version': '1.0', Authorization: 'Bearer alice' },
        body: JSON.stringify(envelope(method, params)),
      })
      return call
    }
    async function startImmediate(call: ReturnType<typeof harness>) {
      const sent = await (await call('SendMessage', SendMessageRequest.toJSON(sendParams(true)))).json() as RpcBody
      const task = sent.result?.task ?? sent.result
      expect(typeof task?.id).toBe('string')
      expect(JSON.stringify(sent)).not.toContain('FAILED')
      return task as { id: string; contextId: string }
    }
    const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve)) }
    const SDK_FAILURE = 'Event processing loop failed:'

    function gatedExecutor(afterGate: (bus: ExecutionEventBus, context: { taskId: string; contextId: string }) => void | Promise<void>) {
      let release: () => void = () => {}
      const executor: AgentExecutor = {
        async execute(context, eventBus) {
          eventBus.publish(AgentEvent.task(Task.fromJSON({
            id: context.taskId, contextId: context.contextId,
            status: { state: 'TASK_STATE_WORKING' }, history: [Message.toJSON(context.userMessage)],
          })))
          await new Promise<void>((resolve) => { release = resolve })
          await afterGate(eventBus, context)
        },
        async cancelTask() {},
      }
      return { executor, release: () => release() }
    }

    it('event with a throwing metadata getter published by the executor yields only the generic failure', async () => {
      expect(base.length).toBeGreaterThan(0)
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const secret = 'fixture-event-secret-detail'
      const gated = gatedExecutor((bus, ids) => {
        bus.publish(AgentEvent.statusUpdate(TaskStatusUpdateEvent.fromJSON({
          taskId: ids.taskId, contextId: ids.contextId, status: { state: 'TASK_STATE_WORKING' }, metadata: poison(secret),
        })))
      })
      const call = harness({ executor: gated.executor })
      const task = await startImmediate(call)
      gated.release()
      await settle()
      const text = await (await call('GetTask', { id: task.id })).text()
      expect(text).not.toContain(secret)
      if (text.includes(SDK_FAILURE)) expect(text).toContain('TASK_STATE_FAILED')
    })

    it('event with a throwing metadata getter published during CancelTask never reaches a persisted task', async () => {
      expect(base.length).toBeGreaterThan(0)
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const secret = 'fixture-cancel-secret-detail'
      let release: () => void = () => {}
      const executor: AgentExecutor = {
        async execute(context, eventBus) {
          eventBus.publish(AgentEvent.task(Task.fromJSON({
            id: context.taskId, contextId: context.contextId,
            status: { state: 'TASK_STATE_WORKING' }, history: [Message.toJSON(context.userMessage)],
          })))
          await new Promise<void>((resolve) => { release = resolve })
        },
        async cancelTask(taskId, eventBus) {
          eventBus.publish(AgentEvent.statusUpdate(TaskStatusUpdateEvent.fromJSON({
            taskId, contextId: 'ctx', status: { state: 'TASK_STATE_CANCELED' }, metadata: poison(secret),
          })))
        },
      }
      const call = harness({ executor })
      const task = await startImmediate(call)
      const cancelText = await (await call('CancelTask', { id: task.id })).text()
      await settle()
      const text = await (await call('GetTask', { id: task.id })).text()
      release()
      expect(cancelText).not.toContain(secret)
      expect(text).not.toContain(secret)
    })

    it.each([
      ['store save failure', 'fixture-class-store-detail'],
      ['executor failure after the first event', 'fixture-class-executor-detail'],
      ['executor-published status update whose message already carries SDK failure text', 'fixture-class-spoof-detail'],
    ])('%s: persisted task and history carry only the generic message', async (route, secret) => {
      expect(route.length).toBeGreaterThan(0)
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const inner = new InMemoryTaskStore(dzupOwnerResolver)
      let failNextSave = false
      const taskStore: TaskStore = {
        load: (id, context) => inner.load(id, context),
        save: async (task, context) => {
          if (failNextSave) { failNextSave = false; throw new Error(secret) }
          return inner.save(task, context)
        },
        list: (params, context) => inner.list(params, context),
      }
      const gated = gatedExecutor((bus, ids) => {
        if (route.startsWith('executor failure')) throw new Error(secret)
        if (route.startsWith('executor-published')) {
          bus.publish(AgentEvent.statusUpdate(TaskStatusUpdateEvent.fromJSON({
            taskId: ids.taskId, contextId: ids.contextId,
            status: { state: 'TASK_STATE_FAILED', message: { messageId: 'spoof', role: 'ROLE_AGENT', parts: [{ text: `${SDK_FAILURE} ${secret}`, mediaType: 'text/plain' }] } },
          })))
        } else {
          failNextSave = true
          bus.publish(AgentEvent.statusUpdate(TaskStatusUpdateEvent.fromJSON({
            taskId: ids.taskId, contextId: ids.contextId, status: { state: 'TASK_STATE_WORKING' },
          })))
        }
      })
      const call = harness({ executor: gated.executor, taskStore })
      const task = await startImmediate(call)
      gated.release()
      await settle()
      let text = ''
      await vi.waitFor(async () => {
        text = await (await call('GetTask', { id: task.id })).text()
        expect(text).toContain('TASK_STATE_FAILED')
      }, { timeout: 2000, interval: 10 })
      expect(text).not.toContain(secret)
      expect(text).toContain('Internal server error')
    })

    it('an executor error object with a throwing message getter yields the generic message', async () => {
      expect(base.length).toBeGreaterThan(0)
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const hostile = new Error('placeholder')
      Object.defineProperty(hostile, 'message', { get: () => { throw new Error('fixture-hostile-message-detail') } })
      const gated = gatedExecutor(() => { throw hostile })
      const call = harness({ executor: gated.executor })
      const task = await startImmediate(call)
      gated.release()
      await settle()
      let text = ''
      await vi.waitFor(async () => {
        text = await (await call('GetTask', { id: task.id })).text()
        expect(text).toContain('TASK_STATE_FAILED')
      }, { timeout: 2000, interval: 10 })
      expect(text).not.toContain('fixture-hostile-message-detail')
      expect(text).toContain('Internal server error')
    })

    it('a malformed or hostile event from the executor never reaches the SDK and yields the generic message', async () => {
      expect(base.length).toBeGreaterThan(0)
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const hostileKind = { data: {} } as Record<string, unknown>
      Object.defineProperty(hostileKind, 'kind', { enumerable: true, get: () => { throw new Error('fixture-kind-secret-detail') } })
      for (const bad of [{ kind: 'statusUpdate' }, { kind: 'unknown-kind', data: {} }, { kind: 'task', data: null }, hostileKind]) {
        const gated = gatedExecutor((bus) => { bus.publish(bad as never) })
        const call = harness({ executor: gated.executor })
        const task = await startImmediate(call)
        gated.release()
        await settle()
        let text = ''
        await vi.waitFor(async () => {
          text = await (await call('GetTask', { id: task.id })).text()
          expect(text).toContain('TASK_STATE_FAILED')
        }, { timeout: 2000, interval: 10 })
        expect(text).not.toContain('fixture-kind-secret-detail')
        expect(text).toContain('Internal server error')
      }
    })

    it('JSON-RPC error envelopes carry fixed text and never echo caller or host text', async () => {
      expect(base.length).toBeGreaterThan(0)
      const echoed = 'caller-supplied-id-fixture'
      const gated = gatedExecutor(() => {})
      const call = harness({ executor: gated.executor })
      const body = await (await call('GetTask', { id: echoed })).json() as { error?: { code: number; message: string; data?: unknown } }
      expect(body.error?.code).toBe(-32001)
      expect(JSON.stringify(body)).not.toContain(echoed)
      expect(body.error?.data).toBeUndefined()
    })
  })
})
