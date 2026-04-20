/**
 * Qdrant + RagPipeline — end-to-end example.
 *
 * Run with:
 *   QDRANT_URL=http://localhost:6333 \
 *   OPENAI_API_KEY=sk-... \
 *   npx tsx packages/rag/docs/qdrant-example.ts
 *
 * Prerequisites:
 *   docker run -p 6333:6333 qdrant/qdrant
 */

import { createQdrantRagPipeline, ensureTenantCollection } from '../src/qdrant-factory.js'
import { QdrantAdapter, createOpenAIEmbedding } from '@dzupagent/core'

const QDRANT_URL = process.env['QDRANT_URL'] ?? 'http://localhost:6333'
const OPENAI_API_KEY = process.env['OPENAI_API_KEY'] ?? ''
const TENANT_ID = 'example-tenant'
const SESSION_ID = 'example-session'

async function main() {
  // 1. Build embedding provider (OpenAI text-embedding-3-small, 1536 dims)
  const embeddingProvider = createOpenAIEmbedding({ apiKey: OPENAI_API_KEY })

  // 2. Ensure the tenant collection exists in Qdrant before first write
  const adapter = new QdrantAdapter({ url: QDRANT_URL })
  const collectionName = await ensureTenantCollection(adapter, TENANT_ID)
  console.log(`Collection ready: ${collectionName}`)

  // 3. Create the pipeline — collection prefix must match what ensureTenantCollection used
  const pipeline = createQdrantRagPipeline({
    qdrant: { url: QDRANT_URL },
    embeddingProvider,
    collectionPrefix: 'rag_',   // default; matches ensureTenantCollection default
    dimensions: 1536,           // must match embedding provider
  })

  // 4. Ingest a document
  const docText = `
    DzupAgent is a modular AI agent framework that provides hybrid RAG retrieval,
    multi-agent orchestration, and a plugin-based tool system. The RAG pipeline
    supports vector, keyword, and hybrid search modes with quality-boosted scoring.
    Tenant isolation is enforced at the collection level — each tenant has a
    dedicated Qdrant collection named rag_<tenantId>.
  `.trim()

  const ingestResult = await pipeline.ingest(docText, {
    sourceId: 'dzupagent-overview',
    sessionId: SESSION_ID,
    tenantId: TENANT_ID,
    metadata: { title: 'DzupAgent Overview', author: 'team' },
  })

  console.log(`Ingested ${ingestResult.totalChunks} chunks (${ingestResult.totalTokens} tokens)`)
  console.log(`  embedding: ${ingestResult.embeddingTimeMs}ms  storage: ${ingestResult.storageTimeMs}ms`)

  // 5. Retrieve relevant chunks
  const retrieval = await pipeline.retrieve('How does tenant isolation work?', {
    sessionId: SESSION_ID,
    tenantId: TENANT_ID,
    topK: 3,
    mode: 'vector',
  })

  console.log(`\nRetrieved ${retrieval.chunks.length} chunks in ${retrieval.queryTimeMs}ms`)
  for (const chunk of retrieval.chunks) {
    console.log(`  [score=${chunk.score.toFixed(3)}] ${chunk.text.slice(0, 80)}...`)
  }

  // 6. Assemble LLM-ready context
  const context = await pipeline.assembleContext('Explain the RAG pipeline architecture', {
    sessionId: SESSION_ID,
    tenantId: TENANT_ID,
    maxTokens: 2000,
  })

  console.log(`\nAssembled context (${context.totalTokens} tokens)`)
  console.log(`Citations: ${context.citations.map(c => c.sourceTitle).join(', ')}`)
  console.log('\nSystem prompt snippet:')
  console.log(context.systemPrompt.slice(0, 300))
}

main().catch(console.error)
