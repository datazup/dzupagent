/**
 * MCP Knowledge Graph entity/relation <-> MemoryFrame bidirectional adapter.
 *
 * Converts MCP Knowledge Graph entities (with per-observation granularity)
 * and relations to and from Arrow Tables conforming to the MemoryFrame schema.
 *
 * Entity observations map to category='entity-node', relations to category='causal-edge'.
 */

import type { Table } from 'apache-arrow'
import type { MemoryFrameAdapter, AdapterValidationResult } from './adapter-interface.js'
import { createEmptyColumns, buildTable, getString } from './frame-columns.js'

/**
 * Flattened entity observation — one row per observation about an entity.
 */
export interface MCPKGEntityObservation {
  entityName: string
  entityType: string
  observation: string
  observationIndex: number
  totalObservations: number
}

/**
 * MCP Knowledge Graph relation triple.
 */
export interface MCPKGRelation {
  from: string
  to: string
  relationType: string
}

/**
 * Discriminated union for MCP KG records — either an entity observation or a relation.
 */
export interface MCPKGRecord {
  type: 'entity-observation' | 'relation'
  entityObservation?: MCPKGEntityObservation
  relation?: MCPKGRelation
}

/**
 * MCP Knowledge Graph entity in its original nested form (before flattening).
 */
export interface MCPKGEntity {
  name: string
  entityType: string
  observations: string[]
}

export class MCPKGAdapter implements MemoryFrameAdapter<MCPKGRecord> {
  readonly sourceSystem = 'mcp-knowledge-graph'

  readonly fieldMapping: Record<string, string> = {
    id: 'entityName + "-obs-" + observationIndex',
    key: 'entityName + "-obs-" + observationIndex',
    text: 'observation | "${from} ${relationType} ${to}"',
    namespace: '"entities" (static)',
    category: '"entity-node" | "causal-edge"',
    payload_json: '{ entityName, entityType } | { from, to, relationType }',
  }

  canAdapt(record: unknown): record is MCPKGRecord {
    if (record === null || typeof record !== 'object') return false
    const r = record as Record<string, unknown>

    if (r['type'] === 'entity-observation') {
      const eo = r['entityObservation']
      if (eo === null || eo === undefined || typeof eo !== 'object') return false
      const e = eo as Record<string, unknown>
      return (
        typeof e['entityName'] === 'string' &&
        typeof e['entityType'] === 'string' &&
        typeof e['observation'] === 'string'
      )
    }

    if (r['type'] === 'relation') {
      const rel = r['relation']
      if (rel === null || rel === undefined || typeof rel !== 'object') return false
      const rr = rel as Record<string, unknown>
      return (
        typeof rr['from'] === 'string' &&
        typeof rr['to'] === 'string' &&
        typeof rr['relationType'] === 'string'
      )
    }

    return false
  }

  validate(records: unknown[]): AdapterValidationResult {
    let valid = 0
    let invalid = 0
    const warnings: AdapterValidationResult['warnings'] = []

    for (let i = 0; i < records.length; i++) {
      if (this.canAdapt(records[i])) {
        valid++
      } else {
        invalid++
        warnings.push({
          index: i,
          field: '*',
          message: 'Does not match MCPKGRecord shape (entity-observation or relation)',
        })
      }
    }

    return { valid, invalid, warnings }
  }

  toFrame(records: MCPKGRecord[]): Table {
    const now = Date.now()
    const cols = createEmptyColumns()

    // Find max observations across all entities for importance heuristic
    let maxObservations = 1
    for (const rec of records) {
      if (rec.type === 'entity-observation' && rec.entityObservation) {
        if (rec.entityObservation.totalObservations > maxObservations) {
          maxObservations = rec.entityObservation.totalObservations
        }
      }
    }

    for (const rec of records) {
      if (rec.type === 'entity-observation' && rec.entityObservation) {
        const eo = rec.entityObservation
        const id = `${eo.entityName}-obs-${String(eo.observationIndex)}`

        cols.id.push(id)
        cols.namespace.push('entities')
        cols.key.push(id)
        cols.scope_tenant.push(null)
        cols.scope_project.push(null)
        cols.scope_agent.push(null)
        cols.scope_session.push(null)
        cols.text.push(eo.observation)
        cols.payload_json.push(
          JSON.stringify({
            entityName: eo.entityName,
            entityType: eo.entityType,
          }),
        )
        cols.system_created_at.push(BigInt(now))
        cols.system_expired_at.push(null)
        cols.valid_from.push(BigInt(now))
        cols.valid_until.push(null)
        cols.decay_strength.push(null)
        cols.decay_half_life_ms.push(null)
        cols.decay_last_accessed_at.push(null)
        cols.decay_access_count.push(null)
        cols.agent_id.push(null)
        cols.category.push('entity-node')
        cols.importance.push(eo.totalObservations / maxObservations)
        cols.provenance_source.push('imported')
        cols.is_active.push(true)
      } else if (rec.type === 'relation' && rec.relation) {
        const rel = rec.relation
        const id = `rel-${rel.from}-${rel.relationType}-${rel.to}`

        cols.id.push(id)
        cols.namespace.push('entities')
        cols.key.push(id)
        cols.scope_tenant.push(null)
        cols.scope_project.push(null)
        cols.scope_agent.push(null)
        cols.scope_session.push(null)
        cols.text.push(`${rel.from} ${rel.relationType} ${rel.to}`)
        cols.payload_json.push(
          JSON.stringify({
            from: rel.from,
            to: rel.to,
            relationType: rel.relationType,
          }),
        )
        cols.system_created_at.push(BigInt(now))
        cols.system_expired_at.push(null)
        cols.valid_from.push(BigInt(now))
        cols.valid_until.push(null)
        cols.decay_strength.push(null)
        cols.decay_half_life_ms.push(null)
        cols.decay_last_accessed_at.push(null)
        cols.decay_access_count.push(null)
        cols.agent_id.push(null)
        cols.category.push('causal-edge')
        cols.importance.push(null)
        cols.provenance_source.push('imported')
        cols.is_active.push(true)
      }
    }

    return buildTable(cols)
  }

