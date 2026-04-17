import { describe, it, expect } from 'vitest'

/**
 * Tests that all public exports from the package index are accessible.
 * This covers index.ts lines 9-12 which were showing as uncovered.
 */
describe('package exports', () => {
  it('exports InMemoryCacheBackend', async () => {
    const { InMemoryCacheBackend } = await import('../index.js')
    expect(InMemoryCacheBackend).toBeDefined()
    const instance = new InMemoryCacheBackend()
    expect(instance).toBeDefined()
  })

  it('exports RedisCacheBackend', async () => {
    const { RedisCacheBackend } = await import('../index.js')
    expect(RedisCacheBackend).toBeDefined()
  })

  it('exports CacheMiddleware', async () => {
    const { CacheMiddleware } = await import('../index.js')
    expect(CacheMiddleware).toBeDefined()
  })

  it('exports generateCacheKey', async () => {
    const { generateCacheKey } = await import('../index.js')
    expect(generateCacheKey).toBeTypeOf('function')
  })

  it('all exports are re-exported correctly from index', async () => {
    const indexModule = await import('../index.js')
    // Verify the named exports exist
    expect(indexModule).toHaveProperty('InMemoryCacheBackend')
    expect(indexModule).toHaveProperty('RedisCacheBackend')
    expect(indexModule).toHaveProperty('CacheMiddleware')
    expect(indexModule).toHaveProperty('generateCacheKey')
  })
})
