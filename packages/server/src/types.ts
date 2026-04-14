/**
 * Shared Hono AppEnv type for DzupAgent server.
 *
 * Centralizes all context variable types so middleware can use
 * typed `c.set()` / `c.get()` without `as never` casts.
 */
import type { ForgeIdentity, ForgeCapability } from '@dzupagent/core'
import type { ForgeRole } from './middleware/rbac.js'

export type AppVariables = {
  apiKey: Record<string, unknown>
  forgeIdentity: ForgeIdentity
  forgeCapabilities: ForgeCapability[]
  forgeRole: ForgeRole
  forgeTenantId: string
}

export type AppEnv = { Variables: AppVariables }
