/**
 * MCP server lifecycle management routes.
 *
 * POST   /servers           — Add a new MCP server definition (201)
 * GET    /servers           — List registered MCP servers
 * GET    /servers/:id       — Get a single MCP server (404 if missing)
 * PATCH  /servers/:id       — Update an MCP server definition
 * DELETE /servers/:id       — Remove an MCP server (204)
 * POST   /servers/:id/enable  — Enable a disabled server
 * POST   /servers/:id/disable — Disable an enabled server
 * POST   /servers/:id/test    — Test connectivity to an MCP server
 *
 * GET    /profiles          — List MCP profiles
 * POST   /profiles          — Create an MCP profile (201)
 * GET    /profiles/:id      — Get a single profile
 * DELETE /profiles/:id      — Remove an MCP profile (204)
 */
import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import type { ForgeServerConfig } from '../composition/types.js'
import { sanitizeError } from './route-error.js'
import { McpServerSchema, validateBodyCompat } from './schemas.js'
import { validateMcpHttpEndpoint } from '../security/mcp-url-policy.js'
import type {
  McpServerInput,
  McpServerPatch,
  McpProfile,
  McpServerDefinition,
} from '@dzupagent/core'

// ---------------------------------------------------------------------------
// Response redaction (QF-SEC-06)
// ---------------------------------------------------------------------------

/**
 * Redacted view of an {@link McpServerDefinition} for HTTP responses.
 *
 * Inline secrets carried on `env` and sensitive `headers` (authorization,
 * x-api-key, bearer tokens) are replaced with a sentinel string so they
 * are never returned by the management API. Stored definitions retain
 * the original values for the MCP execution path.
 */
type PublicMcpServerDefinition = Omit<McpServerDefinition, 'env' | 'headers'> & {
  env?: Record<string, string>
  headers?: Record<string, string>
}

const SENSITIVE_HEADER_PATTERN = /authorization|x-api-key|bearer|x-auth|cookie|token/i

function redactMcpDefinition(
  def: McpServerDefinition,
): PublicMcpServerDefinition {
  const redacted: PublicMcpServerDefinition = { ...def }

  if (def.env) {
    redacted.env = Object.fromEntries(
      Object.keys(def.env).map((k) => [k, '[REDACTED]']),
    )
  }

  if (def.headers) {
    redacted.headers = Object.fromEntries(
      Object.entries(def.headers).map(([k, v]) => [
        k,
        SENSITIVE_HEADER_PATTERN.test(k) ? '[REDACTED]' : v,
      ]),
    )
  }

  return redacted
}

