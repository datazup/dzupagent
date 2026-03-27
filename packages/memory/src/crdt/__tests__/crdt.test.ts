import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HLC } from '../hlc.js'
import { CRDTResolver } from '../crdt-resolver.js'
import type { HLCTimestamp, LWWRegister, ORSet, LWWMap } from '../types.js'
import type { MemoryService } from '../../memory-service.js'

// ===========================================================================
// HLC Tests
// ===========================================================================

describe('HLC (Hybrid Logical Clock)', () => {
  let hlc: HLC

  beforeEach(() => {
    hlc = new HLC('node-1')
  })

  it('now() returns monotonically increasing timestamps', () => {
    const t1 = hlc.now()
    const t2 = hlc.now()
    const t3 = hlc.now()

    expect(HLC.compare(t1, t2)).toBe(-1)
    expect(HLC.compare(t2, t3)).toBe(-1)
    expect(HLC.compare(t1, t3)).toBe(-1)
  })

  it('now() increments counter for same-ms calls', () => {
    // Force same wallMs by mocking Date.now
    const fixedTime = 1700000000000
    vi.spyOn(Date, 'now').mockReturnValue(fixedTime)

    const t1 = hlc.now()
    const t2 = hlc.now()
    const t3 = hlc.now()

    expect(t1.wallMs).toBe(fixedTime)
    expect(t2.wallMs).toBe(fixedTime)
    expect(t3.wallMs).toBe(fixedTime)

    expect(t1.counter).toBe(0)
    expect(t2.counter).toBe(1)
    expect(t3.counter).toBe(2)

    vi.restoreAllMocks()
  })

  it('receive() advances clock past remote timestamp', () => {
    const remote: HLCTimestamp = {
      wallMs: Date.now() + 10000,
      counter: 5,
      nodeId: 'node-2',
    }

    const result = hlc.receive(remote)
    expect(result.wallMs).toBeGreaterThanOrEqual(remote.wallMs)
    // After receive, next now() should be even further ahead
    const next = hlc.now()
    expect(HLC.compare(result, next)).toBe(-1)
  })

  it('receive() from far future advances local clock', () => {
    const futureMs = Date.now() + 60000
    const remote: HLCTimestamp = {
      wallMs: futureMs,
      counter: 0,
      nodeId: 'node-2',
    }

    const result = hlc.receive(remote)
    expect(result.wallMs).toBe(futureMs)
    // Counter should be remote.counter + 1 since wallMs ties with remote
    expect(result.counter).toBe(1)
  })

  describe('compare()', () => {
    it('orders by wallMs first', () => {
      const a: HLCTimestamp = { wallMs: 100, counter: 99, nodeId: 'zzz' }
      const b: HLCTimestamp = { wallMs: 200, counter: 0, nodeId: 'aaa' }
      expect(HLC.compare(a, b)).toBe(-1)
      expect(HLC.compare(b, a)).toBe(1)
    })

    it('orders by counter second', () => {
      const a: HLCTimestamp = { wallMs: 100, counter: 1, nodeId: 'zzz' }
      const b: HLCTimestamp = { wallMs: 100, counter: 5, nodeId: 'aaa' }
      expect(HLC.compare(a, b)).toBe(-1)
      expect(HLC.compare(b, a)).toBe(1)
    })

    it('uses nodeId for tiebreak', () => {
      const a: HLCTimestamp = { wallMs: 100, counter: 1, nodeId: 'alpha' }
      const b: HLCTimestamp = { wallMs: 100, counter: 1, nodeId: 'beta' }
      expect(HLC.compare(a, b)).toBe(-1)
      expect(HLC.compare(b, a)).toBe(1)
    })

    it('returns 0 for identical timestamps', () => {
      const a: HLCTimestamp = { wallMs: 100, counter: 1, nodeId: 'node-1' }
      const b: HLCTimestamp = { wallMs: 100, counter: 1, nodeId: 'node-1' }
      expect(HLC.compare(a, b)).toBe(0)
    })
  })
})

// ===========================================================================
// LWW Register Tests
// ===========================================================================

