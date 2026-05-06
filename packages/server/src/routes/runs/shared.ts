/**
 * Shared helpers for `/api/runs/*` handlers.
 *
 * Owner-scope, tenant-scope, and "load run by id" utilities live here so they
 * can be consumed by every per-verb handler file (`create-handler.ts`,
 * `list-handler.ts`, `control-handler.ts`, `stream-handler.ts`) without
 * pulling those handlers into a single monolithic module.
 */
import type { Context } from 'hono'
import type { Run } from '@dzupagent/core'

import type { ForgeServerConfig } from '../../composition/types.js'
import type { AppEnv } from '../../types.js'

/**
 * Extract the current API key's id from the Hono context (set by the auth
 * middleware). Returns undefined when auth is disabled or the context variable
 * is absent.
 */
export function getRequestingKeyId(c: Context): string | undefined {
  // `apiKey` is set by the auth middleware as `Record<string, unknown>`;
  // the runtime may or may not carry an `id` field depending on the
  // configured validateKey callback.
  const key = (c as Context<AppEnv>).get('apiKey')
  const id = key?.['id']
  return typeof id === 'string' ? id : undefined
}

/**
 * MC-S01 / MC-S02: Extract the authenticated API key's tenant scope from the
 * Hono context. Prefers `tenantId`, falls back to `ownerId`, then `id`, and
 * finally `'default'` when auth is disabled entirely. Using this helper keeps
 * quota accounting and tenant-isolation filters aligned on the same key.
 */
export function getRequestingTenantId(c: Context): string {
  const key = (c as Context<AppEnv>).get('apiKey')
  const tenantId = key?.['tenantId']
  if (typeof tenantId === 'string' && tenantId.length > 0) return tenantId
  const ownerId = key?.['ownerId']
  if (typeof ownerId === 'string' && ownerId.length > 0) return ownerId
  const id = key?.['id']
  if (typeof id === 'string' && id.length > 0) return id
  return 'default'
}

/**
 * Enforce owner scoping on a run fetched from the store. Returns the run on
 * success, or a 404 Response when the caller's API key differs from the run's
 * recorded `ownerId`. Runs without an `ownerId` (pre-migration) are always
 * visible — we do not retroactively lock them out.
 */
export function enforceOwnerAccess(c: Context, run: Run): Run | Response {
  const requestingKeyId = getRequestingKeyId(c)
  if (run.ownerId && requestingKeyId && run.ownerId !== requestingKeyId) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Run not found' } }, 404)
  }

  // MC-S02: tenant isolation — reject cross-tenant reads even when the
  // legacy owner check would otherwise allow them through. Runs with no
  // recorded tenant (pre-migration) are treated as 'default'. We only
  // gate when the caller is authenticated; unauth'd callers fall through
  // to preserve the library default.
  const key = (c as Context<AppEnv>).get('apiKey')
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
 * Fetch a run by id, returning a 404 response when missing. This collapses
 * the `get + null-check` dance that every handler used to repeat.
 */
export async function loadRunOr404(
  c: Context,
  config: ForgeServerConfig,
): Promise<Run | Response> {
  const id = c.req.param('id')
  if (!id) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Run not found' } }, 404)
  }
  const run = await config.runStore.get(id)
  if (!run) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Run not found' } }, 404)
  }
  return run
}

/** Combined load + owner-check used by nearly every `/:id/*` handler. */
export async function loadOwnedRun(
  c: Context,
  config: ForgeServerConfig,
): Promise<Run | Response> {
  const run = await loadRunOr404(c, config)
  if (run instanceof Response) return run
  return enforceOwnerAccess(c, run)
}

/** Maximum serialized JSON size of `input` payloads accepted by `POST /runs`. */
export const RUN_INPUT_MAX_BYTES = 256 * 1024
/** Maximum serialized JSON size of `metadata` payloads accepted by `POST /runs`. */
export const RUN_METADATA_MAX_BYTES = 64 * 1024
