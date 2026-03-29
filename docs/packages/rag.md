# @dzipagent/rag -- RAG Pipeline

Composable Retrieval-Augmented Generation pipeline for document ingestion,
hybrid retrieval, and context assembly with citations.

## Installation

```bash
yarn add @dzipagent/rag
```

Peer dependencies: `@dzipagent/core` (for `EmbeddingProvider`, `VectorStore`, `estimateTokens`).

## Quick Start

```ts
import { RagPipeline } from '@dzipagent/rag'
import type { EmbeddingProvider, VectorStore } from '@dzipagent/core'

// 1. Set up dependencies (from @dzipagent/core adapters)
const embeddingProvider: EmbeddingProvider = /* your provider */
const vectorStore: VectorStore = /* qdrant, pgvector, inmemory, etc. */

// 2. Create the pipeline
const pipeline = new RagPipeline(
  {
    chunking: { targetTokens: 1200, overlapFraction: 0.15 },
    retrieval: { mode: 'hybrid', topK: 10, tokenBudget: 8000 },
  },
  { embeddingProvider, vectorStore },
)

// 3. Ingest a document
const ingestResult = await pipeline.ingest(documentText, {
  sourceId: 'doc-123',
  sessionId: 'session-456',
  tenantId: 'tenant-789',
})

// 4. Retrieve and assemble context for an LLM prompt
const context = await pipeline.assembleContext('What are the key findings?', {
  sessionId: 'session-456',
  tenantId: 'tenant-789',
  maxTokens: 8000,
})

// context.systemPrompt   -- ready for LLM system message
// context.citations      -- [{ sourceId, sourceTitle, snippet, score }]
// context.totalTokens    -- token count of assembled context
```

## Components

### RagPipeline

Top-level orchestrator that wires together chunking, embedding, vector storage,
retrieval, and context assembly. Three main entry points:

- `ingest(text, options)` -- chunk text, embed, store in vector DB
- `retrieve(query, options)` -- search for relevant chunks
- `assembleContext(query, options)` -- retrieve + assemble into LLM-ready context

Constructor takes `Partial<RagPipelineConfig>` (merged with defaults) and
`RagPipelineDeps` for injected dependencies:

```ts
interface RagPipelineDeps {
  embeddingProvider: EmbeddingProvider
  vectorStore: VectorStore
  keywordSearch?: (query: string, filter: Record<string, unknown>, limit: number)
    => Promise<Array<{ id: string; score: number; text: string; metadata: Record<string, unknown> }>>
}
```

### SmartChunker

Boundary-aware text splitting with configurable target size, overlap, and
built-in 5-factor quality scoring.

```ts
import { SmartChunker } from '@dzipagent/rag'

const chunker = new SmartChunker({
  targetTokens: 1200,      // target tokens per chunk (default 1200)
  overlapFraction: 0.15,   // overlap between adjacent chunks (default 0.15)
  respectBoundaries: true, // respect markdown/paragraph/sentence boundaries
})

const chunks = chunker.chunkText(text, 'source-id')
// ChunkResult[] with id, text, tokenCount, quality, metadata
```

