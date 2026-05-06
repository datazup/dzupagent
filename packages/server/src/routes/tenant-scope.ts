import type { Context } from 'hono'
import type { AppEnv } from '../types.js'

export const DEFAULT_TENANT_ID = 'default'

export function getRequestingTenantId(c: Context): string {
  const key = (c as Context<AppEnv>).get('apiKey')
  const tenantId = key?.['tenantId']
  if (typeof tenantId === 'string' && tenantId.length > 0) return tenantId
  const ownerId = key?.['ownerId']
  if (typeof ownerId === 'string' && ownerId.length > 0) return ownerId
  const id = key?.['id']
  if (typeof id === 'string' && id.length > 0) return id
  return DEFAULT_TENANT_ID
}
