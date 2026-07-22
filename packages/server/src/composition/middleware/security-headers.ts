/**
 * Security-headers middleware slice of the Hono app composition. Extracted from
 * the legacy `composition/middleware.ts` god-module (DZUPAGENT-ARCH-M-06).
 * Behaviour is unchanged: headers are applied on all paths unless explicitly
 * disabled via `securityHeaders: false`.
 */
import type { Hono } from "hono";
import type { AppEnv } from "../../types.js";
import type { ForgeServerConfig, SecurityHeadersConfig } from "../types.js";

export function applySecurityHeaders(
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
