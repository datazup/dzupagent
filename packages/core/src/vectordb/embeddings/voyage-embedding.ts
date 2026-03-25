/**
 * Voyage AI embedding provider using raw fetch().
 */

import type { EmbeddingProvider } from '../embedding-types.js'

export interface VoyageEmbeddingConfig {
  apiKey: string
  /** Model name (default: 'voyage-3') */
  model?: string
}

interface VoyageEmbeddingResponseData {
  embedding: number[]
  index: number
}

interface VoyageEmbeddingResponse {
  data: VoyageEmbeddingResponseData[]
}

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings'

/** Default dimensions for known Voyage models */
const VOYAGE_DIMENSIONS: Record<string, number> = {
  'voyage-3': 1024,
  'voyage-3-lite': 512,
  'voyage-code-3': 1024,
  'voyage-large-2': 1536,
  'voyage-2': 1024,
}

/**
 * Create an EmbeddingProvider backed by the Voyage AI embeddings API.
 *
 * Uses `fetch()` directly — no SDK dependency.
 */
export function createVoyageEmbedding(config: VoyageEmbeddingConfig): EmbeddingProvider {
  const model = config.model ?? 'voyage-3'
  const dimensions = VOYAGE_DIMENSIONS[model] ?? 1024

  async function embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []

    const response = await fetch(VOYAGE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: texts,
      }),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => 'unknown error')
      throw new Error(`Voyage embedding request failed (${response.status}): ${body}`)
    }

    const json = (await response.json()) as VoyageEmbeddingResponse
    const sorted = [...json.data].sort((a, b) => a.index - b.index)
    return sorted.map((d) => d.embedding)
  }

  async function embedQuery(text: string): Promise<number[]> {
    const results = await embed([text])
    const first = results[0]
    if (!first) {
      throw new Error('Voyage embedding returned no results')
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
