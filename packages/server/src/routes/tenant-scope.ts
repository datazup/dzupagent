import type { Context } from 'hono'
import type { AppEnv } from '../types.js'

export const DEFAULT_TENANT_ID = 'default'

function resolveFromApiKeyShape(apiKey: unknown): string {
  if (typeof apiKey !== 'object' || apiKey === null) return DEFAULT_TENANT_ID
  const key = apiKey as Record<string, unknown>

  const tenantId = key['tenantId']
  if (typeof tenantId === 'string' && tenantId.length > 0) return tenantId
  const ownerId = key['ownerId']
  if (typeof ownerId === 'string' && ownerId.length > 0) return ownerId
  const id = key['id']
  if (typeof id === 'string' && id.length > 0) return id
  return DEFAULT_TENANT_ID
}

export function resolveRequestingTenantIdFromApiKey(apiKey: unknown): string {
  return resolveFromApiKeyShape(apiKey)
}

export function resolveOptionalRequestingTenantIdFromApiKey(apiKey: unknown): string | undefined {
  if (apiKey === undefined || apiKey === null) return undefined
  return resolveFromApiKeyShape(apiKey)
}

export function getOptionalRequestingTenantId(c: Context): string | undefined {
  const key = (c as Context<AppEnv>).get('apiKey')
  return resolveOptionalRequestingTenantIdFromApiKey(key)
}

export function getRequestingTenantId(c: Context): string {
  const key = (c as Context<AppEnv>).get('apiKey')
  return resolveRequestingTenantIdFromApiKey(key)
}
