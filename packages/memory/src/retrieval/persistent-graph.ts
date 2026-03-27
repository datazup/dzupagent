/**
 * Persistent entity graph — maintains an inverted index of entities
 * in the store, updated incrementally on writes instead of rebuilding
 * from scratch on every search call.
 *
 * Storage layout:
 *   [...baseNamespace, "__entities"]        → entity name → { memoryKeys, updatedAt }
 *   [...baseNamespace, "__record_entities"] → memory key  → { entities }
 */
import type { BaseStore } from '@langchain/langgraph'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EntityNode {
  /** Entity name (lowercased) */
  name: string
  /** Memory keys that reference this entity */
  memoryKeys: string[]
  /** Number of memories referencing this entity */
  degree: number
}

export interface GraphTraversalResult {
  key: string
  score: number
  value: Record<string, unknown>
  /** How this result was found */
  path: string
  /** Hop distance from query entities */
  hops: number
}

// ---------------------------------------------------------------------------
// Entity extraction (copied from graph-search.ts to avoid coupling)
// ---------------------------------------------------------------------------

function extractEntities(text: string): Set<string> {
  const entities = new Set<string>()

  // Backtick-enclosed identifiers
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    if (m[1] !== undefined) entities.add(m[1].toLowerCase())
  }

  // PascalCase words (2+ uppercase transitions)
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g)) {
    if (m[1] !== undefined) entities.add(m[1].toLowerCase())
  }

  // Double-quoted strings (3+ chars)
  for (const m of text.matchAll(/"([^"]{3,})"/g)) {
    if (m[1] !== undefined) entities.add(m[1].toLowerCase())
  }

  return entities
}

function getRecordText(value: Record<string, unknown>): string {
  if (typeof value['text'] === 'string') return value['text']
  if (typeof value['content'] === 'string') return value['content']
  return JSON.stringify(value)
}

// ---------------------------------------------------------------------------
// PersistentEntityGraph
// ---------------------------------------------------------------------------

export class PersistentEntityGraph {
  constructor(
    private readonly store: BaseStore,
    private readonly baseNamespace: string[],
  ) {}

  /** Namespace for entity → memoryKeys inverted index */
  private get entityNamespace(): string[] {
    return [...this.baseNamespace, '__entities']
  }

  /** Namespace for memoryKey → entities reverse lookup */
  private get recordEntityNamespace(): string[] {
    return [...this.baseNamespace, '__record_entities']
  }

  // -----------------------------------------------------------------------
  // Indexing
  // -----------------------------------------------------------------------

  /**
   * Index a memory record: extract entities from text and update the
   * inverted index. Also handles stale entity references when a record
   * is re-indexed with different entities.
   *
   * Returns the list of entities found.
   */
  async indexRecord(key: string, text: string): Promise<string[]> {
    try {
      const entities = extractEntities(text)
      const entityList = [...entities]

      // Remove stale references first (in case the record was previously indexed)
      await this.removeRecordRefs(key)

      // Store the reverse mapping: memoryKey → entities
      await this.store.put(this.recordEntityNamespace, key, {
        text: key,
        entities: entityList,
        updatedAt: Date.now(),
      })

      // Update each entity's inverted index entry
      for (const entity of entityList) {
        const existing = await this.store.get(this.entityNamespace, entity)
        const existingKeys: string[] =
          existing && Array.isArray((existing.value as Record<string, unknown>)['memoryKeys'])
            ? (existing.value as Record<string, unknown>)['memoryKeys'] as string[]
            : []

        const keySet = new Set(existingKeys)
        keySet.add(key)

        await this.store.put(this.entityNamespace, entity, {
          text: entity,
          memoryKeys: [...keySet],
          updatedAt: Date.now(),
        })
      }

      return entityList
    } catch {
      // Non-fatal — indexing failures must not break the pipeline
      return []
    }
  }

  /**
   * Remove a memory record from the entity index.
   */
  async removeRecord(key: string): Promise<void> {
    try {
      await this.removeRecordRefs(key)
      await this.store.delete(this.recordEntityNamespace, key)
    } catch {
      // Non-fatal
    }
  }

