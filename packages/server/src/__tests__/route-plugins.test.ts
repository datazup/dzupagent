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

function createTestConfig(routePlugins: ServerRoutePlugin<ForgeServerConfig>[] = []): ForgeServerConfig {
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
    expect(onMount.mock.calls[0]?.[1]).toMatchObject({ serverConfig: onMountConfig })
    expect(createRoutes.mock.calls[0]?.[0]).toMatchObject({ serverConfig: onMountConfig })
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

  it('throws at startup when plugin prefix is outside /api/ without auth bypass', () => {
    const createRoutes = vi.fn(() => new Hono())

    expect(() =>
      createForgeApp(createTestConfig([
        {
          prefix: '/public/health',
          createRoutes,
        },
      ])),
    ).toThrow(/auth boundary/)
  })

  it('allows non-/api/ prefix when plugin explicitly sets auth: bypass', async () => {
    const pluginApp = new Hono()
    pluginApp.get('/ping', (c) => c.json({ ok: true }))

    const app = createForgeApp(createTestConfig([
      {
        prefix: '/public/health',
        auth: 'bypass',
        createRoutes: () => pluginApp,
      },
    ]))

    const response = await app.request('/public/health/ping')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  it('allows empty prefix plugin without throwing (legacy compatibility routes)', async () => {
    const pluginApp = new Hono()
    pluginApp.get('/compat', (c) => c.json({ ok: true }))

    // Empty prefix '' is exempt from the /api/ requirement.
    const app = createForgeApp(createTestConfig([
      {
        prefix: '',
        createRoutes: () => pluginApp,
      },
    ]))

    const response = await app.request('/compat')
    expect(response.status).toBe(200)
  })
})