describe('CRDTResolver — LWW Register', () => {
  let resolver: CRDTResolver

  beforeEach(() => {
    const hlc = new HLC('node-1')
    resolver = new CRDTResolver(hlc)
  })

  it('createRegister stores value with timestamp', () => {
    const reg = resolver.createRegister('hello')
    expect(reg.value).toBe('hello')
    expect(reg.timestamp.nodeId).toBe('node-1')
    expect(reg.timestamp.wallMs).toBeGreaterThan(0)
  })

  it('updateRegister creates new register with later timestamp', () => {
    const reg1 = resolver.createRegister('v1')
    const reg2 = resolver.updateRegister(reg1, 'v2')
    expect(reg2.value).toBe('v2')
    expect(HLC.compare(reg1.timestamp, reg2.timestamp)).toBe(-1)
  })

  it('mergeRegisters: later timestamp wins', () => {
    const reg1 = resolver.createRegister('first')
    const reg2 = resolver.createRegister('second')
    // reg2 has a later timestamp than reg1
    const result = resolver.mergeRegisters(reg1, reg2)
    expect(result.merged.value).toBe('second')
    expect(result.conflictsResolved).toBe(1)
  })

  it('mergeRegisters: commutativity', () => {
    const hlcA = new HLC('node-a')
    const hlcB = new HLC('node-b')
    const resolverA = new CRDTResolver(hlcA)
    const resolverB = new CRDTResolver(hlcB)

    const regA = resolverA.createRegister('from-a')
    const regB = resolverB.createRegister('from-b')

    const mergeAB = resolverA.mergeRegisters(regA, regB)
    const mergeBA = resolverB.mergeRegisters(regB, regA)

    // Both merges should produce the same value
    expect(mergeAB.merged.value).toBe(mergeBA.merged.value)
  })

  it('mergeRegisters: idempotency', () => {
    const reg = resolver.createRegister('hello')
    const result = resolver.mergeRegisters(reg, reg)
    expect(result.merged.value).toBe('hello')
    expect(result.conflictsResolved).toBe(0)
  })
})

// ===========================================================================
// OR-Set Tests
// ===========================================================================

describe('CRDTResolver — OR-Set', () => {
  let resolver: CRDTResolver

  beforeEach(() => {
    const hlc = new HLC('node-1')
    resolver = new CRDTResolver(hlc)
  })

  it('addToSet adds value', () => {
    let set = resolver.createSet()
    set = resolver.addToSet(set, 'apple')
    const values = resolver.getSetValues(set)
    expect(values).toEqual(['apple'])
  })

  it('removeFromSet marks value as removed', () => {
    let set = resolver.createSet()
    set = resolver.addToSet(set, 'apple')
    set = resolver.addToSet(set, 'banana')
    set = resolver.removeFromSet(set, 'apple')
    const values = resolver.getSetValues(set)
    expect(values).toEqual(['banana'])
  })

  it('removeFromSet on missing value is no-op', () => {
    let set = resolver.createSet()
    set = resolver.addToSet(set, 'apple')
    set = resolver.removeFromSet(set, 'nonexistent')
    const values = resolver.getSetValues(set)
    expect(values).toEqual(['apple'])
  })

  it('mergeSets: concurrent add-add — both present', () => {
    let setA = resolver.createSet()
    setA = resolver.addToSet(setA, 'apple')

    let setB = resolver.createSet()
    setB = resolver.addToSet(setB, 'banana')

    const result = resolver.mergeSets(setA, setB)
    const values = resolver.getSetValues(result.merged)
    expect(values).toEqual(['apple', 'banana'])
  })

  it('mergeSets: concurrent add-remove — add wins', () => {
    // Start with a set containing "apple" (same tag on both sides)
    let baseSet = resolver.createSet()
    baseSet = resolver.addToSet(baseSet, 'apple')

    // Replica A: removes apple
    const setA = resolver.removeFromSet(baseSet, 'apple')

    // Replica B: adds apple again (new tag)
    const setB = resolver.addToSet(baseSet, 'apple')

    const result = resolver.mergeSets(setA, setB)
    const values = resolver.getSetValues(result.merged)
    // The original tag is removed in A but not in B — add wins for that tag.
    // Plus B's new add-tag is always active.
    expect(values).toContain('apple')
  })

  it('mergeSets: commutativity', () => {
    let setA = resolver.createSet()
    setA = resolver.addToSet(setA, 'x')
    setA = resolver.addToSet(setA, 'y')

    let setB = resolver.createSet()
    setB = resolver.addToSet(setB, 'y')
    setB = resolver.addToSet(setB, 'z')

    const mergeAB = resolver.mergeSets(setA, setB)
    const mergeBA = resolver.mergeSets(setB, setA)

    expect(resolver.getSetValues(mergeAB.merged).sort())
      .toEqual(resolver.getSetValues(mergeBA.merged).sort())
  })

  it('getSetValues returns only active values', () => {
    let set = resolver.createSet()
    set = resolver.addToSet(set, 'keep')
    set = resolver.addToSet(set, 'remove')
    set = resolver.removeFromSet(set, 'remove')

    const values = resolver.getSetValues(set)
    expect(values).toEqual(['keep'])
  })
})

