/**
 * Cohere embedding provider using raw fetch().
 */

import type { EmbeddingProvider } from '../embedding-types.js'

export interface CohereEmbeddingConfig {
  apiKey: string
  /** Model name (default: 'embed-english-v3.0') */
  model?: string
}

interface CohereEmbeddingResponse {
  embeddings: {
    float: number[][]
  }
}

const COHERE_API_URL = 'https://api.cohere.com/v2/embed'

/** Default dimensions for known Cohere models */
const COHERE_DIMENSIONS: Record<string, number> = {
  'embed-english-v3.0': 1024,
  'embed-multilingual-v3.0': 1024,
  'embed-english-light-v3.0': 384,
  'embed-multilingual-light-v3.0': 384,
}

/**
 * Create an EmbeddingProvider backed by the Cohere v2 embed API.
 *
 * Uses `fetch()` directly — no SDK dependency.
 */
export function createCohereEmbedding(config: CohereEmbeddingConfig): EmbeddingProvider {
  const model = config.model ?? 'embed-english-v3.0'
  const dimensions = COHERE_DIMENSIONS[model] ?? 1024

  async function embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []

    const response = await fetch(COHERE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        texts,
        input_type: 'search_document',
        embedding_types: ['float'],
      }),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => 'unknown error')
      throw new Error(`Cohere embedding request failed (${response.status}): ${body}`)
    }

    const json = (await response.json()) as CohereEmbeddingResponse
    return json.embeddings.float
  }

  async function embedQuery(text: string): Promise<number[]> {
    // Cohere uses 'search_query' input_type for queries, but for simplicity
    // we use the same embed() path. Override with search_query type:
    if (text.length === 0) {
      throw new Error('Cannot embed empty query text')
    }

    const response = await fetch(COHERE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        texts: [text],
        input_type: 'search_query',
        embedding_types: ['float'],
      }),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => 'unknown error')
      throw new Error(`Cohere embedding query failed (${response.status}): ${body}`)
    }

    const json = (await response.json()) as CohereEmbeddingResponse
    const first = json.embeddings.float[0]
    if (!first) {
      throw new Error('Cohere embedding returned no results')
    }
    return first
  }

  return {
    modelId: model,
    dimensions,
    embed,
    embedQuery,
  }
}
