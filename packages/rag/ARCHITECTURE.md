# @dzupagent/rag Architecture

Last updated: 2026-04-03  
Scope: `packages/rag` in this monorepo

## Purpose

`@dzupagent/rag` provides a modular Retrieval-Augmented Generation (RAG) stack with:

- text chunking (`SmartChunker`)
- retrieval (`HybridRetriever`, optional `QualityBoostedRetriever`)
- context assembly and prompt building (`ContextAssembler`)
- orchestration (`RagPipeline`)
- optional memory bridge (`RagMemoryNamespace`)
- citation utilities (`CitationTracker`)

The package is designed around dependency injection: embedding and vector DB behavior come from `@dzupagent/core` interfaces supplied by the caller.

## Public Surface

Exports are defined in `src/index.ts`.

| Export | Kind | Responsibility |
|---|---|---|
| `SmartChunker`, `DEFAULT_CHUNKING_CONFIG` | class/value | Boundary-aware chunk splitting and chunk quality scoring |
| `HybridRetriever`, `DEFAULT_RETRIEVAL_CONFIG` | class/value | Vector/keyword/hybrid retrieval + optional quality boost + token-budget trimming |
| `QualityBoostedRetriever` | class | Post-retrieval reranking using external source quality map |
| `ContextAssembler` | class | Build context text, citations, source breakdown, grounded/extended prompts |
| `RagPipeline`, `DEFAULT_PIPELINE_CONFIG` | class/value | End-to-end ingest/retrieve/assemble orchestration |
| `CitationTracker` | class | Track source metadata and produce/formats citations |
| `RagMemoryNamespace` | class | Store/search/delete chunks through a MemoryService-like API |
| `types.ts` exports | types | Shared configs and data contracts |

## High-Level Architecture

```text
Ingest path
-----------
Raw text
  -> SmartChunker.chunkText()
  -> EmbeddingProvider.embed()           (injected dependency)
  -> VectorStore.upsert()                (injected dependency)

Query path
----------
User query
  -> HybridRetriever.retrieve()
      -> embedQuery() + vectorSearch()   (and optional keywordSearch())
      -> optional quality boosting
      -> token-budget trim
  -> RetrievalResult
  -> ContextAssembler.assembleContext()
      -> contextText + citations + prompt + breakdown
```

## External Dependencies and Contracts

`RagPipeline` expects:

- `embeddingProvider: EmbeddingProvider`
  - `embed(texts: string[]): Promise<number[][]>`
  - `embedQuery(text: string): Promise<number[]>`
- `vectorStore: VectorStore`
  - pipeline currently uses `upsert()` and `search()` directly
- optional `keywordSearch(query, filter, limit)` callback for lexical retrieval

The package itself stores and reads retrieval metadata with these canonical keys:

- `source_id`
- `session_id`
- `chunk_index`
- `quality_score`
- optional: `source_title`, `source_url`, `source_quality`, `sourceQuality`, `domain_authority`

## Component Details

## 1) SmartChunker (`src/chunker.ts`)

### What it does

- Splits source text into overlapping chunks.
- Uses configurable boundary-aware breakpoints (headers, paragraphs, sentence markers, list markers, code fences).
- Adds metadata and a computed quality score for each chunk.

### Key config

- `targetTokens` (default `1200`)
- `overlapFraction` (default `0.15`)
- `respectBoundaries` (default `true`)

### Output

`ChunkResult[]` with:

- `id`: `${sourceId}:${chunkIndex}`
- `text`
- `tokenCount` (`estimateTokens` from `@dzupagent/core`)
- `quality` (`0..1`)
- offsets + boundary type metadata

### Quality model

`computeChunkQuality()` blends:

- content density
- meaningful sentence count
- token ratio vs target
- trailing-chunk position penalty
- boilerplate pattern detection

It also reports vocabulary diversity and structure signals.

## 2) HybridRetriever (`src/retriever.ts`)

### What it does

- Supports retrieval modes: `vector`, `keyword`, `hybrid`.
- Uses Reciprocal Rank Fusion (RRF, default `k=60`) for hybrid mode.
- Optionally applies quality-based score adjustment.
- Enforces a token budget greedily from highest score downward.

