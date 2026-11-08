/**
 * Agent card discovery routes: GET /.well-known/agent.json (legacy) and
 * GET /.well-known/agent-card.json (A2A v0.3.0)
 */
import type { Hono } from "hono";
import type { AppEnv } from "../../types.js";
import type { A2ARoutesConfig } from "./helpers.js";
import { toAgentCardV030 } from "../../a2a/agent-card-v030.js";
import { rateLimiterMiddleware } from "../../middleware/rate-limiter.js";

/**
 * SEC-I-04: this endpoint is public and unauthenticated per the A2A spec, so it
 * is not covered by the `/api/*` rate limiter. Apply a route-scoped throttle to
 * stop unauthenticated discovery floods. Per-IP by default (the route has no
 * bearer token to key on), tunable via `config.wellKnownRateLimit`.
 */
const DEFAULT_WELL_KNOWN_RATE_LIMIT = {
  maxRequests: 60,
  windowMs: 60_000,
  trustForwardedFor: true,
} as const;

export function registerWellKnownRoutes(
  app: Hono<AppEnv>,
  config: A2ARoutesConfig
): void {
  for (const path of ["/.well-known/agent.json", "/.well-known/agent-card.json"]) {
    app.use(
      path,
      rateLimiterMiddleware({
        ...DEFAULT_WELL_KNOWN_RATE_LIMIT,
        ...config.wellKnownRateLimit,
      })
    );
  }
  app.get("/.well-known/agent.json", (c) => {
    return c.json(config.agentCard);
  });
  app.get("/.well-known/agent-card.json", (c) => {
    return c.json(toAgentCardV030(config.agentCard));
  });
}
