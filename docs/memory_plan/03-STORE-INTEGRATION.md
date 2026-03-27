# 03 — LangGraph Store Integration

> **Agent:** langchain-ts-expert
> **Priority:** P0
> **Depends on:** 01-ARCHITECTURE
> **Effort:** 4h

---

## 1. Problem Statement

The current `store.ts` initializes `PostgresStore` without embedding configuration. This means:

1. `store.search()` calls with `query` parameter fall back to keyword matching (or fail silently)
2. Memory items stored without `{ index: [...] }` are invisible to semantic search
3. No control over embedding model, dimensions, or which fields get embedded
4. The `getStore()` function used inside graph nodes returns the LangGraph runtime store, but it's the same instance — no separate configuration

### Current Code (store.ts)

```typescript
// CURRENT — no embedding config
let _store: PostgresStore | null = null

export async function getMemoryStore(): Promise<PostgresStore> {
  if (_store) return _store
  _store = PostgresStore.fromConnString(env.DATABASE_URL)
  await _store.setup()
  return _store
}
```

### What's Missing

```typescript
// NEEDED — with embedding config for semantic search
const store = PostgresStore.fromConnString(env.DATABASE_URL, {
  index: {
    embeddings: embeddingModel,
    dims: 1024,
    fields: ['text'],
  }
})
```

## 2. Implementation Plan

### 2.1 Configure Embedding Model

The LangGraph Store supports automatic embedding of specified fields when items are `put()`. This enables semantic search via `store.search({ query: "..." })`.

**File:** `apps/api/src/services/agent/store.ts`

```typescript
import { PostgresStore } from '@langchain/langgraph-checkpoint-postgres/store'
import { env } from '../../config/env.js'
import { logger } from '../../utils/logger.js'

let _store: PostgresStore | null = null

/**
 * Get or create the PostgresStore singleton with embedding support.
 *
 * Embedding config enables semantic search via store.search({ query }).
 * Items must be stored with { index: ["text"] } to be searchable.
 *
 * Supported embedding providers (in priority order):
 *   1. Anthropic Voyager-3 (via ANTHROPIC_API_KEY)
 *   2. OpenAI text-embedding-3-small (via OPENAI_API_KEY)
 *   3. No embeddings (keyword search fallback)
 */
export async function getMemoryStore(): Promise<PostgresStore> {
  if (_store) return _store

  const embeddingConfig = await buildEmbeddingConfig()

  _store = PostgresStore.fromConnString(env.DATABASE_URL, {
    ...(embeddingConfig ? { index: embeddingConfig } : {}),
  })
  await _store.setup()

  logger.info('LangGraph PostgresStore initialized', {
    hasEmbeddings: !!embeddingConfig,
    embeddingDims: embeddingConfig?.dims ?? 0,
  })

  return _store
}

async function buildEmbeddingConfig(): Promise<{
  embeddings: unknown
  dims: number
  fields: string[]
} | null> {
  // Try Anthropic embeddings first (Voyager-3)
  if (env.ANTHROPIC_API_KEY) {
    try {
      const { AnthropicEmbeddings } = await import('@langchain/anthropic')
      return {
        embeddings: new AnthropicEmbeddings({
          model: 'voyager-3',
          apiKey: env.ANTHROPIC_API_KEY,
        }),
        dims: 1024,
        fields: ['text'],
      }
    } catch {
      logger.warn('AnthropicEmbeddings not available, trying OpenAI')
    }
  }

  // Fallback to OpenAI embeddings
  if (env.OPENAI_API_KEY) {
    try {
      const { OpenAIEmbeddings } = await import('@langchain/openai')
      return {
        embeddings: new OpenAIEmbeddings({
          model: 'text-embedding-3-small',
          apiKey: env.OPENAI_API_KEY,
          ...(env.OPENAI_BASE_URL ? { configuration: { baseURL: env.OPENAI_BASE_URL } } : {}),
        }),
        dims: 1536,
        fields: ['text'],
      }
    } catch {
      logger.warn('OpenAIEmbeddings not available, falling back to keyword search')
    }
  }

  // No embeddings available — store.search() will use keyword fallback
  return null
}
```