### Retrieval modes

- `vector`: embed query, call injected vector search
- `keyword`: call injected keyword search
- `hybrid`: run both and fuse by RRF

### Quality boosting model

- Blend: `chunkQuality * chunkWeight + sourceQuality * sourceWeight`
- Convert to boost factor around midpoint with ±15% range
- Built-in resolution order for source quality:
  1. configured async provider (`sourceQuality.provider`)
  2. chunk metadata (`sourceQuality` fields)
  3. configured fallback (`sourceQuality.fallback`) or `0.5`

### Important behavior

- `topK` is clamped to `[1, 100]`.
- If token budget is exceeded, lower-ranked chunks are dropped.
- First chunk is always kept even when larger than budget.

## 3) QualityBoostedRetriever (`src/quality-retriever.ts`)

### What it does

- Wraps an existing `HybridRetriever`.
- Disables base retriever quality boosting for this call.
- Re-scores using caller-provided `sourceQualities: Record<sourceId, score>`.
- Filters by optional `minScore`.

### Formula

`finalScore = rawScore * (chunkWeight * chunkQuality + sourceWeight * sourceQuality)`

Defaults: `chunkWeight=0.6`, `sourceWeight=0.4`, `minScore=0.0`.

## 4) ContextAssembler (`src/assembler.ts`)

### What it does

- Builds LLM-ready context from retrieval results + per-source metadata.
- Supports source context modes:
  - `off`: source excluded
  - `insights`: use provided source summary (if length >= 20)
  - `full`: include retrieved chunk text
- Produces:
  - `contextText` with numbered source entries
  - `citations` with snippets
  - `sourceBreakdown` with token/chunk usage per source
  - grounded system prompt (default) or extended prompt

### Token budget behavior

- Insights and full chunks are combined and sorted (`insights` first, then score desc).
- When over budget, lowest-ranked `full` chunks are dropped first.
- Insights are preserved preferentially.

## 5) RagPipeline (`src/pipeline.ts`)

### What it does

Top-level orchestrator wiring `SmartChunker`, `HybridRetriever`, and `ContextAssembler` with injected provider/store dependencies.

### Main operations

- `ingest(text, options)`
  - chunk text
  - embed chunk texts in batches (`embedding.batchSize`)
  - upsert vector entries into tenant collection (`collectionPrefix + tenantId`)
- `retrieve(query, { sessionId, tenantId, ...retrievalOverrides })`
  - routes query to tenant-specific cached retriever
  - builds metadata filter (currently from `sessionId`)
- `assembleContext(query, options)`
  - retrieve + assemble in one call
  - supports caller-provided source metadata and assembly options

### Tenant isolation

- One retriever instance cached per `tenantId`.
- Collection name derived by prefix + tenant.
- `disposeTenant()` and `disposeAll()` clear cache.

## 6) RagMemoryNamespace (`src/memory-namespace.ts`)

### What it does

- Bridges chunk storage to a generic `MemoryServiceLike` contract.
- Validates required scope keys (for example `tenantId`, `sessionId`).
- Provides:
  - `storeChunks()`
  - `getChunks()`
  - `searchChunks()` (if memory service supports search)
  - `deleteBySource()` (if memory service supports delete)
  - `getChunkCount()`

### Design notes

- Uses duck typing, no hard runtime dependency on a specific memory implementation.
- Filters out records that do not match expected chunk shape.

## 7) CitationTracker (`src/citation-tracker.ts`)

### What it does

- Maintains source metadata registry.
- Generates deduplicated citations by `(sourceId, chunkIndex)` from retrieval output.
- Provides formatting helpers:
  - inline citation `[N]`
  - reference list with optional URLs

## End-to-End Data Flow

## Ingestion flow

1. Caller invokes `pipeline.ingest(text, options)` with required `sourceId`, `sessionId`, `tenantId`.
2. Text is chunked into `ChunkResult[]`.
3. If `autoEmbed !== false`, chunk texts are embedded in batches.
4. Vector entries are written to `vectorStore.upsert(collectionName, entries)` with metadata fields.
5. `IngestResult` returns chunk counts/tokens and timing metrics.

