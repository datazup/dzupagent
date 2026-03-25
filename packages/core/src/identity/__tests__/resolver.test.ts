import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAPIKeyResolver, hashAPIKey } from '../api-key-resolver.js'
import { CompositeIdentityResolver } from '../identity-resolver.js'
import type { IdentityResolver } from '../identity-resolver.js'
import type { ForgeIdentity } from '../identity-types.js'
import type { APIKeyRecord } from '../api-key-resolver.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIdentity(id: string): ForgeIdentity {
  return {
    id,
    uri: `forge://acme/${id}`,
    displayName: `Agent ${id}`,
    organization: 'acme',
    capabilities: [],
    credentials: [],
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
  }
}

function makeRecord(key: string, id: string, expiresAt?: Date): APIKeyRecord {
  return {
    keyHash: hashAPIKey(key),
    identity: makeIdentity(id),
    expiresAt,
  }
}

// ---------------------------------------------------------------------------
// hashAPIKey
// ---------------------------------------------------------------------------

describe('hashAPIKey', () => {
  it('returns a 64-char hex string', () => {
    const hash = hashAPIKey('my-secret-key')
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('produces consistent hashes', () => {
    expect(hashAPIKey('test')).toBe(hashAPIKey('test'))
  })

  it('produces different hashes for different keys', () => {
    expect(hashAPIKey('key-a')).not.toBe(hashAPIKey('key-b'))
  })
})

// ---------------------------------------------------------------------------
// createAPIKeyResolver — basic resolution
// ---------------------------------------------------------------------------

describe('createAPIKeyResolver', () => {
  it('returns identity for valid key', async () => {
    const resolver = createAPIKeyResolver({
      records: [makeRecord('secret-key', 'agent-1')],
    })
    const identity = await resolver.resolve({ token: 'secret-key' })
    expect(identity).not.toBeNull()
    expect(identity!.id).toBe('agent-1')
  })

  it('returns null for invalid key', async () => {
    const resolver = createAPIKeyResolver({
      records: [makeRecord('secret-key', 'agent-1')],
    })
    const identity = await resolver.resolve({ token: 'wrong-key' })
    expect(identity).toBeNull()
  })

  it('returns null when no token provided', async () => {
    const resolver = createAPIKeyResolver({
      records: [makeRecord('secret-key', 'agent-1')],
    })
    const identity = await resolver.resolve({})
    expect(identity).toBeNull()
  })

  it('returns null for expired key', async () => {
    const pastDate = new Date(Date.now() - 60_000) // 1 minute ago
    const resolver = createAPIKeyResolver({
      records: [makeRecord('expired-key', 'agent-1', pastDate)],
    })
    const identity = await resolver.resolve({ token: 'expired-key' })
    expect(identity).toBeNull()
  })

  it('returns identity for non-expired key', async () => {
    const futureDate = new Date(Date.now() + 3_600_000) // 1 hour from now
    const resolver = createAPIKeyResolver({
      records: [makeRecord('valid-key', 'agent-1', futureDate)],
    })
    const identity = await resolver.resolve({ token: 'valid-key' })
    expect(identity).not.toBeNull()
    expect(identity!.id).toBe('agent-1')
  })

  it('supports async record loading', async () => {
    const loader = vi.fn(async () => [makeRecord('async-key', 'agent-async')])
    const resolver = createAPIKeyResolver({ records: loader })
    const identity = await resolver.resolve({ token: 'async-key' })
    expect(identity).not.toBeNull()
    expect(identity!.id).toBe('agent-async')
    expect(loader).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// createAPIKeyResolver — verify
// ---------------------------------------------------------------------------

describe('createAPIKeyResolver.verify', () => {
  it('returns true for identity in records', async () => {
    const resolver = createAPIKeyResolver({
      records: [makeRecord('key-1', 'agent-1')],
    })
    const valid = await resolver.verify(makeIdentity('agent-1'))
    expect(valid).toBe(true)
  })

  it('returns false for identity not in records', async () => {
    const resolver = createAPIKeyResolver({
      records: [makeRecord('key-1', 'agent-1')],
    })
    const valid = await resolver.verify(makeIdentity('agent-unknown'))
    expect(valid).toBe(false)
  })

  it('returns false for identity with expired key', async () => {
    const pastDate = new Date(Date.now() - 60_000)
    const resolver = createAPIKeyResolver({
      records: [makeRecord('key-1', 'agent-1', pastDate)],
    })
    const valid = await resolver.verify(makeIdentity('agent-1'))
    expect(valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// LRU cache behavior
// ---------------------------------------------------------------------------

describe('createAPIKeyResolver — cache', () => {
  it('second resolve hits cache (does not call loader again)', async () => {
    const loader = vi.fn(async () => [makeRecord('cached-key', 'agent-cached')])
    const resolver = createAPIKeyResolver({ records: loader })

    await resolver.resolve({ token: 'cached-key' })
    await resolver.resolve({ token: 'cached-key' })

    // Loader called once for the first resolve, not for the cached second
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('cache evicts oldest when exceeding maxSize', async () => {
    const loader = vi.fn(async () => [
      makeRecord('key-a', 'agent-a'),
      makeRecord('key-b', 'agent-b'),
      makeRecord('key-c', 'agent-c'),
    ])

    const resolver = createAPIKeyResolver({
      records: loader,
      cacheMaxSize: 2,
    })

    // Fill cache with key-a and key-b
    await resolver.resolve({ token: 'key-a' })
    await resolver.resolve({ token: 'key-b' })
    expect(loader).toHaveBeenCalledTimes(2)

    // Add key-c — should evict key-a (oldest)
    await resolver.resolve({ token: 'key-c' })
    expect(loader).toHaveBeenCalledTimes(3)

    // key-b should still be cached
    loader.mockClear()
    await resolver.resolve({ token: 'key-b' })
    expect(loader).not.toHaveBeenCalled()

    // key-a should have been evicted — needs reload
    await resolver.resolve({ token: 'key-a' })
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('cache TTL: expired entries are re-fetched', async () => {
    const loader = vi.fn(async () => [makeRecord('ttl-key', 'agent-ttl')])
    const resolver = createAPIKeyResolver({
      records: loader,
      cacheTtlMs: 50, // 50ms TTL
    })

    await resolver.resolve({ token: 'ttl-key' })
    expect(loader).toHaveBeenCalledTimes(1)

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 80))

    // Should re-fetch after TTL
    await resolver.resolve({ token: 'ttl-key' })
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('invalidate() clears cache entry', async () => {
    const loader = vi.fn(async () => [makeRecord('inv-key', 'agent-inv')])
    const resolver = createAPIKeyResolver({ records: loader })

    await resolver.resolve({ token: 'inv-key' })
    expect(loader).toHaveBeenCalledTimes(1)

    // Invalidate the cached entry
    resolver.invalidate(hashAPIKey('inv-key'))

    // Next resolve should call loader again
    await resolver.resolve({ token: 'inv-key' })
    expect(loader).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// CompositeIdentityResolver
// ---------------------------------------------------------------------------

describe('CompositeIdentityResolver', () => {
  let nullResolver: IdentityResolver
  let agentAResolver: IdentityResolver
  let agentBResolver: IdentityResolver

  beforeEach(() => {
    nullResolver = {
      resolve: vi.fn(async () => null),
      verify: vi.fn(async () => false),
    }
    agentAResolver = {
      resolve: vi.fn(async () => makeIdentity('agent-a')),
      verify: vi.fn(async (id: ForgeIdentity) => id.id === 'agent-a'),
    }
    agentBResolver = {
      resolve: vi.fn(async () => makeIdentity('agent-b')),
      verify: vi.fn(async (id: ForgeIdentity) => id.id === 'agent-b'),
    }
  })

  it('first resolver wins', async () => {
    const composite = new CompositeIdentityResolver([agentAResolver, agentBResolver])
    const identity = await composite.resolve({ token: 'any' })
    expect(identity).not.toBeNull()
    expect(identity!.id).toBe('agent-a')
    // Second resolver should not be called
    expect(agentBResolver.resolve).not.toHaveBeenCalled()
  })

  it('falls through null to next resolver', async () => {
    const composite = new CompositeIdentityResolver([nullResolver, agentBResolver])
    const identity = await composite.resolve({ token: 'any' })
    expect(identity).not.toBeNull()
    expect(identity!.id).toBe('agent-b')
    expect(nullResolver.resolve).toHaveBeenCalled()
    expect(agentBResolver.resolve).toHaveBeenCalled()
  })

  it('returns null when all resolvers return null', async () => {
    const composite = new CompositeIdentityResolver([nullResolver])
    const identity = await composite.resolve({ token: 'any' })
    expect(identity).toBeNull()
  })

  it('verify returns true if any resolver confirms', async () => {
    const composite = new CompositeIdentityResolver([nullResolver, agentAResolver])
    const valid = await composite.verify(makeIdentity('agent-a'))
    expect(valid).toBe(true)
  })

  it('verify returns false if no resolver confirms', async () => {
    const composite = new CompositeIdentityResolver([nullResolver])
    const valid = await composite.verify(makeIdentity('agent-x'))
    expect(valid).toBe(false)
  })

  it('addResolver appends to the chain', async () => {
    const composite = new CompositeIdentityResolver([nullResolver])
    let identity = await composite.resolve({ token: 'any' })
    expect(identity).toBeNull()

    composite.addResolver(agentAResolver)
    identity = await composite.resolve({ token: 'any' })
    expect(identity).not.toBeNull()
    expect(identity!.id).toBe('agent-a')
  })
})
