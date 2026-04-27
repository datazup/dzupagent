/**
 * Adapter skill preview routes.
 *
 * GET  /                         — List all compiled skills from registry
 * GET  /:provider                — List skills for a specific provider
 * GET  /:provider/:skillId       — Get a specific compiled skill
 * POST /compile                  — Compile a skill bundle on demand
 * GET  /registry/stats           — Registry stats (provider count, total skills, etc.)
 */
import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import type { ForgeServerConfig } from '../composition/types.js'
import { sanitizeError } from './route-error.js'
import type { AdapterSkillBundle, CompiledAdapterSkill } from '@dzupagent/agent-adapters'
import type { AdapterProviderId } from '@dzupagent/agent-adapters'

export function createSkillRoutes(config: Pick<ForgeServerConfig, 'skillRegistry'>): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Guard: return 503 if skillRegistry is not configured (checked per-request)
  app.use('*', async (c, next) => {
    if (!config.skillRegistry) {
      return c.json(
        { error: { code: 'SERVICE_UNAVAILABLE', message: 'Skill registry not configured' } },
        503,
      )
    }
    return next()
  })

  // GET /registry/stats — registry stats
  // Note: placed before /:provider to avoid collision
  app.get('/registry/stats', async (c) => {
    try {
      const providers = config.skillRegistry!.listProviders()
      return c.json({
        data: {
          providerCount: providers.length,
          providers,
        },
      })
    } catch {
      return c.json(
        { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
        500,
      )
    }
  })

  // POST /compile — compile a skill bundle on demand
  // Note: placed before /:provider to avoid collision
  app.post('/compile', async (c) => {
    let body: { bundle: AdapterSkillBundle; providerId?: AdapterProviderId | undefined }
    try {
      body = await c.req.json<{ bundle: AdapterSkillBundle; providerId?: AdapterProviderId | undefined }>()
    } catch {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' } },
        400,
      )
    }

    if (!body.bundle || !body.bundle.bundleId) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'bundle with bundleId is required' } },
        400,
      )
    }

    try {
      const registry = config.skillRegistry!
      const providers = body.providerId
        ? [body.providerId]
        : registry.listProviders()

      const results: Record<string, CompiledAdapterSkill> = {}
      for (const pid of providers) {
        const compiler = registry.getCompiler(pid)
        if (compiler) {
          results[pid] = compiler.compile(body.bundle)
        }
      }

      return c.json({ data: results }, 201)
    } catch (err) {
      const { safe, internal } = sanitizeError(err)
      console.error(`[skills] ${internal}`)
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: safe } },
        400,
      )
    }
  })

  // GET / — list all providers and their compiler availability
  app.get('/', async (c) => {
    try {
      const providers = config.skillRegistry!.listProviders()
      const data = providers.map((pid) => ({
        providerId: pid,
        hasCompiler: !!config.skillRegistry!.getCompiler(pid),
      }))
      return c.json({ data, count: data.length })
    } catch {
      return c.json(
        { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
        500,
      )
    }
  })

  // GET /:provider — list compiler info for a specific provider
  app.get('/:provider', async (c) => {
    try {
      const provider = c.req.param('provider') as AdapterProviderId
      const compiler = config.skillRegistry!.getCompiler(provider)
      if (!compiler) {
        return c.json(
          { error: { code: 'NOT_FOUND', message: `No skill compiler for provider "${provider}"` } },
          404,
        )
      }
      return c.json({
        data: {
          providerId: compiler.providerId,
        },
      })
    } catch {
      return c.json(
        { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
        500,
      )
    }
  })

  // GET /:provider/:skillId — get a specific compiled skill
  // Since the registry is a compiler registry (not a storage of compiled skills),
  // this endpoint returns 404 by design — compiled skills are ephemeral.
  app.get('/:provider/:skillId', async (c) => {
    const provider = c.req.param('provider') as AdapterProviderId
    const compiler = config.skillRegistry!.getCompiler(provider)
    if (!compiler) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: `No skill compiler for provider "${provider}"` } },
        404,
      )
    }
    // Compiled skills are not stored; return 404 with guidance
    return c.json(
      { error: { code: 'NOT_FOUND', message: `Compiled skill "${c.req.param('skillId')}" not found. Use POST /compile to generate compiled skills.` } },
      404,
    )
  })

  return app
}
