import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import type { ServerRoutePlugin } from '../route-plugin.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'

function createTestConfig(routePlugins: ServerRoutePlugin[] = []): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    routePlugins,
  }
}

describe('Route plugins', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('mounts plugin routes via createRoutes and calls onMount', async () => {
    const pluginApp = new Hono()
    pluginApp.get('/ping', (c) => c.json({ ok: true }))

    const createRoutes = vi.fn(() => pluginApp)
    const onMount = vi.fn()

    const app = createForgeApp(createTestConfig([
      {
        prefix: '/api/custom',
        createRoutes,
        onMount,
      },
    ]))

    const response = await app.request('/api/custom/ping')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })

    expect(createRoutes).toHaveBeenCalledTimes(1)
    expect(onMount).toHaveBeenCalledTimes(1)
    const onMountConfig = onMount.mock.calls[0]?.[0] as ForgeServerConfig
    expect(onMountConfig.runStore).toBeDefined()
    expect(onMountConfig.runExecutor).toBeDefined()
  })

  it('skips plugin mount when prefix does not start with slash', async () => {
    const createRoutes = vi.fn(() => {
      const app = new Hono()
      app.get('/ping', (c) => c.json({ ok: true }))
      return app
    })
    const onMount = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const app = createForgeApp(createTestConfig([
      {
        prefix: 'api/invalid',
        createRoutes,
        onMount,
      },
    ]))

    const response = await app.request('/api/invalid/ping')
    expect(response.status).toBe(404)
    expect(createRoutes).not.toHaveBeenCalled()
    expect(onMount).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('api/invalid'))
  })
})
