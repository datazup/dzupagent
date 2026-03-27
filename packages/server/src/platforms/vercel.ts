/**
 * Vercel serverless adapter — thin wrapper around Hono's fetch interface.
 *
 * Vercel Edge/Serverless functions accept a standard `Request` and return
 * a `Response`, which maps directly to `app.fetch()`.
 */
import type { Hono } from 'hono'

/**
 * Export a Hono app as a Vercel serverless handler.
 *
 * @example
 * ```ts
 * // api/index.ts (Vercel entry point)
 * import { createForgeApp } from '@dzipagent/server'
 * import { toVercelHandler } from '@dzipagent/server/platforms/vercel'
 *
 * const app = createForgeApp({ ... })
 * export default toVercelHandler(app)
 * ```
 */
export function toVercelHandler(
  app: Hono,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => app.fetch(req)
}
