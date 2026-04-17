import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FrozenMemorySnapshot } from '../frozen-snapshot.js'
import type { MemoryService } from '../memory-service.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PutCall {
  ns: string
  scope: Record<string, string>
  key: string
  value: Record<string, unknown>
}

function createMockMemoryService(initialData?: {
  [namespace: string]: Record<string, unknown>[]
}): {
  service: MemoryService
  putCalls: PutCall[]
  getCalls: Array<{ ns: string; scope: Record<string, string>; key?: string }>
  formatForPromptCalls: Array<{ records: Record<string, unknown>[]; options?: { header?: string } }>
} {
  const putCalls: PutCall[] = []
  const getCalls: Array<{ ns: string; scope: Record<string, string>; key?: string }> = []
  const formatForPromptCalls: Array<{ records: Record<string, unknown>[]; options?: { header?: string } }> = []

  const data = initialData ?? {}

  const service = {
    get: vi.fn().mockImplementation(
      (ns: string, scope: Record<string, string>, key?: string) => {
        getCalls.push({ ns, scope, key })
        const records = data[ns] ?? []
        if (key) return Promise.resolve(records.filter(r => r['key'] === key))
        return Promise.resolve(records)
      },
    ),
    put: vi.fn().mockImplementation(
      (ns: string, scope: Record<string, string>, key: string, value: Record<string, unknown>) => {
        putCalls.push({ ns, scope, key, value })
        return Promise.resolve()
      },
    ),
    formatForPrompt: vi.fn().mockImplementation(
      (records: Record<string, unknown>[], options?: { header?: string }) => {
        formatForPromptCalls.push({ records, options })
        return `formatted(${records.length})`
      },
    ),
  } as unknown as MemoryService

  return { service, putCalls, getCalls, formatForPromptCalls }
}

