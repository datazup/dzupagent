/**
 * EmbeddingProvider abstraction — provider-agnostic interface for text embedding.
 *
 * All implementations use raw `fetch()` — no SDK dependencies.
 */

/** Provider for generating text embeddings */
export interface EmbeddingProvider {
  /** Model identifier (e.g., 'text-embedding-3-small') */
  readonly modelId: string
  /** Dimensionality of the output vectors */
  readonly dimensions: number

  /** Batch embed multiple texts. Returns one vector per input text. */
  embed(texts: string[]): Promise<number[][]>

  /** Convenience: embed a single query text */
  embedQuery(text: string): Promise<number[]>
}

/** Configuration for auto-detecting an embedding provider */
export interface EmbeddingProviderConfig {
  provider: 'openai' | 'voyage' | 'cohere' | 'ollama' | 'custom'
  apiKey?: string
  model?: string
  /** Base URL for Ollama or custom endpoints */
  baseUrl?: string
  dimensions?: number
}
