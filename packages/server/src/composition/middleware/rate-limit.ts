/**
 * Rate-limiter middleware slice of the Hono app composition. Extracted from the
 * legacy `composition/middleware.ts` god-module (DZUPAGENT-ARCH-M-06).
 * Split into a pre-auth address guard and a post-auth principal/tier limiter
 * (DZUPAGENT-SEC-H-23).
 */
import type { Hono } from "hono";
import type { AppEnv } from "../../types.js";
import type { ForgeServerConfig } from "../types.js";
import {
  createRateLimitMiddlewares,
  type RateLimiterConfig,
} from "../../middleware/rate-limiter.js";

// SEC-M-03: conservative default rate limit applied when auth is enabled but no
// explicit `rateLimit` config was provided. 100 requests / minute per key (or
// per IP, depending on the limiter's key extractor) is a safe floor that keeps
// an authenticated-but-unconfigured deployment from being trivially abused.
export const DEFAULT_RATE_LIMIT: Partial<RateLimiterConfig> = {
  maxRequests: 100,
  windowMs: 60_000,
};

/**
 * Mount the pre-auth, address-keyed flood guard and return a callback that
 * mounts the principal/tier limiter. Call the callback after the auth
 * middleware is registered (DZUPAGENT-SEC-H-23): before auth there is no
 * principal and no tier, so every caller would share one bucket.
 */
export function applyRateLimit(
  app: Hono<AppEnv>,
  config: ForgeServerConfig
): { applyPostAuth: () => void } {
  // Explicit config wins. Otherwise, when auth is enabled (SEC-M-03), fall back
  // to a conservative default limiter so authenticated APIs are never left
  // entirely unthrottled. With no auth and no explicit rateLimit, preserve the
  // prior behaviour (no limiter) — those are local/dev/compat hosts that have
  // already accepted the unauthenticated warning.
  const effectiveRateLimit =
    config.rateLimit ?? (config.auth ? DEFAULT_RATE_LIMIT : undefined);
  if (!effectiveRateLimit) {
    return { applyPostAuth: () => undefined };
  }

  const paths = getRateLimitedRoutePatterns(config);
  const postAuth: Array<[string, ReturnType<typeof createRateLimitMiddlewares>["postAuth"]]> = [];
  for (const path of paths) {
    const { preAuth, postAuth: limiter } = createRateLimitMiddlewares(effectiveRateLimit);
    app.use(path, preAuth);
    postAuth.push([path, limiter]);
  }
  return {
    applyPostAuth: () => {
      for (const [path, limiter] of postAuth) app.use(path, limiter);
    },
  };
}

function getRateLimitedRoutePatterns(config: ForgeServerConfig): string[] {
  const paths = ["/api/*"];
  if (config.a2a) {
    paths.push("/a2a", "/a2a/*");
  }
  if (config.openai?.enabled === true) {
    paths.push("/v1/*");
  }
  return paths;
}