### 2.2 Fix Memory Write Operations

All store `put()` calls that contain a `text` field for semantic retrieval must include `{ index: ["text"] }`.

**File:** App-level `apps/api/src/services/agent/utils/memory-service.ts`

> **Note (2026-03-24):** The generic `MemoryService` in `@dzipagent/memory` now handles text enrichment automatically for `searchable: true` namespaces. The app-level memory-service should migrate to use `@dzipagent/memory`'s `MemoryService` class.

**Changes needed:**

```typescript
// storeGenerationLesson — LINE 101: Add index
await store.put(
  [tenantId, 'lessons'],
  `lesson-${Date.now()}`,
  lesson,
  { index: ['text'] }  // ← ADD THIS
)

// storeApiConventions — needs text field + index
await store.put(
  [ns, 'conventions'],
  `api-${state.intakeData?.featureId ?? 'unknown'}`,
  {
    text: `Feature "${state.intakeData?.featureId}": base=${basePath}, auth=${authPattern}`,  // ← ADD text field
    endpointPattern: basePath,
    authPattern,
    endpointCount: state.apiContract.endpoints.length,
    featureId: state.intakeData?.featureId ?? '',
    timestamp: new Date().toISOString(),
  },
  { index: ['text'] }  // ← ADD THIS
)

// storeSessionSummary — LINE 155: Add index
await store.put(
  [ns, 'session-summaries'],
  threadId,
  { text: `...`, ... },
  { index: ['text'] }  // ← ADD THIS
)

// storeProjectDecision — Add text field + index for searchability
await store.put(
  [ns, 'decisions'],
  state.featurePlan.id,
  {
    text: `Feature "${d.featureName}" (${d.category}): ${d.apiEndpoints?.join(', ')} | Models: ${d.databaseModels?.join(', ')}`,  // ← ADD text field
    featureId: state.intakeData?.featureId ?? '',
    featureName: state.intakeData?.name ?? '',
    // ... rest unchanged
  },
  { index: ['text'] }  // ← ADD THIS
)
```

### 2.3 New Memory Write: Feature Spec Storage

```typescript
// NEW function in memory-service.ts
export async function storeFeatureSpec(
  store: BaseStore | undefined,
  tenantId: string,
  spec: {
    featureSpecId: string
    name: string
    description: string
    category: string
    tags: string[]
    techStack: TechStack
    quality: number
  },
): Promise<void> {
  if (!store) return
  try {
    await store.put(
      [tenantId, 'feature-specs'],
      spec.featureSpecId,
      {
        text: `${spec.name}: ${spec.description}. Category: ${spec.category}. Tags: ${spec.tags.join(', ')}`,
        category: spec.category,
        name: spec.name,
        quality: spec.quality,
        techStack: spec.techStack,
        timestamp: new Date().toISOString(),
      },
      { index: ['text'] }
    )
  } catch (err: unknown) {
    logger.warn('Failed to store feature spec (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
```

### 2.4 Enhanced Search Operations