  /**
   * Internal helper: remove a record's references from all its entity entries.
   */
  private async removeRecordRefs(key: string): Promise<void> {
    const reverseEntry = await this.store.get(this.recordEntityNamespace, key)
    if (!reverseEntry) return

    const oldEntities = Array.isArray(
      (reverseEntry.value as Record<string, unknown>)['entities'],
    )
      ? ((reverseEntry.value as Record<string, unknown>)['entities'] as string[])
      : []

    for (const entity of oldEntities) {
      const entityRecord = await this.store.get(this.entityNamespace, entity)
      if (!entityRecord) continue

      const memoryKeys: string[] = Array.isArray(
        (entityRecord.value as Record<string, unknown>)['memoryKeys'],
      )
        ? ((entityRecord.value as Record<string, unknown>)['memoryKeys'] as string[])
        : []

      const filtered = memoryKeys.filter(k => k !== key)

      if (filtered.length === 0) {
        // No more references — delete the entity entry entirely
        await this.store.delete(this.entityNamespace, entity)
      } else {
        await this.store.put(this.entityNamespace, entity, {
          text: entity,
          memoryKeys: filtered,
          updatedAt: Date.now(),
        })
      }
    }

    // Delete the reverse mapping
    await this.store.delete(this.recordEntityNamespace, key)
  }

  /**
   * Re-index all records in the base namespace.
   * Useful for rebuilding the index from scratch.
   */
  async reindexAll(): Promise<{ entitiesIndexed: number; recordsProcessed: number }> {
    try {
      // First, clear all existing entity and reverse entries
      const existingEntities = await this.store.search(this.entityNamespace)
      for (const entry of existingEntities) {
        await this.store.delete(this.entityNamespace, entry.key)
      }
      const existingReverse = await this.store.search(this.recordEntityNamespace)
      for (const entry of existingReverse) {
        await this.store.delete(this.recordEntityNamespace, entry.key)
      }

      // Fetch all records from the base namespace
      const records = await this.store.search(this.baseNamespace)
      const allEntities = new Set<string>()
      let recordsProcessed = 0

      for (const record of records) {
        const value = record.value as Record<string, unknown>
        const text = getRecordText(value)
        const entities = await this.indexRecord(record.key, text)
        for (const e of entities) allEntities.add(e)
        recordsProcessed++
      }

      return { entitiesIndexed: allEntities.size, recordsProcessed }
    } catch {
      return { entitiesIndexed: 0, recordsProcessed: 0 }
    }
  }

  // -----------------------------------------------------------------------
  // Search
  // -----------------------------------------------------------------------

