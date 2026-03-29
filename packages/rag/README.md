# @dzipagent/rag

Modular RAG (Retrieval-Augmented Generation) pipeline for DzipAgent.

This package provides high-level primitives for text chunking, hybrid retrieval, and context assembly, allowing you to build sophisticated RAG flows with minimal boilerplate.

## Installation

```bash
yarn add @dzipagent/rag
# or
npm install @dzipagent/rag
```

## Key Features

- **Smart Chunking**
  - `SmartChunker` supports multiple strategies (semantic, fixed-size, recursive) to split documents into optimal retrieval units.
- **Hybrid Retrieval**
  - `HybridRetriever` combines vector search with keyword search (BM25-style) using Reciprocal Rank Fusion (RRF) for superior relevance.
- **Quality-Boosted Scoring**
  - `QualityBoostedRetriever` allows re-ranking results based on source authority or custom quality metadata.
- **Context Assembly**
  - `ContextAssembler` builds LLM-ready prompts with token-budget management, citation tracking, and formatting.
- **Top-level Pipeline Orchestrator**
  - `RagPipeline` provides a unified interface for document ingestion, retrieval, and context building.
- **Citation Tracking**
  - `CitationTracker` helps maintain traceability from generated responses back to source document chunks.

## Quick Start

```ts
import { RagPipeline } from '@dzipagent/rag'

const rag = new RagPipeline({
  chunking: { chunkSize: 500, chunkOverlap: 50 },
  retrieval: { topK: 5, hybridAlpha: 0.5 },
}, {
  vectorStore: myVectorStore,
  embeddingProvider: myEmbedder,
  keywordSearch: async (query, filter, limit) => { /* ... */ }
})

// 1. Ingest content
await rag.ingest("Large document text...", { 
  tenantId: 'user-123',
  metadata: { source: 'manual.pdf' } 
})

// 2. Retrieve and assemble context
const context = await rag.assembleContext("How do I configure the server?", {
  tenantId: 'user-123',
  maxTokens: 2000
})

console.log(context.formattedPrompt)
console.log(context.citations)
```

## Usage Examples

### 1) Custom Hybrid Retrieval

Fine-tune the balance between semantic (vector) and lexical (keyword) search.

```ts
import { HybridRetriever } from '@dzipagent/rag'

const retriever = new HybridRetriever({
  topK: 10,
  hybridAlpha: 0.7, // 70% vector, 30% keyword
  minScore: 0.5
})

const results = await retriever.retrieve({
  query: "scaling databases",
  vectorSearch: async (v) => { /* ... */ },
  keywordSearch: async (q) => { /* ... */ }
})
```

### 2) Quality-Based Re-ranking

Boost results from "official" documentation over other sources.

```ts
import { QualityBoostedRetriever } from '@dzipagent/rag'

const booster = new QualityBoostedRetriever({
  boosts: {
    'official-docs': 1.5,
    'community-wiki': 1.1,
    'legacy-archives': 0.8
  }
})

// results will be re-ranked based on their metadata.sourceType
const reranked = booster.boost(initialResults)
```

### 3) Citation Tracking

Maintain a clear audit trail for your RAG outputs.

```ts
import { CitationTracker } from '@dzipagent/rag'

const tracker = new CitationTracker()
const chunks = await rag.retrieve("...")

const context = tracker.createContext(chunks)
// Use context.text in your prompt...

// Later, map LLM citations back to original sources
const sources = tracker.resolve(context.mapping)
```

## API Reference

### Main Classes
- `RagPipeline` — The main entry point for ingestion and retrieval.
- `SmartChunker` — Handles document splitting logic.
- `HybridRetriever` — Orchestrates vector + keyword search.
- `ContextAssembler` — Formats retrieved chunks for LLM consumption.
- `QualityBoostedRetriever` — Re-ranks results based on quality scores.
- `CitationTracker` — Manages source attribution.

### Core Types
- `RagPipelineConfig` / `RagPipelineDeps`
- `ChunkingConfig` / `RetrievalConfig`
- `RetrievedChunk` / `ContextAssemblyResult`

## License

MIT