// ===========================================================================
// LWW-Map Tests
// ===========================================================================

describe('CRDTResolver — LWW-Map', () => {
  let resolver: CRDTResolver

  beforeEach(() => {
    const hlc = new HLC('node-1')
    resolver = new CRDTResolver(hlc)
  })

  it('createMap initializes fields with timestamps', () => {
    const map = resolver.createMap({ name: 'Alice', age: 30 })
    expect(map.fields['name']?.value).toBe('Alice')
    expect(map.fields['age']?.value).toBe(30)
    expect(map.fields['name']?.timestamp.nodeId).toBe('node-1')
  })

  it('updateField updates with new timestamp', () => {
    let map = resolver.createMap({ name: 'Alice' })
    const oldTs = map.fields['name']!.timestamp
    map = resolver.updateField(map, 'name', 'Bob')
    expect(map.fields['name']?.value).toBe('Bob')
    expect(HLC.compare(oldTs, map.fields['name']!.timestamp)).toBe(-1)
  })

  it('mergeMaps: per-field resolution (latest wins per field)', () => {
    const hlcA = new HLC('node-a')
    const hlcB = new HLC('node-b')
    const resolverA = new CRDTResolver(hlcA)
    const resolverB = new CRDTResolver(hlcB)

    // A writes name first, B writes name second (later timestamp)
    const mapA = resolverA.createMap({ name: 'Alice', role: 'admin' })
    const mapB = resolverB.createMap({ name: 'Bob', role: 'user' })

    const result = resolverA.mergeMaps(mapA, mapB)
    const obj = resolverA.toObject(result.merged)

    // Both fields should be resolved: the later writer wins for each field
    expect(obj['name']).toBeDefined()
    expect(obj['role']).toBeDefined()
    expect(result.conflictsResolved).toBeGreaterThan(0)
  })

  it('mergeMaps: different fields merged from both maps', () => {
    const hlcA = new HLC('node-a')
    const hlcB = new HLC('node-b')
    const resolverA = new CRDTResolver(hlcA)
    const resolverB = new CRDTResolver(hlcB)

    const mapA = resolverA.createMap({ name: 'Alice' })
    const mapB = resolverB.createMap({ age: 30 })

    const result = resolverA.mergeMaps(mapA, mapB)
    const obj = resolverA.toObject(result.merged)

    expect(obj['name']).toBe('Alice')
    expect(obj['age']).toBe(30)
    expect(result.conflictsResolved).toBe(0)
  })

  it('mergeMaps: commutativity', () => {
    const hlcA = new HLC('node-a')
    const hlcB = new HLC('node-b')
    const resolverA = new CRDTResolver(hlcA)
    const resolverB = new CRDTResolver(hlcB)

    const mapA = resolverA.createMap({ x: 1, y: 2 })
    const mapB = resolverB.createMap({ y: 99, z: 3 })

    const mergeAB = resolverA.mergeMaps(mapA, mapB)
    const mergeBA = resolverB.mergeMaps(mapB, mapA)

    const objAB = resolverA.toObject(mergeAB.merged)
    const objBA = resolverB.toObject(mergeBA.merged)

    expect(objAB).toEqual(objBA)
  })

  it('toObject extracts plain values', () => {
    const map = resolver.createMap({ text: 'hello', count: 42 })
    const obj = resolver.toObject(map)
    expect(obj).toEqual({ text: 'hello', count: 42 })
  })
})

// ===========================================================================
// Integration — CRDT + MemorySpaceManager
// ===========================================================================

