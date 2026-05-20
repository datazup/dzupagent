/**
 * Reflection HTTP routes — list, get, and query patterns from run reflections.
 *
 * Reflections are read-only from the HTTP perspective (created by the
 * run-worker after each completed run). These routes expose the stored
 * ReflectionSummary data for dashboards and analysis.
 *
 * SEC-M-03 sibling sweep
 * ----------------------
 * `GET /` (list) and `GET /patterns/:type` are fleet-wide aggregates that
 * historically returned reflections from every run in the store regardless of
 * which API key was making the request. The SEC-M-03 pattern (operator RBAC +
 * tenant/owner scoping on telemetry list endpoints) is applied here.
 *
 * Store-interface gap: `RunReflectionStore` keys reflections by `runId` only
 * and `ReflectionSummary` has neither `tenantId` nor `ownerId`. We cannot push
 * the filter into the store without widening that interface (out of scope for
 * this sweep). Instead, when a `runStore` is supplied, we look up the owning
 * run for each candidate reflection and filter in-route. Hosts that don't wire
 * a `runStore` fall back to the legacy unfiltered behaviour, which preserves
 * compatibility with the existing test harness that constructs the route in
 * isolation.
 */
import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import type { RunReflectionStore, ReflectionPattern, ReflectionSummary } from '@dzupagent/agent'
import type { Run, RunStore } from '@dzupagent/core/persistence'
import { getOptionalRequestingTenantId } from './tenant-scope.js'
import { requireOwnedRun } from './run-guard.js'

export interface ReflectionRouteConfig {
  reflectionStore: RunReflectionStore
  /**
   * Optional `RunStore` used to enforce tenant/owner scoping on the
   * list/pattern endpoints. When supplied, only reflections whose owning run
   * matches the requesting API key's tenant and owner are returned.
   *
   * TODO(reflection-store-scope): widen `RunReflectionStore` to accept
   * `tenantId` / `ownerId` filters so we can push this scoping into the store
   * instead of doing a second `runStore.get` per reflection.
   */
  runStore?: RunStore
}

const VALID_PATTERN_TYPES = new Set<ReflectionPattern['type']>([
  'repeated_tool',
  'error_loop',
  'successful_strategy',
  'slow_step',
])

/**
 * Cap pulled from the store when scoping is active. We over-fetch so the
 * post-filter result still has a reasonable chance of meeting the caller's
 * requested limit even when most reflections belong to other tenants.
 */
const SCOPED_FETCH_CAP = 500

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
  c: import('hono').Context<AppEnv>,
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
 * Filter a reflection list by tenant/owner using a `RunStore` lookup. When
 * `runStore` is undefined we cannot enforce scoping (no per-reflection
 * metadata) and return the input unchanged. Reflections whose owning run is
 * missing from the run store are excluded under a closed-world policy: we do
 * not leak telemetry for runs whose ownership cannot be confirmed.
 */
async function filterReflectionsByOwnership(
  reflections: ReflectionSummary[],
  runStore: RunStore | undefined,
  ctx: RbacContext,
): Promise<ReflectionSummary[]> {
  if (!runStore || !ctx.authenticated) return reflections
  if (!ctx.requestingTenantId && !ctx.requestingOwnerId) return reflections

  const filtered: ReflectionSummary[] = []
  for (const reflection of reflections) {
    const run = await runStore.get(reflection.runId)
    if (!run) {
      // Defense-in-depth: drop reflections whose run is unknown. A previous
      // owner-aware run-store may have already filtered the lookup out.
      continue
    }
    if (!isRunVisible(run, ctx)) continue
    filtered.push(reflection)
  }
  return filtered
}

function isRunVisible(run: Run, ctx: RbacContext): boolean {
  if (ctx.requestingTenantId) {
    const runTenantId = (run.tenantId ?? 'default') || 'default'
    if (runTenantId !== ctx.requestingTenantId) return false
  }
  if (ctx.requestingOwnerId) {
    // Legacy ownerless rows are visible (matches routing-stats pattern).
    if (run.ownerId && run.ownerId !== ctx.requestingOwnerId) return false
  }
  return true
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

    // When scoping is active, over-fetch so post-filter still satisfies limit.
    const fetchLimit = config.runStore && rbac.authenticated ? SCOPED_FETCH_CAP : limit
    const candidates = await config.reflectionStore.list(fetchLimit)
    const scoped = await filterReflectionsByOwnership(candidates, config.runStore, rbac)
    const reflections = scoped.slice(0, limit)
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

    const allPatterns = await config.reflectionStore.getPatterns(type)

    // When scoping is active, restrict patterns to those whose run is
    // visible to the caller. `getPatterns` returns flat patterns without a
    // back-pointer to runId, so we cross-reference with the reflection list.
    if (config.runStore && rbac.authenticated && (rbac.requestingTenantId || rbac.requestingOwnerId)) {
      const summaries = await config.reflectionStore.list(SCOPED_FETCH_CAP)
      const visibleSummaries = await filterReflectionsByOwnership(summaries, config.runStore, rbac)
      const visiblePatternKeys = new Set<string>()
      for (const summary of visibleSummaries) {
        for (const pattern of summary.patterns) {
          if (pattern.type === type) {
            visiblePatternKeys.add(patternKey(pattern))
          }
        }
      }
      const filteredPatterns = allPatterns.filter((p) => visiblePatternKeys.has(patternKey(p)))
      return c.json({ patterns: filteredPatterns })
    }

    return c.json({ patterns: allPatterns })
  })

  // --- Get single reflection by runId ---
  // MJ-SEC-02: per-id reads gate on ownership of the OWNING RUN via the
  // shared `requireOwnedRun` guard. The reflection summary itself does not
  // carry tenant/owner metadata, so we authorize by looking up the run and
  // checking its `ownerId` / `tenantId` against the requesting API key.
  // Cross-owner / cross-tenant access returns 404 (not 403) to prevent
  // enumeration of foreign run ids — matching run-context.ts and approvals.ts.
  //
  // When `runStore` is unwired (legacy hosts that construct the route in
  // isolation), the guard is skipped and the route falls back to the
  // pre-MJ-SEC-02 behaviour. This mirrors the list/pattern endpoints, which
  // also degrade to unfiltered legacy behaviour without a `runStore`.
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

/**
 * Identity key for a `ReflectionPattern`. `RunReflectionStore.getPatterns()`
 * returns a flattened list with no back-pointer to its source run, so we
 * fingerprint each pattern by its visible fields. Two patterns from different
 * reflections that happen to share the same type/description/occurrences/
 * stepIndices will be treated as equivalent — acceptable for this sweep
 * because the worst case is "show a pattern the caller could already see via
 * one of their own runs". A future store widening (see TODO above) should
 * make this unnecessary.
 */
function patternKey(p: ReflectionPattern): string {
  return `${p.type}|${p.description}|${p.occurrences}|${p.stepIndices.join(',')}`
}
