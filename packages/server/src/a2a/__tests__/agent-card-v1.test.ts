import { describe, expect, it } from 'vitest'
import { AgentCard as SDKAgentCard } from '@a2a-js/sdk'
import { ServerCallContext } from '@a2a-js/sdk/server'
import { Hono } from 'hono'
import { buildAgentCard } from '../agent-card.js'
import { toAgentCardV030 } from '../agent-card-v030.js'
import { InMemoryA2ATaskStore } from '../task-handler.js'
import { createA2ARoutes } from '../../routes/a2a.js'
import { isA2AV1Request, toAgentCardV1 } from '../v1/agent-card-v1.js'
import { createA2AV1Handler } from '../v1/request-handler.js'
import { dzupOwnerResolver, VerifiedA2AUser } from '../v1/identity.js'
import type { AppEnv } from '../../types.js'

const card = buildAgentCard({
  name: 'card-fixture', description: 'Card fixture', baseUrl: 'http://localhost///', version: '1.2.3',
  authType: 'bearer', agents: [{ name: 'echo', description: 'Echo skill' }],
})

function fixture() {
  let executions = 0
  const v1 = createA2AV1Handler({
    agentCard: toAgentCardV1(card),
    // Deterministic in-test fake; a message result proves v1 dispatch.
    executor: {
      async execute(context, bus) {
        executions++
        bus.publish({ kind: 'message', data: context.userMessage })
      },
      async cancelTask() {},
    },
  })
  const app = new Hono<AppEnv>()
  app.use('/a2a', async (c, next) => {
    if (c.req.header('Authorization') === 'Bearer fixture') {
      c.set('apiKey', { id: 'alice', tenantId: 'tenant-1' })
    }
    await next()
  })
  app.route('', createA2ARoutes({ agentCard: card, taskStore: new InMemoryA2ATaskStore(), v1 }))
  return { app, executions: () => executions }
}

describe('A2A v1 card mapping and header dispatch', () => {
  it('maps only the implemented JSONRPC 1.0 text capabilities without mutating the legacy card', () => {
    expect(card.capabilities.length).toBeGreaterThan(0)
    const before = JSON.stringify(card)
    const mapped = toAgentCardV1(card)
    expect(mapped.supportedInterfaces).toEqual([{ url: 'http://localhost/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' }])
    expect(mapped.capabilities).toEqual({ streaming: false, pushNotifications: false, extendedAgentCard: false, extensions: [] })
    expect(mapped.defaultInputModes).toEqual(['text/plain'])
    expect(mapped.defaultOutputModes).toEqual(['text/plain'])
    expect(mapped.skills).toMatchObject([{ id: 'echo', name: 'echo', description: 'Echo skill', inputModes: ['text/plain'], outputModes: ['text/plain'] }])
    expect(mapped.signatures).toEqual([])
    expect(JSON.stringify(card)).toBe(before)
  })

  it('derives bearer and API-key security requirements from authType', () => {
    expect(card.name.length).toBeGreaterThan(0)
    const bearer = toAgentCardV1(card)
    expect(bearer.securitySchemes['authentication']?.scheme).toMatchObject({ $case: 'httpAuthSecurityScheme', value: { scheme: 'Bearer' } })
    expect(bearer.securityRequirements).toEqual([{ schemes: { authentication: { list: [] } } }])
    const apiKey = toAgentCardV1(card, { authType: 'api-key' })
    expect(apiKey.securitySchemes['authentication']?.scheme).toMatchObject({ $case: 'apiKeySecurityScheme', value: { location: 'header', name: 'Authorization' } })
    const none = toAgentCardV1(card, { authType: 'none' })
    expect(none.securitySchemes).toEqual({})
    expect(none.securityRequirements).toEqual([])
    expect(SDKAgentCard.toJSON(bearer)).toMatchObject({ securitySchemes: { authentication: { httpAuthSecurityScheme: { scheme: 'Bearer' } } } })
  })

  it('dispatches major versions at least one and preserves absent empty and 0.3 headers', () => {
    expect(card.name.length).toBeGreaterThan(0)
    for (const version of ['1.0', '1.1', '2.0', '9.9']) expect(isA2AV1Request(version)).toBe(true)
    for (const version of [undefined, '', '0.3', '0.3.0']) expect(isA2AV1Request(version)).toBe(false)
  })

  it('serves a v1 card only for v1 headers and adds Vary to both card representations', async () => {
    expect(card.capabilities.length).toBeGreaterThan(0)
    const { app } = fixture()
    for (const version of [undefined, '', '0.3', '0.3.0']) {
      const response = await app.request('/.well-known/agent-card.json', { headers: version === undefined ? {} : { 'A2A-Version': version } })
      expect(response.headers.get('Vary')).toContain('A2A-Version')
      expect(await response.text()).toBe(JSON.stringify(toAgentCardV030(card)))
    }
    const response = await app.request('/.well-known/agent-card.json', { headers: { 'A2A-Version': '1.0' } })
    expect(response.headers.get('Vary')).toContain('A2A-Version')
    expect(await response.json()).toMatchObject({ supportedInterfaces: [{ protocolVersion: '1.0', tenant: '' }], capabilities: { extensions: [], streaming: false } })
    const legacy = await app.request('/.well-known/agent.json', { headers: { 'A2A-Version': '1.0' } })
    expect(await legacy.text()).toBe(JSON.stringify(card))
    expect(legacy.headers.get('Vary')).toBeNull()
  })

  it('sends only v1 POST requests to the SDK executor', async () => {
    expect(card.capabilities.length).toBeGreaterThan(0)
    const { app, executions } = fixture()
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: 'm-1', role: 'ROLE_USER', parts: [{ text: 'hello' }] } } })
    for (const version of [undefined, '', '0.3']) {
      const response = await app.request('/a2a', { method: 'POST', headers: { 'content-type': 'application/json', ...(version === undefined ? {} : { 'A2A-Version': version }) }, body })
      expect(await response.json()).toMatchObject({ error: { code: -32601 } })
      expect(executions()).toBe(0)
    }
    const response = await app.request('/a2a', { method: 'POST', headers: { 'content-type': 'application/json', 'A2A-Version': '1.0', Authorization: 'Bearer fixture' }, body })
    expect(await response.json()).toMatchObject({ result: { message: { messageId: 'm-1' } } })
    expect(executions()).toBe(1)
  })

  it('refuses a missing verified scope before invoking the SDK executor', async () => {
    expect(card.name.length).toBeGreaterThan(0)
    const { app, executions } = fixture()
    const response = await app.request('/a2a', { method: 'POST', headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' }, body: '{bad-json' })
    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer')
    expect(executions()).toBe(0)
  })

  it('uses verified tenant and owner in collision-free owner keys and refuses unverified contexts', () => {
    expect(card.name.length).toBeGreaterThan(0)
    const key = (ownerId: string, tenantId: string) => dzupOwnerResolver(new ServerCallContext({ user: new VerifiedA2AUser({ ownerId, tenantId }), tenant: tenantId }))
    expect(key('alice', 'tenant-1')).not.toBe(key('alice', 'tenant-2'))
    expect(key('alice', 'tenant-1')).not.toBe(key('bob', 'tenant-1'))
    expect(key('b:c', 'a')).not.toBe(key('c', 'a:b'))
    expect(() => dzupOwnerResolver(new ServerCallContext())).toThrow('verified caller scope')
    expect(() => new VerifiedA2AUser({ ownerId: undefined, tenantId: undefined })).toThrow('verified owner and tenant')
  })
})