Boundary detection (priority-ordered):
1. Markdown headers (`# ...`)
2. Double newlines (paragraph breaks)
3. Sentence boundaries (`. ` followed by capital, `.\\n`, `! `, `? `)
4. List items (`- `, `* `, `1. `)
5. Code fences (` ``` `)

Quality scoring (5 factors, weighted composite 0-1):
- Content density (25%) -- non-whitespace ratio
- Meaningful sentences (25%) -- sentences with 5+ words
- Token ratio (20%) -- actual vs target tokens
- Position penalty (15%) -- last-chunk discount
- Boilerplate detection (15%) -- cookie/legal/nav pattern matching

Chunks below 50 tokens are merged into their predecessor.

### HybridRetriever

Searches using vector similarity, keyword/FTS, or both with Reciprocal Rank
Fusion (RRF) scoring.

```ts
import { HybridRetriever } from '@dzipagent/rag'

const retriever = new HybridRetriever({
  mode: 'hybrid',           // 'vector' | 'keyword' | 'hybrid'
  topK: 10,
  qualityBoosting: true,
  qualityWeights: { chunk: 0.6, source: 0.4 },
  tokenBudget: 8000,
  embedQuery: (text) => embeddingProvider.embedQuery(text),
  vectorSearch: async (queryVector, filter, limit, minScore) => { /* ... */ },
  keywordSearch: async (query, filter, limit) => { /* ... */ },
})

const result = await retriever.retrieve(query, filter)
// RetrievalResult { chunks: ScoredChunk[], totalTokens, searchMode, queryTimeMs }
```

### ContextAssembler

Transforms retrieval results into LLM-ready context with citation tracking.

- Per-source context modes: `'off'` | `'insights'` | `'full'`
- Grounded and extended system prompt templates (use `{{source_context}}` placeholder)
- Token budget enforcement
- Per-source breakdown of token usage

```ts
import { ContextAssembler } from '@dzipagent/rag'

const assembler = new ContextAssembler()
const context = assembler.assembleContext(retrievalResult, sourceMetadataMap, {
  tokenBudget: 8000,
  snippetLength: 200,
  groundedTemplate: 'Answer based on:\n{{source_context}}',
})
// AssembledContext { systemPrompt, contextText, citations, totalTokens, sourceBreakdown }
```

### QualityBoostedRetriever

Wraps a `HybridRetriever` and re-scores results using an explicit source
quality map. Useful when source quality comes from external signals (user
ratings, freshness, authority).

```ts
import { QualityBoostedRetriever } from '@dzipagent/rag'

const boosted = new QualityBoostedRetriever(baseRetriever, {
  chunkWeight: 0.6,   // weight for chunk-level quality (default 0.6)
  sourceWeight: 0.4,  // weight for source-level quality (default 0.4)
  minScore: 0.1,      // drop chunks below this score (default 0.0)
})

const result = await boosted.retrieve(query, filter, {
  'source-1': 0.9,  // high-quality source
  'source-2': 0.3,  // lower-quality source
})
```

Score formula: `rawScore * (chunkWeight * chunkQuality + sourceWeight * sourceQuality)`

### CitationTracker

Standalone citation utility for source metadata registry, deduplication, and
formatting.

```ts
import { CitationTracker } from '@dzipagent/rag'

const tracker = new CitationTracker()

// Register sources
tracker.registerSources([
  { sourceId: 'src-1', title: 'Research Paper', url: 'https://example.com/paper' },
  { sourceId: 'src-2', title: 'Blog Post', domain: 'blog.example.com' },
])

// Generate citations from retrieval results
const citations = tracker.generateCitations(retrievalResult)
// Deduplicates by (sourceId, chunkIndex), includes 200-char snippets

// Format for display
tracker.formatInlineCitation(0)          // "[1]"
tracker.formatReferenceList(citations)   // "[1] Research Paper (https://...)\n[2] Blog Post"
```

### RagMemoryNamespace

Bridges RAG chunk storage with `@dzipagent/memory` via a duck-typed
`MemoryServiceLike` interface. No hard dependency on the memory package.

```ts
import { RagMemoryNamespace } from '@dzipagent/rag'

const ragMemory = new RagMemoryNamespace(memoryService, {
  namespace: 'rag_chunks',
  scopeKeys: ['tenantId', 'sessionId'],
})

// Store chunks (from ingest)
await ragMemory.storeChunks(chunks, { tenantId: 't1', sessionId: 's1' })

// Retrieve all chunks for a scope
const allChunks = await ragMemory.getChunks({ tenantId: 't1', sessionId: 's1' })

// Semantic search (requires memory service with search support)
const results = await ragMemory.searchChunks('query', scope, 10)

// Delete all chunks for a source (for re-ingestion)
await ragMemory.deleteBySource('source-id', scope)
```

The `MemoryServiceLike` interface requires `put()` and `get()`, with optional
`search()` and `delete()` methods.

## Configuration

```ts
interface RagPipelineConfig {
  chunking: {
    targetTokens: number       // default 1200
    overlapFraction: number    // default 0.15
    respectBoundaries: boolean // default true
  }
  embedding: {
    provider: string    // 'openai', 'voyage', 'cohere', 'ollama', 'custom'
    model: string       // e.g. 'text-embedding-3-small'
    dimensions: number  // e.g. 1536
    batchSize: number   // default 100
  }
  vectorStore: {
    adapter: string           // 'qdrant', 'pgvector', 'chroma', 'pinecone', 'inmemory'
    collectionPrefix: string  // default 'rag_'
  }
  retrieval: {
    mode: 'vector' | 'keyword' | 'hybrid'
    topK: number                               // default 10
    qualityBoosting: boolean                   // default true
    qualityWeights: { chunk: number; source: number }  // default { chunk: 0.6, source: 0.4 }
    tokenBudget: number                        // default 8000
    reranker?: 'cross-encoder' | 'none'        // default 'none'
  }
}
```

All config fields accept `Partial<>` -- unset fields use `DEFAULT_PIPELINE_CONFIG`.

## Integration with DzipAgent

Create a `rag_query` tool for agents:

```ts
import { RagPipeline } from '@dzipagent/rag'

function createRagTool(pipeline: RagPipeline, sessionId: string, tenantId: string) {
  return {
    name: 'rag_query',
    description: 'Search ingested sources for relevant information',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language query' },
        maxResults: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
    invoke: async (input: { query: string; maxResults?: number }) => {
      const context = await pipeline.assembleContext(input.query, {
        sessionId,
        tenantId,
        maxTokens: 8000,
      })
      return JSON.stringify({
        context: context.contextText,
        citations: context.citations,
        totalTokens: context.totalTokens,
      })
    },
  }
}
```

## Exports

```ts
// Classes
export { SmartChunker, HybridRetriever, ContextAssembler, RagPipeline,
         QualityBoostedRetriever, CitationTracker, RagMemoryNamespace }

// Constants
export { DEFAULT_CHUNKING_CONFIG, DEFAULT_RETRIEVAL_CONFIG, DEFAULT_PIPELINE_CONFIG }

// Types (all from types.ts plus component-specific types)
export type { RagPipelineConfig, ChunkingConfig, EmbeddingConfig, VectorStoreConfig,
  RetrievalConfig, ChunkResult, ChunkMetadata, RetrievalResult, ScoredChunk,
  AssembledContext, CitationResult, SourceContextBreakdown, QualityMetrics,
  IngestOptions, IngestResult, SearchMode, ContextMode, SourceMeta, AssemblyOptions,
  VectorSearchFn, KeywordSearchFn, VectorSearchHit, KeywordSearchHit,
  RagPipelineDeps, HybridRetrieverConfig, SourceQualityMap, QualityBoostConfig,
  CitationSourceMeta, RagMemoryConfig, MemoryServiceLike }
```
