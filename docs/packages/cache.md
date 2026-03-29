# @dzipagent/cache -- LLM Response Caching

Deterministic LLM response caching with SHA-256 key generation, policy-based
cacheability checks, and pluggable backends (Redis, in-memory).

## Installation

```bash
yarn add @dzipagent/cache
```

Optional peer dependency: `ioredis` (only needed for `RedisCacheBackend`).

## Quick Start

```ts
import { CacheMiddleware, InMemoryCacheBackend } from '@dzipagent/cache'

const cache = new CacheMiddleware({
  backend: new InMemoryCacheBackend({ maxEntries: 1000 }),
  policy: {
    maxTemperature: 0.3,      // only cache near-deterministic requests
    defaultTtlSeconds: 3600,  // 1 hour TTL
    namespace: 'my-app',      // prefix for tenant isolation
  },
  onHit: (key, model) => console.log(`Cache hit: ${model}`),
  onMiss: (key, model) => console.log(`Cache miss: ${model}`),
})

// Check cache before calling LLM
const request = {
  messages: [{ role: 'user', content: 'Hello' }],
  model: 'gpt-4o',
  temperature: 0,
}

const cached = await cache.get(request)
if (cached) {
  return cached // string response from cache
}

const response = await llm.invoke(request)
await cache.set(request, response)
```

## Components

### CacheMiddleware

The main entry point. Wraps a `CacheBackend` with policy enforcement and
optional hit/miss callbacks.

```ts
const cache = new CacheMiddleware({
  backend: CacheBackend,
  policy: CachePolicy,
  onHit?: (key: string, model: string) => void,
  onMiss?: (key: string, model: string) => void,
})
```

Methods:

- `isCacheable(request)` -- check if a request qualifies for caching
- `get(request)` -- look up cached response (returns `string | null`)
- `set(request, response)` -- store a response (no-op if not cacheable)
- `stats()` -- get `CacheStats` from the backend

Cacheability is determined by temperature: requests with `temperature <= maxTemperature`
are cacheable. Override with a custom `isCacheable` function in the policy.

Cache writes are best-effort -- failures are silently ignored to avoid
disrupting the main LLM flow.

### generateCacheKey

Produces a deterministic SHA-256 hash from the normalized request payload.

```ts
import { generateCacheKey } from '@dzipagent/cache'

const key = generateCacheKey(request, 'my-namespace')
// "my-namespace:llm:a1b2c3d4..."  (with namespace)
// "llm:a1b2c3d4..."               (without namespace)
```

Key derivation includes: `messages` (role:content pairs), `model`, `temperature`,
`maxTokens`. Identical requests always produce the same key regardless of extra
fields on the request object.

### InMemoryCacheBackend

LRU-evicting in-memory cache with TTL expiry. Suitable for development,
testing, and single-process deployments.

```ts
import { InMemoryCacheBackend } from '@dzipagent/cache'

const backend = new InMemoryCacheBackend({
  maxEntries: 1000,  // LRU eviction threshold (default 1000)
})
```

LRU ordering uses `Map` insertion order -- accessed entries are moved to the
end. TTL is checked on read; expired entries are lazily removed. The `stats()`
method purges all expired entries before reporting size.

### RedisCacheBackend

Production-grade backend using ioredis. Uses key prefixing for namespace
isolation and `SCAN + DEL` for safe bulk deletion (no `KEYS` command).

```ts
import { RedisCacheBackend } from '@dzipagent/cache'
import Redis from 'ioredis'

const redis = new Redis('redis://localhost:6379')
const backend = new RedisCacheBackend(redis, {
  prefix: 'myapp',  // key prefix for isolation (default: '')
})
```

The constructor accepts any ioredis-compatible client via duck typing
(`RedisClientLike` interface) -- no hard import of ioredis. TTL is set via
Redis `EX` option. `stats().size` returns `-1` since counting Redis keys
requires separate commands.

## CacheBackend Interface

Both backends implement the same interface, so you can swap between them:

```ts
interface CacheBackend {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds?: number): Promise<void>
  delete(key: string): Promise<void>
  clear(): Promise<void>
  stats(): Promise<CacheStats>
}

interface CacheStats {
  hits: number
  misses: number
  size: number     // -1 for Redis (unknown)
  hitRate: number  // hits / (hits + misses), or 0 if no requests
}
```

## CachePolicy

Controls what gets cached and for how long:

```ts
interface CachePolicy {
  maxTemperature: number       // max temperature for cacheability (default 0.3)
  defaultTtlSeconds: number   // default TTL in seconds (default 3600)
  namespace?: string           // prefix for tenant isolation
  isCacheable?: (request: CacheableRequest) => boolean  // custom override
}
```

## Cache Entry Format

Serialized as JSON in the backend:

```ts
interface CacheEntry {
  response: string   // the LLM response text
  model: string      // model that produced it
  cachedAt: number   // timestamp (Date.now())
  ttl: number        // TTL in seconds
}
```

## Integration with DzipEventBus

Wire cache events into the framework's event system:

```ts
const cache = new CacheMiddleware({
  backend: new RedisCacheBackend(redis),
  policy: { maxTemperature: 0.3, defaultTtlSeconds: 3600 },
  onHit: (key, model) => bus.emit({ type: 'cache:hit', data: { key, model } }),
  onMiss: (key, model) => bus.emit({ type: 'cache:miss', data: { key, model } }),
})
```

## Exports

```ts
// Classes
export { CacheMiddleware, InMemoryCacheBackend, RedisCacheBackend }

// Functions
export { generateCacheKey }

// Types
export type { CacheBackend, CachePolicy, CacheableRequest, CacheStats,
              CacheMiddlewareConfig, CacheEntry }
```