export function createMcpRoutes(
  config: Pick<ForgeServerConfig, 'mcpManager' | 'mcpAllowedExecutables' | 'mcpAllowedHttpHosts'>,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  function validateHttpServerInput(server: Pick<McpServerInput, 'transport' | 'endpoint'>):
  | Response
  | undefined {
    if (server.transport !== 'http' && server.transport !== 'sse') return undefined

    const result = validateMcpHttpEndpoint(server.endpoint, server.transport, {
      allowedHosts: config.mcpAllowedHttpHosts,
    })
    if (result.ok) return undefined

    return Response.json(
      {
        error: {
          code: 'FORBIDDEN',
          message: `MCP ${server.transport.toUpperCase()} endpoint rejected by URL policy: ${result.reason}`,
        },
      },
      { status: 403 },
    )
  }

  // Guard: return 503 if mcpManager is not configured (checked per-request)
  app.use('*', async (c, next) => {
    if (!config.mcpManager) {
      return c.json(
        { error: { code: 'SERVICE_UNAVAILABLE', message: 'MCP manager not configured' } },
        503,
      )
    }
    return next()
  })

  // -------------------------------------------------------------------------
  // Server routes
  // -------------------------------------------------------------------------

  // GET /servers — list all servers
  app.get('/servers', async (c) => {
    const servers = await config.mcpManager!.listServers()
    return c.json({
      data: servers.map(redactMcpDefinition),
      count: servers.length,
    })
  })

  // POST /servers — add a server
  app.post('/servers', async (c) => {
    const parsed = await validateBodyCompat(c, McpServerSchema)
    if (parsed instanceof Response) return parsed
    const body: McpServerInput = parsed

    // RF-S03: gate stdio transport registrations behind an explicit
    // allowlist so authenticated API keys cannot spawn arbitrary binaries
    // on the host. `endpoint` carries the command for stdio transports.
    if (body.transport === 'stdio') {
      const allowedExes = config.mcpAllowedExecutables ?? []
      if (!allowedExes.includes(body.endpoint)) {
        return c.json(
          {
            error: {
              code: 'FORBIDDEN',
              message:
                'stdio MCP server command not in allowlist. Set mcpAllowedExecutables in ForgeServerConfig.',
            },
          },
          403,
        )
      }
    }

    const urlPolicyError = validateHttpServerInput(body)
    if (urlPolicyError) return urlPolicyError

    try {
      const server = await config.mcpManager!.addServer(body)
      return c.json({ data: redactMcpDefinition(server) }, 201)
    } catch (err) {
      const { safe, internal } = sanitizeError(err)
      console.error(`[mcp] ${internal}`)
      if (internal.includes('already exists')) {
        return c.json(
          { error: { code: 'VALIDATION_ERROR', message: safe } },
          409,
        )
      }
      throw err
    }
  })

  // GET /servers/:id — get a server
  app.get('/servers/:id', async (c) => {
    const id = c.req.param('id')
    const server = await config.mcpManager!.getServer(id)
    if (!server) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: `MCP server "${id}" not found` } },
        404,
      )
    }
    return c.json({ data: redactMcpDefinition(server) })
  })

  // PATCH /servers/:id — update a server
  app.patch('/servers/:id', async (c) => {
    const id = c.req.param('id')
    let patch: McpServerPatch
    try {
      patch = await c.req.json<McpServerPatch>()
    } catch {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' } },
        400,
      )
    }

    const existing = await config.mcpManager!.getServer(id)
    if (!existing) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: `MCP server "${id}" not found` } },
        404,
      )
    }

    // MJ-SEC-03: validate stdio executable allowlist on patch.
    // A patch may change transport to stdio or change the endpoint of an
    // existing stdio server — both must be gated.
    if (patch.transport === 'stdio' || patch.endpoint !== undefined) {
      const effectiveTransport = patch.transport ?? existing?.transport
      if (effectiveTransport === 'stdio') {
        const effectiveEndpoint = patch.endpoint ?? existing?.endpoint ?? ''
        const allowedExes = config.mcpAllowedExecutables ?? []
        if (!allowedExes.includes(effectiveEndpoint)) {
          return c.json(
            {
              error: {
                code: 'FORBIDDEN',
                message:
                  'stdio MCP server command not in allowlist. Set mcpAllowedExecutables in ForgeServerConfig.',
              },
            },
            403,
          )
        }
      }
    }

    const effectiveHttpTransport = patch.transport ?? existing.transport
    if (effectiveHttpTransport === 'http' || effectiveHttpTransport === 'sse') {
      const effectiveEndpoint = patch.endpoint ?? existing.endpoint
      const urlPolicyError = validateHttpServerInput({
        transport: effectiveHttpTransport,
        endpoint: effectiveEndpoint,
      })
      if (urlPolicyError) return urlPolicyError
    }

    try {
      const updated = await config.mcpManager!.updateServer(id, patch)
      return c.json({ data: redactMcpDefinition(updated) })
    } catch (err) {
      const { safe, internal } = sanitizeError(err)
      console.error(`[mcp] ${internal}`)
      if (internal.includes('not found')) {
        return c.json(
          { error: { code: 'NOT_FOUND', message: safe } },
          404,
        )
      }
      throw err
    }
  })

  // DELETE /servers/:id — remove a server
  app.delete('/servers/:id', async (c) => {
    try {
      await config.mcpManager!.removeServer(c.req.param('id'))
      return c.body(null, 204)
    } catch (err) {
      const { safe, internal } = sanitizeError(err)
      console.error(`[mcp] ${internal}`)
      return c.json(
        { error: { code: 'INTERNAL_ERROR', message: safe } },
        500,
      )
    }
  })

  // POST /servers/:id/enable — enable a server
  app.post('/servers/:id/enable', async (c) => {
    const id = c.req.param('id')
    try {
      const server = await config.mcpManager!.enableServer(id)
      return c.json({ data: redactMcpDefinition(server) })
    } catch (err) {
      const { safe, internal } = sanitizeError(err)
      console.error(`[mcp] ${internal}`)
      if (internal.includes('not found')) {
        return c.json(
          { error: { code: 'NOT_FOUND', message: safe } },
          404,
        )
      }
      throw err
    }
  })

  // POST /servers/:id/disable — disable a server
  app.post('/servers/:id/disable', async (c) => {
    const id = c.req.param('id')
    try {
      const server = await config.mcpManager!.disableServer(id)
      return c.json({ data: redactMcpDefinition(server) })
    } catch (err) {
      const { safe, internal } = sanitizeError(err)
      console.error(`[mcp] ${internal}`)
      if (internal.includes('not found')) {
        return c.json(
          { error: { code: 'NOT_FOUND', message: safe } },
          404,
        )
      }
      throw err
    }
  })

  // POST /servers/:id/test — test connectivity
  app.post('/servers/:id/test', async (c) => {
    const id = c.req.param('id')
    try {
      const server = await config.mcpManager!.getServer(id)
      if (!server) {
        return c.json(
          { error: { code: 'NOT_FOUND', message: `MCP server "${id}" not found` } },
          404,
        )
      }

      const urlPolicyError = validateHttpServerInput(server)
      if (urlPolicyError) return urlPolicyError

      const result = await config.mcpManager!.testServer(id)
      return c.json({ data: result })
    } catch (err) {
      const { safe, internal } = sanitizeError(err)
      console.error(`[mcp] ${internal}`)
      return c.json(
        { error: { code: 'INTERNAL_ERROR', message: safe } },
        500,
      )
    }
  })

  // -------------------------------------------------------------------------
  // Profile routes
  // -------------------------------------------------------------------------

  // GET /profiles — list all profiles
  app.get('/profiles', async (c) => {
    const profiles = await config.mcpManager!.listProfiles()
    return c.json({ data: profiles, count: profiles.length })
  })

  // POST /profiles — create a profile
  app.post('/profiles', async (c) => {
    let body: McpProfile
    try {
      body = await c.req.json<McpProfile>()
    } catch {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' } },
        400,
      )
    }

    if (!body.id || !Array.isArray(body.serverIds)) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'id and serverIds (array) are required' } },
        400,
      )
    }

    try {
      const profile = await config.mcpManager!.addProfile(body)
      return c.json({ data: profile }, 201)
    } catch (err) {
      const { safe, internal } = sanitizeError(err)
      console.error(`[mcp] ${internal}`)
      if (internal.includes('already exists')) {
        return c.json(
          { error: { code: 'VALIDATION_ERROR', message: safe } },
          409,
        )
      }
      throw err
    }
  })

  // GET /profiles/:id — get a profile
  app.get('/profiles/:id', async (c) => {
    const id = c.req.param('id')
    const profile = await config.mcpManager!.getProfile(id)
    if (!profile) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: `MCP profile "${id}" not found` } },
        404,
      )
    }
    return c.json({ data: profile })
  })

  // DELETE /profiles/:id — remove a profile
  app.delete('/profiles/:id', async (c) => {
    try {
      await config.mcpManager!.removeProfile(c.req.param('id'))
      return c.body(null, 204)
    } catch (err) {
      const { safe, internal } = sanitizeError(err)
      console.error(`[mcp] ${internal}`)
      return c.json(
        { error: { code: 'INTERNAL_ERROR', message: safe } },
        500,
      )
    }
  })

  return app
}
