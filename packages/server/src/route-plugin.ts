/**
 * A server route plugin that mounts domain-specific routes
 * without requiring the server to have compile-time knowledge of domain types.
 *
 * `createRoutes()` returns a Hono sub-app but is typed as `unknown` to avoid
 * coupling consumers to a specific Hono version/installation. The server casts
 * it internally when calling `app.route()`.
 *
 * AUTH CONSTRAINT
 * ---------------
 * By default every plugin MUST use a prefix that starts with `/api/` so that
 * the auth middleware applied to that path segment is not bypassed.  Plugins
 * that intentionally serve unauthenticated routes (e.g. health checks, OIDC
 * callbacks) must explicitly opt out by setting `auth: 'bypass'`.  Attempting
 * to register a non-`/api/` plugin without `auth: 'bypass'` will throw a
 * startup error from `mountRoutePlugins`.
 */
export interface ServerRoutePluginContext<TServerConfig = unknown> {
  /** Runtime config after server bootstrap defaults have been resolved. */
  readonly serverConfig: TServerConfig
}

export interface ServerRoutePlugin<TServerConfig = unknown> {
  /** Optional stable family label for diagnostics and composition tests. */
  readonly family?: string
  /** URL prefix (e.g., '/api/workflows'); use '' only for root-level framework compatibility routes. */
  readonly prefix: string
  /**
   * Auth enforcement mode.
   *
   * - `'required'` (default) — the prefix MUST start with `/api/` so that the
   *   standard auth middleware covers these routes.
   * - `'bypass'` — the plugin explicitly opts out of the `/api/` prefix
   *   requirement.  Use only for unauthenticated routes such as health checks,
   *   OIDC redirect handlers, or public webhooks.
   */
  readonly auth?: 'required' | 'bypass'
  /** Factory that creates the Hono sub-app/router. Returns unknown to avoid Hono version coupling. */
  createRoutes(context: ServerRoutePluginContext<TServerConfig>): unknown
  /**
   * Optional: called after routes are mounted, for event-bus integration hooks.
   * The first argument stays the legacy server config for source
   * compatibility; newer plugins can use the second context argument.
   */
  onMount?(serverConfig: TServerConfig, context: ServerRoutePluginContext<TServerConfig>): void
}