## Retrieval flow

1. Caller invokes `pipeline.retrieve(query, { sessionId, tenantId, ... })`.
2. Pipeline retrieves/creates tenant-specific retriever.
3. Retriever performs vector/keyword/hybrid search.
4. Optional quality boosting adjusts scores.
5. Token budget trims output list.
6. `RetrievalResult` returned with `chunks`, `totalTokens`, `searchMode`, `queryTimeMs`.

## Assembly flow

1. Caller invokes `pipeline.assembleContext(query, options)`.
2. Pipeline runs retrieval using `maxTokens` as retrieval budget.
3. `ContextAssembler` merges retrieved chunks with source metadata/context modes.
4. Returns `AssembledContext` with prompt, context text, citations, and source breakdown.

## Feature Matrix

| Feature | Where | Description | How to enable |
|---|---|---|---|
| Boundary-aware chunking | `SmartChunker` | Splits near semantic boundaries when possible | `respectBoundaries: true` |
| Overlap chunking | `SmartChunker` | Preserves context continuity between chunks | tune `overlapFraction` |
| Chunk quality scoring | `SmartChunker` | Computes per-chunk quality score used downstream | automatic |
| Vector retrieval | `HybridRetriever` | Semantic search via embeddings | provide `embedQuery` + `vectorSearch` |
| Keyword retrieval | `HybridRetriever` | Lexical/FTS retrieval path | provide `keywordSearch` |
| Hybrid retrieval (RRF) | `HybridRetriever` | Fuses vector + keyword ranking | set mode `hybrid` |
| Built-in quality boost | `HybridRetriever` | Adjusts relevance by chunk/source quality | `qualityBoosting: true` |
| External quality boost | `QualityBoostedRetriever` | Re-ranks by external source quality map | wrap base retriever |
| Context mode control | `ContextAssembler` | Source-level `off`/`insights`/`full` behavior | provide `SourceMeta.contextMode` |
| Prompt templates | `ContextAssembler` | Custom grounded/extended prompt templates | `groundedTemplate` / `extendedTemplate` |
| Citation helpers | `CitationTracker` | Inline/reference list formatting | register sources + generate citations |
| Memory namespace bridge | `RagMemoryNamespace` | Store/search/delete chunks in memory service | provide `MemoryServiceLike` |

## Test Coverage

This section maps implemented features to the current test suite in
`packages/rag/src/__tests__`.

## Test Suite Map

| Test file | Primary scope |
|---|---|
| `chunker-quality.test.ts` | `SmartChunker` chunking behavior + quality scoring heuristics |
| `retriever.test.ts` | `HybridRetriever` modes, RRF, metadata parsing, budgeting, timing |
| `rag.integration.test.ts` | Public retriever surface, hybrid fusion integration path |
| `quality-retriever.test.ts` | `QualityBoostedRetriever` boosting and option pass-through |
| `assembler.test.ts` | `ContextAssembler` modes, budgeting, citations, prompt builders |
| `citation-tracker.test.ts` | `CitationTracker` source registry + citation formatting |
| `memory-namespace.test.ts` | `RagMemoryNamespace` CRUD/search/scope behavior |
| `pipeline-memory-retriever.test.ts` | `RagPipeline` tenant collection isolation + source-quality strategy behavior in `HybridRetriever` |

Notes:

- `chunker.test.ts` and `minimal-chunker.test.ts` are placeholders (`export {}`) and are excluded in `vitest.config.ts`.

## Feature-to-Test Matrix

