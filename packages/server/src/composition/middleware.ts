/**
 * Middleware composition for the Hono app. Encapsulates the legacy ordering
 * from `app.ts`:
 *
 *   1. CORS (only when explicitly configured)
 *   2. Security headers (all paths) — unless explicitly disabled
 *   3. Auth (`/api/*`) — when `config.auth` is provided
 *   4. RBAC  (`/api/*`) — chained after auth unless explicitly disabled
 *   5. Rate limiter (`/api/*`) — when `config.rateLimit` is provided
 *   6. JSON body size guard (all paths) — unless explicitly disabled
 *   7. Shutdown guard for `POST /api/runs` — when `config.shutdown` is provided
 *   8. Request metrics (all paths) — when `config.metrics` is provided
 *   9. Global `onError` handler (always)
 *
 * The function returns the resolved `effectiveAuth` (with `apiKeyStore` wired
 * into the validateKey callback when applicable) so downstream consumers
 * (notably the A2A route mount) can reuse it.
 *
 * DZUPAGENT-ARCH-M-06: this module is now a thin composition root. Each numbered
 * concern lives in a per-concern leaf module under `./middleware/`; this file
 * only wires them into the legacy ordering and re-exports the public surface.
 */
import type { Hono } from "hono";
import type { AppEnv } from "../types.js";
import type { ForgeServerConfig } from "./types.js";
import type { AuthConfig } from "../middleware/auth.js";

import { applyCors } from "./middleware/cors.js";
import { applySecurityHeaders } from "./middleware/security-headers.js";
import { applyAuthAndRbac } from "./middleware/auth.js";
import { applyRateLimit } from "./middleware/rate-limit.js";
import { applyJsonBodySizeLimit } from "./middleware/json-body-limit.js";
import {
  applyShutdownGuard,
  applyRequestMetrics,
  applyErrorHandler,
} from "./middleware/runtime.js";

export {
  assertExplicitFrameworkApiAuth,
  createDefaultRbacConfig,
} from "./middleware/auth.js";
export { DEFAULT_JSON_BODY_MAX_BYTES } from "./middleware/json-body-limit.js";
export { DEFAULT_RATE_LIMIT } from "./middleware/rate-limit.js";

export interface ComposedMiddleware {
  /** Auth config with apiKeyStore validate function wired in (when applicable). */
  effectiveAuth: AuthConfig | undefined;
}

export function applyMiddleware(
  app: Hono<AppEnv>,
  config: ForgeServerConfig
): ComposedMiddleware {
  applyCors(app, config);
  applySecurityHeaders(app, config);
  const effectiveAuth = applyAuthAndRbac(app, config);
  applyRateLimit(app, config);
  applyJsonBodySizeLimit(app, config);
  applyShutdownGuard(app, config);
  applyRequestMetrics(app, config);
  applyErrorHandler(app, config);

  return { effectiveAuth };
}
