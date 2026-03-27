import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ProvenanceWriter,
  createProvenance,
  extractProvenance,
  createContentHash,
} from '../provenance-writer.js'
import type { MemoryProvenance } from '../types.js'
import type { MemoryService } from '../../memory-service.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PutCall {
  ns: string
  scope: Record<string, string>
  key: string
  value: Record<string, unknown>
}

/** In-memory record store backing the mock MemoryService */
type RecordStore = Map<string, Map<string, Record<string, unknown>>>

function createMockMemoryService(): {
  service: MemoryService
  putCalls: PutCall[]
  records: RecordStore
} {
  const putCalls: PutCall[] = []
  const records: RecordStore = new Map()

  const service = {
    put: vi.fn().mockImplementation(
      (ns: string, scope: Record<string, string>, key: string, value: Record<string, unknown>) => {
        putCalls.push({ ns, scope, key, value })
        // Store for later retrieval
        const nsKey = `${ns}:${JSON.stringify(scope)}`
        if (!records.has(nsKey)) records.set(nsKey, new Map())
        records.get(nsKey)!.set(key, value)
        return Promise.resolve()
      },
    ),
    get: vi.fn().mockImplementation(
      (ns: string, scope: Record<string, string>, key?: string) => {
        const nsKey = `${ns}:${JSON.stringify(scope)}`
        const nsRecords = records.get(nsKey)
        if (!nsRecords) return Promise.resolve([])
        if (key) {
          const val = nsRecords.get(key)
          return Promise.resolve(val ? [val] : [])
        }
        return Promise.resolve(Array.from(nsRecords.values()))
      },
    ),
    search: vi.fn().mockResolvedValue([]),
    formatForPrompt: vi.fn().mockReturnValue(''),
  } as unknown as MemoryService

  return { service, putCalls, records }
}

const SCOPE = { tenantId: 't1', projectId: 'p1' }
const AGENT_URI = 'forge://acme/planner'
const AGENT_URI_2 = 'forge://acme/executor'

// ---------------------------------------------------------------------------
// createContentHash
// ---------------------------------------------------------------------------

describe('createContentHash', () => {
  it('produces a deterministic hash for the same content', () => {
    const content = { text: 'hello', count: 42 }
    const hash1 = createContentHash(content)
    const hash2 = createContentHash(content)
    expect(hash1).toBe(hash2)
    expect(hash1).toHaveLength(64) // SHA-256 hex
  })

  it('uses sorted keys — different key order produces the same hash', () => {
    const a = { z: 1, a: 2, m: 3 }
    const b = { a: 2, m: 3, z: 1 }
    expect(createContentHash(a)).toBe(createContentHash(b))
  })

  it('produces different hashes for different content', () => {
    expect(createContentHash({ a: 1 })).not.toBe(createContentHash({ a: 2 }))
  })

  it('handles nested objects with sorted keys', () => {
    const a = { outer: { z: 1, a: 2 } }
    const b = { outer: { a: 2, z: 1 } }
    expect(createContentHash(a)).toBe(createContentHash(b))
  })

  it('handles arrays (order-sensitive)', () => {
    expect(createContentHash([1, 2, 3])).not.toBe(createContentHash([3, 2, 1]))
  })
})

// ---------------------------------------------------------------------------
// createProvenance
// ---------------------------------------------------------------------------