```typescript
// NEW function: Semantic search across feature specs (cross-stack)
export async function searchFeatureSpecs(
  store: BaseStore | undefined,
  tenantId: string,
  query: string,
  limit: number = 5,
): Promise<Array<{ specId: string; name: string; category: string; score: number }>> {
  if (!store) return []
  try {
    const results = await store.search(
      [tenantId, 'feature-specs'],
      { query, limit },
    )
    return results.map(item => ({
      specId: item.key,
      name: (item.value as Record<string, unknown>)['name'] as string,
      category: (item.value as Record<string, unknown>)['category'] as string,
      score: (item as { score?: number }).score ?? 0,
    }))
  } catch (err: unknown) {
    logger.warn('Feature spec search failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}

// NEW function: Search lessons with tech-stack context
export async function searchLessonsForContext(
  store: BaseStore | undefined,
  tenantId: string,
  query: string,
  techStack?: TechStack,
  limit: number = 5,
): Promise<string> {
  if (!store) return ''
  try {
    const results = await store.search(
      [tenantId, 'lessons'],
      { query, limit: limit * 2 },  // Over-fetch, then filter
    )

    // Filter: prefer universal lessons + lessons for matching tech stack
    const filtered = results.filter(item => {
      const lesson = item.value as Record<string, unknown>
      const isUniversal = !(lesson['techStackSpecific'] as boolean)
      if (isUniversal) return true
      if (!techStack) return true
      const lessonStack = lesson['techStack'] as TechStack | undefined
      if (!lessonStack) return true
      // Match if same backend or same frontend
      return lessonStack.backend === techStack.backend ||
             lessonStack.frontend === techStack.frontend
    }).slice(0, limit)

    if (filtered.length === 0) return ''

    const lines = filtered.map(item => {
      const l = item.value as Record<string, unknown>
      return `- ${l['text'] as string}`
    })
    return `## Lessons from Previous Generations\n\n${lines.join('\n')}\n\nAvoid these issues.`
  } catch {
    return ''
  }
}
```

## 3. Store Table Schema

PostgresStore auto-creates tables. After `setup()` with embedding config, the schema looks like:

```sql
-- Auto-created by PostgresStore.setup()
CREATE TABLE IF NOT EXISTS store (
  prefix TEXT NOT NULL,       -- namespace as dot-separated string
  key TEXT NOT NULL,          -- item key
  value JSONB NOT NULL,       -- item value
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  -- Embedding vector (only for indexed items)
  embedding VECTOR(1024),     -- dimension matches config.dims
  PRIMARY KEY (prefix, key)
);

-- Vector similarity index for semantic search
CREATE INDEX IF NOT EXISTS store_embedding_idx
  ON store USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
```

## 4. Performance Considerations

### 4.1 Embedding Cost

Each `put()` with `{ index: [...] }` triggers an embedding API call:
- Anthropic Voyager-3: ~$0.00013 per 1K tokens
- OpenAI text-embedding-3-small: ~$0.00002 per 1K tokens

For a typical generation with 5 memory writes, cost is negligible (~$0.001).

### 4.2 Search Latency

PostgresStore semantic search uses pgvector:
- Expected latency: 5-15ms for namespace with <1000 items
- Scales well to ~10K items per namespace with IVFFlat index
- For larger datasets, consider HNSW index (`ivfflat` → `hnsw`)

### 4.3 Caching Strategy

Memory reads happen at specific points in the pipeline (not every node). Current pattern is correct — load once in `plan()`, use throughout generation.

For frequently accessed data (project conventions), consider a per-invocation cache:

```typescript
// In graph state — optional cache field
memoryCache: Annotation<Record<string, string>>({
  reducer: (current, update) => ({ ...current, ...update }),
  default: () => ({}),
})

// In plan node: load once and cache
const conventions = await loadApiConventions(store, projectId, tenantId)
return { memoryCache: { conventions } }

// In generate nodes: read from cache instead of re-querying
const conventions = state.memoryCache['conventions'] ?? ''
```

## 5. Testing Strategy

### 5.1 Unit Tests

```typescript
// Test embedding config selection
describe('buildEmbeddingConfig', () => {
  it('selects Anthropic when ANTHROPIC_API_KEY set', async () => { ... })
  it('falls back to OpenAI when no Anthropic key', async () => { ... })
  it('returns null when no API keys', async () => { ... })
})

// Test semantic search
describe('store.search()', () => {
  it('finds lessons by semantic similarity', async () => {
    await store.put(['t1', 'lessons'], 'l1', { text: 'JWT refresh token rotation needed' }, { index: ['text'] })
    const results = await store.search(['t1', 'lessons'], { query: 'authentication token refresh', limit: 1 })
    expect(results).toHaveLength(1)
    expect(results[0].key).toBe('l1')
  })
})
```

## 6. Acceptance Criteria

- [ ] Store initializes with embedding configuration when API keys available
- [ ] All memory writes include `{ index: ["text"] }` for searchable items
- [ ] All searchable items include a `text` field
- [ ] `store.search()` returns semantically relevant results
- [ ] Graceful fallback to keyword search when no embedding API key
- [ ] Memory writes remain non-blocking (fire-and-forget with error logging)
- [ ] Performance: <50ms per search, <200ms per put (including embedding)
