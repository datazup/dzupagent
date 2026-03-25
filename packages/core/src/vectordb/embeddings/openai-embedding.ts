/**
 * OpenAI-compatible embedding provider using raw fetch().
 * Supports OpenAI API and any API-compatible endpoint (Azure, vLLM, etc.).
 */

import type { EmbeddingProvider } from '../embedding-types.js'

export interface OpenAIEmbeddingConfig {
  apiKey: string
  /** Model name (default: 'text-embedding-3-small') */
  model?: string
  /** Output dimensions (default: 1536) */
  dimensions?: number
  /** Base URL (default: 'https://api.openai.com/v1') */
  baseUrl?: string
}

interface OpenAIEmbeddingResponseData {
  embedding: number[]
  index: number
}

interface OpenAIEmbeddingResponse {
  data: OpenAIEmbeddingResponseData[]
}

/**
 * Create an EmbeddingProvider backed by the OpenAI embeddings API.
 *
 * Uses `fetch()` directly — no openai SDK dependency.
 */
export function createOpenAIEmbedding(config: OpenAIEmbeddingConfig): EmbeddingProvider {
  const model = config.model ?? 'text-embedding-3-small'
  const dimensions = config.dimensions ?? 1536
  const baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')

  async function embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []

    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: texts,
        dimensions,
      }),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => 'unknown error')
      throw new Error(`OpenAI embedding request failed (${response.status}): ${body}`)
    }

    const json = (await response.json()) as OpenAIEmbeddingResponse
    // Sort by index to ensure order matches input
    const sorted = [...json.data].sort((a, b) => a.index - b.index)
    return sorted.map((d) => d.embedding)
  }

  async function embedQuery(text: string): Promise<number[]> {
    const results = await embed([text])
    const first = results[0]
    if (!first) {
      throw new Error('OpenAI embedding returned no results')
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
