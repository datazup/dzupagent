/**
 * Shared run-loading guard for `/api/runs/:id/*` subroutes (MJ-SEC-02).
 *
 * Subroute files (`run-context.ts`, `run-trace.ts`, `approval.ts`,
 * `human-contact.ts`, `enrichment-metrics.ts`) historically reimplemented the
 * `runStore.get` + null-check + owner-check trio inline, which made it easy
 * for new subroutes to forget the owner check entirely.
 *
 * `requireOwnedRun` collapses that trio into a single call. It returns either
 * the loaded `Run` (caller is allowed to proceed) or a `Response` with an
 * appropriate status (caller must short-circuit and return).
 *
 * Cross-owner / cross-tenant access deliberately returns 404 rather than 403
 * so attackers cannot use status-code probing to enumerate run ids that
 * belong to other tenants.
 *
 * The owner/tenant resolution logic mirrors `enforceOwnerAccess` in
 * `routes/runs.ts`; it is duplicated here (rather than re-exported) so this
 * helper has no inbound dependency on the run-lifecycle handlers.
 */
import type { Context } from 'hono'
import type { Run, RunStore } from '@dzupagent/core'

/**
 * Extract the current API key's id from the Hono context (set by the auth
 * middleware). Returns undefined when auth is disabled or the context
 * variable is absent.
 */
function getRequestingKeyId(c: Context): string | undefined {
  const key = c.get('apiKey' as never) as Record<string, unknown> | undefined
  const id = key?.['id']
  return typeof id === 'string' ? id : undefined
}

/**
 * Extract the authenticated API key's tenant scope. Prefers `tenantId`,
 * falls back to `ownerId`, then `id`, and finally `'default'` when auth is
 * disabled entirely.
 */
function getRequestingTenantId(c: Context): string {
  const key = c.get('apiKey' as never) as Record<string, unknown> | undefined
  const tenantId = key?.['tenantId']
  if (typeof tenantId === 'string' && tenantId.length > 0) return tenantId
  const ownerId = key?.['ownerId']
  if (typeof ownerId === 'string' && ownerId.length > 0) return ownerId
  const id = key?.['id']
  if (typeof id === 'string' && id.length > 0) return id
  return 'default'
}

/**
 * Enforce owner + tenant scoping on a previously-loaded run. Returns the run
 * unchanged on success, or a 404 Response when the caller's API key differs
 * from the run's recorded `ownerId` / `tenantId`. Runs without an `ownerId`
 * (pre-migration rows) are always visible — we do not retroactively lock
 * them out.
 */
function enforceOwnerAccess(c: Context, run: Run): Run | Response {
  const requestingKeyId = getRequestingKeyId(c)
  if (run.ownerId && requestingKeyId && run.ownerId !== requestingKeyId) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Run not found' } }, 404)
  }

  // Tenant isolation — reject cross-tenant reads even when the legacy owner
  // check would otherwise allow them through. Only gate when the caller is
  // authenticated; unauth'd callers fall through to preserve the library
  // default.
  const key = c.get('apiKey' as never) as Record<string, unknown> | undefined
  if (key) {
    const requestingTenantId = getRequestingTenantId(c)
    const runTenantId = (run.tenantId ?? 'default') || 'default'
    if (runTenantId !== requestingTenantId) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Run not found' } }, 404)
    }
  }

  return run
}

/**
 * Load a run by id and enforce owner + tenant scoping. Returns the run on
 * success, or a Hono `Response` (404 for missing/foreign run) when the
 * caller must abort.
 *
 * Usage:
 * ```ts
 * const run = await requireOwnedRun(c, runId, runStore)
 * if (run instanceof Response) return run
 * // ...continue with `run`
 * ```
 *
 * @param c       Hono context, used to read the authenticated `apiKey` for
 *                owner/tenant checks.
 * @param runId   Run identifier from `c.req.param('id')` (caller passes it
 *                explicitly so the helper does not depend on a specific
 *                param name).
 * @param runStore Persistence-layer store implementing `RunStore.get`.
 */
export async function requireOwnedRun(
  c: Context,
  runId: string | undefined,
  runStore: RunStore,
): Promise<Run | Response> {
  if (!runId) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Run not found' } },
      404,
    )
  }

  const raw = await runStore.get(runId)
  if (!raw) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Run not found' } },
      404,
    )
  }

  return enforceOwnerAccess(c, raw)
}
