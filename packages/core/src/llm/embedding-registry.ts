/**
 * EmbeddingRegistry — tracks available embedding models with metadata
 * (dimensions, cost, batch size) for provider-agnostic selection.
 */

/** Metadata entry for a registered embedding model */
export interface EmbeddingModelEntry {
  /** Unique identifier (e.g., 'openai/text-embedding-3-small') */
  id: string
  /** Provider name (e.g., 'openai', 'voyage', 'cohere') */
  provider: string
  /** Model name as passed to the provider API */
  model: string
  /** Output vector dimensionality */
  dimensions: number
  /** Maximum texts per batch request */
  maxBatchSize: number
  /** Cost per 1k tokens in USD (for budgeting) */
  costPer1kTokens: number
  /** Human-readable description */
  description?: string
}

/**
 * Registry for embedding models. Allows registering, querying, and
 * selecting embedding models by provider or capability.
 */
export class EmbeddingRegistry {
  private models = new Map<string, EmbeddingModelEntry>()

  /** Register an embedding model entry */
  register(entry: EmbeddingModelEntry): void {
    this.models.set(entry.id, entry)
  }

  /** Get a model entry by ID */
  get(id: string): EmbeddingModelEntry | undefined {
    return this.models.get(id)
  }

  /** List all registered embedding models */
  list(): EmbeddingModelEntry[] {
    return Array.from(this.models.values())
  }

  /** List models for a specific provider */
  getByProvider(provider: string): EmbeddingModelEntry[] {
    return this.list().filter(m => m.provider === provider)
  }

  /**
   * Get the default (first registered) embedding model, optionally filtered by provider.
   */
  getDefault(provider?: string): EmbeddingModelEntry | undefined {
    if (provider) {
      return this.getByProvider(provider)[0]
    }
    return this.list()[0]
  }

  /** Check if a model ID is registered */
  has(id: string): boolean {
    return this.models.has(id)
  }

  /** Remove a model entry */
  remove(id: string): boolean {
    return this.models.delete(id)
  }
}

/** Pre-configured common embedding models */
export const COMMON_EMBEDDING_MODELS: EmbeddingModelEntry[] = [
  {
    id: 'openai/text-embedding-3-small',
    provider: 'openai',
    model: 'text-embedding-3-small',
    dimensions: 1536,
    maxBatchSize: 2048,
    costPer1kTokens: 0.00002,
    description: 'OpenAI small embedding model — best price/performance ratio',
  },
  {
    id: 'openai/text-embedding-3-large',
    provider: 'openai',
    model: 'text-embedding-3-large',
    dimensions: 3072,
    maxBatchSize: 2048,
    costPer1kTokens: 0.00013,
    description: 'OpenAI large embedding model — highest quality',
  },
  {
    id: 'openai/text-embedding-ada-002',
    provider: 'openai',
    model: 'text-embedding-ada-002',
    dimensions: 1536,
    maxBatchSize: 2048,
    costPer1kTokens: 0.0001,
    description: 'OpenAI legacy Ada v2 embedding model',
  },
  {
    id: 'voyage/voyage-3',
    provider: 'voyage',
    model: 'voyage-3',
    dimensions: 1024,
    maxBatchSize: 128,
    costPer1kTokens: 0.00006,
    description: 'Voyage AI v3 — strong retrieval performance',
  },
  {
    id: 'cohere/embed-english-v3.0',
    provider: 'cohere',
    model: 'embed-english-v3.0',
    dimensions: 1024,
    maxBatchSize: 96,
    costPer1kTokens: 0.0001,
    description: 'Cohere Embed v3 — English-optimized',
  },
]

/**
 * Create an EmbeddingRegistry pre-loaded with common models.
 */
export function createDefaultEmbeddingRegistry(): EmbeddingRegistry {
  const registry = new EmbeddingRegistry()
  for (const entry of COMMON_EMBEDDING_MODELS) {
    registry.register(entry)
  }
  return registry
}
