/**
 * Plugin and transport type definitions: HTTP transport, CORS, authentication,
 * rate limiting, security headers, JSON body limits, security policy,
 * OpenAI compatibility, playground/deploy, and server route plugins.
 *
 * These types represent the "server extension" concern — anything that controls
 * how the HTTP server is configured, secured, and extended via plugins.
 */
import type { AuthConfig } from '../middleware/auth.js'
import type { RBACConfig } from '../middleware/rbac.js'
import type { RateLimiterConfig } from '../middleware/rate-limiter.js'
import type { ResourceQuotaManager } from '../security/resource-quota.js'
import type { InputGuardConfig } from '../security/input-guard.js'
import type { PostgresApiKeyStore } from '../persistence/api-key-store.js'
import type { DeployRouteConfig } from '../routes/deploy-types.js'
import type { PlaygroundRouteConfig } from '../routes/playground.js'
import type { OpenAIAuthConfig } from '../routes/openai-compat/auth-middleware.js'
import type { ServerRoutePlugin } from '../route-plugin.js'
import type { ComplianceAuditStore } from '@dzupagent/core/security'

export interface SecurityHeadersConfig {
  /** Defaults to `nosniff`; pass `false` to disable. */
  xContentTypeOptions?: string | false
  /** Defaults to `no-referrer`; pass `false` to disable. */
  referrerPolicy?: string | false
  /** Defaults to `DENY` (clickjacking guard); pass `false` to disable. */
  xFrameOptions?: string | false
  /**
   * Defaults to `default-src 'self'; base-uri 'self'; frame-ancestors 'none'`
   * (DZUPAGENT-SEC-I-03). Pass `false` to disable, or override with a custom
   * policy when serving HTML that requires external assets.
   */
  contentSecurityPolicy?: string | false
  /** Additional explicit headers; pass `false` to suppress a header from this map. */
  additionalHeaders?: Record<string, string | false | undefined>
}

export interface JsonBodyLimitConfig {
  /** Default max JSON body size in bytes. Defaults to 1 MiB. */
  defaultMaxBytes?: number
  /**
   * Route-specific max JSON body size in bytes. Keys are request paths.
   * A key ending in `*` is treated as a prefix match.
   */
  routeMaxBytes?: Record<string, number>
}

/**
 * HTTP transport / authentication / rate limiting concerns.
 *
 * @deprecated Internal composition building block for {@link ForgeServerConfig}
 * and {@link ForgeHostRuntimeConfig}. The standalone re-export through
 * `@dzupagent/server/app` is a legacy compatibility alias with zero workspace
 * consumers and is not part of the package-root public surface. Prefer the
 * aggregate `ForgeServerConfig` or `ForgeHostRuntimeConfig` types.
 */
export interface ForgeTransportConfig {
  /**
   * Framework `/api/*` authentication mode.
   *
   * Production hosts must configure this explicitly. Use `mode: 'api-key'`
   * for production deployments. `mode: 'none'` is an intentional local
   * development or legacy compatibility opt-out and emits a startup warning.
   */
  auth?: AuthConfig
  /** Optional RBAC config (MC-S02). Defaults to API-key role extraction; pass `false` to disable. */
  rbac?: RBACConfig | false
  /** Optional Postgres API key store. When provided alongside auth.mode='api-key', validate is wired automatically. */
  apiKeyStore?: PostgresApiKeyStore
  /**
   * Explicit browser origins allowed by CORS. Omit to disable CORS headers.
   * Wildcard (`'*'`) is allowed in development, but production requires
   * `allowWildcardCors: true` for legacy compatibility.
   */
  corsOrigins?: string | string[]
  /** Compatibility opt-in that enables wildcard CORS. Do not use for credentialed browser-token deployments. */
  allowWildcardCors?: boolean
  /** Safe default HTTP response headers. Pass `false` to disable, or override individual headers. */
  securityHeaders?: SecurityHeadersConfig | false
  rateLimit?: Partial<RateLimiterConfig>
  /**
   * Shared JSON request body size protection. Defaults to a conservative
   * framework-wide limit with route-specific allowances for known large
   * payload surfaces. Pass `false` to disable in controlled compatibility
   * hosts.
   */
  jsonBodyLimit?: JsonBodyLimitConfig | false
}

/**
 * Security policy: safety monitor, quotas, input guard.
 *
 * @deprecated Internal composition building block for {@link ForgeServerConfig}
 * and {@link ForgeHostRuntimeConfig}. The standalone re-export through
 * `@dzupagent/server/app` is a legacy compatibility alias with zero workspace
 * consumers and is not part of the package-root public surface. Prefer the
 * aggregate `ForgeServerConfig` or `ForgeHostRuntimeConfig` types.
 */
export interface ForgeSecurityConfig {
  /** Skip attaching the built-in runtime safety monitor (default false). */
  disableSafetyMonitor?: boolean
  /** Per-key resource quota manager (MC-S01). */
  resourceQuota?: ResourceQuotaManager
  /** MC-S03 input guard configuration. Pass `false` to opt out. */
  security?: {
    inputGuard?: InputGuardConfig | false
  }
  /**
   * RF-36: Compliance audit store. When provided, a ComplianceAuditLogger is
   * attached to the event bus and all security-relevant events are recorded.
   * Use PostgresAuditStore for durable audit trails in production.
   */
  auditStore?: ComplianceAuditStore
}

/** Compatibility and deployment route family config. */
export interface ForgeCompatibilityRouteFamilyConfig {
  playground?: PlaygroundRouteConfig
  deploy?: DeployRouteConfig
  /** OpenAI-compatible `/v1/*` HTTP compatibility surface. */
  openai?: {
    /**
     * Mount `/v1/chat/completions` and `/v1/models`.
     *
     * Defaults to false so createForgeApp hosts expose the compatibility API
     * only when they explicitly opt in.
     */
    enabled?: boolean
    auth?: OpenAIAuthConfig
  }
}

/**
 * Host-supplied route plugin type alias. Declared here so composition helpers
 * that only need the plugin extension point can import from plugin-types rather
 * than from the aggregate types barrel.
 *
 * The full `ServerRoutePlugin` generic is re-exported from this module so
 * callers can reference the concrete plugin type without importing from the
 * route-plugin module directly.
 */
export type { ServerRoutePlugin }
