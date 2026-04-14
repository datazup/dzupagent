import { describe, it, expect, vi } from 'vitest'
import { CacheMiddleware } from '../middleware.js'
import { InMemoryCacheBackend } from '../backends/in-memory.js'
import { generateCacheKey } from '../key-generator.js'
import type { CacheableRequest } from '../types.js'

function makeRequest(overrides: Partial<CacheableRequest> = {}): CacheableRequest {
  return {
    messages: [{ role: 'user', content: 'Hello' }],
    model: 'test-model',
    temperature: 0,
    maxTokens: 256,
    ...overrides,
  }
}

describe('cache middleware', () => {
  it('generateCacheKey is deterministic for equivalent requests', () => {
    const request = makeRequest()
    const keyA = generateCacheKey(request, 'tenant-a')
    const keyB = generateCacheKey(makeRequest(), 'tenant-a')

    expect(keyA).toBe(keyB)
    expect(keyA.startsWith('tenant-a:llm:')).toBe(true)
  })

  it('stores and retrieves cacheable requests', async () => {
    const backend = new InMemoryCacheBackend()
    const middleware = new CacheMiddleware({
      backend,
      policy: {
        maxTemperature: 0.3,
        defaultTtlSeconds: 60,
      },
    })
    const request = makeRequest({ temperature: 0.1 })

    await middleware.set(request, 'cached-response')
    const result = await middleware.get(request)

    expect(result).toBe('cached-response')
  })

  it('does not cache requests above maxTemperature', async () => {
    const backend = new InMemoryCacheBackend()
    const middleware = new CacheMiddleware({
      backend,
      policy: {
        maxTemperature: 0.2,
        defaultTtlSeconds: 60,
      },
    })
    const request = makeRequest({ temperature: 0.8 })

    await middleware.set(request, 'should-not-be-cached')
    const result = await middleware.get(request)

    expect(result).toBeNull()
  })

  it('invokes onHit and onMiss callbacks', async () => {
    const backend = new InMemoryCacheBackend()
    const onHit = vi.fn()
    const onMiss = vi.fn()
    const middleware = new CacheMiddleware({
      backend,
      policy: {
        maxTemperature: 0.3,
        defaultTtlSeconds: 60,
      },
      onHit,
      onMiss,
    })
    const request = makeRequest()

    const miss = await middleware.get(request)
    expect(miss).toBeNull()
    expect(onMiss).toHaveBeenCalledTimes(1)

    await middleware.set(request, 'cached')
    const hit = await middleware.get(request)
    expect(hit).toBe('cached')
    expect(onHit).toHaveBeenCalledTimes(1)
  })
})