| Feature | Main tests covering it | What is verified |
|---|---|---|
| Boundary-aware chunking | `chunker-quality.test.ts` (`boundary detection`) | header and paragraph breakpoints, token boundary fallback |
| Overlap + chunk metadata | `chunker-quality.test.ts` (`chunkText`) | sequential IDs/indexes, overlapping offsets, token counts |
| Trailing tiny-chunk merge | `chunker-quality.test.ts` (`trailing chunk merge`) | tiny tail is merged into predecessor |
| Chunk quality scoring | `chunker-quality.test.ts` (`computeChunkQuality`) | meaningful content scoring, boilerplate penalty, diversity/structure metrics, score clamping |
| Vector retrieval mode | `retriever.test.ts` (`vector mode`) | ranking, `vectorScore` mapping, `embedQuery` invocation |
| Keyword retrieval mode | `retriever.test.ts` (`keyword mode`) | keyword path, `keywordScore` mapping, behavior without keyword function |
| Hybrid retrieval (RRF) | `retriever.test.ts` (`hybrid mode (RRF)`), `rag.integration.test.ts` | shared-hit boosting, mixed-source fused rankings |
| Retrieval budget + limits | `retriever.test.ts` (`token budget enforcement`, `topK clamping`) | first-chunk guarantee, token trimming, `topK` clamped to 1..100 |
| Retrieval metadata parsing | `retriever.test.ts` (`metadata parsing`) | source fields and `source_quality` numeric/string normalization path |
| Built-in source quality strategy | `pipeline-memory-retriever.test.ts` (`HybridRetriever source quality boosting`) | metadata fallback, provider precedence, provider error fallback, configured fallback |
| External quality boosting | `quality-retriever.test.ts` | map-based score changes, custom weights, `minScore` filter, descending order |
| Disable double boosting | `quality-retriever.test.ts` | wrapper sets `qualityBoosting: false` on base retriever |
| Context modes (`off/insights/full`) | `assembler.test.ts` (`context modes`) | exclusion of `off`, summary-only `insights`, summary length guard, ordering |
| Assembly token budgeting | `assembler.test.ts` (`token budget`) | low-score full chunks dropped first, insights preserved |
| Prompt generation | `assembler.test.ts` (`buildGroundedPrompt`, `buildExtendedPrompt`) | no-source behavior, template replacement, source section rendering |
| Citations in assembled context | `assembler.test.ts` (`citations`) | snippet length, title fallback, numbered context format |
| Source breakdown accounting | `assembler.test.ts` (`source breakdown`) | per-source chunk/token aggregation |
| Citation utility behavior | `citation-tracker.test.ts` | source registration overwrite behavior, dedupe by `sourceId+chunkIndex`, inline/ref list formatting |
| Memory namespace scope + storage | `memory-namespace.test.ts`, `pipeline-memory-retriever.test.ts` | required scope validation, record shape filtering, search/delete capability checks |
| Tenant collection isolation | `pipeline-memory-retriever.test.ts` | different tenants resolve to distinct vector collections |

## Coverage Gaps and Risks

Current implementation has meaningful coverage, but these gaps remain:

- `RagPipeline.ingest()` happy path and edge cases are not directly unit-tested in `packages/rag` (chunking + embedding + vector upsert contract assertions).
- `RagPipeline.assembleContext()` orchestration path is not directly unit-tested end-to-end (retrieve + assemble coupling).
- Re-ingestion cleanup behavior is not covered (and currently pipeline is upsert-only).
- There is no test explicitly guarding short-input/high-overlap chunker termination; current suite run still reports worker OOM (`ERR_WORKER_OUT_OF_MEMORY`).

## How To Use

## 1) Create a pipeline

```ts
import { RagPipeline } from '@dzupagent/rag'
import type { EmbeddingProvider, VectorStore } from '@dzupagent/core'

const embeddingProvider: EmbeddingProvider = /* your provider */
const vectorStore: VectorStore = /* your adapter */

const rag = new RagPipeline(
  {
    chunking: { targetTokens: 500, overlapFraction: 0.1, respectBoundaries: true },
    retrieval: { mode: 'hybrid', topK: 8, qualityBoosting: true, tokenBudget: 3000 },
  },
  {
    embeddingProvider,
    vectorStore,
    keywordSearch: async (query, filter, limit) => {
      // Return [{ id, score, text, metadata }]
      return []
    },
  },
)
```

## 2) Ingest a document

