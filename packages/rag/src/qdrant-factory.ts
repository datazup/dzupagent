/**
 * QdrantRagFactory — convenience factory that wires QdrantAdapter into RagPipeline.
 *
 * Tenant isolation strategy: one Qdrant collection per tenant, named
 * `<collectionPrefix><tenantId>` (default prefix: "rag_"). This keeps
 * Qdrant RBAC clean and avoids cross-tenant filter misses.
 */

import { QdrantAdapter } from '@dzupagent/core'
import type { QdrantAdapterConfig, EmbeddingProvider } from '@dzupagent/core'

import { RagPipeline } from './pipeline.js'
import type { RagPipelineDeps } from './pipeline.js'
import type { RagPipelineConfig } from './types.js'

// Re-export for callers who want to customise adapter config without importing @dzupagent/core
export type { QdrantAdapterConfig }

// ---------------------------------------------------------------------------
// Factory Config
// ---------------------------------------------------------------------------

/** Config accepted by QdrantRagFactory.create() */
export interface QdrantRagConfig {
  /** Qdrant connection options (url, apiKey) */
  qdrant?: QdrantAdapterConfig

  /** Embedding provider — must implement EmbeddingProvider from @dzupagent/core */
  embeddingProvider: EmbeddingProvider

  /**
   * Collection name prefix. Each tenant gets its own collection:
   *   `<prefix><tenantId>` (default: "rag_")
   */
  collectionPrefix?: string

  /**
   * Vector dimensions — must match the embedding provider's output.
   * Defaults to 1536 (OpenAI text-embedding-3-small).
   */
  dimensions?: number

  /** Optional keyword search function for hybrid retrieval. */
  keywordSearch?: RagPipelineDeps['keywordSearch']

  /** Fine-grained pipeline overrides (chunking, retrieval, etc.) */
  pipeline?: Partial<Omit<RagPipelineConfig, 'vectorStore'>>
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a RagPipeline backed by Qdrant.
 *
 * @example
 * ```ts
 * import { createQdrantRagPipeline } from '@dzupagent/rag'
 * import { createOpenAIEmbedding } from '@dzupagent/core'
 *
 * const pipeline = createQdrantRagPipeline({
 *   qdrant: { url: 'http://localhost:6333', apiKey: process.env.QDRANT_API_KEY },
 *   embeddingProvider: createOpenAIEmbedding({ apiKey: process.env.OPENAI_API_KEY! }),
 * })
 *
 * await pipeline.ingest('Your document text...', {
 *   sourceId: 'doc-1',
 *   sessionId: 'session-abc',
 *   tenantId: 'tenant-xyz',
 * })
 *
 * const ctx = await pipeline.assembleContext('What is the setup guide?', {
 *   sessionId: 'session-abc',
 *   tenantId: 'tenant-xyz',
 * })
 * console.log(ctx.contextText)
 * ```
 */
export function createQdrantRagPipeline(config: QdrantRagConfig): RagPipeline {
  const adapter = new QdrantAdapter(config.qdrant)

  const pipelineConfig: Partial<RagPipelineConfig> = {
    ...config.pipeline,
    vectorStore: {
      adapter: 'qdrant',
      collectionPrefix: config.collectionPrefix ?? 'rag_',
      dimensions: config.dimensions ?? 1536,
    },
  }

  const deps: RagPipelineDeps = {
    embeddingProvider: config.embeddingProvider,
    vectorStore: adapter,
    ...(config.keywordSearch !== undefined ? { keywordSearch: config.keywordSearch } : {}),
  }

  return new RagPipeline(pipelineConfig, deps)
}

/**
 * Ensure a Qdrant collection exists for the given tenant.
 *
 * Safe to call on every startup — no-ops if the collection already exists.
 */
export async function ensureTenantCollection(
  adapter: QdrantAdapter,
  tenantId: string,
  options: {
    collectionPrefix?: string
    dimensions?: number
  } = {},
): Promise<string> {
  const prefix = options.collectionPrefix ?? 'rag_'
  const dimensions = options.dimensions ?? 1536
  const collectionName = `${prefix}${tenantId}`

  const exists = await adapter.collectionExists(collectionName)
  if (!exists) {
    await adapter.createCollection(collectionName, { dimensions, metric: 'cosine' })
  }

  return collectionName
}
