/**
 * Custom embedding provider — delegates to a user-supplied function.
 */

import type { EmbeddingProvider } from '../embedding-types.js'

export interface CustomEmbeddingConfig {
  /** User-supplied batch embedding function */
  embedFn: (texts: string[]) => Promise<number[][]>
  /** Identifier for this custom model */
  modelId: string
  /** Output dimensions */
  dimensions: number
}

/**
 * Create an EmbeddingProvider that delegates to a user-supplied function.
 *
 * Useful for wrapping proprietary APIs, fine-tuned models, or test stubs.
 */
export function createCustomEmbedding(config: CustomEmbeddingConfig): EmbeddingProvider {
  async function embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    return config.embedFn(texts)
  }

  async function embedQuery(text: string): Promise<number[]> {
    const results = await embed([text])
    const first = results[0]
    if (!first) {
      throw new Error('Custom embedding returned no results')
    }
    return first
  }

  return {
    modelId: config.modelId,
    dimensions: config.dimensions,
    embed,
    embedQuery,
  }
}