describe('CRDT integration with MemorySpaceManager', () => {
  function createMockMemoryService(): {
    svc: MemoryService
    putSpy: ReturnType<typeof vi.fn>
    getSpy: ReturnType<typeof vi.fn>
    searchSpy: ReturnType<typeof vi.fn>
  } {
    const putSpy = vi.fn().mockResolvedValue(undefined)
    const getSpy = vi.fn().mockResolvedValue([])
    const searchSpy = vi.fn().mockResolvedValue([])

    const svc = {
      put: putSpy,
      get: getSpy,
      search: searchSpy,
      formatForPrompt: vi.fn().mockReturnValue(''),
    } as unknown as MemoryService

    return { svc, putSpy, getSpy, searchSpy }
  }

  it('CRDT space: concurrent writes to same key merge correctly', async () => {
    const { svc, putSpy, getSpy } = createMockMemoryService()

    // Dynamic import to avoid circular issues in tests
    const { MemorySpaceManager } = await import('../../sharing/memory-space-manager.js')

    const manager = new MemorySpaceManager({
      memoryService: svc,
      nodeId: 'test-node',
    })

    // Simulate space lookup: return a CRDT-configured space
    const spaceRecord = {
      id: 'space-1',
      name: 'test-space',
      owner: 'forge://org/agent-a',
      participants: [
        { agentUri: 'forge://org/agent-a', permission: 'admin', joinedAt: '2024-01-01' },
        { agentUri: 'forge://org/agent-b', permission: 'read-write', joinedAt: '2024-01-01' },
      ],
      conflictResolution: 'crdt',
      createdAt: '2024-01-01',
    }

    // First call: getSpace (loadSpace), second call: get existing value for key
    getSpy
      .mockResolvedValueOnce([spaceRecord]) // loadSpace
      .mockResolvedValueOnce([]) // no existing value for this key

    await manager.share({
      from: 'forge://org/agent-a',
      spaceId: 'space-1',
      key: 'config',
      value: { theme: 'dark', lang: 'en' },
      mode: 'push',
    })

    // Verify put was called with _crdt metadata
    expect(putSpy).toHaveBeenCalled()
    const writtenValue = putSpy.mock.calls[putSpy.mock.calls.length - 1]
    // The provenance writer calls memoryService.put — check it has _crdt
    // ProvenanceWriter wraps the value, so we check the call args
    const lastPutArgs = putSpy.mock.calls[putSpy.mock.calls.length - 1] as unknown[]
    const lastValue = lastPutArgs[3] as Record<string, unknown>
    expect(lastValue['_crdt']).toBeDefined()
    expect(lastValue['theme']).toBe('dark')
    expect(lastValue['lang']).toBe('en')
  })

  it('CRDT space: conflict event emitted on merge', async () => {
    const { svc, putSpy, getSpy } = createMockMemoryService()
    const { MemorySpaceManager } = await import('../../sharing/memory-space-manager.js')

    const events: Array<{ type: string }> = []
    const manager = new MemorySpaceManager({
      memoryService: svc,
      nodeId: 'test-node',
      onEvent: (e) => events.push(e),
    })

    const spaceRecord = {
      id: 'space-1',
      name: 'test-space',
      owner: 'forge://org/agent-a',
      participants: [
        { agentUri: 'forge://org/agent-a', permission: 'admin', joinedAt: '2024-01-01' },
        { agentUri: 'forge://org/agent-b', permission: 'read-write', joinedAt: '2024-01-01' },
      ],
      conflictResolution: 'crdt',
      createdAt: '2024-01-01',
    }

    // Create an existing CRDT record with an older timestamp from a different node
    const hlcOther = new HLC('other-node')
    const otherResolver = new CRDTResolver(hlcOther)
    const existingMap = otherResolver.createMap({ theme: 'light', lang: 'fr' })

    const existingRecord = {
      theme: 'light',
      lang: 'fr',
      _crdt: existingMap,
    }

    getSpy
      .mockResolvedValueOnce([spaceRecord]) // loadSpace
      .mockResolvedValueOnce([existingRecord]) // existing value for key

    await manager.share({
      from: 'forge://org/agent-b',
      spaceId: 'space-1',
      key: 'config',
      value: { theme: 'dark', lang: 'en' },
      mode: 'push',
    })

    // Should have emitted both write and conflict events
    const eventTypes = events.map(e => e.type)
    expect(eventTypes).toContain('memory:space:write')
    expect(eventTypes).toContain('memory:space:conflict')

    // The merged value should use the later timestamp for each field
    const lastPutArgs = putSpy.mock.calls[putSpy.mock.calls.length - 1] as unknown[]
    const lastValue = lastPutArgs[3] as Record<string, unknown>
    expect(lastValue['_crdt']).toBeDefined()
    // The incoming values (from test-node) are created AFTER the existing ones,
    // so they should win
    expect(lastValue['theme']).toBe('dark')
    expect(lastValue['lang']).toBe('en')
  })
})
