/**
 * Wave 21 deep coverage for CacheMiddleware.
 *
 * Gap analysis targets (not covered by cache-middleware.test.ts,
 * middleware-advanced.test.ts or middleware-deep.test.ts):
 *  - Cache hit/miss paths with explicit interaction counters
 *  - Key generation determinism, order-sensitivity, config sensitivity
 *  - TTL semantics (expiry, TTL=0 bypass-by-not-storing, refresh)
 *  - Bypass via `isCacheable` override (noCache-equivalent)
 *  - Error handling end-to-end (get-throw, set-throw, parse-error)
 *  - Concurrent identical requests (deduplication semantics)
 *  - Large payloads + long message lists (key stability)
 *  - Invalidation via backend.delete / backend.clear
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CacheMiddleware } from '../middleware.js'
import { InMemoryCacheBackend } from '../backends/in-memory.js'
import { generateCacheKey } from '../key-generator.js'
import type { CacheableRequest, CacheBackend, CacheStats } from '../types.js'

function makeRequest(overrides: Partial<CacheableRequest> = {}): CacheableRequest {
  return {
    messages: [{ role: 'user', content: 'Hello' }],
    model: 'gpt-4o',
    temperature: 0,
    maxTokens: 256,
    ...overrides,
  }
}

function failingStats(): CacheStats {
  return { hits: 0, misses: 0, size: 0, hitRate: 0 }
}

describe('CacheMiddleware — Wave 21 deep (W21-B3)', () => {
  let backend: InMemoryCacheBackend
  let middleware: CacheMiddleware

  beforeEach(() => {
    backend = new InMemoryCacheBackend()
    middleware = new CacheMiddleware({
      backend,
      policy: { maxTemperature: 1, defaultTtlSeconds: 3600 },
    })
  })

  // ---------- Cache hit path --------------------------------------------

  describe('cache hit path', () => {
    it('returns cached response on second get without re-invoking backend setter', async () => {
      const setSpy = vi.spyOn(backend, 'set')
      const req = makeRequest()

      await middleware.set(req, 'resp-1')
      const first = await middleware.get(req)
      const second = await middleware.get(req)

      expect(first).toBe('resp-1')
      expect(second).toBe('resp-1')
      // set was only called once in our flow
      expect(setSpy).toHaveBeenCalledTimes(1)
    })

    it('increments hit counter on cache hits', async () => {
      const req = makeRequest()
      await middleware.set(req, 'resp')

      await middleware.get(req)
      await middleware.get(req)
      await middleware.get(req)

      const stats = await middleware.stats()
      expect(stats.hits).toBe(3)
    })

    it('invokes onHit with correct key/model metadata', async () => {
      const onHit = vi.fn()
      const mw = new CacheMiddleware({
        backend,
        policy: { maxTemperature: 1, defaultTtlSeconds: 60, namespace: 'ns' },
        onHit,
      })

      const req = makeRequest({ model: 'claude-haiku' })
      await mw.set(req, 'resp')
      await mw.get(req)

      expect(onHit).toHaveBeenCalledTimes(1)
      const [key, model] = onHit.mock.calls[0]!
      expect(key).toMatch(/^ns:llm:[a-f0-9]{64}$/)
      expect(model).toBe('claude-haiku')
    })
  })

  // ---------- Cache miss path -------------------------------------------

  describe('cache miss path', () => {
    it('returns null for an un-cached request', async () => {
      expect(await middleware.get(makeRequest())).toBeNull()
    })

    it('after set, subsequent request stores response in cache', async () => {
      const req = makeRequest()
      await middleware.set(req, 'new-response')
      expect(await middleware.get(req)).toBe('new-response')
    })

    it('increments miss counter on misses', async () => {
      await middleware.get(makeRequest({ messages: [{ role: 'user', content: 'q1' }] }))
      await middleware.get(makeRequest({ messages: [{ role: 'user', content: 'q2' }] }))

      const stats = await middleware.stats()
      expect(stats.misses).toBe(2)
    })
  })

  // ---------- Key generation --------------------------------------------

  describe('key generation', () => {
    it('same messages + model + temperature = same key', () => {
      const a = generateCacheKey(makeRequest())
      const b = generateCacheKey(makeRequest())
      expect(a).toBe(b)
    })

    it('different messages produce different keys', () => {
      const a = generateCacheKey(makeRequest({ messages: [{ role: 'user', content: 'foo' }] }))
      const b = generateCacheKey(makeRequest({ messages: [{ role: 'user', content: 'bar' }] }))
      expect(a).not.toBe(b)
    })

    it('different model produces different key', () => {
      const a = generateCacheKey(makeRequest({ model: 'gpt-4o' }))
      const b = generateCacheKey(makeRequest({ model: 'claude-opus' }))
      expect(a).not.toBe(b)
    })

    it('temperature affects key', () => {
      const a = generateCacheKey(makeRequest({ temperature: 0 }))
      const b = generateCacheKey(makeRequest({ temperature: 0.5 }))
      expect(a).not.toBe(b)
    })

    it('maxTokens affects key', () => {
      const a = generateCacheKey(makeRequest({ maxTokens: 256 }))
      const b = generateCacheKey(makeRequest({ maxTokens: 512 }))
      expect(a).not.toBe(b)
    })

    it('message order matters (reordered messages produce different key)', () => {
      const req1 = makeRequest({
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'second' },
        ],
      })
      const req2 = makeRequest({
        messages: [
          { role: 'assistant', content: 'second' },
          { role: 'user', content: 'first' },
        ],
      })
      expect(generateCacheKey(req1)).not.toBe(generateCacheKey(req2))
    })

    it('role matters in key (same content, different role)', () => {
      const req1 = makeRequest({ messages: [{ role: 'user', content: 'hello' }] })
      const req2 = makeRequest({ messages: [{ role: 'assistant', content: 'hello' }] })
      expect(generateCacheKey(req1)).not.toBe(generateCacheKey(req2))
    })

    it('namespace produces distinct keys even for identical requests', () => {
      const req = makeRequest()
      const keyA = generateCacheKey(req, 'tenant-a')
      const keyB = generateCacheKey(req, 'tenant-b')
      expect(keyA).not.toBe(keyB)
      expect(keyA.startsWith('tenant-a:llm:')).toBe(true)
      expect(keyB.startsWith('tenant-b:llm:')).toBe(true)
    })
  })

  // ---------- TTL semantics ---------------------------------------------

  describe('TTL semantics', () => {
    it('entry within TTL is returned from cache', async () => {
      const mw = new CacheMiddleware({
        backend,
        policy: { maxTemperature: 1, defaultTtlSeconds: 60 },
      })
      const req = makeRequest()
      await mw.set(req, 'resp')
      expect(await mw.get(req)).toBe('resp')
    })

    it('entry expires after TTL — backend returns null', async () => {
      // Use a short TTL and advance time via fake timers
      vi.useFakeTimers()
      try {
        const mw = new CacheMiddleware({
          backend,
          policy: { maxTemperature: 1, defaultTtlSeconds: 1 },
        })
        const req = makeRequest()
        await mw.set(req, 'resp')

        // Advance past TTL
        vi.setSystemTime(Date.now() + 2000)

        expect(await mw.get(req)).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })

    it('defaultTtlSeconds is passed to backend.set', async () => {
      const setSpy = vi.spyOn(backend, 'set')
      const mw = new CacheMiddleware({
        backend,
        policy: { maxTemperature: 1, defaultTtlSeconds: 7200 },
      })
      await mw.set(makeRequest(), 'resp')
      expect(setSpy).toHaveBeenCalledWith(expect.any(String), expect.any(String), 7200)
    })

    it('TTL of 0 means no expiry (stores indefinitely)', async () => {
      vi.useFakeTimers()
      try {
        const mw = new CacheMiddleware({
          backend,
          policy: { maxTemperature: 1, defaultTtlSeconds: 0 },
        })
        const req = makeRequest()
        await mw.set(req, 'resp')
        // Advance a large amount of time — still cached
        vi.setSystemTime(Date.now() + 1000 * 60 * 60 * 24 * 365)
        expect(await mw.get(req)).toBe('resp')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // ---------- Bypass via isCacheable (noCache equivalent) --------------

  describe('bypass via isCacheable', () => {
    it('custom isCacheable returning false always skips backend get', async () => {
      const getSpy = vi.spyOn(backend, 'get')
      const mw = new CacheMiddleware({
        backend,
        policy: {
          maxTemperature: 1,
          defaultTtlSeconds: 60,
          isCacheable: () => false,
        },
      })

      await mw.get(makeRequest())
      expect(getSpy).not.toHaveBeenCalled()
    })

    it('custom isCacheable returning false skips backend set', async () => {
      const setSpy = vi.spyOn(backend, 'set')
      const mw = new CacheMiddleware({
        backend,
        policy: {
          maxTemperature: 1,
          defaultTtlSeconds: 60,
          isCacheable: () => false,
        },
      })

      await mw.set(makeRequest(), 'resp')
      expect(setSpy).not.toHaveBeenCalled()
    })

    it('per-request bypass via a flag in the request object', async () => {
      const mw = new CacheMiddleware({
        backend,
        policy: {
          maxTemperature: 1,
          defaultTtlSeconds: 60,
          isCacheable: (req) => !(req as { noCache?: boolean }).noCache,
        },
      })

      const normalReq = makeRequest()
      const bypassReq = { ...makeRequest(), noCache: true }

      await mw.set(normalReq, 'stored')
      await mw.set(bypassReq, 'should-not-store')

      expect(await mw.get(normalReq)).toBe('stored')
      expect(await mw.get(bypassReq)).toBeNull()
    })
  })

  // ---------- Error handling --------------------------------------------

  describe('error handling', () => {
    it('backend.get throwing results in miss callback being invoked', async () => {
      const onMiss = vi.fn()
      const failingBackend: CacheBackend = {
        get: async () => {
          throw new Error('redis unavailable')
        },
        set: async () => {},
        delete: async () => {},
        clear: async () => {},
        stats: async () => failingStats(),
      }

      const mw = new CacheMiddleware({
        backend: failingBackend,
        policy: { maxTemperature: 1, defaultTtlSeconds: 60 },
        onMiss,
      })

      const result = await mw.get(makeRequest())
      expect(result).toBeNull()
      expect(onMiss).toHaveBeenCalledTimes(1)
    })

    it('backend.set throwing does not crash and is not treated as fatal', async () => {
      const failingBackend: CacheBackend = {
        get: async () => null,
        set: async () => {
          throw new Error('write failure')
        },
        delete: async () => {},
        clear: async () => {},
        stats: async () => failingStats(),
      }

      const mw = new CacheMiddleware({
        backend: failingBackend,
        policy: { maxTemperature: 1, defaultTtlSeconds: 60 },
      })

      // Should not throw
      await expect(mw.set(makeRequest(), 'resp')).resolves.toBeUndefined()
    })

    it('backend.set throwing still emits onDegraded diagnostic', async () => {
      const onDegraded = vi.fn()
      const failingBackend: CacheBackend = {
        get: async () => null,
        set: async () => {
          throw new Error('write failure')
        },
        delete: async () => {},
        clear: async () => {},
        stats: async () => failingStats(),
      }

      const mw = new CacheMiddleware({
        backend: failingBackend,
        policy: { maxTemperature: 1, defaultTtlSeconds: 60 },
        onDegraded,
      })

      await mw.set(makeRequest(), 'resp')
      expect(onDegraded).toHaveBeenCalledWith('set', 'write failure', expect.any(String))
    })

    it('invalid stored JSON triggers miss + degraded callback', async () => {
      const onMiss = vi.fn()
      const onDegraded = vi.fn()
      const corruptBackend: CacheBackend = {
        get: async () => '{{{not json',
        set: async () => {},
        delete: async () => {},
        clear: async () => {},
        stats: async () => failingStats(),
      }

      const mw = new CacheMiddleware({
        backend: corruptBackend,
        policy: { maxTemperature: 1, defaultTtlSeconds: 60 },
        onMiss,
        onDegraded,
      })

      const result = await mw.get(makeRequest())
      expect(result).toBeNull()
      expect(onMiss).toHaveBeenCalledTimes(1)
      expect(onDegraded).toHaveBeenCalledTimes(1)
    })
  })

  // ---------- Concurrent identical requests ----------------------------

  describe('concurrent identical requests', () => {
    it('N parallel get() calls all observe the same cached value', async () => {
      const req = makeRequest()
      await middleware.set(req, 'shared-value')

      const results = await Promise.all(
        Array.from({ length: 10 }, () => middleware.get(req)),
      )
      expect(results.every((r) => r === 'shared-value')).toBe(true)
    })

    it('parallel set() calls with the same key only keep one entry', async () => {
      const req = makeRequest()
      await Promise.all([
        middleware.set(req, 'resp-1'),
        middleware.set(req, 'resp-2'),
        middleware.set(req, 'resp-3'),
      ])
      const stats = await middleware.stats()
      expect(stats.size).toBe(1)
      // Whatever landed last wins — all three are valid, but only one entry remains
      const result = await middleware.get(req)
      expect(['resp-1', 'resp-2', 'resp-3']).toContain(result)
    })

    it('parallel misses for different keys all increment miss counter', async () => {
      await Promise.all([
        middleware.get(makeRequest({ messages: [{ role: 'user', content: 'q1' }] })),
        middleware.get(makeRequest({ messages: [{ role: 'user', content: 'q2' }] })),
        middleware.get(makeRequest({ messages: [{ role: 'user', content: 'q3' }] })),
      ])
      const stats = await middleware.stats()
      expect(stats.misses).toBe(3)
    })
  })

  // ---------- Large payloads --------------------------------------------

  describe('large payloads', () => {
    it('stores and retrieves a 100KB response correctly', async () => {
      const req = makeRequest()
      const large = 'a'.repeat(100_000)
      await middleware.set(req, large)
      const got = await middleware.get(req)
      expect(got).toBe(large)
      expect(got!.length).toBe(100_000)
    })

    it('generates a key for requests with a long message list', () => {
      const longMessages = Array.from({ length: 500 }, (_, i) => ({
        role: 'user' as const,
        content: `message-${i}`,
      }))
      const req = makeRequest({ messages: longMessages })
      const key = generateCacheKey(req)
      // SHA-256 hex is always 64 chars
      expect(key).toMatch(/^llm:[a-f0-9]{64}$/)
    })

    it('caches requests with extremely long single message content', async () => {
      const req = makeRequest({
        messages: [{ role: 'user', content: 'x'.repeat(50_000) }],
      })
      await middleware.set(req, 'ok')
      expect(await middleware.get(req)).toBe('ok')
    })
  })

  // ---------- Invalidation ----------------------------------------------

  describe('invalidation', () => {
    it('backend.delete removes a cached entry', async () => {
      const req = makeRequest()
      await middleware.set(req, 'resp')
      expect(await middleware.get(req)).toBe('resp')

      const key = generateCacheKey(req)
      await backend.delete(key)

      expect(await middleware.get(req)).toBeNull()
    })

    it('backend.clear removes all cached entries', async () => {
      const req1 = makeRequest({ messages: [{ role: 'user', content: 'q1' }] })
      const req2 = makeRequest({ messages: [{ role: 'user', content: 'q2' }] })
      await middleware.set(req1, 'r1')
      await middleware.set(req2, 'r2')

      await backend.clear()

      expect(await middleware.get(req1)).toBeNull()
      expect(await middleware.get(req2)).toBeNull()
      const stats = await middleware.stats()
      expect(stats.size).toBe(0)
    })

    it('after clear, new writes are stored fresh', async () => {
      const req = makeRequest()
      await middleware.set(req, 'old')
      await backend.clear()
      await middleware.set(req, 'new')
      expect(await middleware.get(req)).toBe('new')
    })

    it('deleting non-existent key does not throw', async () => {
      await expect(backend.delete('no-such-key')).resolves.toBeUndefined()
    })
  })
})
