/**
 * Graph-based memory traversal.
 * Follows entity co-references across records to find related memories.
 */

export interface GraphSearchResult {
  key: string
  score: number
  value: Record<string, unknown>
  /** How this result relates to the query */
  relationship: string
}

interface GraphRecord {
  key: string
  value: Record<string, unknown>
}

/**
 * Extract named entities from text.
 * Detects: `backtick-enclosed`, PascalCase identifiers, and "quoted strings".
 */
function extractEntities(text: string): Set<string> {
  const entities = new Set<string>()

  // Backtick-enclosed identifiers: `SomeIdentifier`
  const backtickMatches = text.matchAll(/`([^`]+)`/g)
  for (const m of backtickMatches) {
    if (m[1] !== undefined) entities.add(m[1].toLowerCase())
  }

  // PascalCase words (at least two uppercase letters to avoid common words)
  const pascalMatches = text.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g)
  for (const m of pascalMatches) {
    if (m[1] !== undefined) entities.add(m[1].toLowerCase())
  }

  // Double-quoted strings (3+ chars to avoid noise)
  const quoteMatches = text.matchAll(/"([^"]{3,})"/g)
  for (const m of quoteMatches) {
    if (m[1] !== undefined) entities.add(m[1].toLowerCase())
  }

  return entities
}

function getRecordText(value: Record<string, unknown>): string {
  if (typeof value['text'] === 'string') return value['text']
  if (typeof value['content'] === 'string') return value['content']
  return JSON.stringify(value)
}

/**
 * Graph-based memory traversal using entity co-references.
 * Finds memories related to the query via shared named entities.
 */
export class EntityGraphSearch {
  /**
   * Find memories related to the query via shared entities.
   * 1. Extract entities from query
   * 2. Find records containing those entities (direct matches)
   * 3. Find records that share entities with direct matches (1-hop)
   */
  search(records: GraphRecord[], query: string, limit: number): GraphSearchResult[] {
    const queryEntities = extractEntities(query)
    if (queryEntities.size === 0) return []

    // Build entity index: entity -> set of record keys
    const entityIndex = new Map<string, Set<string>>()
    const recordEntities = new Map<string, Set<string>>()

    for (const rec of records) {
      const text = getRecordText(rec.value)
      const entities = extractEntities(text)
      recordEntities.set(rec.key, entities)
      for (const ent of entities) {
        let bucket = entityIndex.get(ent)
        if (!bucket) {
          bucket = new Set()
          entityIndex.set(ent, bucket)
        }
        bucket.add(rec.key)
      }
    }

    // Direct matches: records sharing entities with query
    const directScores = new Map<string, { score: number; entities: string[] }>()
    for (const qe of queryEntities) {
      const matching = entityIndex.get(qe)
      if (!matching) continue
      for (const key of matching) {
        const entry = directScores.get(key) ?? { score: 0, entities: [] }
        entry.score += 1
        entry.entities.push(qe)
        directScores.set(key, entry)
      }
    }

    // 1-hop: records sharing entities with direct matches
    const hopScores = new Map<string, { score: number; via: string }>()
    for (const [directKey] of directScores) {
      const ents = recordEntities.get(directKey) ?? new Set()
      for (const ent of ents) {
        if (queryEntities.has(ent)) continue // skip query entities
        const neighbors = entityIndex.get(ent)
        if (!neighbors) continue
        for (const neighborKey of neighbors) {
          if (neighborKey === directKey || directScores.has(neighborKey)) continue
          const existing = hopScores.get(neighborKey)
          if (!existing || existing.score < 0.5) {
            hopScores.set(neighborKey, { score: 0.5, via: ent })
          }
        }
      }
    }

    const recordMap = new Map(records.map(r => [r.key, r.value]))
    const results: GraphSearchResult[] = []

    for (const [key, data] of directScores) {
      const value = recordMap.get(key)
      if (!value) continue
      results.push({
        key,
        score: data.score / queryEntities.size,
        value,
        relationship: `shares entities: ${data.entities.join(', ')}`,
      })
    }

    for (const [key, data] of hopScores) {
      const value = recordMap.get(key)
      if (!value) continue
      results.push({
        key,
        score: data.score / queryEntities.size,
        value,
        relationship: `1-hop via entity: ${data.via}`,
      })
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit)
  }
}
