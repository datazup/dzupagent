import type { CacheBackend, CacheStats } from '../types.js'

/**
 * Build a structurally complete `CacheBackend` test double.
 *
 * The sorted-set half of the interface (`zadd`/`zrangebyscore`/`zrem`/`zcard`,
 * `types.ts:20-32`) was added after these suites were written, leaving twelve
 * hand-rolled doubles incomplete — each annotated `: CacheBackend`, each a
 * TS2739. Completing them one by one would have duplicated four stubs twelve
 * times, so they share this factory instead.
 *
 * The sorted-set stubs THROW rather than return an empty value. Nothing outside
 * the backends themselves calls them today — `CacheMiddleware` never does — so a
 * call arriving from a middleware path is a genuine surprise. A lenient
 * `async () => []` would let such a path observe an empty sorted set and pass,
 * which is the coverage hole this factory exists to avoid re-opening. A test
 * that legitimately needs sorted-set behaviour passes its own override.
 *
 * The filename deliberately omits a `.test` segment so vitest's test glob does
 * not collect this helper as a suite.
 */
export function makeCacheBackend(overrides: Partial<CacheBackend> = {}): CacheBackend {
  const unstubbed =
    (name: string) =>
    async (): Promise<never> => {
      throw new Error(
        `makeCacheBackend: ${name}() was called but this test did not stub it`,
      )
    }

  return {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
    clear: async () => {},
    stats: async (): Promise<CacheStats> => ({ hits: 0, misses: 0, size: 0, hitRate: 0 }),
    zadd: unstubbed('zadd'),
    zrangebyscore: unstubbed('zrangebyscore'),
    zrem: unstubbed('zrem'),
    zcard: unstubbed('zcard'),
    ...overrides,
  }
}