  fromFrame(table: Table): MCPKGRecord[] {
    const results: MCPKGRecord[] = []
    const numRows = table.numRows

    for (let i = 0; i < numRows; i++) {
      const category = getString(table, 'category', i)
      const text = getString(table, 'text', i)
      const payload = getString(table, 'payload_json', i)

      if (!text) continue

      if (category === 'causal-edge' && payload) {
        try {
          const parsed = JSON.parse(payload) as Record<string, unknown>
          if (
            typeof parsed['from'] === 'string' &&
            typeof parsed['to'] === 'string' &&
            typeof parsed['relationType'] === 'string'
          ) {
            results.push({
              type: 'relation',
              relation: {
                from: parsed['from'],
                to: parsed['to'],
                relationType: parsed['relationType'],
              },
            })
          }
        } catch {
          // Non-fatal: skip malformed payload
        }
      } else {
        // Treat as entity observation
        let entityName = 'unknown'
        let entityType = 'unknown'

        if (payload) {
          try {
            const parsed = JSON.parse(payload) as Record<string, unknown>
            if (typeof parsed['entityName'] === 'string') entityName = parsed['entityName']
            if (typeof parsed['entityType'] === 'string') entityType = parsed['entityType']
          } catch {
            // Non-fatal: skip malformed payload
          }
        }

        results.push({
          type: 'entity-observation',
          entityObservation: {
            entityName,
            entityType,
            observation: text,
            observationIndex: 0,
            totalObservations: 1,
          },
        })
      }
    }

    return results
  }
}

/**
 * Flatten MCP KG entities into MCPKGRecord[] for the adapter.
 *
 * Each entity with N observations becomes N MCPKGRecord entries.
 * This enables per-observation granularity in the MemoryFrame.
 *
 * @param entities   MCP Knowledge Graph entities
 * @param relations  MCP Knowledge Graph relations
 * @returns          Flattened records suitable for MCPKGAdapter.toFrame()
 */
export function flattenMCPKG(
  entities: MCPKGEntity[],
  relations: MCPKGRelation[],
): MCPKGRecord[] {
  const records: MCPKGRecord[] = []

  for (const entity of entities) {
    for (let i = 0; i < entity.observations.length; i++) {
      records.push({
        type: 'entity-observation',
        entityObservation: {
          entityName: entity.name,
          entityType: entity.entityType,
          observation: entity.observations[i]!,
          observationIndex: i,
          totalObservations: entity.observations.length,
        },
      })
    }
  }

  for (const relation of relations) {
    records.push({ type: 'relation', relation })
  }

  return records
}

/**
 * Reconstruct MCP KG entities from MCPKGRecord[] (reverse of flatten).
 *
 * Groups entity observations by entityName and reassembles the observations array.
 * Relations are returned as-is.
 *
 * @param records  Flattened MCPKGRecord array (from adapter.fromFrame or flattenMCPKG)
 * @returns        Reconstructed entities and relations
 */
export function reconstructMCPKG(
  records: MCPKGRecord[],
): {
  entities: MCPKGEntity[]
  relations: MCPKGRelation[]
} {
  const entityMap = new Map<string, { entityType: string; observations: string[] }>()
  const relations: MCPKGRelation[] = []

  for (const record of records) {
    if (record.type === 'entity-observation' && record.entityObservation) {
      const eo = record.entityObservation
      const existing = entityMap.get(eo.entityName)
      if (existing) {
        existing.observations.push(eo.observation)
      } else {
        entityMap.set(eo.entityName, {
          entityType: eo.entityType,
          observations: [eo.observation],
        })
      }
    } else if (record.type === 'relation' && record.relation) {
      relations.push(record.relation)
    }
  }

  const entities = Array.from(entityMap.entries()).map(([name, data]) => ({
    name,
    entityType: data.entityType,
    observations: data.observations,
  }))

  return { entities, relations }
}