```ts
const ingest = await rag.ingest(longText, {
  sourceId: 'doc-001',
  sessionId: 'session-abc',
  tenantId: 'tenant-x',
  metadata: {
    source_title: 'Platform Runbook',
    source_url: 'https://docs.example.com/runbook',
    source_quality: 0.9,
  },
})

console.log(ingest.totalChunks, ingest.totalTokens)
```

## 3) Retrieve chunks only

```ts
const retrieval = await rag.retrieve('How do I rotate API keys?', {
  sessionId: 'session-abc',
  tenantId: 'tenant-x',
  mode: 'hybrid',
  topK: 5,
  tokenBudget: 1200,
})

for (const chunk of retrieval.chunks) {
  console.log(chunk.id, chunk.score, chunk.sourceId)
}
```

## 4) Retrieve + assemble context for an LLM

```ts
const sourceMetadata = new Map([
  ['doc-001', {
    sourceId: 'doc-001',
    title: 'Platform Runbook',
    url: 'https://docs.example.com/runbook',
    contextMode: 'full' as const,
  }],
  ['doc-002', {
    sourceId: 'doc-002',
    title: 'Release Notes Summary',
    contextMode: 'insights' as const,
    summary: 'High-level notes from recent release cycles ...',
  }],
])

const assembled = await rag.assembleContext('What changed in incident handling?', {
  sessionId: 'session-abc',
  tenantId: 'tenant-x',
  maxTokens: 2000,
  sourceMetadata,
})

console.log(assembled.systemPrompt)
console.log(assembled.citations)
```

## 5) Optional: external source-quality reranking

```ts
import { HybridRetriever, QualityBoostedRetriever } from '@dzupagent/rag'

const baseRetriever = new HybridRetriever({
  mode: 'hybrid',
  topK: 10,
  qualityBoosting: false,
  qualityWeights: { chunk: 0.6, source: 0.4 },
  tokenBudget: 2000,
  embedQuery: async (q) => /* vector */ [],
  vectorSearch: async (vec, filter, limit) => /* vector hits */ [],
  keywordSearch: async (q, filter, limit) => /* keyword hits */ [],
})

const boostedRetriever = new QualityBoostedRetriever(baseRetriever, {
  chunkWeight: 0.6,
  sourceWeight: 0.4,
  minScore: 0.1,
})

const boosted = await boostedRetriever.retrieve(
  'question',
  { session_id: 'session-abc' },
  { 'doc-001': 1.0, 'doc-legacy': 0.3 },
)
```

## 6) Optional: use memory namespace bridge

```ts
import { RagMemoryNamespace } from '@dzupagent/rag'

const memoryNs = new RagMemoryNamespace(memoryService, {
  namespace: 'rag-chunks',
  scopeKeys: ['tenantId', 'sessionId'],
})

await memoryNs.storeChunks(ingest.chunks, {
  tenantId: 'tenant-x',
  sessionId: 'session-abc',
})

const storedChunks = await memoryNs.getChunks({
  tenantId: 'tenant-x',
  sessionId: 'session-abc',
})
```

## Current Limitations and Caveats

These are implementation-accurate caveats as of this snapshot:

- `SmartChunker` currently has a short-input/high-overlap loop risk that can trigger worker OOM in tests (`chunker-quality.test.ts` does not complete reliably in full run).
- `RagPipeline.ingest()` is upsert-only; re-ingesting a source with fewer chunks can leave stale vectors unless caller performs explicit cleanup.
- `RagPipeline.retrieve()` currently filters by `session_id` only; tenant separation is achieved by collection name, not by metadata filter.
- `RagPipelineConfig.embedding` and `RagPipelineConfig.vectorStore` fields are mostly descriptive in current code; runtime behavior is controlled by injected dependencies.
- `RetrievalConfig.reranker` and `IngestOptions.autoSummarize` are defined in types but not operationally used in current implementation.
- `README.md` examples are not fully aligned with current method signatures and options; prefer this architecture document + `src/types.ts` for integration.

## Test Status Snapshot

Command executed:

- `yarn workspace @dzupagent/rag test`

Observed outcome:

- 7 test files passed (`78` tests passed)
- 1 unhandled worker error: `ERR_WORKER_OUT_OF_MEMORY`
- overall command exit code: `1`
