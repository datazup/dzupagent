/**
 * Ollama embedding provider using raw fetch().
 * Local-only — no API key required.
 */

import type { EmbeddingProvider } from '../embedding-types.js'
import { vectorHttpErrorToForgeError } from '../http-error.js'

export interface OllamaEmbeddingConfig {
  /** Ollama model name (required, e.g. 'nomic-embed-text') */
  model: string
  /** Base URL (default: 'http://localhost:11434') */
  baseUrl?: string
  /** Output dimensions (must match the model's native dimensions) */
  dimensions?: number
}

interface OllamaEmbedResponse {
  embeddings: number[][]
}

/**
 * Create an EmbeddingProvider backed by a local Ollama instance.
 *
 * Uses `fetch()` against the Ollama REST API — no SDK dependency.
 */
export function createOllamaEmbedding(config: OllamaEmbeddingConfig): EmbeddingProvider {
  const baseUrl = (config.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '')
  const dimensions = config.dimensions ?? 768

  async function embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []

    // eslint-disable-next-line no-restricted-globals -- intentional: Ollama local/self-hosted endpoint; baseUrl is operator-configured infrastructure, not user input
    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        input: texts,
      }),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => 'unknown error')
      throw vectorHttpErrorToForgeError(response.status, body, 'ollama-embedding')
    }

    const json = (await response.json()) as OllamaEmbedResponse
    return json.embeddings
  }

  async function embedQuery(text: string): Promise<number[]> {
    const results = await embed([text])
    const first = results[0]
    if (!first) {
      throw new Error('Ollama embedding returned no results')
    }
    return first
  }

  return {
    modelId: config.model,
    dimensions,
    embed,
    embedQuery,
  }
}
