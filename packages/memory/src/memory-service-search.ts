/**
 * Search-path helpers for {@link MemoryService}.
 *
 * Decay-aware re-ranking and Reciprocal Rank Fusion (RRF) of keyword
 * + vector results. Pure functions; the coordinator threads in store
 * handles and capabilities.
 */
import type { BaseStore } from '@langchain/langgraph'
import type { NamespaceConfig, SemanticStoreAdapter } from './memory-types.js'
import { scoreWithDecay } from './decay-engine.js'
import type { DecayMetadata } from './decay-engine.js'
import type { MemoryStoreCapabilities } from './store-capabilities.js'
import type { ReferenceTracker } from './provenance/reference-tracker.js'
import { deriveMemoryEntryId } from './provenance/reference-tracker.js'
import { buildNamespaceTuple } from './memory-service-store.js'
import type { ReadContext } from './memory-service-types.js'

/**
 * Extract DecayMetadata from a record value when all required fields are
 * present. Returns null if the record does not carry decay metadata.
 */
export function extractDecayMeta(
  value: Record<string, unknown>,
): DecayMetadata | null {
  const decay = value['_decay']
  if (
    decay != null &&
    typeof decay === 'object' &&
    typeof (decay as Record<string, unknown>)['strength'] === 'number' &&
    typeof (decay as Record<string, unknown>)['lastAccessedAt'] === 'number' &&
    typeof (decay as Record<string, unknown>)['halfLifeMs'] === 'number' &&
    typeof (decay as Record<string, unknown>)['accessCount'] === 'number' &&
    typeof (decay as Record<string, unknown>)['createdAt'] === 'number'
  ) {
    return decay as DecayMetadata
  }
  return null
}

interface ScoredKeyword {
  value: Record<string, unknown>
  finalScore: number
  key: string
}

interface SearchDeps {
  store: BaseStore
  semanticStore: SemanticStoreAdapter | undefined
  capabilities: MemoryStoreCapabilities
  referenceTracker: ReferenceTracker | undefined
}

/**
 * Run a semantic search within a searchable namespace, applying decay
 * re-ranking and (when configured) RRF fusion with the SemanticStore.
 *
 * Non-fatal: returns `[]` on error.
 */
export async function searchMemory(
  ns: NamespaceConfig,
  scope: Record<string, string>,
  query: string,
  limit: number,
  readContext: ReadContext | undefined,
  deps: SearchDeps,
): Promise<Record<string, unknown>[]> {
  const tuple = buildNamespaceTuple(ns, scope)
  let finalResults: Record<string, unknown>[]
  try {
    // Fetch extra results so decay re-ranking can still fill the limit
    const fetchLimit = Math.min(limit * 2, limit + 20)
    const results = await deps.store.search(
      tuple,
      deps.capabilities.supportsPagination
        ? { query, limit: fetchLimit }
        : { query },
    )

    const now = Date.now()
    const scored: ScoredKeyword[] = results.map((r, idx) => {
      const value = r.value as Record<string, unknown>
      const decayMeta = extractDecayMeta(value)
      // Use inverse rank as a proxy relevance score (1.0 for first result, decreasing)
      const relevance = 1 / (idx + 1)
      const finalScore = decayMeta
        ? scoreWithDecay(relevance, decayMeta, now)
        : relevance
      return { value, finalScore, key: r.key }
    })

    if (deps.semanticStore) {
      finalResults = await fuseWithVector(
        ns.name,
        query,
        scored,
        limit,
        deps.semanticStore,
      )
    } else {
      // Re-sort by decay-weighted score (descending) and trim to requested limit
      scored.sort((a, b) => b.finalScore - a.finalScore)
      finalResults = scored.slice(0, limit).map(s => s.value)
    }
  } catch {
    return []
  }

  // Fire-and-forget reference tracking (never blocks the search path)
  if (readContext && deps.referenceTracker && finalResults.length > 0) {
    const tracker = deps.referenceTracker
    const { runId } = readContext
    void Promise.all(
      finalResults.map((record, rank) => {
        const entryId = deriveMemoryEntryId(record, rank)
        return tracker.trackReference(runId, entryId, {
          namespace: ns.name,
          query,
          rank,
        })
      }),
    ).catch(() => { /* swallow tracker errors — non-fatal */ })
  }

  return finalResults
}

/**
 * Fuse keyword search results with vector search results using
 * Reciprocal Rank Fusion (RRF): score = sum(1 / (k + rank)) per result.
 */
export async function fuseWithVector(
  namespace: string,
  query: string,
  keywordScored: ScoredKeyword[],
  limit: number,
  semanticStore: SemanticStoreAdapter,
): Promise<Record<string, unknown>[]> {
  const RRF_K = 60

  // Sort keyword results by finalScore descending for rank assignment
  const sortedKeyword = [...keywordScored].sort((a, b) => b.finalScore - a.finalScore)

  // Build RRF accumulator keyed by record key
  const fused = new Map<string, { value: Record<string, unknown>; rrfScore: number }>()

  for (let rank = 0; rank < sortedKeyword.length; rank++) {
    const item = sortedKeyword[rank]!
    const rrfScore = 1 / (RRF_K + rank)
    fused.set(item.key, { value: item.value, rrfScore })
  }

  // Run vector search (non-fatal — fall back to keyword-only on error)
  try {
    const collectionName = `memory_${namespace}`
    const vectorResults = await semanticStore.search(collectionName, query, limit)

    for (let rank = 0; rank < vectorResults.length; rank++) {
      const vr = vectorResults[rank]!
      const rrfScore = 1 / (RRF_K + rank)
      const existing = fused.get(vr.id)
      if (existing) {
        existing.rrfScore += rrfScore
      } else {
        // Vector-only result: reconstruct value from metadata
        fused.set(vr.id, {
          value: { text: vr.text, ...vr.metadata },
          rrfScore,
        })
      }
    }
  } catch {
    // Vector search failed — fall back to keyword-only results
  }

  return [...fused.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, limit)
    .map(f => f.value)
}
