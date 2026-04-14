# @dzupagent/cache

Lightweight response caching primitives for LLM workflows in DzupAgent.

This package provides a policy-driven `CacheMiddleware`, deterministic key generation, and pluggable backends (in-memory and Redis) so you can reduce repeated LLM calls while keeping cache behavior explicit and observable.

## Installation

```bash
yarn add @dzupagent/cache
# or
npm install @dzupagent/cache
```

If you want Redis-backed caching, also install `ioredis` (peer dependency):

```bash
yarn add ioredis
```

## What this package gives you

- **Policy-based cacheability**
  - Cache only when requests satisfy policy rules (temperature thresholds or your own custom predicate).
- **Deterministic cache keys**
  - Stable SHA-256 keys based on request shape (`messages`, `model`, `temperature`, `maxTokens`).
- **Namespace isolation**
  - Prefix keys by tenant/environment using `namespace` (or backend prefixes for Redis).
- **Pluggable storage backends**
  - `InMemoryCacheBackend`: LRU + TTL for local/single-process workloads.
  - `RedisCacheBackend`: shared/distributed cache with safe key scanning for clear operations.
- **Observability hooks**
  - Optional `onHit` / `onMiss` callbacks for metrics and event buses.
- **Best-effort reliability**
  - Cache failures don’t break your LLM flow; middleware gracefully falls back to cache miss behavior.

## Quick Start

```ts
import { CacheMiddleware, InMemoryCacheBackend } from '@dzupagent/cache'

const cache = new CacheMiddleware({
  backend: new InMemoryCacheBackend({ maxEntries: 1000 }),
  policy: {
    maxTemperature: 0.3,
    defaultTtlSeconds: 3600,
    namespace: 'prod',
  },
  onHit: (key, model) => console.log('cache-hit', { key, model }),
  onMiss: (key, model) => console.log('cache-miss', { key, model }),
})

const request = {
  model: 'gpt-4o-mini',
  temperature: 0.2,
  messages: [{ role: 'user', content: 'Summarize this changelog' }],
}

let response = await cache.get(request)

if (!response) {
  response = '...llm response...'
  await cache.set(request, response)
}

console.log(await cache.stats())
```

## Usage Examples

### 1) Wrap an LLM call

```ts
import { CacheMiddleware, InMemoryCacheBackend } from '@dzupagent/cache'

const cache = new CacheMiddleware({
  backend: new InMemoryCacheBackend(),
  policy: { maxTemperature: 0.3, defaultTtlSeconds: 1800 },
})

export async function invokeWithCache(request: {
  model: string
  temperature?: number
  maxTokens?: number
  messages: Array<{ role: string; content: string }>
}) {
  const cached = await cache.get(request)
  if (cached) return cached

  const fresh = await llm.invoke(request)
  await cache.set(request, fresh)
  return fresh
}
```

### 2) Use custom cacheability logic

```ts
import { CacheMiddleware, InMemoryCacheBackend } from '@dzupagent/cache'

const cache = new CacheMiddleware({
  backend: new InMemoryCacheBackend(),
  policy: {
    maxTemperature: 1,
    defaultTtlSeconds: 900,
    isCacheable: (req) => {
      // Example: only cache deterministic model + short prompts
      const text = req.messages.map(m => m.content).join('\n')
      return req.model === 'gpt-4o-mini' && text.length < 8_000
    },
  },
})
```

### 3) Shared Redis cache across services

```ts
import Redis from 'ioredis'
import { CacheMiddleware, RedisCacheBackend } from '@dzupagent/cache'

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')

const cache = new CacheMiddleware({
  backend: new RedisCacheBackend(redis, { prefix: 'dzupagent:cache' }),
  policy: {
    maxTemperature: 0.3,
    defaultTtlSeconds: 3600,
    namespace: 'tenant-a',
  },
})
```

## API Reference

### Main exports

- `CacheMiddleware` — policy-aware cache orchestration (`get`, `set`, `stats`, `isCacheable`)
- `generateCacheKey(request, namespace?)` — deterministic key hashing with optional namespace
- `InMemoryCacheBackend` — in-process backend with TTL + LRU eviction
- `RedisCacheBackend` — Redis backend with optional key prefixing

### Core types

- `CacheBackend` — backend contract (`get`, `set`, `delete`, `clear`, `stats`)
- `CachePolicy` — cacheability and TTL policy settings
- `CacheableRequest` — request shape used for key generation and policy checks
- `CacheStats` — `{ hits, misses, size, hitRate }`
- `CacheMiddlewareConfig`, `CacheEntry`

## Notes

- Default cacheability checks use `temperature <= maxTemperature`.
  - If `temperature` is omitted, middleware treats it as `1` (typically non-cacheable unless your policy allows it).
- In-memory backend is ideal for development and single-process runtime.
- Redis backend is recommended for multi-instance deployments.

## License

MIT
