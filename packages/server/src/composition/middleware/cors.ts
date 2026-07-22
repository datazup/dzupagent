/**
 * CORS middleware slice of the Hono app composition. Extracted from the legacy
 * `composition/middleware.ts` god-module (DZUPAGENT-ARCH-M-06). Behaviour is
 * unchanged: CORS is only mounted when explicitly configured, and wildcard
 * origins are refused in production unless `allowWildcardCors` is set.
 */
import type { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv } from "../../types.js";
import type { ForgeServerConfig } from "../types.js";

const WILDCARD_CORS_WARNING =
  "[ForgeServer] WARNING: CORS is open to all origins (*). This is intended only for local development or legacy compatibility.";

const WILDCARD_CORS_ERROR =
  "[ForgeServer] Refusing wildcard CORS in production without allowWildcardCors=true. Configure corsOrigins with an explicit allow-list, disable CORS by omitting corsOrigins, or opt into compatibility with allowWildcardCors.";

export function applyCors(app: Hono<AppEnv>, config: ForgeServerConfig): void {
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
