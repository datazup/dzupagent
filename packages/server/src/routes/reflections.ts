/**
 * Reflection HTTP routes — list, get, and query patterns from run reflections.
 *
 * Reflections are read-only from the HTTP perspective (created by the
 * run-worker after each completed run). These routes expose the stored
 * ReflectionSummary data for dashboards and analysis.
 *
 * SEC-M-03 sibling sweep + RUN-REFLECTION-STORE-WIDEN
 * ---------------------------------------------------
 * `GET /` (list) and `GET /patterns/:type` are fleet-wide aggregates that
 * historically returned reflections from every run in the store regardless of
 * which API key was making the request. The SEC-M-03 / MJ-SEC-02 pattern
 * (operator RBAC + tenant/owner scoping on telemetry list endpoints) is
 * applied here by pushing tenant/ownerId filters into the store interface
 * itself (`RunReflectionStore.list({ tenantId, ownerId })` and
 * `getPatterns(type, { tenantId, ownerId })`).
 *
 * The previous defense-in-depth implementation looked up the owning
 * `RunStore` row per candidate reflection (an O(N) extra-fetch with a
 * SCOPED_FETCH_CAP over-fetch guard). That hack is now removed; the store
 * does the filtering at the SELECT layer. The per-id `GET /:runId`
 * endpoint still uses `requireOwnedRun` (MJ-SEC-02), which is correct —
 * it gates by the owning run, not the reflection row.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../types.js'
import type { RunReflectionStore, ReflectionPattern } from '@dzupagent/agent/reflection'
import type { RunStore } from '@dzupagent/core/persistence'
import { getOptionalRequestingTenantId } from './tenant-scope.js'
import { requireOwnedRun } from './run-guard.js'

export interface ReflectionRouteConfig {
  reflectionStore: RunReflectionStore
  /**
   * Optional `RunStore` used by the per-id `GET /:runId` endpoint to
   * enforce ownership via {@link requireOwnedRun}. When unwired, the
   * per-id guard is skipped (legacy hosts that mount the route in
   * isolation). List/pattern endpoints no longer consume this — they
   * push tenant/owner filters into the store itself.
   */
  runStore?: RunStore
}

const VALID_PATTERN_TYPES = new Set<ReflectionPattern['type']>([
  'repeated_tool',
  'error_loop',
  'successful_strategy',
  'slow_step',
])

interface RbacContext {
  /** True if the request is authenticated; subsequent filtering applies. */
  authenticated: boolean
  requestingTenantId: string | undefined
  requestingOwnerId: string | undefined
}

/**
 * Resolve the requesting key's owner/tenant, or return a 403 Response if the
 * key is present but malformed (matches the routing-stats pattern).
 */
function resolveRbacContext(
  c: Context<AppEnv>,
  resource: string,
): RbacContext | Response {
  const key = c.get('apiKey')
  if (key !== undefined && typeof key?.['id'] !== 'string') {
    return c.json(
      { error: { code: 'FORBIDDEN', message: `API key must have a valid id to access ${resource}` } },
      403,
    )
  }
  const requestingTenantId = getOptionalRequestingTenantId(c)
  const requestingOwnerId = typeof key?.['id'] === 'string' ? key['id'] : undefined
  return {
    authenticated: key !== undefined,
    requestingTenantId,
    requestingOwnerId,
  }
}

/**
 * Translate an {@link RbacContext} into the tenant/owner filter accepted by
 * {@link RunReflectionStore}. Unauthenticated requests pass `undefined` for
 * both fields, preserving legacy unfiltered behaviour for hosts that mount
 * the routes without an auth middleware.
 */
function scopeFromRbac(ctx: RbacContext): { tenantId?: string; ownerId?: string } {
  if (!ctx.authenticated) return {}
  return {
    ...(ctx.requestingTenantId !== undefined ? { tenantId: ctx.requestingTenantId } : {}),
    ...(ctx.requestingOwnerId !== undefined ? { ownerId: ctx.requestingOwnerId } : {}),
  }
}

export function createReflectionRoutes(config: ReflectionRouteConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // --- List reflections ---
  app.get('/', async (c) => {
    const rbac = resolveRbacContext(c, 'reflections')
    if (rbac instanceof Response) return rbac

    const limitParam = c.req.query('limit')
    let limit = 20
    if (limitParam !== undefined) {
      const parsed = parseInt(limitParam, 10)
      if (!Number.isNaN(parsed) && parsed > 0) {
        limit = Math.min(parsed, 100)
      }
    }

    const scope = scopeFromRbac(rbac)
    const reflections = await config.reflectionStore.list({ limit, ...scope })
    return c.json({ reflections })
  })

  // --- Get patterns by type ---
  // NOTE: This route must be registered BEFORE /:runId to avoid
  // "patterns" being interpreted as a runId parameter.
  app.get('/patterns/:type', async (c) => {
    const type = c.req.param('type') as ReflectionPattern['type']

    if (!VALID_PATTERN_TYPES.has(type)) {
      return c.json(
        { error: { code: 'BAD_REQUEST', message: `Invalid pattern type: ${type}. Valid types: ${[...VALID_PATTERN_TYPES].join(', ')}` } },
        400,
      )
    }

    const rbac = resolveRbacContext(c, 'reflection patterns')
    if (rbac instanceof Response) return rbac

    const scope = scopeFromRbac(rbac)
    const patterns = await config.reflectionStore.getPatterns(type, scope)
    return c.json({ patterns })
  })

  // --- Get single reflection by runId ---
  // MJ-SEC-02: per-id reads gate on ownership of the OWNING RUN via the
  // shared `requireOwnedRun` guard. The reflection summary itself now
  // carries tenant/owner stamps (RUN-REFLECTION-STORE-WIDEN), but we keep
  // the existing run-store-based guard so single-id reads share the same
  // 404-on-miss enumeration-resistant code path as run-context.ts and
  // approvals.ts.
  //
  // When `runStore` is unwired (legacy hosts that construct the route in
  // isolation), the guard is skipped and the route falls back to the
  // pre-MJ-SEC-02 behaviour.
  app.get('/:runId', async (c) => {
    const runId = c.req.param('runId')

    if (config.runStore) {
      const ownedRun = await requireOwnedRun(c, runId, config.runStore)
      if (ownedRun instanceof Response) return ownedRun
    }

    const reflection = await config.reflectionStore.get(runId)

    if (!reflection) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: 'Reflection not found' } },
        404,
      )
    }

    return c.json(reflection)
  })

  return app
}
