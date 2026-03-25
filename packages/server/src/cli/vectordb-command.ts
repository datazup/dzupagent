/**
 * VEC-018: CLI vectordb:status command — check vector DB connectivity and report status.
 *
 * Provides programmatic health check and terminal-formatted output
 * for the vector store backing an agent deployment.
 */

import type { VectorStore } from '@forgeagent/core'

/**
 * Result of a vector DB status check.
 */
export interface VectorDBStatusResult {
  /** Provider name (e.g. 'qdrant', 'pinecone', 'in-memory') */
  provider: string
  /** Whether the vector store is reachable and healthy */
  healthy: boolean
  /** Round-trip latency in milliseconds */
  latencyMs: number
  /** Collections discovered with their vector counts */
  collections: Array<{ name: string; count: number }>
  /** Embedding provider name, if known */
  embeddingProvider?: string
  /** Embedding vector dimensions, if known */
  embeddingDimensions?: number
}

/**
 * Check vector DB connectivity and report status.
 *
 * Performs a health check, lists collections, and counts vectors.
 */
export async function vectordbStatus(
  vectorStore: VectorStore,
): Promise<VectorDBStatusResult> {
  const start = Date.now()
  let healthy = false

  try {
    const health = await vectorStore.healthCheck()
    healthy = health.healthy
  } catch {
    healthy = false
  }

  const latencyMs = Date.now() - start

  const collections: Array<{ name: string; count: number }> = []

  if (healthy) {
    try {
      const names = await vectorStore.listCollections()
      for (const name of names) {
        try {
          const count = await vectorStore.count(name)
          collections.push({ name, count })
        } catch {
          collections.push({ name, count: -1 })
        }
      }
    } catch {
      // Unable to list collections — continue with empty list
    }
  }

  return {
    provider: vectorStore.provider,
    healthy,
    latencyMs,
    collections,
  }
}

/**
 * Format a VectorDBStatusResult for terminal output.
 */
export function formatVectorDBStatus(status: VectorDBStatusResult): string {
  const lines: string[] = []

  lines.push(`Vector DB Status`)
  lines.push(`  Provider:  ${status.provider}`)
  lines.push(`  Healthy:   ${status.healthy ? 'yes' : 'NO'}`)
  lines.push(`  Latency:   ${status.latencyMs}ms`)

  if (status.embeddingProvider) {
    lines.push(`  Embedding: ${status.embeddingProvider}`)
  }
  if (status.embeddingDimensions !== undefined) {
    lines.push(`  Dimensions: ${status.embeddingDimensions}`)
  }

  if (status.collections.length > 0) {
    lines.push(`  Collections:`)
    for (const col of status.collections) {
      const countStr = col.count >= 0 ? String(col.count) : 'error'
      lines.push(`    - ${col.name} (${countStr} vectors)`)
    }
  } else {
    lines.push(`  Collections: none`)
  }

  return lines.join('\n')
}
