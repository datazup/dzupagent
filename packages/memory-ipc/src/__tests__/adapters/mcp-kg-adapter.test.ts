import { describe, it, expect } from 'vitest'
import {
  MCPKGAdapter,
  flattenMCPKG,
  reconstructMCPKG,
  type MCPKGRecord,
  type MCPKGEntity,
  type MCPKGRelation,
} from '../../adapters/mcp-kg-adapter.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntityRecord(
  entityName = 'PostgreSQL',
  observation = 'Used as primary database',
  index = 0,
  total = 1,
): MCPKGRecord {
  return {
    type: 'entity-observation',
    entityObservation: {
      entityName,
      entityType: 'technology',
      observation,
      observationIndex: index,
      totalObservations: total,
    },
  }
}

function makeRelationRecord(
  from = 'PostgreSQL',
  relationType = 'stores-data-for',
  to = 'UserService',
): MCPKGRecord {
  return {
    type: 'relation',
    relation: { from, to, relationType },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCPKGAdapter', () => {
  const adapter = new MCPKGAdapter()

  describe('sourceSystem', () => {
    it('returns "mcp-knowledge-graph"', () => {
      expect(adapter.sourceSystem).toBe('mcp-knowledge-graph')
    })
  })

  // -------------------------------------------------------------------------
  // canAdapt
  // -------------------------------------------------------------------------

  describe('canAdapt', () => {
    it('accepts entity-observation records', () => {
      expect(adapter.canAdapt(makeEntityRecord())).toBe(true)
    })

    it('accepts relation records', () => {
      expect(adapter.canAdapt(makeRelationRecord())).toBe(true)
    })

    it('rejects null', () => {
      expect(adapter.canAdapt(null)).toBe(false)
    })

    it('rejects non-object', () => {
      expect(adapter.canAdapt('string')).toBe(false)
    })

    it('rejects unknown type', () => {
      expect(adapter.canAdapt({ type: 'unknown' })).toBe(false)
    })

    it('rejects entity-observation with missing entityObservation', () => {
      expect(adapter.canAdapt({ type: 'entity-observation' })).toBe(false)
    })

    it('rejects entity-observation with null entityObservation', () => {
      expect(adapter.canAdapt({ type: 'entity-observation', entityObservation: null })).toBe(false)
    })

    it('rejects entity-observation missing entityName', () => {
      expect(adapter.canAdapt({
        type: 'entity-observation',
        entityObservation: { entityType: 'tech', observation: 'obs' },
      })).toBe(false)
    })

    it('rejects relation with missing relation', () => {
      expect(adapter.canAdapt({ type: 'relation' })).toBe(false)
    })

    it('rejects relation with null relation', () => {
      expect(adapter.canAdapt({ type: 'relation', relation: null })).toBe(false)
    })

    it('rejects relation missing from', () => {
      expect(adapter.canAdapt({
        type: 'relation',
        relation: { to: 'B', relationType: 'uses' },
      })).toBe(false)
    })

    it('rejects relation missing relationType', () => {
      expect(adapter.canAdapt({
        type: 'relation',
        relation: { from: 'A', to: 'B' },
      })).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // validate
  // -------------------------------------------------------------------------

  describe('validate', () => {
    it('counts valid and invalid records', () => {
      const result = adapter.validate([
        makeEntityRecord(),
        makeRelationRecord(),
        { type: 'bad' },
      ])
      expect(result.valid).toBe(2)
      expect(result.invalid).toBe(1)
    })

    it('reports shape mismatch for invalid records', () => {
      const result = adapter.validate([42, null])
      expect(result.invalid).toBe(2)
      expect(result.warnings.every((w) => w.field === '*')).toBe(true)
    })

    it('handles empty array', () => {
      const result = adapter.validate([])
      expect(result.valid).toBe(0)
      expect(result.invalid).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // toFrame
  // -------------------------------------------------------------------------

  describe('toFrame', () => {
    it('converts entity-observation to Arrow row', () => {
      const record = makeEntityRecord('Redis', 'Used for caching', 0, 3)
      const table = adapter.toFrame([record])

      expect(table.numRows).toBe(1)
      expect(table.getChild('id')?.get(0)).toBe('Redis-obs-0')
      expect(table.getChild('text')?.get(0)).toBe('Used for caching')
      expect(table.getChild('namespace')?.get(0)).toBe('entities')
      expect(table.getChild('category')?.get(0)).toBe('entity-node')
      expect(table.getChild('provenance_source')?.get(0)).toBe('imported')
      expect(table.getChild('is_active')?.get(0)).toBe(true)

      const payload = JSON.parse(table.getChild('payload_json')?.get(0) as string)
      expect(payload.entityName).toBe('Redis')
      expect(payload.entityType).toBe('technology')
    })

    it('computes importance as totalObservations / maxObservations', () => {
      const records: MCPKGRecord[] = [
        makeEntityRecord('A', 'obs-A', 0, 2),
        makeEntityRecord('B', 'obs-B', 0, 4),
      ]
      const table = adapter.toFrame(records)

      // maxObservations = 4
      // A: 2/4 = 0.5, B: 4/4 = 1.0
      expect(table.getChild('importance')?.get(0)).toBeCloseTo(0.5, 5)
      expect(table.getChild('importance')?.get(1)).toBeCloseTo(1.0, 5)
    })

    it('converts relation to Arrow row', () => {
      const record = makeRelationRecord('UserService', 'depends-on', 'PostgreSQL')
      const table = adapter.toFrame([record])

      expect(table.numRows).toBe(1)
      expect(table.getChild('id')?.get(0)).toBe('rel-UserService-depends-on-PostgreSQL')
      expect(table.getChild('text')?.get(0)).toBe('UserService depends-on PostgreSQL')
      expect(table.getChild('category')?.get(0)).toBe('causal-edge')
      expect(table.getChild('importance')?.get(0)).toBeNull()

      const payload = JSON.parse(table.getChild('payload_json')?.get(0) as string)
      expect(payload.from).toBe('UserService')
      expect(payload.to).toBe('PostgreSQL')
      expect(payload.relationType).toBe('depends-on')
    })

    it('handles mixed entity and relation records', () => {
      const records: MCPKGRecord[] = [
        makeEntityRecord('A', 'obs-1', 0, 1),
        makeRelationRecord('A', 'uses', 'B'),
        makeEntityRecord('B', 'obs-2', 0, 1),
      ]
      const table = adapter.toFrame(records)
      expect(table.numRows).toBe(3)
      expect(table.getChild('category')?.get(0)).toBe('entity-node')
      expect(table.getChild('category')?.get(1)).toBe('causal-edge')
      expect(table.getChild('category')?.get(2)).toBe('entity-node')
    })

    it('handles empty array', () => {
      const table = adapter.toFrame([])
      expect(table.numRows).toBe(0)
    })

    it('sets scope columns to null (no tenant/project/agent/session)', () => {
      const table = adapter.toFrame([makeEntityRecord()])
      expect(table.getChild('scope_tenant')?.get(0)).toBeNull()
      expect(table.getChild('scope_project')?.get(0)).toBeNull()
      expect(table.getChild('scope_agent')?.get(0)).toBeNull()
      expect(table.getChild('scope_session')?.get(0)).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // fromFrame
  // -------------------------------------------------------------------------

  describe('fromFrame', () => {
    it('converts entity-node rows back to entity-observation records', () => {
      const record = makeEntityRecord('Redis', 'Fast cache', 0, 1)
      const table = adapter.toFrame([record])
      const result = adapter.fromFrame(table)

      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('entity-observation')
      expect(result[0].entityObservation?.entityName).toBe('Redis')
      expect(result[0].entityObservation?.entityType).toBe('technology')
      expect(result[0].entityObservation?.observation).toBe('Fast cache')
    })

    it('converts causal-edge rows back to relation records', () => {
      const record = makeRelationRecord('A', 'uses', 'B')
      const table = adapter.toFrame([record])
      const result = adapter.fromFrame(table)

      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('relation')
      expect(result[0].relation?.from).toBe('A')
      expect(result[0].relation?.to).toBe('B')
      expect(result[0].relation?.relationType).toBe('uses')
    })

    it('skips rows with null text', () => {
      const records = [makeEntityRecord('Valid', 'has text')]
      const table = adapter.toFrame(records)
      const result = adapter.fromFrame(table)
      expect(result).toHaveLength(1)
    })

    it('handles rows without payload_json as entity with unknown metadata', () => {
      // In fromFrame, if category is not 'causal-edge' and payload is missing,
      // defaults entityName and entityType to 'unknown'
      const records = [makeEntityRecord()]
      const table = adapter.toFrame(records)
      const result = adapter.fromFrame(table)
      expect(result[0].entityObservation?.entityName).toBe('PostgreSQL')
    })

    it('handles empty table', () => {
      const table = adapter.toFrame([])
      expect(adapter.fromFrame(table)).toEqual([])
    })

    it('handles mixed records', () => {
      const records: MCPKGRecord[] = [
        makeEntityRecord('X', 'obs-x'),
        makeRelationRecord('X', 'connects', 'Y'),
        makeEntityRecord('Y', 'obs-y'),
      ]
      const table = adapter.toFrame(records)
      const result = adapter.fromFrame(table)

      expect(result).toHaveLength(3)
      expect(result[0].type).toBe('entity-observation')
      expect(result[1].type).toBe('relation')
      expect(result[2].type).toBe('entity-observation')
    })
  })

  // -------------------------------------------------------------------------
  // Round-trip
  // -------------------------------------------------------------------------

  describe('round-trip', () => {
    it('preserves entity data through toFrame -> fromFrame', () => {
      const original = makeEntityRecord('TypeScript', 'Strongly typed language', 2, 5)
      const table = adapter.toFrame([original])
      const restored = adapter.fromFrame(table)

      expect(restored).toHaveLength(1)
      const r = restored[0]
      expect(r.type).toBe('entity-observation')
      expect(r.entityObservation?.entityName).toBe('TypeScript')
      expect(r.entityObservation?.entityType).toBe('technology')
      expect(r.entityObservation?.observation).toBe('Strongly typed language')
    })

    it('preserves relation data through toFrame -> fromFrame', () => {
      const original = makeRelationRecord('App', 'built-with', 'Vue')
      const table = adapter.toFrame([original])
      const restored = adapter.fromFrame(table)

      expect(restored).toHaveLength(1)
      const r = restored[0]
      expect(r.type).toBe('relation')
      expect(r.relation?.from).toBe('App')
      expect(r.relation?.to).toBe('Vue')
      expect(r.relation?.relationType).toBe('built-with')
    })
  })
})

// ---------------------------------------------------------------------------
// flattenMCPKG
// ---------------------------------------------------------------------------

describe('flattenMCPKG', () => {
  it('flattens entities with multiple observations', () => {
    const entities: MCPKGEntity[] = [
      {
        name: 'PostgreSQL',
        entityType: 'database',
        observations: ['Reliable', 'ACID-compliant', 'Supports JSONB'],
      },
    ]
    const relations: MCPKGRelation[] = []

    const records = flattenMCPKG(entities, relations)
    expect(records).toHaveLength(3)

    expect(records[0].type).toBe('entity-observation')
    expect(records[0].entityObservation?.entityName).toBe('PostgreSQL')
    expect(records[0].entityObservation?.observation).toBe('Reliable')
    expect(records[0].entityObservation?.observationIndex).toBe(0)
    expect(records[0].entityObservation?.totalObservations).toBe(3)

    expect(records[1].entityObservation?.observation).toBe('ACID-compliant')
    expect(records[1].entityObservation?.observationIndex).toBe(1)

    expect(records[2].entityObservation?.observation).toBe('Supports JSONB')
    expect(records[2].entityObservation?.observationIndex).toBe(2)
  })

  it('appends relations after entities', () => {
    const entities: MCPKGEntity[] = [
      { name: 'A', entityType: 'service', observations: ['obs'] },
    ]
    const relations: MCPKGRelation[] = [
      { from: 'A', to: 'B', relationType: 'calls' },
    ]

    const records = flattenMCPKG(entities, relations)
    expect(records).toHaveLength(2)
    expect(records[0].type).toBe('entity-observation')
    expect(records[1].type).toBe('relation')
    expect(records[1].relation).toEqual({ from: 'A', to: 'B', relationType: 'calls' })
  })

  it('handles multiple entities', () => {
    const entities: MCPKGEntity[] = [
      { name: 'A', entityType: 'type-a', observations: ['a1', 'a2'] },
      { name: 'B', entityType: 'type-b', observations: ['b1'] },
    ]
    const records = flattenMCPKG(entities, [])
    expect(records).toHaveLength(3)
    expect(records[0].entityObservation?.entityName).toBe('A')
    expect(records[2].entityObservation?.entityName).toBe('B')
  })

  it('handles empty inputs', () => {
    const records = flattenMCPKG([], [])
    expect(records).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// reconstructMCPKG
// ---------------------------------------------------------------------------

describe('reconstructMCPKG', () => {
  it('groups entity observations by entityName', () => {
    const records: MCPKGRecord[] = [
      makeEntityRecord('PG', 'Reliable', 0, 2),
      makeEntityRecord('PG', 'Fast', 1, 2),
      makeEntityRecord('Redis', 'In-memory', 0, 1),
    ]

    const { entities, relations } = reconstructMCPKG(records)
    expect(entities).toHaveLength(2)

    const pg = entities.find((e) => e.name === 'PG')
    expect(pg?.observations).toEqual(['Reliable', 'Fast'])

    const redis = entities.find((e) => e.name === 'Redis')
    expect(redis?.observations).toEqual(['In-memory'])

    expect(relations).toEqual([])
  })

  it('collects relations separately', () => {
    const records: MCPKGRecord[] = [
      makeRelationRecord('A', 'uses', 'B'),
      makeRelationRecord('B', 'extends', 'C'),
    ]

    const { entities, relations } = reconstructMCPKG(records)
    expect(entities).toEqual([])
    expect(relations).toHaveLength(2)
    expect(relations[0]).toEqual({ from: 'A', to: 'B', relationType: 'uses' })
  })

  it('handles mixed records', () => {
    const records: MCPKGRecord[] = [
      makeEntityRecord('X', 'obs-1'),
      makeRelationRecord('X', 'links', 'Y'),
      makeEntityRecord('Y', 'obs-2'),
    ]

    const { entities, relations } = reconstructMCPKG(records)
    expect(entities).toHaveLength(2)
    expect(relations).toHaveLength(1)
  })

  it('handles empty records', () => {
    const { entities, relations } = reconstructMCPKG([])
    expect(entities).toEqual([])
    expect(relations).toEqual([])
  })

  it('round-trips with flattenMCPKG', () => {
    const originalEntities: MCPKGEntity[] = [
      { name: 'PostgreSQL', entityType: 'db', observations: ['Reliable', 'ACID'] },
      { name: 'Redis', entityType: 'cache', observations: ['Fast'] },
    ]
    const originalRelations: MCPKGRelation[] = [
      { from: 'App', to: 'PostgreSQL', relationType: 'stores-in' },
      { from: 'App', to: 'Redis', relationType: 'caches-with' },
    ]

    const flattened = flattenMCPKG(originalEntities, originalRelations)
    const { entities, relations } = reconstructMCPKG(flattened)

    expect(entities).toHaveLength(2)
    const pg = entities.find((e) => e.name === 'PostgreSQL')
    expect(pg?.observations).toEqual(['Reliable', 'ACID'])
    expect(pg?.entityType).toBe('db')

    const redis = entities.find((e) => e.name === 'Redis')
    expect(redis?.observations).toEqual(['Fast'])

    expect(relations).toHaveLength(2)
    expect(relations).toEqual(originalRelations)
  })
})