describe('createProvenance', () => {
  it('generates valid provenance with all fields', () => {
    const content = { text: 'decision made' }
    const prov = createProvenance({ agentUri: AGENT_URI }, content)

    expect(prov.createdBy).toBe(AGENT_URI)
    expect(prov.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(prov.source).toBe('direct')
    expect(prov.confidence).toBe(1.0)
    expect(prov.contentHash).toBe(createContentHash(content))
    expect(prov.lineage).toEqual([AGENT_URI])
    expect(prov.derivedFrom).toBeUndefined()
  })

  it('uses provided source and confidence', () => {
    const prov = createProvenance(
      { agentUri: AGENT_URI, source: 'derived', confidence: 0.8, derivedFrom: ['key-a'] },
      { text: 'derived content' },
    )

    expect(prov.source).toBe('derived')
    expect(prov.confidence).toBe(0.8)
    expect(prov.derivedFrom).toEqual(['key-a'])
  })

  it('clamps confidence to [0, 1]', () => {
    const over = createProvenance({ agentUri: AGENT_URI, confidence: 1.5 }, {})
    expect(over.confidence).toBe(1.0)

    const under = createProvenance({ agentUri: AGENT_URI, confidence: -0.5 }, {})
    expect(under.confidence).toBe(0)
  })

  it('omits derivedFrom when empty', () => {
    const prov = createProvenance({ agentUri: AGENT_URI, derivedFrom: [] }, {})
    expect(prov.derivedFrom).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// extractProvenance
// ---------------------------------------------------------------------------

describe('extractProvenance', () => {
  it('extracts _provenance from a record value', () => {
    const provenance: MemoryProvenance = {
      createdBy: AGENT_URI,
      createdAt: '2026-03-25T00:00:00.000Z',
      source: 'direct',
      confidence: 1.0,
      contentHash: 'abc123',
      lineage: [AGENT_URI],
    }
    const record = { text: 'hello', _provenance: provenance }

    const extracted = extractProvenance(record)
    expect(extracted).toEqual(provenance)
  })

  it('returns undefined when no _provenance field', () => {
    expect(extractProvenance({ text: 'no provenance' })).toBeUndefined()
  })

  it('returns undefined when _provenance is null', () => {
    expect(extractProvenance({ _provenance: null })).toBeUndefined()
  })

  it('returns undefined when _provenance has invalid shape', () => {
    expect(extractProvenance({ _provenance: { createdBy: 123 } })).toBeUndefined()
  })

  it('returns undefined when _provenance is missing required fields', () => {
    expect(extractProvenance({
      _provenance: { createdBy: AGENT_URI, createdAt: '2026-01-01' },
    })).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// ProvenanceWriter
// ---------------------------------------------------------------------------

describe('ProvenanceWriter', () => {
  let mock: ReturnType<typeof createMockMemoryService>
  let writer: ProvenanceWriter

  beforeEach(() => {
    mock = createMockMemoryService()
    writer = new ProvenanceWriter(mock.service)
  })

  describe('put', () => {
    it('auto-injects _provenance into the record', async () => {
      const value = { text: 'important decision' }
      await writer.put('decisions', SCOPE, 'dec-1', value, { agentUri: AGENT_URI })

      expect(mock.putCalls).toHaveLength(1)
      const written = mock.putCalls[0]!
      expect(written.ns).toBe('decisions')
      expect(written.key).toBe('dec-1')
      expect(written.value['text']).toBe('important decision')

      const prov = extractProvenance(written.value)
      expect(prov).toBeDefined()
      expect(prov!.createdBy).toBe(AGENT_URI)
      expect(prov!.source).toBe('direct')
      expect(prov!.confidence).toBe(1.0)
      expect(prov!.lineage).toEqual([AGENT_URI])
      expect(prov!.contentHash).toBe(createContentHash(value))
    })

    it('respects custom source and confidence', async () => {
      await writer.put('decisions', SCOPE, 'dec-2', { text: 'derived' }, {
        agentUri: AGENT_URI,
        source: 'derived',
        confidence: 0.7,
        derivedFrom: ['src-1', 'src-2'],
      })

      const prov = extractProvenance(mock.putCalls[0]!.value)
      expect(prov!.source).toBe('derived')
      expect(prov!.confidence).toBe(0.7)
      expect(prov!.derivedFrom).toEqual(['src-1', 'src-2'])
    })
  })

  describe('extendProvenance', () => {
    it('appends agent to lineage', async () => {
      // Write initial record
      await writer.put('decisions', SCOPE, 'dec-1', { text: 'original' }, {
        agentUri: AGENT_URI,
      })

      // Extend provenance with a second agent
      await writer.extendProvenance('decisions', SCOPE, 'dec-1', AGENT_URI_2)

      // Should have 2 puts total
      expect(mock.putCalls).toHaveLength(2)
      const updated = mock.putCalls[1]!.value
      const prov = extractProvenance(updated)
      expect(prov).toBeDefined()
      expect(prov!.lineage).toEqual([AGENT_URI, AGENT_URI_2])
      // Original creator remains
      expect(prov!.createdBy).toBe(AGENT_URI)
    })

    it('does not duplicate consecutive same-agent entries', async () => {
      await writer.put('decisions', SCOPE, 'dec-1', { text: 'orig' }, {
        agentUri: AGENT_URI,
      })

      await writer.extendProvenance('decisions', SCOPE, 'dec-1', AGENT_URI)

      const prov = extractProvenance(mock.putCalls[1]!.value)
      expect(prov!.lineage).toEqual([AGENT_URI])
    })

    it('is a no-op when the record does not exist', async () => {
      await writer.extendProvenance('decisions', SCOPE, 'nonexistent', AGENT_URI)
      expect(mock.putCalls).toHaveLength(0)
    })

    it('is a no-op when the record has no provenance', async () => {
      // Manually seed a record without provenance
      const nsKey = `decisions:${JSON.stringify(SCOPE)}`
      mock.records.set(nsKey, new Map([['dec-1', { text: 'no prov' }]]))

      await writer.extendProvenance('decisions', SCOPE, 'dec-1', AGENT_URI)
      expect(mock.putCalls).toHaveLength(0)
    })
  })

  describe('getByProvenance', () => {
    beforeEach(async () => {
      // Seed records with different provenance
      await writer.put('lessons', SCOPE, 'l1', { text: 'lesson A' }, {
        agentUri: AGENT_URI,
        source: 'direct',
        confidence: 0.9,
      })
      await writer.put('lessons', SCOPE, 'l2', { text: 'lesson B' }, {
        agentUri: AGENT_URI_2,
        source: 'derived',
        confidence: 0.5,
        derivedFrom: ['l1'],
      })
      await writer.put('lessons', SCOPE, 'l3', { text: 'lesson C' }, {
        agentUri: AGENT_URI,
        source: 'imported',
        confidence: 1.0,
      })
    })

    it('filters by createdBy', async () => {
      const results = await writer.getByProvenance('lessons', SCOPE, {
        createdBy: AGENT_URI,
      })
      expect(results).toHaveLength(2)
      for (const r of results) {
        const p = extractProvenance(r.value)
        expect(p!.createdBy).toBe(AGENT_URI)
      }
    })

    it('filters by source', async () => {
      const results = await writer.getByProvenance('lessons', SCOPE, {
        source: 'derived',
      })
      expect(results).toHaveLength(1)
      expect(extractProvenance(results[0]!.value)!.source).toBe('derived')
    })

    it('filters by minConfidence', async () => {
      const results = await writer.getByProvenance('lessons', SCOPE, {
        minConfidence: 0.8,
      })
      expect(results).toHaveLength(2) // l1 (0.9) and l3 (1.0)
      for (const r of results) {
        expect(extractProvenance(r.value)!.confidence).toBeGreaterThanOrEqual(0.8)
      }
    })

    it('filters by touchedBy (lineage)', async () => {
      // First extend l2 so AGENT_URI is in its lineage
      await writer.extendProvenance('lessons', SCOPE, 'l2', AGENT_URI)

      const results = await writer.getByProvenance('lessons', SCOPE, {
        touchedBy: AGENT_URI,
      })
      // l1 (creator), l2 (extended), l3 (creator)
      expect(results).toHaveLength(3)
    })

    it('returns empty when no records match', async () => {
      const results = await writer.getByProvenance('lessons', SCOPE, {
        createdBy: 'forge://other/agent',
      })
      expect(results).toHaveLength(0)
    })

    it('combines multiple query filters', async () => {
      const results = await writer.getByProvenance('lessons', SCOPE, {
        createdBy: AGENT_URI,
        source: 'imported',
      })
      expect(results).toHaveLength(1)
      expect(extractProvenance(results[0]!.value)!.source).toBe('imported')
    })
  })

  describe('getLineage', () => {
    it('returns ordered lineage chain', async () => {
      await writer.put('decisions', SCOPE, 'dec-1', { text: 'v1' }, {
        agentUri: AGENT_URI,
      })
      await writer.extendProvenance('decisions', SCOPE, 'dec-1', AGENT_URI_2)

      const lineage = await writer.getLineage('decisions', SCOPE, 'dec-1')
      expect(lineage).toEqual([AGENT_URI, AGENT_URI_2])
    })

    it('returns empty array for nonexistent record', async () => {
      const lineage = await writer.getLineage('decisions', SCOPE, 'nope')
      expect(lineage).toEqual([])
    })

    it('returns empty array for record without provenance', async () => {
      const nsKey = `decisions:${JSON.stringify(SCOPE)}`
      mock.records.set(nsKey, new Map([['dec-1', { text: 'bare' }]]))

      const lineage = await writer.getLineage('decisions', SCOPE, 'dec-1')
      expect(lineage).toEqual([])
    })
  })
})