  /**
   * Search the graph starting from query-relevant entities.
   *
   * 1. Extract entities from query
   * 2. Look up entity index to find direct matches (hop 0)
   * 3. For each direct match, find co-occurring entities (hop 1)
   * 4. Continue expanding up to maxHops
   * 5. Score by hop distance and entity overlap
   */
  async search(
    query: string,
    maxHops: number,
    limit: number,
  ): Promise<GraphTraversalResult[]> {
    try {
      const queryEntities = extractEntities(query)
      if (queryEntities.size === 0) return []

      // Collect scored memory keys: key → { score, path, hops }
      const scored = new Map<string, { score: number; path: string; hops: number }>()

      // Hop 0: direct entity matches
      const directMemoryKeys = new Set<string>()
      for (const entity of queryEntities) {
        const record = await this.store.get(this.entityNamespace, entity)
        if (!record) continue

        const memoryKeys: string[] = Array.isArray(
          (record.value as Record<string, unknown>)['memoryKeys'],
        )
          ? ((record.value as Record<string, unknown>)['memoryKeys'] as string[])
          : []

        for (const mk of memoryKeys) {
          directMemoryKeys.add(mk)
          const existing = scored.get(mk)
          const newScore = 1.0
          if (!existing || existing.score < newScore) {
            scored.set(mk, {
              score: newScore,
              path: `entity: ${entity}`,
              hops: 0,
            })
          }
        }
      }

      // Multi-hop expansion
      let currentFrontier = directMemoryKeys
      const visited = new Set(directMemoryKeys)

      for (let hop = 1; hop <= maxHops; hop++) {
        const nextFrontier = new Set<string>()
        const hopScore = Math.pow(0.5, hop)

        for (const mk of currentFrontier) {
          // Load the record to get its text and extract entities
          const reverseEntry = await this.store.get(this.recordEntityNamespace, mk)
          if (!reverseEntry) continue

          const neighborEntities: string[] = Array.isArray(
            (reverseEntry.value as Record<string, unknown>)['entities'],
          )
            ? ((reverseEntry.value as Record<string, unknown>)['entities'] as string[])
            : []

          for (const neighborEntity of neighborEntities) {
            if (queryEntities.has(neighborEntity)) continue

            const entityRecord = await this.store.get(this.entityNamespace, neighborEntity)
            if (!entityRecord) continue

            const neighborKeys: string[] = Array.isArray(
              (entityRecord.value as Record<string, unknown>)['memoryKeys'],
            )
              ? ((entityRecord.value as Record<string, unknown>)['memoryKeys'] as string[])
              : []

            for (const nk of neighborKeys) {
              if (visited.has(nk)) continue
              visited.add(nk)
              nextFrontier.add(nk)

              const existing = scored.get(nk)
              if (!existing || existing.score < hopScore) {
                scored.set(nk, {
                  score: hopScore,
                  path: `${hop}-hop via: ${neighborEntity}`,
                  hops: hop,
                })
              }
            }
          }
        }

        currentFrontier = nextFrontier
        if (nextFrontier.size === 0) break
      }

      // Sort by score, take top N, then load actual values
      const sorted = [...scored.entries()]
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, limit)

      const results: GraphTraversalResult[] = []
      for (const [key, meta] of sorted) {
        const record = await this.store.get(this.baseNamespace, key)
        if (!record) continue
        results.push({
          key,
          score: meta.score,
          value: record.value as Record<string, unknown>,
          path: meta.path,
          hops: meta.hops,
        })
      }

      return results
    } catch {
      return []
    }
  }

  // -----------------------------------------------------------------------
  // Inspection
  // -----------------------------------------------------------------------

  /**
   * Get all entities and their degrees (for stats/debugging).
   */
  async getEntities(limit?: number): Promise<EntityNode[]> {
    try {
      const entries = await this.store.search(this.entityNamespace)
      const nodes: EntityNode[] = entries.map(entry => {
        const value = entry.value as Record<string, unknown>
        const memoryKeys: string[] = Array.isArray(value['memoryKeys'])
          ? (value['memoryKeys'] as string[])
          : []
        return {
          name: entry.key,
          memoryKeys,
          degree: memoryKeys.length,
        }
      })

      // Sort by degree descending
      nodes.sort((a, b) => b.degree - a.degree)
      return limit ? nodes.slice(0, limit) : nodes
    } catch {
      return []
    }
  }

  /**
   * Get entities related to a given entity (co-occurring in memories).
   */
  async getRelatedEntities(entity: string): Promise<EntityNode[]> {
    try {
      const lowerEntity = entity.toLowerCase()
      const entityRecord = await this.store.get(this.entityNamespace, lowerEntity)
      if (!entityRecord) return []

      const memoryKeys: string[] = Array.isArray(
        (entityRecord.value as Record<string, unknown>)['memoryKeys'],
      )
        ? ((entityRecord.value as Record<string, unknown>)['memoryKeys'] as string[])
        : []

      // Collect all co-occurring entities
      const coEntities = new Map<string, Set<string>>()
      for (const mk of memoryKeys) {
        const reverseEntry = await this.store.get(this.recordEntityNamespace, mk)
        if (!reverseEntry) continue

        const entities: string[] = Array.isArray(
          (reverseEntry.value as Record<string, unknown>)['entities'],
        )
          ? ((reverseEntry.value as Record<string, unknown>)['entities'] as string[])
          : []

        for (const e of entities) {
          if (e === lowerEntity) continue
          if (!coEntities.has(e)) coEntities.set(e, new Set())
          coEntities.get(e)!.add(mk)
        }
      }

      // Build EntityNode results from co-occurring entities
      const results: EntityNode[] = []
      for (const [name, sharedKeys] of coEntities) {
        // Load full entity record to get all memory keys
        const rec = await this.store.get(this.entityNamespace, name)
        if (!rec) {
          results.push({ name, memoryKeys: [...sharedKeys], degree: sharedKeys.size })
          continue
        }
        const allKeys: string[] = Array.isArray(
          (rec.value as Record<string, unknown>)['memoryKeys'],
        )
          ? ((rec.value as Record<string, unknown>)['memoryKeys'] as string[])
          : []
        results.push({ name, memoryKeys: allKeys, degree: allKeys.length })
      }

      results.sort((a, b) => b.degree - a.degree)
      return results
    } catch {
      return []
    }
  }
}
