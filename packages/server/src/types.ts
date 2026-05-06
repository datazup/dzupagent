/**
 * Shared Hono AppEnv type for DzupAgent server.
 *
 * Centralizes all context variable types so middleware can use
 * typed `c.set()` / `c.get()` without `as never` casts.
 */
import type { ForgeIdentity, ForgeCapability } from '@dzupagent/core'
import type { ForgeRole } from './middleware/rbac.js'

/**
 * Shape of the API-key context variable populated by `authMiddleware`.
 *
 * Covers both the `validateKey` callback return (an arbitrary record) and the
 * fields that downstream middleware (RBAC, learning routes, approvals) read
 * directly. Kept open via the `[key: string]: unknown` indexer so custom
 * `validateKey` implementations can carry extra metadata without forcing a
 * widening cast at the call site.
 */
export type ApiKeyContext = {
  id?: string
  ownerId?: string
  role?: string
  tenantId?: string
  rateLimitTier?: string
  maxTokensPerRun?: number
  maxRunsPerHour?: number
  [key: string]: unknown
}

/**
 * Legacy identity context shape (pre-`forgeIdentity`).
 *
 * Kept for backwards compatibility with hosts that still set
 * `c.set('identity', …)` (notably the api-keys route owner-resolver). New code
 * should populate `forgeIdentity` via `identityMiddleware` instead.
 */
export type LegacyIdentityContext = {
  id?: string
  [key: string]: unknown
}

export type AppVariables = {
  apiKey: ApiKeyContext
  forgeIdentity: ForgeIdentity
  forgeCapabilities: ForgeCapability[]
  forgeRole: ForgeRole
  forgeTenantId: string
  /** Legacy identity slot; see {@link LegacyIdentityContext}. */
  identity: LegacyIdentityContext
}

export type AppEnv = { Variables: AppVariables }
