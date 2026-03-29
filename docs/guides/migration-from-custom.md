# Migration Guide: Custom AI Stack to DzipAgent

This guide covers migrating an Express-based AI application (like research-app)
from a custom AI stack to the dzipagent framework. It documents patterns and
lessons learned from the research-app migration.

## Strategy Overview

The migration uses two key patterns:

1. **Feature flags** -- environment variables (`USE_DZIPAGENT_*`) that toggle
   between old and new implementations at runtime
2. **Facade pattern** -- wrapper services that present the old API while
   delegating to dzipagent internally

This allows incremental migration with instant rollback capability.

## Phase 1: ModelRegistry Setup

Replace scattered LLM initialization with `@dzipagent/core` ModelRegistry.

### Before (custom)

```ts
// Scattered across multiple files
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
```

### After (dzipagent)

```ts
import { ModelRegistry } from '@dzipagent/core'

const registry = new ModelRegistry()

registry.register('gpt-4o', {
  provider: 'openai',
  model: 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY,
})

registry.register('claude-sonnet', {
  provider: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  apiKey: process.env.ANTHROPIC_API_KEY,
})

// Single point of access
const model = registry.get('gpt-4o')
```

### Feature flag

```bash
# .env
USE_DZIPAGENT_LLM=false  # flip to true when ready
```

```ts
function getLLM(modelName: string) {
  if (process.env.USE_DZIPAGENT_LLM === 'true') {
    return registry.get(modelName)
  }
  return legacyGetModel(modelName)
}
```

## Phase 2: Cache Migration

Replace custom LLM caching with `@dzipagent/cache`.

```ts
import { CacheMiddleware, RedisCacheBackend } from '@dzipagent/cache'

const cache = new CacheMiddleware({
  backend: new RedisCacheBackend(redisClient, { prefix: 'myapp' }),
  policy: {
    maxTemperature: 0.3,
    defaultTtlSeconds: 3600,
    namespace: 'production',
  },
})

// Wrap existing LLM calls
async function cachedLLMCall(request) {
  const cached = await cache.get(request)
  if (cached) return cached

  const response = await llm.invoke(request)
  await cache.set(request, response)
  return response
}
```

## Phase 3: RAG Pipeline Migration

Replace custom chunking, embedding, and retrieval with `@dzipagent/rag`.

### Facade pattern

Create a service that matches your existing API while using dzipagent internals:

```ts
import { RagPipeline } from '@dzipagent/rag'

class RagService {
  private pipeline: RagPipeline

  constructor(embeddingProvider, vectorStore) {
    this.pipeline = new RagPipeline(
      {
        chunking: { targetTokens: 1200, overlapFraction: 0.15 },
        retrieval: { mode: 'hybrid', topK: 10, tokenBudget: 8000 },
      },
      { embeddingProvider, vectorStore },
    )
  }

  // Match existing method signatures
  async ingestSource(sourceId: string, text: string, sessionId: string, tenantId: string) {
    return this.pipeline.ingest(text, { sourceId, sessionId, tenantId })
  }

  async queryWithContext(query: string, sessionId: string, tenantId: string) {
    return this.pipeline.assembleContext(query, { sessionId, tenantId })
  }
}
```

### Feature flag

```ts
async function handleSourceIngestion(source, session) {
  if (process.env.USE_DZIPAGENT_RAG === 'true') {
    return ragService.ingestSource(source.id, source.text, session.id, session.tenantId)
  }
  return legacyIngest(source, session)
}
```

## Phase 4: Scraper Migration

Replace custom Puppeteer/fetch code with `@dzipagent/scraper`.

```ts
import { WebScraper } from '@dzipagent/scraper'

const scraper = new WebScraper({
  mode: 'auto',
  http: { maxRetries: 3, retryDelayMs: 1000 },
  browser: { maxConcurrency: 3, stealth: true },
})

// Direct replacement for existing scrape functions
async function scrapeUrl(url: string) {
  const result = await scraper.scrape(url)
  return {
    text: result.text,
    title: result.title,
    metadata: {
      author: result.author,
      publishedDate: result.publishedDate,
      description: result.description,
    },
  }
}
```

