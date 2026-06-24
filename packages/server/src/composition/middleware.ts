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
 */
import type { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { cors } from "hono/cors";
import { defaultLogger } from "@dzupagent/core/utils";

import type {
  ForgeServerConfig,
  JsonBodyLimitConfig,
  SecurityHeadersConfig,
} from "./types.js";
import { authMiddleware, type AuthConfig } from "../middleware/auth.js";
import {
  rbacMiddleware,
  type ForgeRole,
  type RBACConfig,
} from "../middleware/rbac.js";
import {
  rateLimiterMiddleware,
  type RateLimiterConfig,
} from "../middleware/rate-limiter.js";

export interface ComposedMiddleware {
  /** Auth config with apiKeyStore validate function wired in (when applicable). */
  effectiveAuth: AuthConfig | undefined;
}

export const DEFAULT_JSON_BODY_MAX_BYTES = 1_048_576;

const DEFAULT_ROUTE_JSON_BODY_MAX_BYTES: Record<string, number> = {
  "/api/memory/import": 8 * 1_048_576,
  "/api/workflows/compile": 2 * 1_048_576,
  "/v1/chat/completions": 2 * 1_048_576,
};

const FRAMEWORK_API_AUTH_WARNING =
  '[ForgeServer] WARNING: Framework /api/* routes are running without authentication. Set auth.mode="api-key" for production, or auth.mode="none" only for local development or legacy compatibility.';

const PRODUCTION_FRAMEWORK_API_AUTH_ERROR =
  '[ForgeServer] Refusing to start production framework /api/* routes without explicit auth. Configure auth: { mode: "api-key", ... } for production, or auth: { mode: "none" } only for an intentional development/compatibility opt-out.';

const WILDCARD_CORS_WARNING =
  "[ForgeServer] WARNING: CORS is open to all origins (*). This is intended only for local development or legacy compatibility.";

const WILDCARD_CORS_ERROR =
  "[ForgeServer] Refusing wildcard CORS in production without allowWildcardCors=true. Configure corsOrigins with an explicit allow-list, disable CORS by omitting corsOrigins, or opt into compatibility with allowWildcardCors.";

export function assertExplicitFrameworkApiAuth(
  config: ForgeServerConfig
): void {
  if (config.auth) {
    return;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(PRODUCTION_FRAMEWORK_API_AUTH_ERROR);
  }

  console.warn(FRAMEWORK_API_AUTH_WARNING);
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

export function createDefaultRbacConfig(config: ForgeServerConfig): RBACConfig {
  if (config.rbac !== false && config.rbac !== undefined) {
    return config.rbac;
  }

  return {
    extractRole: (c) => {
      const key = c.get("apiKey") as Record<string, unknown> | undefined;
      const role = key?.["role"];
      // SEC-L-05: least-privilege default. A key with no explicit role must
      // NOT be silently promoted to 'operator'; fall back to the lowest role
      // ('viewer') so privilege is granted only when explicitly configured.
      return typeof role === "string" ? (role as ForgeRole) : "viewer";
    },
  };
}

function applyCors(app: Hono<AppEnv>, config: ForgeServerConfig): void {
  const origin = resolveCorsOrigin(config);
  if (!origin) {
    return;
  }

  app.use(
    "*",
    cors({
      origin,
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
    })
  );

  if (isWildcardCorsOrigin(origin)) {
    console.warn(WILDCARD_CORS_WARNING);
  }
}

function resolveCorsOrigin(
  config: ForgeServerConfig
): string | string[] | undefined {
  const origin =
    config.corsOrigins ?? (config.allowWildcardCors ? "*" : undefined);
  if (!origin) {
    return undefined;
  }

  const origins = Array.isArray(origin) ? origin : [origin];
  const hasWildcard = origins.includes("*");
  if (
    hasWildcard &&
    process.env.NODE_ENV === "production" &&
    !config.allowWildcardCors
  ) {
    throw new Error(WILDCARD_CORS_ERROR);
  }
  if (hasWildcard && origins.length > 1) {
    throw new Error(
      "[ForgeServer] Invalid CORS configuration: wildcard (*) cannot be combined with explicit origins."
    );
  }

  return origin;
}

function isWildcardCorsOrigin(origin: string | string[]): boolean {
  return Array.isArray(origin) ? origin.includes("*") : origin === "*";
}

function applySecurityHeaders(
  app: Hono<AppEnv>,
  config: ForgeServerConfig
): void {
  if (config.securityHeaders === false) {
    return;
  }

  const headers = resolveSecurityHeaders(config.securityHeaders);
  app.use("*", async (c, next) => {
    await next();
    for (const [name, value] of headers) {
      c.header(name, value);
    }
  });
}

// DZUPAGENT-SEC-I-03: default clickjacking + CSP guard on all responses.
// `frame-ancestors 'none'` blocks the host from being embedded in any frame;
// `default-src 'self'` + `base-uri 'self'` constrain script/asset/base origins
// for any HTML the framework happens to serve. Hosts can override via the
// config or pass `false` to disable a specific header.
const DEFAULT_CONTENT_SECURITY_POLICY =
  "default-src 'self'; base-uri 'self'; frame-ancestors 'none'";
const DEFAULT_X_FRAME_OPTIONS = "DENY";

function resolveSecurityHeaders(
  config?: SecurityHeadersConfig
): Array<[string, string]> {
  const defaults: Array<[string, string | false | undefined]> = [
    ["X-Content-Type-Options", config?.xContentTypeOptions ?? "nosniff"],
    ["Referrer-Policy", config?.referrerPolicy ?? "no-referrer"],
    ["X-Frame-Options", config?.xFrameOptions ?? DEFAULT_X_FRAME_OPTIONS],
    [
      "Content-Security-Policy",
      config?.contentSecurityPolicy ?? DEFAULT_CONTENT_SECURITY_POLICY,
    ],
  ];

  const headers = new Map<string, string>();
  for (const [name, value] of defaults) {
    if (typeof value === "string") {
      headers.set(name, value);
    }
  }
  for (const [name, value] of Object.entries(config?.additionalHeaders ?? {})) {
    if (value === false || value === undefined) {
      headers.delete(name);
    } else {
      headers.set(name, value);
    }
  }
  return [...headers.entries()];
}

function applyAuthAndRbac(
  app: Hono<AppEnv>,
  config: ForgeServerConfig
): AuthConfig | undefined {
  if (!config.auth) {
    return undefined;
  }

  if (config.auth.mode === "none") {
    // SEC-M-02: refuse an explicit `auth.mode: 'none'` in production unless the
    // host has opted in via `allowUnsafeNoAuthInProduction`. An unauthenticated
    // production deployment is a misconfiguration by default, not a choice.
    if (
      process.env.NODE_ENV === "production" &&
      !config.allowUnsafeNoAuthInProduction
    ) {
      throw new Error(PRODUCTION_FRAMEWORK_API_AUTH_ERROR);
    }
    console.warn(FRAMEWORK_API_AUTH_WARNING);
  }

  let effectiveAuth: AuthConfig = config.auth;
  if (
    config.auth.mode === "api-key" &&
    !config.auth.validateKey &&
    config.apiKeyStore
  ) {
    effectiveAuth = {
      ...config.auth,
      validateKey: async (key) => {
        const record = await config.apiKeyStore!.validate(key);
        return record ? ({ ...record } as Record<string, unknown>) : null;
      },
    };
  }
  app.use("/api/*", authMiddleware(effectiveAuth));

  // MC-S02: RBAC — mounted after authMiddleware so the `apiKey` context
  // variable is populated. SEC-L-05: a key with no explicit role defaults to
  // the least-privilege `'viewer'` role (was `'operator'`), so privilege is
  // never granted implicitly; operator/admin access must be set on the key.
  // Admin-only endpoints (MCP registration, cluster management) reject lower
  // roles. Hosts can opt out with `config.rbac = false`.
  if (config.rbac !== false) {
    app.use("/api/*", rbacMiddleware(createDefaultRbacConfig(config)));
  }

  return effectiveAuth;
}

// SEC-M-03: conservative default rate limit applied when auth is enabled but no
// explicit `rateLimit` config was provided. 100 requests / minute per key (or
// per IP, depending on the limiter's key extractor) is a safe floor that keeps
// an authenticated-but-unconfigured deployment from being trivially abused.
export const DEFAULT_RATE_LIMIT: Partial<RateLimiterConfig> = {
  maxRequests: 100,
  windowMs: 60_000,
};

function applyRateLimit(app: Hono<AppEnv>, config: ForgeServerConfig): void {
  // Explicit config wins. Otherwise, when auth is enabled (SEC-M-03), fall back
  // to a conservative default limiter so authenticated APIs are never left
  // entirely unthrottled. With no auth and no explicit rateLimit, preserve the
  // prior behaviour (no limiter) — those are local/dev/compat hosts that have
  // already accepted the unauthenticated warning.
  const effectiveRateLimit =
    config.rateLimit ?? (config.auth ? DEFAULT_RATE_LIMIT : undefined);
  if (!effectiveRateLimit) {
    return;
  }

  for (const path of getRateLimitedRoutePatterns(config)) {
    app.use(path, rateLimiterMiddleware(effectiveRateLimit));
  }
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

function applyJsonBodySizeLimit(
  app: Hono<AppEnv>,
  config: ForgeServerConfig
): void {
  if (config.jsonBodyLimit === false) {
    return;
  }

  const limits = resolveJsonBodyLimits(config.jsonBodyLimit);
  app.use("*", async (c, next) => {
    if (!shouldCheckJsonBodySize(c.req.method, c.req.header("content-type"))) {
      return next();
    }

    const maxBytes = resolveJsonBodyMaxBytes(c.req.path, limits);
    const contentLength = parseContentLength(c.req.header("content-length"));
    if (contentLength !== undefined && contentLength > maxBytes) {
      return c.json(
        {
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message: `JSON request body too large (max ${maxBytes} bytes)`,
          },
        },
        413
      );
    }

    if (contentLength === undefined) {
      // SEC-M-04: stream the body and abort as soon as we have read more than
      // `maxBytes` (i.e. at `maxBytes + 1`). An oversize attacker payload is
      // never buffered in full — we stop reading the moment the limit is
      // crossed. For within-limit bodies we collect the (bounded) chunks and
      // rebuild the request so downstream handlers can still parse it.
      const result = await measureAndRebuildBody(c.req.raw, maxBytes);
      if (result.exceeded) {
        return c.json(
          {
            error: {
              code: "PAYLOAD_TOO_LARGE",
              message: `JSON request body too large (max ${maxBytes} bytes)`,
            },
          },
          413
        );
      }
      if (result.rebuilt) {
        // Replace the consumed body with a fresh, replayable Request.
        c.req.raw = result.rebuilt;
      }
    }

    return next();
  });
}

interface ResolvedJsonBodyLimits {
  defaultMaxBytes: number;
  routeMaxBytes: Record<string, number>;
}

function resolveJsonBodyLimits(
  config?: JsonBodyLimitConfig
): ResolvedJsonBodyLimits {
  return {
    defaultMaxBytes: positiveIntegerOr(
      config?.defaultMaxBytes,
      DEFAULT_JSON_BODY_MAX_BYTES
    ),
    routeMaxBytes: {
      ...DEFAULT_ROUTE_JSON_BODY_MAX_BYTES,
      ...sanitizeRouteMaxBytes(config?.routeMaxBytes),
    },
  };
}

function sanitizeRouteMaxBytes(
  routeMaxBytes?: Record<string, number>
): Record<string, number> {
  if (!routeMaxBytes) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(routeMaxBytes).filter(
      ([path, bytes]) => path.length > 0 && Number.isInteger(bytes) && bytes > 0
    )
  );
}

function positiveIntegerOr(
  value: number | undefined,
  fallback: number
): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function shouldCheckJsonBodySize(
  method: string,
  contentType: string | undefined
): boolean {
  if (method !== "POST" && method !== "PUT" && method !== "PATCH") {
    return false;
  }
  if (!contentType) {
    return false;
  }
  const normalized = contentType.toLowerCase();
  return (
    normalized.includes("application/json") || normalized.includes("+json")
  );
}

function parseContentLength(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

interface BodyMeasureResult {
  /** True when the body exceeded `maxBytes` (read aborted at `maxBytes + 1`). */
  exceeded: boolean;
  /**
   * A replayable Request rebuilt from the (within-limit) collected body, or
   * `undefined` when no rebuild is needed (no body, or the size check could not
   * run). The original body stream is consumed by the measurement, so callers
   * must swap to this rebuilt Request for downstream parsing.
   */
  rebuilt?: Request;
}

/**
 * SEC-M-04: stream the request body and abort the moment the cumulative byte
 * count exceeds `maxBytes` (i.e. at `maxBytes + 1`). An oversize payload is
 * never buffered in full — reading stops as soon as the limit is crossed, so an
 * attacker cannot force the process to allocate the whole body just to have its
 * size checked.
 *
 * Reading the body consumes the underlying stream, so for within-limit bodies we
 * collect the (bounded ≤ `maxBytes`) chunks and rebuild a fresh, replayable
 * Request that downstream handlers can parse.
 *
 * Returns `{ exceeded: false }` with no rebuild when the body cannot be streamed
 * (no body, or the runtime does not expose a readable stream), matching the
 * prior best-effort behaviour where an unreadable body was treated as size 0.
 */
async function measureAndRebuildBody(
  request: Request,
  maxBytes: number
): Promise<BodyMeasureResult> {
  const stream = request.body;
  if (!stream) {
    return { exceeded: false };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          // Abort: the remaining chunks are never read or buffered.
          return { exceeded: true };
        }
        chunks.push(value);
      }
    }
  } catch {
    // Treat an unreadable/aborted body as within-limit; the downstream JSON
    // parser will surface any genuine malformed-body error. Rebuild from what
    // we managed to collect so the downstream consumer still has a body.
    /* fall through to rebuild */
  } finally {
    reader.releaseLock();
  }

  // Reassemble the collected (bounded) chunks into a single buffer and rebuild a
  // replayable Request, since reading consumed the original stream.
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const rebuilt = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: total > 0 ? buffer : undefined,
    // Required by undici when a body stream/buffer is supplied.
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  return { exceeded: false, rebuilt };
}

