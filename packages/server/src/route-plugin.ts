/**
 * A server route plugin that mounts domain-specific routes
 * without requiring the server to have compile-time knowledge of domain types.
 *
 * `createRoutes()` returns a Hono sub-app but is typed as `unknown` to avoid
 * coupling consumers to a specific Hono version/installation. The server casts
 * it internally when calling `app.route()`.
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
  /** Factory that creates the Hono sub-app/router. Returns unknown to avoid Hono version coupling. */
  createRoutes(context: ServerRoutePluginContext<TServerConfig>): unknown
  /**
   * Optional: called after routes are mounted, for event-bus integration hooks.
   * The first argument stays the legacy server config for source
   * compatibility; newer plugins can use the second context argument.
   */
  onMount?(serverConfig: TServerConfig, context: ServerRoutePluginContext<TServerConfig>): void
}
