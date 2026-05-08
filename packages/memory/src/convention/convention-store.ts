/**
 * MemoryService persistence helpers for conventions.
 *
 * Centralises the namespace + scope conventions so the coordinator
 * class stays thin.
 */
import type { MemoryService } from '../memory-service.js'
import type { SemanticStoreAdapter } from '../memory-types.js'
import type { ConventionFilter, DetectedConvention } from './types.js'
import { conventionToRecord, recordToConvention } from './convention-codec.js'

export const CONVENTION_SCOPE_KEY = 'conventions'

export async function storeConvention(
  memoryService: MemoryService,
  namespace: string,
  conv: DetectedConvention,
): Promise<void> {
  await memoryService.put(
    namespace,
    { scope: CONVENTION_SCOPE_KEY },
    conv.id,
    conventionToRecord(conv),
  )
}

export async function tombstoneConvention(
  memoryService: MemoryService,
  namespace: string,
  conventionId: string,
): Promise<void> {
  // MemoryService has no delete — write a tombstone that findExisting filters out.
  await memoryService.put(
    namespace,
    { scope: CONVENTION_SCOPE_KEY },
    conventionId,
    { _deleted: true },
  )
}

export async function findExistingConvention(
  memoryService: MemoryService,
  namespace: string,
  id: string,
): Promise<DetectedConvention | null> {
  const records = await memoryService.get(namespace, { scope: CONVENTION_SCOPE_KEY }, id)
  if (records.length === 0) return null
  const record = records[0]!
  if (record['_deleted']) return null
  return recordToConvention(record)
}

/**
 * Apply category, techStack, and minConfidence filters to a list of conventions.
 */
export function applyConventionFilters(
  conventions: DetectedConvention[],
  filter: ConventionFilter | undefined,
): DetectedConvention[] {
  if (!filter) return conventions
  let result = conventions
  if (filter.category) {
    result = result.filter(c => c.category === filter.category)
  }
  if (filter.techStack) {
    result = result.filter(c => c.techStack === filter.techStack)
  }
  if (filter.minConfidence !== undefined) {
    const min = filter.minConfidence
    result = result.filter(c => c.confidence >= min)
  }
  return result
}

/**
 * Re-rank conventions using a SemanticStore. Non-fatal: returns the input
 * unchanged on any failure.
 */
export async function semanticRerank(
  semanticStore: SemanticStoreAdapter,
  query: string,
  conventions: DetectedConvention[],
): Promise<DetectedConvention[]> {
  if (conventions.length === 0) return conventions
  try {
    const semanticResults = await semanticStore.search('conventions', query, 20)
    const scoreMap = new Map<string, number>()
    for (const sr of semanticResults) {
      scoreMap.set(sr.id, sr.score)
    }
    return [...conventions].sort((a, b) => {
      const scoreA = scoreMap.get(a.id) ?? -1
      const scoreB = scoreMap.get(b.id) ?? -1
      return scoreB - scoreA
    })
  } catch {
    // Non-fatal: semantic search failure should not break getConventions
    return conventions
  }
}

/**
 * Auto-embed conventions into the SemanticStore. Non-fatal: returns void
 * even on failure.
 */
export async function embedConventions(
  semanticStore: SemanticStoreAdapter,
  conventions: DetectedConvention[],
): Promise<void> {
  if (conventions.length === 0) return
  await semanticStore.upsert(
    'conventions',
    conventions.map(c => ({
      id: c.id,
      text: `${c.name}: ${c.description}. Category: ${c.category}. Pattern: ${c.pattern ?? ''}`,
      metadata: {
        category: c.category,
        confidence: c.confidence,
        techStack: c.techStack ?? '',
      },
    })),
  ).catch(() => {
    // Non-fatal: vector indexing failures should not break convention analysis
  })
}
