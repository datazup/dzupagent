import { describe, it, expect, vi } from 'vitest'
import { CacheMiddleware } from '../middleware.js'
import { InMemoryCacheBackend } from '../backends/in-memory.js'
import type { CacheableRequest, CacheBackend, CacheStats } from '../types.js'

function makeRequest(overrides: Partial<CacheableRequest> = {}): CacheableRequest {
  return {
    messages: [{ role: 'user', content: 'Hello' }],
    model: 'gpt-4',
    temperature: 0,
    maxTokens: 256,
    ...overrides,
  }
}

describe('CacheMiddleware — deep coverage', () => {

  // --- onDegraded callback in middleware (lines 79-80, 109-110) ---

  describe('onDegraded callback', () => {
    it('calls onDegraded on get when backend.get throws an Error', async () => {
      const onDegraded = vi.fn()
      const failingBackend: CacheBackend = {
        get: async () => { throw new Error('backend get fail') },
        set: async () => {},
        delete: async () => {},
        clear: async () => {},
        stats: async (): Promise<CacheStats> => ({ hits: 0, misses: 0, size: 0, hitRate: 0 }),
      }
      const mw = new CacheMiddleware({
        backend: failingBackend,
        policy: { maxTemperature: 1, defaultTtlSeconds: 60 },
        onDegraded,
      })

      const result = await mw.get(makeRequest())
      expect(result).toBeNull()
      expect(onDegraded).toHaveBeenCalledTimes(1)
      expect(onDegraded).toHaveBeenCalledWith('get', 'backend get fail', expect.any(String))
    })

    it('calls onDegraded on set when backend.set throws an Error', async () => {
      const onDegraded = vi.fn()
      const failingBackend: CacheBackend = {
        get: async () => null,
        set: async () => { throw new Error('backend set fail') },
        delete: async () => {},
        clear: async () => {},
        stats: async (): Promise<CacheStats> => ({ hits: 0, misses: 0, size: 0, hitRate: 0 }),
      }
      const mw = new CacheMiddleware({
        backend: failingBackend,
        policy: { maxTemperature: 1, defaultTtlSeconds: 60 },
        onDegraded,
      })

      await mw.set(makeRequest(), 'some-response')
      expect(onDegraded).toHaveBeenCalledTimes(1)
      expect(onDegraded).toHaveBeenCalledWith('set', 'backend set fail', expect.any(String))
    })

    it('calls onDegraded with stringified non-Error on get', async () => {
      const onDegraded = vi.fn()
      const failingBackend: CacheBackend = {
        get: async () => { throw 'raw string error' },
        set: async () => {},
        delete: async () => {},
        clear: async () => {},
        stats: async (): Promise<CacheStats> => ({ hits: 0, misses: 0, size: 0, hitRate: 0 }),
      }
      const mw = new CacheMiddleware({
        backend: failingBackend,
        policy: { maxTemperature: 1, defaultTtlSeconds: 60 },
        onDegraded,
      })

      await mw.get(makeRequest())
      expect(onDegraded).toHaveBeenCalledWith('get', 'raw string error', expect.any(String))
    })

    it('calls onDegraded with stringified non-Error on set', async () => {
      const onDegraded = vi.fn()
      const failingBackend: CacheBackend = {
        get: async () => null,
        set: async () => { throw 42 },
        delete: async () => {},
        clear: async () => {},
        stats: async (): Promise<CacheStats> => ({ hits: 0, misses: 0, size: 0, hitRate: 0 }),
      }
      const mw = new CacheMiddleware({
        backend: failingBackend,
        policy: { maxTemperature: 1, defaultTtlSeconds: 60 },
        onDegraded,
      })

      await mw.set(makeRequest(), 'val')
      expect(onDegraded).toHaveBeenCalledWith('set', '42', expect.any(String))
    })

    it('calls both onDegraded and onMiss on get error', async () => {
      const onDegraded = vi.fn()
      const onMiss = vi.fn()
      const failingBackend: CacheBackend = {
        get: async () => { throw new Error('fail') },
        set: async () => {},
        delete: async () => {},
        clear: async () => {},
        stats: async (): Promise<CacheStats> => ({ hits: 0, misses: 0, size: 0, hitRate: 0 }),
      }
      const mw = new CacheMiddleware({
        backend: failingBackend,
        policy: { maxTemperature: 1, defaultTtlSeconds: 60 },
        onDegraded,
        onMiss,
      })

      await mw.get(makeRequest())
      expect(onDegraded).toHaveBeenCalledTimes(1)
      expect(onMiss).toHaveBeenCalledTimes(1)
    })
  })

  // --- isCacheable boundary conditions ---

  describe('isCacheable boundary conditions', () => {
    it('temperature exactly at maxTemperature is cacheable', () => {
      const mw = new CacheMiddleware({
        backend: new InMemoryCacheBackend(),
        policy: { maxTemperature: 0.5, defaultTtlSeconds: 60 },
      })
      expect(mw.isCacheable(makeRequest({ temperature: 0.5 }))).toBe(true)
    })

    it('temperature just above maxTemperature is not cacheable', () => {
      const mw = new CacheMiddleware({
        backend: new InMemoryCacheBackend(),
        policy: { maxTemperature: 0.5, defaultTtlSeconds: 60 },
      })
      expect(mw.isCacheable(makeRequest({ temperature: 0.500001 }))).toBe(false)
    })

    it('maxTemperature of 0 only caches temperature 0', () => {
      const mw = new CacheMiddleware({
        backend: new InMemoryCacheBackend(),
        policy: { maxTemperature: 0, defaultTtlSeconds: 60 },
      })
      expect(mw.isCacheable(makeRequest({ temperature: 0 }))).toBe(true)
      expect(mw.isCacheable(makeRequest({ temperature: 0.01 }))).toBe(false)
    })

    it('maxTemperature of 2 caches everything', () => {
      const mw = new CacheMiddleware({
        backend: new InMemoryCacheBackend(),
        policy: { maxTemperature: 2, defaultTtlSeconds: 60 },
      })
      expect(mw.isCacheable(makeRequest({ temperature: 0 }))).toBe(true)
      expect(mw.isCacheable(makeRequest({ temperature: 1 }))).toBe(true)
      expect(mw.isCacheable(makeRequest({ temperature: 2 }))).toBe(true)
    })

    it('custom isCacheable completely overrides temperature check', () => {
      const mw = new CacheMiddleware({
        backend: new InMemoryCacheBackend(),
        policy: {
          maxTemperature: 0,
          defaultTtlSeconds: 60,
          isCacheable: () => true, // always cacheable
        },
      })
      // High temperature but custom says yes
      expect(mw.isCacheable(makeRequest({ temperature: 2 }))).toBe(true)
    })

    it('custom isCacheable that always returns false blocks all caching', async () => {
      const backend = new InMemoryCacheBackend()
      const mw = new CacheMiddleware({
        backend,
        policy: {
          maxTemperature: 1,
          defaultTtlSeconds: 60,
          isCacheable: () => false,
        },
      })
      const req = makeRequest({ temperature: 0 })
      await mw.set(req, 'val')
      expect(await mw.get(req)).toBeNull()
      const stats = await backend.stats()
      expect(stats.size).toBe(0)
    })
  })

  // --- JSON round-trip and serialization ---

  describe('cache entry serialization', () => {
    it('correctly round-trips a response with special characters', async () => {
      const backend = new InMemoryCacheBackend()
      const mw = new CacheMiddleware({
        backend,
        policy: { maxTemperature: 1, defaultTtlSeconds: 60 },
      })
      const req = makeRequest()
      const response = 'Line 1\nLine 2\t"quoted"\r\nEnd'
      await mw.set(req, response)
      expect(await mw.get(req)).toBe(response)
    })

    it('correctly round-trips empty string response', async () => {
      const backend = new InMemoryCacheBackend()
      const mw = new CacheMiddleware({
        backend,
        policy: { maxTemperature: 1, defaultTtlSeconds: 60 },
      })
      const req = makeRequest()
      await mw.set(req, '')
      expect(await mw.get(req)).toBe('')
    })

    it('correctly round-trips a very large response', async () => {
      const backend = new InMemoryCacheBackend()
      const mw = new CacheMiddleware({
        backend,
        policy: { maxTemperature: 1, defaultTtlSeconds: 60 },
      })
      const req = makeRequest()
      const large = 'x'.repeat(100_000)
      await mw.set(req, large)
      expect(await mw.get(req)).toBe(large)
    })

    it('correctly round-trips unicode response', async () => {
      const backend = new InMemoryCacheBackend()
      const mw = new CacheMiddleware({
        backend,
        policy: { maxTemperature: 1, defaultTtlSeconds: 60 },
      })
      const req = makeRequest()
      const unicode = 'Hello 世界 🌍 مرحبا'
      await mw.set(req, unicode)
      expect(await mw.get(req)).toBe(unicode)
    })

    it('handles backend returning invalid JSON gracefully', async () => {
      const corruptBackend: CacheBackend = {
        get: async () => '{broken json',
        set: async () => {},
        delete: async () => {},
        clear: async () => {},
        stats: async (): Promise<CacheStats> => ({ hits: 0, misses: 0, size: 0, hitRate: 0 }),
      }
      const onDegraded = vi.fn()
      const mw = new CacheMiddleware({
        backend: corruptBackend,
        policy: { maxTemperature: 1, defaultTtlSeconds: 60 },
        onDegraded,
      })

      const result = await mw.get(makeRequest())
      expect(result).toBeNull()
      // onDegraded should be called because JSON.parse throws
      expect(onDegraded).toHaveBeenCalledTimes(1)
      expect(onDegraded).toHaveBeenCalledWith('get', expect.stringContaining(''), expect.any(String))
    })
  })

  // --- Callback combinations ---

  describe('callback combinations', () => {
    it('works with no callbacks configured', async () => {
      const mw = new CacheMiddleware({
        backend: new InMemoryCacheBackend(),
        policy: { maxTemperature: 1, defaultTtlSeconds: 60 },
      })
      const req = makeRequest()
      await mw.set(req, 'val')
      expect(await mw.get(req)).toBe('val')
    })

    it('onHit receives the correct cache key', async () => {
      const backend = new InMemoryCacheBackend()
      const onHit = vi.fn()
      const mw = new CacheMiddleware({
        backend,
        policy: { maxTemperature: 1, defaultTtlSeconds: 60, namespace: 'ns' },
        onHit,
      })
      const req = makeRequest()
      await mw.set(req, 'cached')
      await mw.get(req)

      expect(onHit).toHaveBeenCalledTimes(1)
      const [key, model] = onHit.mock.calls[0]
      expect(key).toMatch(/^ns:llm:[a-f0-9]{64}$/)
      expect(model).toBe('gpt-4')
    })

    it('onMiss receives the correct cache key', async () => {
      const onMiss = vi.fn()
      const mw = new CacheMiddleware({
        backend: new InMemoryCacheBackend(),
        policy: { maxTemperature: 1, defaultTtlSeconds: 60 },
        onMiss,
      })
      await mw.get(makeRequest({ model: 'claude-3' }))

      expect(onMiss).toHaveBeenCalledTimes(1)
      const [key, model] = onMiss.mock.calls[0]
      expect(key).toMatch(/^llm:[a-f0-9]{64}$/)
      expect(model).toBe('claude-3')
    })
  })

  // --- Multiple middleware instances sharing a backend ---

  describe('shared backend', () => {
    it('two middlewares with same namespace share cache entries', async () => {
      const backend = new InMemoryCacheBackend()
      const mw1 = new CacheMiddleware({
        backend,
        policy: { maxTemperature: 1, defaultTtlSeconds: 60, namespace: 'shared' },
      })
      const mw2 = new CacheMiddleware({
        backend,
        policy: { maxTemperature: 1, defaultTtlSeconds: 60, namespace: 'shared' },
      })

      const req = makeRequest()
      await mw1.set(req, 'from-mw1')
      expect(await mw2.get(req)).toBe('from-mw1')
    })

    it('two middlewares with different namespaces are isolated', async () => {
      const backend = new InMemoryCacheBackend()
      const mw1 = new CacheMiddleware({
        backend,
        policy: { maxTemperature: 1, defaultTtlSeconds: 60, namespace: 'ns1' },
      })
      const mw2 = new CacheMiddleware({
        backend,
        policy: { maxTemperature: 1, defaultTtlSeconds: 60, namespace: 'ns2' },
      })

      const req = makeRequest()
      await mw1.set(req, 'from-mw1')
      expect(await mw2.get(req)).toBeNull()
    })
  })
})
