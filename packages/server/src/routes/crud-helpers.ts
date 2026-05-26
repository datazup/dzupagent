/**
 * Shared CRUD route mechanics for tenant-scoped resource routers.
 *
 * Built-in resource routers (agents, personas, ...) repeat the same three
 * concerns on every handler: extract the requesting tenant, validate the
 * request body into a typed value (returning a 400 envelope on failure), and
 * emit consistent `{ data }` / `{ error: { code, message } }` JSON envelopes.
 *
 * These helpers centralize that boilerplate WITHOUT changing any response
 * shape. The envelopes produced here are byte-for-byte identical to the
 * hand-written handlers they replace, so the public HTTP contract is
 * unchanged.
 */
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ZodType } from 'zod'
import { getRequestingTenantId } from './tenant-scope.js'
import { validateBodyCompat } from './schemas.js'

/**
 * Resolve the requesting tenant id from the authenticated API key.
 *
 * Thin re-export so resource routers can depend on a single CRUD helper
 * module instead of reaching into {@link getRequestingTenantId} directly.
 */
export function tenantOf(c: Context): string {
  return getRequestingTenantId(c)
}

/**
 * Emit a `{ data }` success envelope.
 *
 * @param status - HTTP status (defaults to 200; pass 201 for creates).
 */
export function data<T>(c: Context, payload: T, status: ContentfulStatusCode = 200): Response {
  return c.json({ data: payload }, status)
}

/**
 * Emit a `{ error: { code: 'NOT_FOUND', message } }` envelope with a 404
 * status. Message defaults to `"<Resource> not found"` when a resource label
 * is supplied.
 */
export function notFound(c: Context, message: string): Response {
  return c.json({ error: { code: 'NOT_FOUND', message } }, 404)
}

/**
 * Validate a request body against a Zod schema.
 *
 * On success returns `{ ok: true, value }`. On failure returns
 * `{ ok: false, response }` carrying the 400 envelope produced by
 * {@link validateBodyCompat}. Callers narrow on `ok` and early-return the
 * response, e.g.:
 *
 * ```ts
 * const parsed = await body(c, CreateSchema)
 * if (!parsed.ok) return parsed.response
 * // parsed.value is fully typed here
 * ```
 */
export async function body<T>(
  c: Context,
  schema: ZodType<T>,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  const parsed = await validateBodyCompat(c, schema)
  if (parsed instanceof Response) return { ok: false, response: parsed }
  return { ok: true, value: parsed }
}
