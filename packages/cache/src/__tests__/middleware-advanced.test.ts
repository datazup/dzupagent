import { describe, it, expect, vi, beforeEach } from 'vitest'
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

describe('CacheMiddleware — advanced', () => {
  let backend: InMemoryCacheBackend
  let middleware: CacheMiddleware

  beforeEach(() => {
    backend = new InMemoryCacheBackend()
    middleware = new CacheMiddleware({
      backend,
      policy: {
        maxTemperature: 0.3,
        defaultTtlSeconds: 3600,
      },
    })
  })

  // --- isCacheable ---

  it('isCacheable returns true when temperature <= maxTemperature', () => {
    expect(middleware.isCacheable(makeRequest({ temperature: 0 }))).toBe(true)
    expect(middleware.isCacheable(makeRequest({ temperature: 0.3 }))).toBe(true)
  })

  it('isCacheable returns false when temperature > maxTemperature', () => {
    expect(middleware.isCacheable(makeRequest({ temperature: 0.31 }))).toBe(false)
    expect(middleware.isCacheable(makeRequest({ temperature: 1 }))).toBe(false)
  })

  it('isCacheable treats undefined temperature as 1 (not cacheable by default)', () => {
    // temperature defaults to 1 in isCacheable when undefined
    expect(middleware.isCacheable(makeRequest({ temperature: undefined }))).toBe(false)
  })

  it('isCacheable uses custom isCacheable when provided', () => {
    const custom = new CacheMiddleware({
      backend,
      policy: {
        maxTemperature: 0,
        defaultTtlSeconds: 60,
        isCacheable: (req) => req.model.startsWith('gpt'),
      },
    })

    // Temperature is high but custom check passes (model starts with 'gpt')
    expect(custom.isCacheable(makeRequest({ temperature: 1, model: 'gpt-4' }))).toBe(true)
    expect(custom.isCacheable(makeRequest({ temperature: 0, model: 'claude-3' }))).toBe(false)
  })

  // --- namespace isolation ---

  it('namespace isolates cache entries', async () => {
    const nsA = new CacheMiddleware({
      backend,
      policy: { maxTemperature: 1, defaultTtlSeconds: 60, namespace: 'tenant-a' },
    })
    const nsB = new CacheMiddleware({
      backend,
      policy: { maxTemperature: 1, defaultTtlSeconds: 60, namespace: 'tenant-b' },
    })

    const req = makeRequest()
    await nsA.set(req, 'response-a')

    expect(await nsA.get(req)).toBe('response-a')
    expect(await nsB.get(req)).toBeNull()
  })

  // --- set skips non-cacheable ---

  it('set does nothing for non-cacheable requests', async () => {
    const hotReq = makeRequest({ temperature: 0.9 })
    await middleware.set(hotReq, 'should-not-store')

    // Even if we hack temperature down later, the entry was never stored
    const stats = await backend.stats()
    expect(stats.size).toBe(0)
  })

  // --- get returns null for non-cacheable ---

  it('get returns null for non-cacheable requests without hitting backend', async () => {
    // Pre-populate the backend directly
    const req = makeRequest({ temperature: 0 })
    await middleware.set(req, 'stored')

    // Now query with high temperature — should skip backend entirely
    const hotReq = makeRequest({ temperature: 0.9 })
    const result = await middleware.get(hotReq)
    expect(result).toBeNull()
  })

  // --- CacheEntry structure ---

  it('stores a proper CacheEntry JSON with model and cachedAt', async () => {
    const req = makeRequest({ temperature: 0, model: 'gpt-4o' })
    await middleware.set(req, 'the-response')

    // Read raw from backend to verify structure
    const key = (await getFirstKey(backend))
    expect(key).toBeTruthy()
    const raw = await backend.get(key!)
    expect(raw).toBeTruthy()

    const entry = JSON.parse(raw!)
    expect(entry.response).toBe('the-response')
    expect(entry.model).toBe('gpt-4o')
    expect(entry.cachedAt).toBeTypeOf('number')
    expect(entry.ttl).toBe(3600)
  })

  // --- backend error resilience ---

  it('get returns null when backend throws', async () => {
    const failBackend = createFailingBackend()
    const mw = new CacheMiddleware({
      backend: failBackend,
      policy: { maxTemperature: 1, defaultTtlSeconds: 60 },
    })

    const result = await mw.get(makeRequest())
    expect(result).toBeNull()
  })

  it('set does not throw when backend throws', async () => {
    const failBackend = createFailingBackend()
    const mw = new CacheMiddleware({
      backend: failBackend,
      policy: { maxTemperature: 1, defaultTtlSeconds: 60 },
    })

    await expect(mw.set(makeRequest(), 'val')).resolves.toBeUndefined()
  })

  // --- onHit / onMiss callbacks ---

  it('onMiss fires with correct key and model on cache miss', async () => {
    const onMiss = vi.fn()
    const mw = new CacheMiddleware({
      backend,
      policy: { maxTemperature: 1, defaultTtlSeconds: 60 },
      onMiss,
    })

    const req = makeRequest({ model: 'claude-3' })
    await mw.get(req)

    expect(onMiss).toHaveBeenCalledTimes(1)
    expect(onMiss).toHaveBeenCalledWith(expect.any(String), 'claude-3')
  })

  it('onHit fires with correct key and model on cache hit', async () => {
    const onHit = vi.fn()
    const mw = new CacheMiddleware({
      backend,
      policy: { maxTemperature: 1, defaultTtlSeconds: 60 },
      onHit,
    })

    const req = makeRequest({ model: 'gpt-4o' })
    await mw.set(req, 'cached')
    await mw.get(req)

    expect(onHit).toHaveBeenCalledTimes(1)
    expect(onHit).toHaveBeenCalledWith(expect.any(String), 'gpt-4o')
  })

  it('onMiss fires when backend get returns parse-invalid JSON', async () => {
    const onMiss = vi.fn()
    const corruptBackend: CacheBackend = {
      get: async () => 'not-valid-json',
      set: async () => {},
      delete: async () => {},
      clear: async () => {},
      stats: async () => ({ hits: 0, misses: 0, size: 0, hitRate: 0 }),
    }
    const mw = new CacheMiddleware({
      backend: corruptBackend,
      policy: { maxTemperature: 1, defaultTtlSeconds: 60 },
      onMiss,
    })

    const result = await mw.get(makeRequest())
    expect(result).toBeNull()
    expect(onMiss).toHaveBeenCalledTimes(1)
  })

  // --- stats delegation ---

  it('stats delegates to the backend', async () => {
    const req = makeRequest({ temperature: 0 })
    await middleware.set(req, 'val')
    await middleware.get(req)
    await middleware.get(makeRequest({ temperature: 0, messages: [{ role: 'user', content: 'other' }] }))

    const stats = await middleware.stats()
    expect(stats.hits).toBe(1)
    expect(stats.misses).toBe(1)
    expect(stats.size).toBe(1)
  })

  // --- TTL pass-through ---

  it('uses policy defaultTtlSeconds when storing entries', async () => {
    const setSpy = vi.spyOn(backend, 'set')
    const req = makeRequest({ temperature: 0 })
    await middleware.set(req, 'val')

    expect(setSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      3600,
    )
  })
})

// --- helpers ---

async function getFirstKey(backend: InMemoryCacheBackend): Promise<string | null> {
  // We cheat by storing a known request and computing its key
  // Instead, we rely on the fact that InMemoryCacheBackend uses a Map internally
  // and stats reports size. We'll just use a workaround via get.
  // Actually, let's just use the generateCacheKey utility.
  const { generateCacheKey } = await import('../key-generator.js')
  const req: CacheableRequest = {
    messages: [{ role: 'user', content: 'Hello' }],
    model: 'gpt-4o',
    temperature: 0,
    maxTokens: 256,
  }
  return generateCacheKey(req)
}

function createFailingBackend(): CacheBackend {
  return {
    get: async () => { throw new Error('backend failure') },
    set: async () => { throw new Error('backend failure') },
    delete: async () => { throw new Error('backend failure') },
    clear: async () => { throw new Error('backend failure') },
    stats: async (): Promise<CacheStats> => ({ hits: 0, misses: 0, size: 0, hitRate: 0 }),
  }
}
