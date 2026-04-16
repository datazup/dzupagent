/**
 * Integration tests for Memory Provenance + Causal Graph subsystems.
 *
 * These tests exercise ProvenanceWriter and CausalGraph together, verifying
 * cross-cutting behavior that unit tests for each module in isolation do not cover.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ProvenanceWriter, extractProvenance } from '../provenance/provenance-writer.js'
import { CausalGraph } from '../causal/causal-graph.js'
import { pruneStaleMemories } from '../staleness-pruner.js'
import type { MemoryService } from '../memory-service.js'
import type { MemoryEntry } from '../consolidation-types.js'

// ---------------------------------------------------------------------------
// Shared mock
// ---------------------------------------------------------------------------

interface PutCall {
  ns: string
  scope: Record<string, string>
  key: string
  value: Record<string, unknown>
}

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
    delete: vi.fn().mockImplementation(
      (ns: string, scope: Record<string, string>, key: string) => {
        const nsKey = `${ns}:${JSON.stringify(scope)}`
        const nsRecords = records.get(nsKey)
        if (nsRecords) nsRecords.delete(key)
        return Promise.resolve(true)
      },
    ),
    formatForPrompt: vi.fn().mockReturnValue(''),
  } as unknown as MemoryService

  return { service, putCalls, records }
}

const SCOPE = { tenantId: 't1', projectId: 'p1' }
const AGENT_A = 'forge://acme/researcher'
const AGENT_B = 'forge://acme/reviewer'
const NS = 'findings'
const MS_PER_DAY = 24 * 60 * 60 * 1000
const NOW = Date.now()

// ---------------------------------------------------------------------------
// Provenance Tests
// ---------------------------------------------------------------------------

describe('Provenance integration', () => {
  let mock: ReturnType<typeof createMockMemoryService>
  let writer: ProvenanceWriter

  beforeEach(() => {
    mock = createMockMemoryService()
    writer = new ProvenanceWriter(mock.service)
  })

  it('1. write a memory entry => provenance record has correct source and timestamp', async () => {
    const before = new Date().toISOString()
    await writer.put(NS, SCOPE, 'finding-1', { text: 'Key finding' }, {
      agentUri: AGENT_A,
      source: 'direct',
    })
    const after = new Date().toISOString()

    const written = mock.putCalls[0]!.value
    const prov = extractProvenance(written)
    expect(prov).toBeDefined()
    expect(prov!.source).toBe('direct')
    expect(prov!.createdAt >= before).toBe(true)
    expect(prov!.createdAt <= after).toBe(true)
  })

  it('2. provenance record has correct agentId (createdBy) and lineage', async () => {
    await writer.put(NS, SCOPE, 'finding-2', { text: 'Another finding' }, {
      agentUri: AGENT_A,
    })

    const prov = extractProvenance(mock.putCalls[0]!.value)
    expect(prov!.createdBy).toBe(AGENT_A)
    expect(prov!.lineage).toEqual([AGENT_A])
  })

  it('3. two writes from different agents => separate provenance records', async () => {
    await writer.put(NS, SCOPE, 'finding-a', { text: 'Finding from A' }, {
      agentUri: AGENT_A,
    })
    await writer.put(NS, SCOPE, 'finding-b', { text: 'Finding from B' }, {
      agentUri: AGENT_B,
    })

    const provA = extractProvenance(mock.putCalls[0]!.value)
    const provB = extractProvenance(mock.putCalls[1]!.value)

    expect(provA!.createdBy).toBe(AGENT_A)
    expect(provB!.createdBy).toBe(AGENT_B)
    expect(provA!.contentHash).not.toBe(provB!.contentHash)
  })

  it('4. provenance query by createdBy returns the correct records', async () => {
    await writer.put(NS, SCOPE, 'r1', { text: 'From A' }, { agentUri: AGENT_A })
    await writer.put(NS, SCOPE, 'r2', { text: 'From B' }, { agentUri: AGENT_B })
    await writer.put(NS, SCOPE, 'r3', { text: 'Also from A' }, { agentUri: AGENT_A })

    const results = await writer.getByProvenance(NS, SCOPE, { createdBy: AGENT_A })
    expect(results).toHaveLength(2)
    for (const r of results) {
      expect(extractProvenance(r.value)!.createdBy).toBe(AGENT_A)
    }
  })
})

// ---------------------------------------------------------------------------
// Causal Graph Tests
// ---------------------------------------------------------------------------

describe('CausalGraph integration', () => {
  let mock: ReturnType<typeof createMockMemoryService>
  let graph: CausalGraph

  beforeEach(() => {
    mock = createMockMemoryService()
    graph = new CausalGraph(mock.service)
  })

  it('5. create a causal edge B depends on A => edge A->B exists', async () => {
    await graph.addRelation({
      cause: 'A', causeNamespace: NS,
      effect: 'B', effectNamespace: NS,
      confidence: 0.9,
    })

    const nodeA = await graph.getRelations('A', NS)
    expect(nodeA.effects).toHaveLength(1)
    expect(nodeA.effects[0]!.effect).toBe('B')
  })

  it('6. query children (effects) of A => returns [B]', async () => {
    await graph.addRelation({
      cause: 'A', causeNamespace: NS,
      effect: 'B', effectNamespace: NS,
      confidence: 0.9,
    })

    const nodeA = await graph.getRelations('A', NS)
    const childKeys = nodeA.effects.map(e => e.effect)
    expect(childKeys).toEqual(['B'])
  })

  it('7. query parents (causes) of B => returns [A]', async () => {
    await graph.addRelation({
      cause: 'A', causeNamespace: NS,
      effect: 'B', effectNamespace: NS,
      confidence: 0.9,
    })

    const nodeB = await graph.getRelations('B', NS)
    const parentKeys = nodeB.causes.map(c => c.cause)
    expect(parentKeys).toEqual(['A'])
  })

  it('8. remove relation A->B => causal edge is removed via tombstone', async () => {
    await graph.addRelation({
      cause: 'A', causeNamespace: NS,
      effect: 'B', effectNamespace: NS,
      confidence: 0.9,
    })

    await graph.removeRelation('A', NS, 'B', NS)

    const nodeA = await graph.getRelations('A', NS)
    expect(nodeA.effects).toHaveLength(0)

    const nodeB = await graph.getRelations('B', NS)
    expect(nodeB.causes).toHaveLength(0)
  })

  it('9. create chain A->B->C => transitive traversal from C includes A', async () => {
    await graph.addRelation({
      cause: 'A', causeNamespace: NS,
      effect: 'B', effectNamespace: NS,
      confidence: 0.9,
    })
    await graph.addRelation({
      cause: 'B', causeNamespace: NS,
      effect: 'C', effectNamespace: NS,
      confidence: 0.8,
    })

    const result = await graph.traverse('C', NS, { direction: 'causes' })
    const ancestorKeys = result.nodes.map(n => n.key).sort()
    expect(ancestorKeys).toEqual(['A', 'B'])
    expect(result.depth).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Provenance + Consolidation integration
// ---------------------------------------------------------------------------

describe('Provenance + Consolidation integration', () => {
  let mock: ReturnType<typeof createMockMemoryService>
  let writer: ProvenanceWriter

  beforeEach(() => {
    mock = createMockMemoryService()
    writer = new ProvenanceWriter(mock.service)
  })

  it('10. consolidated memory preserves provenance of both originals via derivedFrom', async () => {
    // Write two original memories
    await writer.put(NS, SCOPE, 'orig-1', { text: 'First finding' }, {
      agentUri: AGENT_A,
    })
    await writer.put(NS, SCOPE, 'orig-2', { text: 'Second finding' }, {
      agentUri: AGENT_B,
    })

    // Consolidate into a new memory with derived provenance
    await writer.put(NS, SCOPE, 'consolidated', { text: 'Combined finding' }, {
      agentUri: AGENT_A,
      source: 'consolidated',
      derivedFrom: ['orig-1', 'orig-2'],
    })

    const consolidatedProv = extractProvenance(mock.putCalls[2]!.value)
    expect(consolidatedProv).toBeDefined()
    expect(consolidatedProv!.derivedFrom).toEqual(['orig-1', 'orig-2'])
    expect(consolidatedProv!.source).toBe('consolidated')
  })

  it('11. consolidated memory has provenance source "consolidated"', async () => {
    await writer.put(NS, SCOPE, 'merged', { text: 'Merged content' }, {
      agentUri: AGENT_A,
      source: 'consolidated',
      derivedFrom: ['a', 'b'],
    })

    const prov = extractProvenance(mock.putCalls[0]!.value)
    expect(prov!.source).toBe('consolidated')
  })
})

// ---------------------------------------------------------------------------
// Provenance + Staleness pruner integration
// ---------------------------------------------------------------------------

describe('Provenance + Staleness pruner integration', () => {
  let mock: ReturnType<typeof createMockMemoryService>
  let graph: CausalGraph

  beforeEach(() => {
    mock = createMockMemoryService()
    graph = new CausalGraph(mock.service)
  })

  it('12. a memory with causal dependents should NOT be pruned when marked as important', () => {
    // A memory that has causal dependents should be considered important.
    // The staleness pruner respects the importance field, so we simulate
    // a memory that has dependents by giving it high importance.
    const memories: MemoryEntry[] = [
      {
        key: 'root-memory',
        text: 'Root memory with dependents',
        createdAt: NOW - 60 * MS_PER_DAY,
        accessCount: 1,
        importance: 0.9, // high importance protects from pruning
      },
      {
        key: 'stale-memory',
        text: 'Old stale memory',
        createdAt: NOW - 60 * MS_PER_DAY,
        accessCount: 1,
        importance: 0.3,
      },
    ]

    const result = pruneStaleMemories(memories, {
      maxStaleness: 30,
      importanceThreshold: 0.8,
      now: NOW,
    })

    // Root memory (importance 0.9 >= 0.8 threshold) should be kept
    expect(result.kept.find(m => m.key === 'root-memory')).toBeDefined()
    // Stale memory should be pruned
    expect(result.pruned.find(m => m.key === 'stale-memory')).toBeDefined()
  })

  it('13. a memory without causal dependents and past TTL SHOULD be pruned', () => {
    const memories: MemoryEntry[] = [
      {
        key: 'orphan-old',
        text: 'Old memory with no dependents',
        createdAt: NOW - 100 * MS_PER_DAY,
        accessCount: 1,
        importance: 0.2,
      },
    ]

    const result = pruneStaleMemories(memories, {
      maxStaleness: 30,
      maxAgeDays: 90,
      now: NOW,
    })

    expect(result.pruned).toHaveLength(1)
    expect(result.pruned[0]!.key).toBe('orphan-old')
  })
})

// ---------------------------------------------------------------------------
// General integration
// ---------------------------------------------------------------------------

describe('General integration', () => {
  let mock: ReturnType<typeof createMockMemoryService>
  let writer: ProvenanceWriter

  beforeEach(() => {
    mock = createMockMemoryService()
    writer = new ProvenanceWriter(mock.service)
  })

  it('14. ProvenanceWriter handles concurrent writes without data loss', async () => {
    // Fire multiple concurrent writes and verify all complete
    const promises = Array.from({ length: 10 }, (_, i) =>
      writer.put(NS, SCOPE, `concurrent-${i}`, { text: `Write ${i}` }, {
        agentUri: AGENT_A,
      }),
    )

    await Promise.all(promises)

    // All 10 writes should have been issued
    expect(mock.putCalls).toHaveLength(10)

    // Each should have valid provenance
    for (const call of mock.putCalls) {
      const prov = extractProvenance(call.value)
      expect(prov).toBeDefined()
      expect(prov!.createdBy).toBe(AGENT_A)
    }

    // All 10 keys should be distinct
    const keys = new Set(mock.putCalls.map(c => c.key))
    expect(keys.size).toBe(10)
  })

  it('15. CausalGraph handles circular dependency A->B->A gracefully', async () => {
    const graph = new CausalGraph(mock.service)

    await graph.addRelation({
      cause: 'A', causeNamespace: NS,
      effect: 'B', effectNamespace: NS,
      confidence: 0.9,
    })
    await graph.addRelation({
      cause: 'B', causeNamespace: NS,
      effect: 'A', effectNamespace: NS,
      confidence: 0.8,
    })

    // Traverse should not hang — it uses a visited set
    const result = await graph.traverse('A', NS, {
      direction: 'both',
      maxDepth: 10,
    })

    // Should discover B but not revisit A
    const nodeKeys = result.nodes.map(n => n.key)
    expect(nodeKeys).toEqual(['B'])
    // Relations should include both edges
    expect(result.relations.length).toBeGreaterThanOrEqual(1)
  })
})
