/**
 * A server route plugin that mounts domain-specific routes
 * without requiring the server to have compile-time knowledge of domain types.
 *
 * `createRoutes()` returns a Hono sub-app but is typed as `unknown` to avoid
 * coupling consumers to a specific Hono version/installation. The server casts
 * it internally when calling `app.route()`.
 */
export interface ServerRoutePlugin {
  /** URL prefix (e.g., '/api/workflows') */
  readonly prefix: string
  /** Factory that creates the Hono sub-app/router. Returns unknown to avoid Hono version coupling. */
  createRoutes(): unknown
  /** Optional: called after routes are mounted, for event-bus integration hooks */
  onMount?(serverConfig: unknown): void
}
