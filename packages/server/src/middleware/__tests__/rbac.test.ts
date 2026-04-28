import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'

import {
  DEFAULT_ADMIN_ONLY_PATHS,
  DEFAULT_ROUTE_PERMISSIONS,
  rbacMiddleware,
  resolveRoutePermission,
  type ForgeRole,
} from '../rbac.js'

function createApp(role: ForgeRole | undefined = 'operator', routePermissions = {}) {
  const app = new Hono()
  app.use('/api/*', rbacMiddleware({
    extractRole: () => role,
    routePermissions,
  }))
  app.get('/api/health', (c) => c.json({ ok: true }))
  app.all('/api/*', (c) => c.json({ ok: true, path: c.req.path }))
  return app
}

describe('rbacMiddleware', () => {
  it('denies unknown /api route groups instead of passing through', async () => {
    const app = createApp('admin')

    const res = await app.request('/api/unmapped-control-plane')
    const body = await res.json() as { error: { code: string; message: string } }

    expect(res.status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.error.message).toContain('No RBAC policy is configured')
  })

  it('keeps health endpoints public to RBAC', async () => {
    const app = createApp(undefined)

    const res = await app.request('/api/health/ready')

    expect(res.status).toBe(200)
  })

  it('requires explicit admin role for high-risk management route groups', async () => {
    const highRiskPaths = [
      '/api/keys',
      '/api/registry',
      '/api/triggers',
      '/api/schedules',
      '/api/deploy',
      '/api/evals',
      '/api/benchmarks',
      '/api/prompts',
      '/api/personas',
      '/api/marketplace',
      '/api/mailbox',
      '/api/clusters',
      '/api/mcp',
    ]
    const operatorApp = createApp('operator')
    const adminApp = createApp('admin')

    for (const path of highRiskPaths) {
      const operatorRes = await operatorApp.request(`${path}/probe`)
      expect(operatorRes.status, path).toBe(403)
      const operatorBody = await operatorRes.json() as { error: { message: string } }
      expect(operatorBody.error.message, path).toContain('admin-only endpoint')

      const adminRes = await adminApp.request(`${path}/probe`)
      expect(adminRes.status, path).toBe(200)
    }
  })

  it('maps every built-in management route group to an explicit RBAC policy', () => {
    const routeGroups = [
      ...Object.keys(DEFAULT_ROUTE_PERMISSIONS),
      ...DEFAULT_ADMIN_ONLY_PATHS,
    ]

    for (const routeGroup of routeGroups) {
      expect(resolveRoutePermission(routeGroup), routeGroup).toBeDefined()
      expect(resolveRoutePermission(`${routeGroup}/child`), routeGroup).toBeDefined()
    }
  })

  it('does not match similarly named prefixes by startsWith alone', async () => {
    const app = createApp('admin')

    const res = await app.request('/api/mcp-danger')

    expect(res.status).toBe(403)
    const body = await res.json() as { error: { message: string } }
    expect(body.error.message).toContain('No RBAC policy is configured')
  })

  it('allows hosts to add resource policies for custom route plugins', async () => {
    const app = createApp('operator', {
      '/api/custom-plugin': { resource: 'settings', action: 'read' },
    })

    const forbidden = await app.request('/api/custom-plugin/state')
    expect(forbidden.status).toBe(403)

    const allowedApp = new Hono()
    allowedApp.use('/api/*', rbacMiddleware({
      extractRole: () => 'operator',
      routePermissions: {
        '/api/custom-plugin': { resource: 'settings', action: 'read' },
      },
      customPermissions: {
        operator: [{ resource: 'settings', action: 'read' }],
      },
    }))
    allowedApp.get('/api/custom-plugin/state', (c) => c.json({ ok: true }))

    const allowed = await allowedApp.request('/api/custom-plugin/state')
    expect(allowed.status).toBe(200)
  })
})
