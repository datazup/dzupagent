/**
 * API-key identity resolver — resolves API keys to ForgeIdentity via SHA-256 hash lookup.
 *
 * Features:
 * - SHA-256 hashing of incoming tokens (keys never stored in plaintext)
 * - LRU cache with configurable TTL and max size
 * - Supports static or async record loading
 */
import { createHash } from 'node:crypto'

import type { ForgeIdentity } from './identity-types.js'
import type { IdentityResolutionContext, IdentityResolver } from './identity-resolver.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A stored API key record (key is stored as SHA-256 hash). */
export interface APIKeyRecord {
  /** SHA-256 hex hash of the API key. */
  keyHash: string
  /** The identity this key maps to. */
  identity: ForgeIdentity
  /** Optional expiration date for the key. */
  expiresAt?: Date
  /** Arbitrary metadata. */
  metadata?: Record<string, unknown>
}

/** Configuration for the API key resolver. */
export interface APIKeyResolverConfig {
  /** Static array or async function returning API key records. */
  records: APIKeyRecord[] | (() => Promise<APIKeyRecord[]>)
  /** Cache TTL in milliseconds. Default: 300_000 (5 minutes). */
  cacheTtlMs?: number
  /** Maximum number of cached entries. Default: 1000. */
  cacheMaxSize?: number
}

// ---------------------------------------------------------------------------
// LRU cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  identity: ForgeIdentity | null
  expiresAt: number // Date.now() + ttl
}

class LRUCache {
  private readonly map = new Map<string, CacheEntry>()
  private readonly maxSize: number
  private readonly ttlMs: number

  constructor(maxSize: number, ttlMs: number) {
    this.maxSize = maxSize
    this.ttlMs = ttlMs
  }

  get(key: string): CacheEntry | undefined {
    const entry = this.map.get(key)
    if (!entry) return undefined

    // Check TTL
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key)
      return undefined
    }

    // Move to end (most recently used)
    this.map.delete(key)
    this.map.set(key, entry)
    return entry
  }

  set(key: string, identity: ForgeIdentity | null): void {
    // Delete first to ensure it goes to the end
    this.map.delete(key)

    // Evict oldest if at capacity
    if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next()
      if (!oldest.done) {
        this.map.delete(oldest.value)
      }
    }

    this.map.set(key, {
      identity,
      expiresAt: Date.now() + this.ttlMs,
    })
  }

  delete(key: string): void {
    this.map.delete(key)
  }

  get size(): number {
    return this.map.size
  }
}

// ---------------------------------------------------------------------------
// Hash helper
// ---------------------------------------------------------------------------

/** Hash a plaintext API key with SHA-256, returning a hex string. */
export function hashAPIKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Extended resolver interface with cache invalidation. */
export interface APIKeyIdentityResolver extends IdentityResolver {
  /** Remove a cached entry by key hash. */
  invalidate(keyHash: string): void
}

/** Create an API-key identity resolver. */
export function createAPIKeyResolver(config: APIKeyResolverConfig): APIKeyIdentityResolver {
  const ttlMs = config.cacheTtlMs ?? 300_000
  const maxSize = config.cacheMaxSize ?? 1000
  const cache = new LRUCache(maxSize, ttlMs)

  async function loadRecords(): Promise<APIKeyRecord[]> {
    if (typeof config.records === 'function') {
      return config.records()
    }
    return config.records
  }

  async function findByHash(hash: string): Promise<ForgeIdentity | null> {
    const records = await loadRecords()
    const record = records.find((r) => r.keyHash === hash)
    if (!record) return null

    // Check expiration
    if (record.expiresAt && record.expiresAt.getTime() < Date.now()) {
      return null
    }

    return record.identity
  }

  return {
    async resolve(context: IdentityResolutionContext): Promise<ForgeIdentity | null> {
      const token = context.token
      if (!token) return null

      const hash = hashAPIKey(token)

      // Check cache first
      const cached = cache.get(hash)
      if (cached !== undefined) {
        return cached.identity
      }

      // Cache miss — look up
      const identity = await findByHash(hash)
      cache.set(hash, identity)
      return identity
    },

    async verify(identity: ForgeIdentity): Promise<boolean> {
      // For API key resolver, verify checks that the identity still exists in the records
      const records = await loadRecords()
      return records.some((r) => {
        if (r.identity.id !== identity.id) return false
        if (r.expiresAt && r.expiresAt.getTime() < Date.now()) return false
        return true
      })
    },

    invalidate(keyHash: string): void {
      cache.delete(keyHash)
    },
  }
}
