/**
 * Arrow schema and builder for entity graph analytics frames.
 *
 * Captures entity-level graph metrics (PageRank, hub scores, community IDs)
 * alongside memory key associations for graph-based retrieval analytics.
 */

import {
  Schema,
  Field,
  Utf8,
  Float64,
  Int32,
  Int64,
  Dictionary,
  type Table,
  tableFromArrays,
} from 'apache-arrow'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Arrow schema for entity graph frames. */
export const ENTITY_GRAPH_SCHEMA = new Schema([
  new Field('entity_name', new Utf8(), false),
  new Field('entity_type', new Dictionary(new Utf8(), new Int32()), true),
  new Field('memory_key_count', new Int32(), false),
  new Field('memory_keys_json', new Utf8(), true),
  new Field('pagerank_score', new Float64(), true),
  new Field('hub_score', new Float64(), true),
  new Field('community_id', new Int32(), true),
  new Field('updated_at', new Int64(), false),
])

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

/** A single entity graph entry. */
export interface EntityGraphEntry {
  name: string
  type?: string
  memoryKeys: string[]
  pagerankScore?: number
  hubScore?: number
  communityId?: number
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Builds Arrow tables from entity graph data.
 *
 * Each entity becomes one row with its associated memory keys stored
 * as a JSON array and graph metrics in dedicated columns.
 */
export class EntityGraphFrameBuilder {
  /**
   * Build a Table from an array of entity graph entries.
   */
  static fromEntities(
    entities: ReadonlyArray<EntityGraphEntry>,
  ): Table {
    const now = BigInt(Date.now())

    const entity_name: string[] = []
    const entity_type: (string | null)[] = []
    const memory_key_count: number[] = []
    const memory_keys_json: (string | null)[] = []
    const pagerank_score: (number | null)[] = []
    const hub_score: (number | null)[] = []
    const community_id: (number | null)[] = []
    const updated_at: bigint[] = []

    for (const e of entities) {
      entity_name.push(e.name)
      entity_type.push(e.type ?? null)
      memory_key_count.push(e.memoryKeys.length)
      memory_keys_json.push(
        e.memoryKeys.length > 0 ? JSON.stringify(e.memoryKeys) : null,
      )
      pagerank_score.push(e.pagerankScore ?? null)
      hub_score.push(e.hubScore ?? null)
      community_id.push(e.communityId ?? null)
      updated_at.push(now)
    }

    return tableFromArrays({
      entity_name,
      entity_type,
      memory_key_count,
      memory_keys_json,
      pagerank_score,
      hub_score,
      community_id,
      updated_at,
    })
  }
}