## Phase 5: Agent Migration (Tools to DzipAgent)

Replace custom tool loops with `@dzipagent/agent` orchestration.

### Before (manual tool loop)

```ts
while (toolCallsRemaining > 0) {
  const response = await llm.call(messages)
  if (response.tool_calls) {
    for (const call of response.tool_calls) {
      const result = await executeTool(call)
      messages.push(toolResultMessage(result))
    }
  } else {
    break
  }
}
```

### After (DzipAgent)

```ts
import { DzipAgent } from '@dzipagent/agent'

const agent = new DzipAgent({
  model: registry.get('gpt-4o'),
  tools: [
    scraper.asTool(),
    createRagTool(pipeline, sessionId, tenantId),
    // ... other tools
  ],
  maxIterations: 10,
})

// Streaming
const stream = agent.stream(messages)
for await (const event of stream) {
  // handle events
}

// Non-streaming
const result = await agent.generate(messages)
```

## Phase 6: Express Integration

Replace custom SSE streaming with `@dzipagent/express`.

```ts
import { createAgentRouter } from '@dzipagent/express'

const router = createAgentRouter({
  agents: { research: researchAgent, chat: chatAgent },
  auth: requireAuth,
  hooks: {
    beforeAgent: async (req, agentName) => {
      await rateLimit(req)
      logger.info(`Agent ${agentName} starting`)
    },
    afterAgent: async (req, agentName, result) => {
      await saveConversation(req, result)
    },
  },
})

app.use('/api/ai', router)
```

## Common Gotchas

### 1. Embedding dimensions mismatch

When switching embedding providers, ensure the vector store collection uses
matching dimensions. You may need to re-embed existing data.

```ts
// Check dimensions match your vector store
const config = {
  embedding: { model: 'text-embedding-3-small', dimensions: 1536 },
  vectorStore: { adapter: 'qdrant' }, // collection must use 1536 dimensions
}
```

### 2. Collection naming

`@dzipagent/rag` uses `{collectionPrefix}{tenantId}` for collection names.
Ensure this matches your existing naming scheme or plan a data migration.

### 3. Cache key compatibility

`@dzipagent/cache` generates SHA-256 keys from `messages + model + temperature + maxTokens`.
Existing cached responses from a custom implementation will not be found --
they will naturally expire and get re-cached.

### 4. SSE event format differences

The `@dzipagent/express` SSE format uses named event types:
```
event: chunk
data: {"content":"..."}
```

If your frontend expects a different format (e.g., `data: {...}\n\n` without
event types), use the `formatEvent` option on `SSEHandlerConfig`.

### 5. Puppeteer optional dependency

`@dzipagent/scraper` loads Puppeteer via dynamic import. If you only use HTTP
mode, Puppeteer is never imported. But if `mode: 'auto'` falls back to browser
and Puppeteer is not installed, the scrape will fail. Install Puppeteer
explicitly if you need browser fallback.

### 6. Temperature-based cache policy

The default cache policy only caches requests with `temperature <= 0.3`.
Creative/high-temperature requests are never cached. Adjust `maxTemperature`
or provide a custom `isCacheable` function if needed.

### 7. Token budget enforcement

`@dzipagent/rag` enforces a token budget at the retrieval level. If your
existing system returns all matching chunks regardless of size, the new
behavior may return fewer (but more relevant) chunks. Adjust `tokenBudget`
in `RetrievalConfig` if needed.

## Rollback

Every feature flag can be set back to `false` independently. The facade
services maintain backward compatibility, so switching back does not require
code changes -- only environment variable updates.

```bash
# Roll back a single component
USE_DZIPAGENT_RAG=false
USE_DZIPAGENT_LLM=true   # keep this one on
USE_DZIPAGENT_CACHE=true  # keep this one on
```