const SCOPE = { tenantId: 't1', projectId: 'p1' }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FrozenMemorySnapshot', () => {
  describe('isFrozen()', () => {
    it('returns false before freeze()', () => {
      const { service } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)
      expect(snapshot.isFrozen()).toBe(false)
    })

    it('returns true after freeze()', async () => {
      const { service } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze(['decisions'], SCOPE)
      expect(snapshot.isFrozen()).toBe(true)
    })

    it('returns false after unfreeze()', async () => {
      const { service } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze(['decisions'], SCOPE)
      await snapshot.unfreeze()
      expect(snapshot.isFrozen()).toBe(false)
    })

    it('toggles correctly across multiple cycles', async () => {
      const { service } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)
      expect(snapshot.isFrozen()).toBe(false)
      await snapshot.freeze(['ns1'], SCOPE)
      expect(snapshot.isFrozen()).toBe(true)
      await snapshot.unfreeze()
      expect(snapshot.isFrozen()).toBe(false)
      await snapshot.freeze(['ns1'], SCOPE)
      expect(snapshot.isFrozen()).toBe(true)
    })
  })

  describe('freeze()', () => {
    it('calls memoryService.get() for each namespace passed', async () => {
      const { service, getCalls } = createMockMemoryService({
        decisions: [{ key: 'd1', text: 'Use Postgres' }],
        lessons: [{ key: 'l1', text: 'Always migrate' }],
      })
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze(['decisions', 'lessons'], SCOPE)
      expect(getCalls).toHaveLength(2)
      expect(getCalls[0]!.ns).toBe('decisions')
      expect(getCalls[1]!.ns).toBe('lessons')
      expect(getCalls[0]!.scope).toEqual(SCOPE)
    })

    it('sets isFrozen to true', async () => {
      const { service } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze(['ns1'], SCOPE)
      expect(snapshot.isFrozen()).toBe(true)
    })

    it('resets writeBuffer to empty', async () => {
      const { service } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)
      // Freeze, do some writes, then re-freeze
      await snapshot.freeze(['ns1'], SCOPE)
      await snapshot.put('ns1', SCOPE, 'k', { text: 'v' })
      expect(snapshot.pendingWrites).toBe(1)
      await snapshot.freeze(['ns1'], SCOPE)
      expect(snapshot.pendingWrites).toBe(0)
    })

    it('handles empty namespace list', async () => {
      const { service, getCalls } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze([], SCOPE)
      expect(snapshot.isFrozen()).toBe(true)
      expect(getCalls).toHaveLength(0)
    })

    it('passes scope through to memoryService.get', async () => {
      const { service, getCalls } = createMockMemoryService()
      const customScope = { userId: 'u1', orgId: 'org1' }
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze(['ns1'], customScope)
      expect(getCalls[0]!.scope).toEqual(customScope)
    })

    it('takes snapshots of all namespace records', async () => {
      const { service } = createMockMemoryService({
        decisions: [
          { key: 'd1', text: 'Use Postgres' },
          { key: 'd2', text: 'Use Vue 3' },
        ],
      })
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze(['decisions'], SCOPE)
      const result = await snapshot.get('decisions', SCOPE)
      expect(result).toHaveLength(2)
    })
  })

  describe('get() while frozen', () => {
    it('returns snapshot data without calling memoryService.get again', async () => {
      const { service, getCalls } = createMockMemoryService({
        decisions: [{ key: 'd1', text: 'Use Postgres' }],
      })
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze(['decisions'], SCOPE)
      expect(getCalls).toHaveLength(1)
      // Subsequent get() should NOT trigger another memoryService.get call
      const result = await snapshot.get('decisions', SCOPE)
      expect(getCalls).toHaveLength(1)
      expect(result).toHaveLength(1)
      expect(result[0]!['text']).toBe('Use Postgres')
    })

    it('with key parameter: filters to only matching records', async () => {
      const { service } = createMockMemoryService({
        decisions: [
          { key: 'd1', text: 'Use Postgres' },
          { key: 'd2', text: 'Use Vue 3' },
          { key: 'd3', text: 'Use Tailwind' },
        ],
      })
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze(['decisions'], SCOPE)
      const result = await snapshot.get('decisions', SCOPE, 'd2')
      expect(result).toHaveLength(1)
      expect(result[0]!['text']).toBe('Use Vue 3')
    })

    it('with key parameter that matches nothing: returns empty array', async () => {
      const { service } = createMockMemoryService({
        decisions: [{ key: 'd1', text: 'Use Postgres' }],
      })
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze(['decisions'], SCOPE)
      const result = await snapshot.get('decisions', SCOPE, 'nonexistent')
      expect(result).toEqual([])
    })

    it('namespace not in snapshot: delegates to memoryService.get', async () => {
      const { service, getCalls } = createMockMemoryService({
        decisions: [{ key: 'd1', text: 'Use Postgres' }],
        other: [{ key: 'o1', text: 'Other thing' }],
      })
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze(['decisions'], SCOPE)
      const callsAfterFreeze = getCalls.length
      const result = await snapshot.get('other', SCOPE)
      expect(getCalls.length).toBe(callsAfterFreeze + 1)
      expect(result).toHaveLength(1)
    })

    it('returns empty array for frozen namespace with no records', async () => {
      const { service } = createMockMemoryService({
        decisions: [],
      })
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze(['decisions'], SCOPE)
      const result = await snapshot.get('decisions', SCOPE)
      expect(result).toEqual([])
    })

    it('multiple get() calls on same namespace return same snapshot data', async () => {
      const { service } = createMockMemoryService({
        decisions: [{ key: 'd1', text: 'Use Postgres' }],
      })
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze(['decisions'], SCOPE)
      const r1 = await snapshot.get('decisions', SCOPE)
      const r2 = await snapshot.get('decisions', SCOPE)
      expect(r1).toEqual(r2)
    })
  })

  describe('get() while NOT frozen', () => {
    it('delegates to memoryService.get', async () => {
      const { service, getCalls } = createMockMemoryService({
        decisions: [{ key: 'd1', text: 'Use Postgres' }],
      })
      const snapshot = new FrozenMemorySnapshot(service)
      const result = await snapshot.get('decisions', SCOPE)
      expect(getCalls).toHaveLength(1)
      expect(result).toHaveLength(1)
    })

    it('passes key parameter to memoryService.get', async () => {
      const { service, getCalls } = createMockMemoryService({
        decisions: [
          { key: 'd1', text: 'A' },
          { key: 'd2', text: 'B' },
        ],
      })
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.get('decisions', SCOPE, 'd1')
      expect(getCalls[0]!.key).toBe('d1')
    })

    it('passes scope to memoryService.get', async () => {
      const { service, getCalls } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)
      const customScope = { userId: 'u1' }
      await snapshot.get('ns1', customScope)
      expect(getCalls[0]!.scope).toEqual(customScope)
    })
  })

  describe('put() while frozen', () => {
    it('buffers write and does NOT call memoryService.put', async () => {
      const { service, putCalls } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze(['decisions'], SCOPE)
      await snapshot.put('decisions', SCOPE, 'k1', { text: 'v1' })
      expect(putCalls).toHaveLength(0)
      expect(snapshot.pendingWrites).toBe(1)
    })

    it('pendingWrites increments for each buffered write', async () => {
      const { service } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze(['decisions'], SCOPE)
      await snapshot.put('decisions', SCOPE, 'k1', { text: 'v1' })
      expect(snapshot.pendingWrites).toBe(1)
      await snapshot.put('decisions', SCOPE, 'k2', { text: 'v2' })
      expect(snapshot.pendingWrites).toBe(2)
      await snapshot.put('decisions', SCOPE, 'k3', { text: 'v3' })
      expect(snapshot.pendingWrites).toBe(3)
    })

    it('buffers writes across multiple namespaces', async () => {
      const { service, putCalls } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze(['decisions', 'lessons'], SCOPE)
      await snapshot.put('decisions', SCOPE, 'd1', { text: 'A' })
      await snapshot.put('lessons', SCOPE, 'l1', { text: 'B' })
      await snapshot.put('decisions', SCOPE, 'd2', { text: 'C' })
      expect(putCalls).toHaveLength(0)
      expect(snapshot.pendingWrites).toBe(3)
    })

    it('multiple buffered writes accumulate without triggering memoryService', async () => {
      const { service, putCalls } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze(['ns1'], SCOPE)
      for (let i = 0; i < 10; i++) {
        await snapshot.put('ns1', SCOPE, `k${i}`, { text: `v${i}` })
      }
      expect(snapshot.pendingWrites).toBe(10)
      expect(putCalls).toHaveLength(0)
    })

    it('buffers writes for namespaces not in the snapshot list too', async () => {
      const { service, putCalls } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze(['decisions'], SCOPE)
      await snapshot.put('different_ns', SCOPE, 'k1', { text: 'v1' })
      // Put is buffered regardless of snapshot membership when frozen
      expect(putCalls).toHaveLength(0)
      expect(snapshot.pendingWrites).toBe(1)
    })
  })

  describe('put() while NOT frozen', () => {
    it('calls memoryService.put immediately', async () => {
      const { service, putCalls } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.put('decisions', SCOPE, 'k1', { text: 'v1' })
      expect(putCalls).toHaveLength(1)
      expect(putCalls[0]!.ns).toBe('decisions')
      expect(putCalls[0]!.key).toBe('k1')
      expect(putCalls[0]!.value).toEqual({ text: 'v1' })
    })

    it('pendingWrites stays 0 when not frozen', async () => {
      const { service } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.put('decisions', SCOPE, 'k1', { text: 'v1' })
      await snapshot.put('decisions', SCOPE, 'k2', { text: 'v2' })
      expect(snapshot.pendingWrites).toBe(0)
    })

    it('passes scope through to memoryService.put', async () => {
      const { service, putCalls } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)
      const customScope = { userId: 'u9' }
      await snapshot.put('ns1', customScope, 'k1', { text: 'v1' })
      expect(putCalls[0]!.scope).toEqual(customScope)
    })
  })

  describe('unfreeze()', () => {
    it('calls memoryService.put for each buffered write in order', async () => {
      const { service, putCalls } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze(['decisions'], SCOPE)
      await snapshot.put('decisions', SCOPE, 'k1', { text: 'v1' })
      await snapshot.put('decisions', SCOPE, 'k2', { text: 'v2' })
      await snapshot.put('decisions', SCOPE, 'k3', { text: 'v3' })
      expect(putCalls).toHaveLength(0)

      await snapshot.unfreeze()

      expect(putCalls).toHaveLength(3)
      expect(putCalls[0]!.key).toBe('k1')
      expect(putCalls[1]!.key).toBe('k2')
      expect(putCalls[2]!.key).toBe('k3')
    })

    it('sets isFrozen to false', async () => {
      const { service } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze(['ns1'], SCOPE)
      await snapshot.unfreeze()
      expect(snapshot.isFrozen()).toBe(false)
    })

    it('clears writeBuffer (pendingWrites → 0)', async () => {
      const { service } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze(['ns1'], SCOPE)
      await snapshot.put('ns1', SCOPE, 'k1', { text: 'v1' })
      expect(snapshot.pendingWrites).toBe(1)
      await snapshot.unfreeze()
      expect(snapshot.pendingWrites).toBe(0)
    })

    it('clears snapshots — subsequent get() delegates to service', async () => {
      const { service, getCalls } = createMockMemoryService({
        decisions: [{ key: 'd1', text: 'Use Postgres' }],
      })
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze(['decisions'], SCOPE)
      const callsAfterFreeze = getCalls.length
      await snapshot.unfreeze()

      // After unfreeze, get() should delegate
      await snapshot.get('decisions', SCOPE)
      expect(getCalls.length).toBe(callsAfterFreeze + 1)
    })

    it('preserves write data — buffered values match flushed values', async () => {
      const { service, putCalls } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze(['decisions'], SCOPE)
      const value = { text: 'Use Postgres', confidence: 0.9 }
      await snapshot.put('decisions', SCOPE, 'k1', value)
      await snapshot.unfreeze()
      expect(putCalls[0]!.value).toEqual(value)
    })

    it('preserves namespace, scope, and key during flush', async () => {
      const { service, putCalls } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze(['ns1'], SCOPE)
      const customScope = { userId: 'u1' }
      await snapshot.put('myns', customScope, 'mykey', { text: 'foo' })
      await snapshot.unfreeze()
      expect(putCalls[0]!).toMatchObject({
        ns: 'myns',
        scope: customScope,
        key: 'mykey',
        value: { text: 'foo' },
      })
    })

    it('unfreezing with no buffered writes is a no-op for puts', async () => {
      const { service, putCalls } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze(['decisions'], SCOPE)
      await snapshot.unfreeze()
      expect(putCalls).toHaveLength(0)
      expect(snapshot.isFrozen()).toBe(false)
    })
  })

  describe('pendingWrites getter', () => {
    it('is 0 initially', () => {
      const { service } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)
      expect(snapshot.pendingWrites).toBe(0)
    })

    it('is 0 right after freeze', async () => {
      const { service } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze(['ns1'], SCOPE)
      expect(snapshot.pendingWrites).toBe(0)
    })

    it('is 0 after unfreeze', async () => {
      const { service } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze(['ns1'], SCOPE)
      await snapshot.put('ns1', SCOPE, 'k', { text: 'v' })
      await snapshot.unfreeze()
      expect(snapshot.pendingWrites).toBe(0)
    })

    it('counts correctly as writes accumulate', async () => {
      const { service } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze(['ns1'], SCOPE)

      const counts: number[] = []
      counts.push(snapshot.pendingWrites)
      await snapshot.put('ns1', SCOPE, 'k1', { text: 'v1' })
      counts.push(snapshot.pendingWrites)
      await snapshot.put('ns1', SCOPE, 'k2', { text: 'v2' })
      counts.push(snapshot.pendingWrites)
      await snapshot.put('ns1', SCOPE, 'k3', { text: 'v3' })
      counts.push(snapshot.pendingWrites)
      expect(counts).toEqual([0, 1, 2, 3])
    })
  })

  describe('multiple freeze/unfreeze cycles', () => {
    it('each cycle works independently', async () => {
      const { service, putCalls } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)

      // Cycle 1
      await snapshot.freeze(['ns1'], SCOPE)
      await snapshot.put('ns1', SCOPE, 'k1', { text: 'cycle1' })
      await snapshot.unfreeze()
      expect(putCalls).toHaveLength(1)

      // Cycle 2
      await snapshot.freeze(['ns1'], SCOPE)
      await snapshot.put('ns1', SCOPE, 'k2', { text: 'cycle2' })
      await snapshot.unfreeze()
      expect(putCalls).toHaveLength(2)

      // Cycle 3
      await snapshot.freeze(['ns1'], SCOPE)
      await snapshot.put('ns1', SCOPE, 'k3', { text: 'cycle3' })
      await snapshot.unfreeze()
      expect(putCalls).toHaveLength(3)
    })

    it('buffer from previous cycle is fully flushed before next freeze', async () => {
      const { service, putCalls } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)

      await snapshot.freeze(['ns1'], SCOPE)
      await snapshot.put('ns1', SCOPE, 'k1', { text: 'v1' })
      await snapshot.put('ns1', SCOPE, 'k2', { text: 'v2' })
      await snapshot.unfreeze()
      expect(putCalls).toHaveLength(2)

      // Refreeze and add new write — only new write should be buffered
      await snapshot.freeze(['ns1'], SCOPE)
      expect(snapshot.pendingWrites).toBe(0)
      await snapshot.put('ns1', SCOPE, 'k3', { text: 'v3' })
      expect(snapshot.pendingWrites).toBe(1)

      await snapshot.unfreeze()
      expect(putCalls).toHaveLength(3)
      expect(putCalls[2]!.key).toBe('k3')
    })

    it('snapshots from previous freeze do not bleed into next freeze', async () => {
      const dataA = { ns1: [{ key: 'a', text: 'A-data' }] }
      const dataB = { ns1: [{ key: 'b', text: 'B-data' }] }
      const data: { ns1?: Record<string, unknown>[] } = {}

      const { service } = createMockMemoryService(data)
      const snapshot = new FrozenMemorySnapshot(service)

      // Cycle 1: data is dataA
      Object.assign(data, dataA)
      await snapshot.freeze(['ns1'], SCOPE)
      const r1 = await snapshot.get('ns1', SCOPE)
      expect(r1[0]!['key']).toBe('a')
      await snapshot.unfreeze()

      // Cycle 2: data changed to dataB
      delete data.ns1
      Object.assign(data, dataB)
      await snapshot.freeze(['ns1'], SCOPE)
      const r2 = await snapshot.get('ns1', SCOPE)
      expect(r2[0]!['key']).toBe('b')
    })
  })

  describe('formatForPrompt()', () => {
    it('returns empty string if namespace not in snapshot', () => {
      const { service } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)
      expect(snapshot.formatForPrompt('not_frozen')).toBe('')
    })

    it('returns empty string if namespace snapshot is empty array', async () => {
      const { service } = createMockMemoryService({ decisions: [] })
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze(['decisions'], SCOPE)
      expect(snapshot.formatForPrompt('decisions')).toBe('')
    })

    it('calls memoryService.formatForPrompt with correct args when data exists', async () => {
      const { service, formatForPromptCalls } = createMockMemoryService({
        decisions: [{ key: 'd1', text: 'Use Postgres' }],
      })
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze(['decisions'], SCOPE)
      const result = snapshot.formatForPrompt('decisions', '## Decisions')
      expect(formatForPromptCalls).toHaveLength(1)
      expect(formatForPromptCalls[0]!.records).toHaveLength(1)
      expect(formatForPromptCalls[0]!.options).toEqual({ header: '## Decisions' })
      expect(result).toBe('formatted(1)')
    })

    it('passes undefined header when none provided', async () => {
      const { service, formatForPromptCalls } = createMockMemoryService({
        decisions: [{ key: 'd1', text: 'A' }],
      })
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze(['decisions'], SCOPE)
      snapshot.formatForPrompt('decisions')
      expect(formatForPromptCalls[0]!.options).toEqual({ header: undefined })
    })

    it('returns empty string when not frozen even if namespace would have data', () => {
      const { service } = createMockMemoryService({
        decisions: [{ key: 'd1', text: 'A' }],
      })
      const snapshot = new FrozenMemorySnapshot(service)
      // Did not freeze
      expect(snapshot.formatForPrompt('decisions')).toBe('')
    })
  })

  describe('freeze with empty namespace list', () => {
    it('isFrozen still true', async () => {
      const { service } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze([], SCOPE)
      expect(snapshot.isFrozen()).toBe(true)
    })

    it('all get() calls delegate to service (no snapshots taken)', async () => {
      const { service, getCalls } = createMockMemoryService({
        decisions: [{ key: 'd1', text: 'A' }],
      })
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze([], SCOPE)
      expect(getCalls).toHaveLength(0)

      await snapshot.get('decisions', SCOPE)
      expect(getCalls).toHaveLength(1)
    })

    it('put() still buffers when frozen with empty namespace list', async () => {
      const { service, putCalls } = createMockMemoryService()
      const snapshot = new FrozenMemorySnapshot(service)
      await snapshot.freeze([], SCOPE)
      await snapshot.put('any', SCOPE, 'k', { text: 'v' })
      expect(putCalls).toHaveLength(0)
      expect(snapshot.pendingWrites).toBe(1)

      await snapshot.unfreeze()
      expect(putCalls).toHaveLength(1)
    })
  })

  describe('integration — full session lifecycle', () => {
    it('freeze → reads from snapshot, writes buffered → unfreeze flushes', async () => {
      const { service, putCalls, getCalls } = createMockMemoryService({
        decisions: [{ key: 'd1', text: 'Initial' }],
      })
      const snapshot = new FrozenMemorySnapshot(service)

      // Take snapshot
      await snapshot.freeze(['decisions'], SCOPE)
      const initialGetCalls = getCalls.length

      // During session: read returns frozen, write is buffered
      const reads: Record<string, unknown>[][] = []
      reads.push(await snapshot.get('decisions', SCOPE))
      await snapshot.put('decisions', SCOPE, 'd2', { text: 'New decision' })
      await snapshot.put('decisions', SCOPE, 'd3', { text: 'Another' })
      reads.push(await snapshot.get('decisions', SCOPE))

      // No additional service get calls during reads
      expect(getCalls.length).toBe(initialGetCalls)
      // No service puts yet
      expect(putCalls).toHaveLength(0)
      expect(snapshot.pendingWrites).toBe(2)

      // Frozen snapshot reads remain stable (do not include buffered writes)
      expect(reads[0]).toEqual(reads[1])

      // End of session: flush
      await snapshot.unfreeze()
      expect(putCalls).toHaveLength(2)
      expect(putCalls[0]!.key).toBe('d2')
      expect(putCalls[1]!.key).toBe('d3')
      expect(snapshot.isFrozen()).toBe(false)
    })
  })
})
