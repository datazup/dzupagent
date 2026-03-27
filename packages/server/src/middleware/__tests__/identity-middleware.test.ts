import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import type { IdentityResolver, ForgeIdentity } from '@dzipagent/core'
import { identityMiddleware, getForgeIdentity, getForgeCapabilities } from '../identity.js'
import { capabilityGuard } from '../capability-guard.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIdentity(overrides?: Partial<ForgeIdentity>): ForgeIdentity {
  return {
    id: 'id-1',
    uri: 'forge://acme/test-agent',
    displayName: 'Test Agent',
    organization: 'acme',
    capabilities: [
      { name: 'runs.create', version: '1.0.0', description: 'Create runs' },
      { name: 'agents.read', version: '1.0.0', description: 'Read agents' },
    ],
    credentials: [{ type: 'api-key', issuedAt: new Date() }],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makeResolver(identity: ForgeIdentity | null): IdentityResolver {
  return {
    resolve: vi.fn().mockResolvedValue(identity),
    verify: vi.fn().mockResolvedValue(identity !== null),
  }
}

async function request(
  app: Hono,
  path: string,
  headers?: Record<string, string>,
): Promise<Response> {
  return app.request(path, { headers })
}

// ---------------------------------------------------------------------------
// identityMiddleware
// ---------------------------------------------------------------------------

describe('identityMiddleware', () => {
  it('resolves identity from Bearer token', async () => {
    const identity = makeIdentity()
    const resolver = makeResolver(identity)
    const app = new Hono()
    app.use('*', identityMiddleware({ resolver }))
    app.get('/test', (c) => {
      const id = getForgeIdentity(c)
      return c.json({ resolved: id?.id })
    })

    const res = await request(app, '/test', { Authorization: 'Bearer my-token' })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { resolved: string }
    expect(data.resolved).toBe('id-1')
    expect(resolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'my-token' }),
    )
  })

  it('resolves identity from ApiKey header format', async () => {
    const identity = makeIdentity()
    const resolver = makeResolver(identity)
    const app = new Hono()
    app.use('*', identityMiddleware({ resolver }))
    app.get('/test', (c) => {
      const id = getForgeIdentity(c)
      return c.json({ resolved: id?.id })
    })

    const res = await request(app, '/test', { Authorization: 'ApiKey sk-123' })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { resolved: string }
    expect(data.resolved).toBe('id-1')
    expect(resolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'sk-123' }),
    )
  })

  it('resolves identity from X-API-Key header', async () => {
    const identity = makeIdentity()
    const resolver = makeResolver(identity)
    const app = new Hono()
    app.use('*', identityMiddleware({ resolver }))
    app.get('/test', (c) => {
      const id = getForgeIdentity(c)
      return c.json({ resolved: id?.id })
    })

    const res = await request(app, '/test', { 'X-API-Key': 'key-456' })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { resolved: string }
    expect(data.resolved).toBe('id-1')
    expect(resolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'key-456' }),
    )
  })

  it('rejects with 401 when required and no identity resolved', async () => {
    const resolver = makeResolver(null)
    const app = new Hono()
    app.use('*', identityMiddleware({ resolver, required: true }))
    app.get('/test', (c) => c.json({ ok: true }))

    const res = await request(app, '/test')
    expect(res.status).toBe(401)
    const data = (await res.json()) as { error: { code: string } }
    expect(data.error.code).toBe('IDENTITY_RESOLUTION_FAILED')
  })

  it('allows anonymous when required is false', async () => {
    const resolver = makeResolver(null)
    const app = new Hono()
    app.use('*', identityMiddleware({ resolver, required: false }))
    app.get('/test', (c) => c.json({ ok: true }))

    const res = await request(app, '/test')
    expect(res.status).toBe(200)
    const data = (await res.json()) as { ok: boolean }
    expect(data.ok).toBe(true)
  })

  it('allows anonymous by default (required defaults to false)', async () => {
    const resolver = makeResolver(null)
    const app = new Hono()
    app.use('*', identityMiddleware({ resolver }))
    app.get('/test', (c) => c.json({ ok: true }))

    const res = await request(app, '/test')
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// getForgeIdentity / getForgeCapabilities
// ---------------------------------------------------------------------------

describe('getForgeIdentity', () => {
  it('returns identity from context', async () => {
    const identity = makeIdentity({ id: 'ctx-id' })
    const resolver = makeResolver(identity)
    const app = new Hono()
    app.use('*', identityMiddleware({ resolver }))
    app.get('/test', (c) => {
      const id = getForgeIdentity(c)
      return c.json({ id: id?.id })
    })

    const res = await request(app, '/test', { Authorization: 'Bearer t' })
    const data = (await res.json()) as { id: string }
    expect(data.id).toBe('ctx-id')
  })

  it('returns undefined when not set', async () => {
    const app = new Hono()
    app.get('/test', (c) => {
      const id = getForgeIdentity(c)
      return c.json({ id: id ?? null })
    })

    const res = await request(app, '/test')
    const data = (await res.json()) as { id: null }
    expect(data.id).toBeNull()
  })
})

describe('getForgeCapabilities', () => {
  it('returns capabilities from context', async () => {
    const identity = makeIdentity()
    const resolver = makeResolver(identity)
    const app = new Hono()
    app.use('*', identityMiddleware({ resolver }))
    app.get('/test', (c) => {
      const caps = getForgeCapabilities(c)
      return c.json({ count: caps.length, names: caps.map((cap) => cap.name) })
    })

    const res = await request(app, '/test', { Authorization: 'Bearer t' })
    const data = (await res.json()) as { count: number; names: string[] }
    expect(data.count).toBe(2)
    expect(data.names).toContain('runs.create')
  })

  it('returns empty array when no identity', async () => {
    const app = new Hono()
    app.get('/test', (c) => {
      const caps = getForgeCapabilities(c)
      return c.json({ count: caps.length })
    })

    const res = await request(app, '/test')
    const data = (await res.json()) as { count: number }
    expect(data.count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// capabilityGuard
// ---------------------------------------------------------------------------

describe('capabilityGuard', () => {
  it('allows when identity has required capability', async () => {
    const identity = makeIdentity()
    const resolver = makeResolver(identity)
    const app = new Hono()
    app.use('*', identityMiddleware({ resolver }))
    app.get('/test', capabilityGuard('runs.create'), (c) => c.json({ ok: true }))

    const res = await request(app, '/test', { Authorization: 'Bearer t' })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { ok: boolean }
    expect(data.ok).toBe(true)
  })

  it('denies with 403 when capability is missing', async () => {
    const identity = makeIdentity({
      capabilities: [
        { name: 'agents.read', version: '1.0.0', description: 'Read agents' },
      ],
    })
    const resolver = makeResolver(identity)
    const app = new Hono()
    app.use('*', identityMiddleware({ resolver }))
    app.get('/test', capabilityGuard('runs.delete'), (c) => c.json({ ok: true }))

    const res = await request(app, '/test', { Authorization: 'Bearer t' })
    expect(res.status).toBe(403)
    const data = (await res.json()) as { error: { code: string; capability: string } }
    expect(data.error.code).toBe('CAPABILITY_DENIED')
    expect(data.error.capability).toBe('runs.delete')
  })

  it('checks multiple capabilities (all must pass)', async () => {
    const identity = makeIdentity({
      capabilities: [
        { name: 'runs.create', version: '1.0.0', description: 'Create runs' },
        // Missing agents.delete
      ],
    })
    const resolver = makeResolver(identity)
    const app = new Hono()
    app.use('*', identityMiddleware({ resolver }))
    app.get(
      '/test',
      capabilityGuard(['runs.create', 'agents.delete']),
      (c) => c.json({ ok: true }),
    )

    const res = await request(app, '/test', { Authorization: 'Bearer t' })
    expect(res.status).toBe(403)
    const data = (await res.json()) as { error: { code: string; capability: string } }
    expect(data.error.capability).toBe('agents.delete')
  })

  it('passes when all multiple capabilities are present', async () => {
    const identity = makeIdentity({
      capabilities: [
        { name: 'runs.create', version: '1.0.0', description: 'Create runs' },
        { name: 'agents.read', version: '1.0.0', description: 'Read agents' },
      ],
    })
    const resolver = makeResolver(identity)
    const app = new Hono()
    app.use('*', identityMiddleware({ resolver }))
    app.get(
      '/test',
      capabilityGuard(['runs.create', 'agents.read']),
      (c) => c.json({ ok: true }),
    )

    const res = await request(app, '/test', { Authorization: 'Bearer t' })
    expect(res.status).toBe(200)
  })

  it('denies with 403 when no identity is available', async () => {
    const app = new Hono()
    // No identity middleware — identity will be undefined
    app.get('/test', capabilityGuard('runs.create'), (c) => c.json({ ok: true }))

    const res = await request(app, '/test')
    expect(res.status).toBe(403)
    const data = (await res.json()) as { error: { code: string } }
    expect(data.error.code).toBe('CAPABILITY_DENIED')
  })

  it('denies with 403 when identity middleware resolved no identity', async () => {
    const resolver = makeResolver(null)
    const app = new Hono()
    app.use('*', identityMiddleware({ resolver, required: false }))
    app.get('/test', capabilityGuard('runs.create'), (c) => c.json({ ok: true }))

    const res = await request(app, '/test')
    expect(res.status).toBe(403)
    const data = (await res.json()) as { error: { code: string } }
    expect(data.error.code).toBe('CAPABILITY_DENIED')
  })
})
