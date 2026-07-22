/**
 * Auth + RBAC middleware slice of the Hono app composition, plus the explicit
 * framework-API auth assertion. Extracted from the legacy
 * `composition/middleware.ts` god-module (DZUPAGENT-ARCH-M-06). Behaviour is
 * unchanged.
 */
import type { Hono } from "hono";
import type { AppEnv } from "../../types.js";
import type { ForgeServerConfig } from "../types.js";
import { authMiddleware, type AuthConfig } from "../../middleware/auth.js";
import {
  rbacMiddleware,
  type ForgeRole,
  type RBACConfig,
} from "../../middleware/rbac.js";

export const FRAMEWORK_API_AUTH_WARNING =
  '[ForgeServer] WARNING: Framework /api/* routes are running without authentication. Set auth.mode="api-key" for production, or auth.mode="none" only for local development or legacy compatibility.';

export const PRODUCTION_FRAMEWORK_API_AUTH_ERROR =
  '[ForgeServer] Refusing to start production framework /api/* routes without explicit auth. Configure auth: { mode: "api-key", ... } for production, or auth: { mode: "none" } only for an intentional development/compatibility opt-out.';

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

export function applyAuthAndRbac(
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
