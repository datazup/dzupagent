import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TENANT_ID,
  resolveOptionalRequestingTenantIdFromApiKey,
  resolveRequestingTenantIdFromApiKey,
} from '../tenant-scope.js'

describe('tenant scope helpers', () => {
  it('prefers tenantId over ownerId and id', () => {
    expect(
      resolveRequestingTenantIdFromApiKey({
        tenantId: 'tenant-a',
        ownerId: 'owner-a',
        id: 'key-a',
      }),
    ).toBe('tenant-a')
  })

  it('falls back to ownerId, then id', () => {
    expect(resolveRequestingTenantIdFromApiKey({ ownerId: 'owner-a', id: 'key-a' })).toBe('owner-a')
    expect(resolveRequestingTenantIdFromApiKey({ id: 'key-a' })).toBe('key-a')
  })

  it('returns default tenant for empty or non-object keys', () => {
    expect(resolveRequestingTenantIdFromApiKey(undefined)).toBe(DEFAULT_TENANT_ID)
    expect(resolveRequestingTenantIdFromApiKey(null)).toBe(DEFAULT_TENANT_ID)
    expect(resolveRequestingTenantIdFromApiKey('token')).toBe(DEFAULT_TENANT_ID)
    expect(resolveRequestingTenantIdFromApiKey({ tenantId: '' })).toBe(DEFAULT_TENANT_ID)
  })

  it('optional resolver returns undefined only when api key is absent', () => {
    expect(resolveOptionalRequestingTenantIdFromApiKey(undefined)).toBeUndefined()
    expect(resolveOptionalRequestingTenantIdFromApiKey(null)).toBeUndefined()
    expect(resolveOptionalRequestingTenantIdFromApiKey({ id: 'key-a' })).toBe('key-a')
    expect(resolveOptionalRequestingTenantIdFromApiKey('token')).toBe(DEFAULT_TENANT_ID)
  })
})
