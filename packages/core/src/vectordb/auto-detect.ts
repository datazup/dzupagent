/**
 * Auto-detection utilities for embedding providers and vector store backends.
 *
 * Reads environment variables to determine the best available provider,
 * falling through a priority chain until one is found.
 */

import type { EmbeddingProvider } from './embedding-types.js'
import { createVoyageEmbedding } from './embeddings/voyage-embedding.js'
import { createOpenAIEmbedding } from './embeddings/openai-embedding.js'
import { createCohereEmbedding } from './embeddings/cohere-embedding.js'
import { InMemoryVectorStore } from './in-memory-vector-store.js'
import { SemanticStore } from './semantic-store.js'

/**
 * Auto-detect embedding provider from environment variables.
 *
 * Priority chain: VOYAGE_API_KEY -> OPENAI_API_KEY -> COHERE_API_KEY -> throws
 *
 * @param env - Optional env object (defaults to process.env)
 */
export function createAutoEmbeddingProvider(
  env?: Record<string, string | undefined>,
): EmbeddingProvider {
  const e = env ?? process.env

  const voyageKey = e['VOYAGE_API_KEY']
  if (voyageKey) {
    return createVoyageEmbedding({
      apiKey: voyageKey,
      model: e['VOYAGE_MODEL'],
    })
  }

  const openaiKey = e['OPENAI_API_KEY']
  if (openaiKey) {
    return createOpenAIEmbedding({
      apiKey: openaiKey,
      model: e['OPENAI_EMBEDDING_MODEL'],
      baseUrl: e['OPENAI_BASE_URL'],
    })
  }

  const cohereKey = e['COHERE_API_KEY']
  if (cohereKey) {
    return createCohereEmbedding({
      apiKey: cohereKey,
      model: e['COHERE_EMBEDDING_MODEL'],
    })
  }

  throw new Error(
    'No embedding provider detected. Set one of: VOYAGE_API_KEY, OPENAI_API_KEY, COHERE_API_KEY',
  )
}

/**
 * Result of auto-detecting the vector store provider.
 *
 * NOTE: Actual adapter construction happens in Phase 2.
 * This function only returns config metadata for the detected provider.
 */
export interface AutoDetectResult {
  provider: string
  config: Record<string, unknown>
}

/**
 * Auto-detect vector store provider from environment variables.
 *
 * Priority chain:
 * 1. VECTOR_PROVIDER env var (explicit override)
 * 2. QDRANT_URL present -> qdrant
 * 3. PINECONE_API_KEY present -> pinecone
 * 4. Falls back to 'memory' (in-memory store)
 *
 * @param env - Optional env object (defaults to process.env)
 */
export function detectVectorProvider(
  env?: Record<string, string | undefined>,
): AutoDetectResult {
  const e = env ?? process.env

  // Explicit override
  const explicit = e['VECTOR_PROVIDER']
  if (explicit) {
    return {
      provider: explicit,
      config: { source: 'VECTOR_PROVIDER' },
    }
  }

  // Qdrant
  const qdrantUrl = e['QDRANT_URL']
  if (qdrantUrl) {
    return {
      provider: 'qdrant',
      config: {
        url: qdrantUrl,
        apiKey: e['QDRANT_API_KEY'],
      },
    }
  }

  // Pinecone
  const pineconeKey = e['PINECONE_API_KEY']
  if (pineconeKey) {
    return {
      provider: 'pinecone',
      config: {
        apiKey: pineconeKey,
        environment: e['PINECONE_ENVIRONMENT'],
      },
    }
  }

  // Fallback: in-memory
  return {
    provider: 'memory',
    config: {},
  }
}

/**
 * Create a fully-wired SemanticStore by auto-detecting embedding provider
 * and using an InMemoryVectorStore as the backing store.
 *
 * This is a convenience for development / testing. For production, construct
 * SemanticStore manually with a real vector store adapter (Qdrant, Pinecone, etc.).
 *
 * @param env - Optional env object (defaults to process.env)
 * @throws if no embedding provider can be detected
 */
export function createAutoSemanticStore(
  env?: Record<string, string | undefined>,
): SemanticStore {
  const embedding = createAutoEmbeddingProvider(env)
  const vectorStore = new InMemoryVectorStore()

  return new SemanticStore({
    embedding,
    vectorStore,
  })
}
