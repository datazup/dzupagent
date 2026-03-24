/**
 * Cloudflare Workers adapter — exports Hono app as a Workers-compatible module.
 *
 * Cloudflare Workers expect an object with a `fetch` method that accepts
 * `(Request, Env, ExecutionContext)`. Hono's `app.fetch()` already matches
 * the `(Request) => Promise<Response>` signature.
 */
import type { Hono } from 'hono'

interface CloudflareWorkerHandler {
  fetch: (request: Request) => Promise<Response>
}

/**
 * Export a Hono app as a Cloudflare Workers handler.
 *
 * @example
 * ```ts
 * // src/worker.ts
 * import { createForgeApp } from '@forgeagent/server'
 * import { toCloudflareHandler } from '@forgeagent/server/platforms/cloudflare'
 *
 * const app = createForgeApp({ ... })
 * export default toCloudflareHandler(app)
 * ```
 */
export function toCloudflareHandler(app: Hono): CloudflareWorkerHandler {
  return { fetch: async (request: Request): Promise<Response> => app.fetch(request) }
}
