/**
 * Search-path helpers for {@link MemoryService}.
 *
 * Decay-aware re-ranking and Reciprocal Rank Fusion (RRF) of keyword
 * + vector results. Pure functions; the coordinator threads in store
 * handles and capabilities.
 */
import type { BaseStore } from '@langchain/langgraph'
import type {
  NamespaceConfig,
  SemanticMetadataFilter,
  SemanticStoreAdapter,
} from './memory-types.js'
import { scoreWithDecay } from './decay-engine.js'
import type { DecayMetadata } from './decay-engine.js'
import type { MemoryStoreCapabilities } from './store-capabilities.js'
import type { ReferenceTracker } from './provenance/reference-tracker.js'
import { deriveMemoryEntryId } from './provenance/reference-tracker.js'
import {
  VECTOR_KEY_META_KEY,
  VECTOR_NAMESPACE_META_KEY,
  buildNamespaceTuple,
  buildVectorCollectionName,
} from './memory-service-store.js'
import type { ReadContext } from './memory-service-types.js'

/**
 * Build the metadata filter that binds the vector channel to exactly the
 * scope the keyword channel is reading.
 *
 * A vector collection is per-namespace and therefore holds every tenant's
 * documents. Searching it unfiltered fuses foreign-tenant text into results
 * that go straight into the model prompt, defeating the tuple-level isolation
 * the keyword channel has. The filter dimensions are the namespace's declared
 * `scopeKeys` — the same dimensions `buildNamespaceTuple` uses — so the two
 * channels can never drift apart.
 */
export function buildVectorScopeFilter(
  ns: NamespaceConfig,
  scope: Record<string, string>,
): SemanticMetadataFilter {
  const clauses: SemanticMetadataFilter[] = [
    { field: VECTOR_NAMESPACE_META_KEY, op: 'eq', value: ns.name },
  ]
  for (const k of ns.scopeKeys) {
    const val = scope[k]
    if (!val) {
      throw new Error(`Missing scope key "${k}" for namespace "${ns.name}"`)
    }
    clauses.push({ field: k, op: 'eq', value: val })
  }
  return clauses.length === 1 ? clauses[0]! : { and: clauses }
}

/**
 * Reconstruct a record value from a vector-only hit, dropping the internal
 * indexing markers so they never reach `formatForPrompt`.
 */
function valueFromVectorHit(
  text: string,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const rest: Record<string, unknown> = {}
  // `metadata` is required by the interface but adapters do omit it. Reading
  // it unguarded threw inside the fusion loop, and the surrounding catch
  // turned that into a silent keyword-only fallback — the whole vector
  // channel lost to one missing field.
  for (const [k, v] of Object.entries(metadata ?? {})) {
    if (k === VECTOR_NAMESPACE_META_KEY || k === VECTOR_KEY_META_KEY) continue
    rest[k] = v
  }
  return { text, ...rest }
}

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
 * Non-fatal: returns `[]` on error. This conflates "no matches" with "the
 * store is unreachable"; callers that make a decision from the result count
 * should use {@link searchMemoryWithStatus} instead.
 */
export async function searchMemory(
  ns: NamespaceConfig,
  scope: Record<string, string>,
  query: string,
  limit: number,
  readContext: ReadContext | undefined,
  deps: SearchDeps,
): Promise<Record<string, unknown>[]> {
  const { results } = await searchMemoryWithStatus(
    ns,
    scope,
    query,
    limit,
    readContext,
    deps,
  )
  return results
}

/**
 * As {@link searchMemory}, but reports whether the store could be read.
 *
 * An empty `results` with `searchFailed: true` means "unknown", not "none".
 * Reporting a count from a failed read tells an operator the agent has learned
 * nothing at exactly the moment its memory is unreachable.
 */
export async function searchMemoryWithStatus(
  ns: NamespaceConfig,
  scope: Record<string, string>,
  query: string,
  limit: number,
  readContext: ReadContext | undefined,
  deps: SearchDeps,
): Promise<{ results: Record<string, unknown>[]; searchFailed: boolean }> {
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
        ns,
        scope,
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
    return { results: [], searchFailed: true }
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

  return { results: finalResults, searchFailed: false }
}

/**
 * Fuse keyword search results with vector search results using
 * Reciprocal Rank Fusion (RRF): score = sum(1 / (k + rank)) per result.
 *
 * The vector channel is scope-filtered to `ns`/`scope` — the same binding the
 * keyword channel has — so a vector-only hit can never originate from another
 * tenant or another namespace.
 */
export async function fuseWithVector(
  ns: NamespaceConfig,
  scope: Record<string, string>,
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
    const collectionName = buildVectorCollectionName(ns)
    const vectorResults = await semanticStore.search(
      collectionName,
      query,
      limit,
      buildVectorScopeFilter(ns, scope),
    )

    for (let rank = 0; rank < vectorResults.length; rank++) {
      const vr = vectorResults[rank]!
      const rrfScore = 1 / (RRF_K + rank)
      // Doc ids are scope-qualified, so fuse on the original store key that
      // the write path stamped into metadata. Falling back to the doc id
      // keeps third-party adapters that do not round-trip metadata working
      // (they merely lose de-duplication, not correctness).
      const metaKey = vr.metadata?.[VECTOR_KEY_META_KEY]
      const fusionKey = typeof metaKey === 'string' ? metaKey : vr.id
      const existing = fused.get(fusionKey)
      if (existing) {
        existing.rrfScore += rrfScore
      } else {
        // Vector-only result: reconstruct value from metadata
        fused.set(fusionKey, {
          value: valueFromVectorHit(vr.text, vr.metadata),
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