function resolveJsonBodyMaxBytes(
  path: string,
  limits: ResolvedJsonBodyLimits
): number {
  const exact = limits.routeMaxBytes[path];
  if (exact !== undefined) {
    return exact;
  }

  let matchedBytes: number | undefined;
  let matchedPrefixLength = -1;
  for (const [pattern, bytes] of Object.entries(limits.routeMaxBytes)) {
    if (!pattern.endsWith("*")) {
      continue;
    }
    const prefix = pattern.slice(0, -1);
    if (path.startsWith(prefix) && prefix.length > matchedPrefixLength) {
      matchedBytes = bytes;
      matchedPrefixLength = prefix.length;
    }
  }

  return matchedBytes ?? limits.defaultMaxBytes;
}

function applyShutdownGuard(
  app: Hono<AppEnv>,
  config: ForgeServerConfig
): void {
  if (!config.shutdown) {
    return;
  }
  app.use("/api/runs", async (c, next) => {
    if (c.req.method === "POST" && !config.shutdown!.isAcceptingRuns()) {
      return c.json(
        {
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "Server is shutting down",
          },
        },
        503
      );
    }
    return next();
  });
}

function applyRequestMetrics(
  app: Hono<AppEnv>,
  config: ForgeServerConfig
): void {
  if (!config.metrics) {
    return;
  }
  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    const latency = Date.now() - start;
    config.metrics!.increment("http_requests_total", {
      method: c.req.method,
      path: c.req.path,
      status: String(c.res.status),
    });
    config.metrics!.observe("http_request_duration_ms", latency, {
      method: c.req.method,
      path: c.req.path,
    });
  });
}

function applyErrorHandler(app: Hono<AppEnv>, config: ForgeServerConfig): void {
  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : String(err);

    defaultLogger.error(
      `[ForgeServer] ${c.req.method} ${c.req.path}: ${message}`
    );
    config.metrics?.increment("http_errors_total", { path: c.req.path });
    return c.json(
      { error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
      500
    );
  });
}
