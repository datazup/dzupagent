import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  WorkingMemory,
  createWorkingMemory,
} from '../persistence/working-memory.js'
import type { WorkingMemorySnapshot } from '../persistence/working-memory-types.js'

interface SessionState extends Record<string, unknown> {
  taskId: string
  attempts: number
  metadata: { user: string; tags: string[] }
  flag: boolean
}

describe('WorkingMemory — basic get/set/delete/clear/has/keys/size', () => {
  let mem: WorkingMemory<SessionState>

  beforeEach(() => {
    mem = new WorkingMemory<SessionState>()
  })

  it('stores and retrieves a string value', () => {
    mem.set('taskId', 'abc-123')
    expect(mem.get('taskId')).toBe('abc-123')
  })

  it('stores and retrieves a number value', () => {
    mem.set('attempts', 7)
    expect(mem.get('attempts')).toBe(7)
  })

  it('returns undefined for an unknown key', () => {
    expect(mem.get('taskId')).toBeUndefined()
  })

  it('reports has() correctly for present and absent keys', () => {
    mem.set('flag', true)
    expect(mem.has('flag')).toBe(true)
    expect(mem.has('taskId')).toBe(false)
  })

  it('delete() removes a key and returns true', () => {
    mem.set('taskId', 'x')
    expect(mem.delete('taskId')).toBe(true)
    expect(mem.has('taskId')).toBe(false)
  })

  it('delete() returns false for an absent key', () => {
    expect(mem.delete('nope')).toBe(false)
  })

  it('clear() drops every entry and resets size to 0', () => {
    mem.set('taskId', 'a')
    mem.set('attempts', 1)
    mem.clear()
    expect(mem.size).toBe(0)
    expect(mem.has('taskId')).toBe(false)
    expect(mem.keys()).toEqual([])
  })

  it('keys() returns all live keys and size matches', () => {
    mem.set('taskId', 'a')
    mem.set('attempts', 1)
    mem.set('flag', true)
    expect(mem.keys().sort()).toEqual(['attempts', 'flag', 'taskId'])
    expect(mem.size).toBe(3)
  })
})

describe('WorkingMemory — TypeScript generic safety', () => {
  it('coexists with mixed value types', () => {
    const mem = new WorkingMemory<SessionState>()
    mem.set('taskId', 'tid')
    mem.set('attempts', 3)
    mem.set('flag', false)
    mem.set('metadata', { user: 'alice', tags: ['x'] })
    expect(mem.get('taskId')).toBe('tid')
    expect(mem.get('attempts')).toBe(3)
    expect(mem.get('flag')).toBe(false)
    expect(mem.get('metadata')).toEqual({ user: 'alice', tags: ['x'] })
  })

  it('supports nested object values without coercion', () => {
    interface Nested extends Record<string, unknown> {
      data: { a: { b: { c: number } } }
    }
    const mem = new WorkingMemory<Nested>()
    mem.set('data', { a: { b: { c: 42 } } })
    expect(mem.get('data')?.a.b.c).toBe(42)
  })

  it('supports array values', () => {
    interface ListState extends Record<string, unknown> {
      items: number[]
    }
    const mem = new WorkingMemory<ListState>()
    mem.set('items', [1, 2, 3])
    expect(mem.get('items')).toEqual([1, 2, 3])
  })
})

describe('WorkingMemory — TTL behaviour', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the value before TTL expires', () => {
    const mem = new WorkingMemory<{ k: string }>()
    mem.set('k', 'v', 1000)
    vi.advanceTimersByTime(500)
    expect(mem.get('k')).toBe('v')
  })

  it('returns undefined after TTL expires', () => {
    const mem = new WorkingMemory<{ k: string }>()
    mem.set('k', 'v', 1000)
    vi.advanceTimersByTime(1500)
    expect(mem.get('k')).toBeUndefined()
  })

  it('has() returns false for expired key', () => {
    const mem = new WorkingMemory<{ k: string }>()
    mem.set('k', 'v', 100)
    vi.advanceTimersByTime(200)
    expect(mem.has('k')).toBe(false)
  })

  it('per-call TTL overrides defaultTtlMs', () => {
    const mem = new WorkingMemory<{ a: string; b: string }>({ defaultTtlMs: 1000 })
    mem.set('a', 'short', 100) // override to 100ms
    mem.set('b', 'long') // uses default 1000ms
    vi.advanceTimersByTime(200)
    expect(mem.get('a')).toBeUndefined()
    expect(mem.get('b')).toBe('long')
  })

  it('keys with no TTL never expire', () => {
    const mem = new WorkingMemory<{ k: string }>()
    mem.set('k', 'v')
    vi.advanceTimersByTime(10_000_000)
    expect(mem.get('k')).toBe('v')
  })

  it('expired key counted as removed by delete()', () => {
    const mem = new WorkingMemory<{ k: string }>()
    mem.set('k', 'v', 100)
    vi.advanceTimersByTime(200)
    expect(mem.delete('k')).toBe(false)
  })
})

describe('WorkingMemory — LRU eviction', () => {
  it('evicts the least-recently-used key when maxKeys is exceeded', () => {
    const mem = new WorkingMemory<Record<string, string>>({ maxKeys: 3 })
    mem.set('a', '1')
    mem.set('b', '2')
    mem.set('c', '3')
    mem.set('d', '4') // forces eviction of 'a' (least recently used)
    expect(mem.has('a')).toBe(false)
    expect(mem.has('b')).toBe(true)
    expect(mem.has('c')).toBe(true)
    expect(mem.has('d')).toBe(true)
    expect(mem.size).toBe(3)
  })

  it('get() updates LRU order so the touched key is preserved', () => {
    const mem = new WorkingMemory<Record<string, string>>({ maxKeys: 3 })
    mem.set('a', '1')
    mem.set('b', '2')
    mem.set('c', '3')
    mem.get('a') // 'a' becomes most recently used
    mem.set('d', '4') // should evict 'b' now
    expect(mem.has('a')).toBe(true)
    expect(mem.has('b')).toBe(false)
  })

  it('set() on existing key refreshes LRU position without evicting', () => {
    const mem = new WorkingMemory<Record<string, string>>({ maxKeys: 3 })
    mem.set('a', '1')
    mem.set('b', '2')
    mem.set('c', '3')
    mem.set('a', '1-new') // 'a' becomes most recent
    mem.set('d', '4') // should evict 'b'
    expect(mem.has('a')).toBe(true)
    expect(mem.get('a')).toBe('1-new')
    expect(mem.has('b')).toBe(false)
  })

  it('throws on invalid maxKeys', () => {
    expect(() => new WorkingMemory({ maxKeys: 0 })).toThrow()
    expect(() => new WorkingMemory({ maxKeys: -1 })).toThrow()
    expect(() => new WorkingMemory({ maxKeys: Number.NaN })).toThrow()
  })

  it('eviction fires onChange for evicted keys', () => {
    const onChange = vi.fn()
    const mem = new WorkingMemory<Record<string, string>>({ maxKeys: 2, onChange })
    mem.set('a', '1')
    mem.set('b', '2')
    onChange.mockClear()
    mem.set('c', '3') // evicts 'a'
    const calls = onChange.mock.calls.map(c => c[0])
    expect(calls).toContain('a') // eviction event
    expect(calls).toContain('c') // set event
  })
})

describe('WorkingMemory — onChange callback', () => {
  it('fires after a set with (key, newValue, undefined) for a new key', () => {
    const onChange = vi.fn()
    const mem = new WorkingMemory<{ k: string }>({ onChange })
    mem.set('k', 'v')
    expect(onChange).toHaveBeenCalledWith('k', 'v', undefined)
  })

  it('fires with (key, newValue, prevValue) when value changes', () => {
    const onChange = vi.fn()
    const mem = new WorkingMemory<{ k: string }>({ onChange })
    mem.set('k', 'v1')
    onChange.mockClear()
    mem.set('k', 'v2')
    expect(onChange).toHaveBeenCalledWith('k', 'v2', 'v1')
  })

  it('does NOT fire when set with same value (referential equality)', () => {
    const onChange = vi.fn()
    const mem = new WorkingMemory<{ k: string }>({ onChange })
    mem.set('k', 'v')
    onChange.mockClear()
    mem.set('k', 'v')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('fires on delete with (key, undefined, prevValue)', () => {
    const onChange = vi.fn()
    const mem = new WorkingMemory<{ k: string }>({ onChange })
    mem.set('k', 'v')
    onChange.mockClear()
    mem.delete('k')
    expect(onChange).toHaveBeenCalledWith('k', undefined, 'v')
  })

  it('does NOT fire on delete of an absent key', () => {
    const onChange = vi.fn()
    const mem = new WorkingMemory<{ k: string }>({ onChange })
    mem.delete('k')
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('WorkingMemory — snapshot()', () => {
  it('returns a deep clone of the current state', () => {
    const mem = new WorkingMemory<SessionState>()
    mem.set('taskId', 't')
    mem.set('metadata', { user: 'alice', tags: ['x', 'y'] })
    const snap = mem.snapshot()
    expect(snap.data.taskId).toBe('t')
    expect(snap.data.metadata).toEqual({ user: 'alice', tags: ['x', 'y'] })
  })

  it('mutating the live store after snapshot does not affect the snapshot', () => {
    const mem = new WorkingMemory<{ items: number[] }>()
    mem.set('items', [1, 2, 3])
    const snap = mem.snapshot()
    mem.get('items')!.push(4) // mutate live array
    mem.set('items', [9, 9, 9]) // replace live entry
    expect(snap.data.items).toEqual([1, 2, 3])
  })

  it('mutating the snapshot data does not affect the live store', () => {
    const mem = new WorkingMemory<{ items: number[] }>()
    mem.set('items', [1, 2, 3])
    const snap = mem.snapshot()
    // The top-level object is frozen, but nested data is a deep clone.
    // Mutating the inner array must not bleed back into the live store.
    ;(snap.data.items as number[]).push(99)
    expect(mem.get('items')).toEqual([1, 2, 3])
  })

  it('records capturedAt as a Date.now() value', () => {
    const before = Date.now()
    const mem = new WorkingMemory<{ k: string }>()
    mem.set('k', 'v')
    const snap = mem.snapshot()
    const after = Date.now()
    expect(snap.capturedAt).toBeGreaterThanOrEqual(before)
    expect(snap.capturedAt).toBeLessThanOrEqual(after)
  })
})

describe('WorkingMemory — restore()', () => {
  it('replaces the entire state with the snapshot data', () => {
    const mem = new WorkingMemory<{ a: string; b: string }>()
    mem.set('a', 'old-a')
    mem.set('b', 'old-b')
    const snap: WorkingMemorySnapshot<{ a: string; b: string }> = {
      data: { a: 'new-a', b: 'new-b' },
      capturedAt: Date.now(),
    }
    mem.restore(snap)
    expect(mem.get('a')).toBe('new-a')
    expect(mem.get('b')).toBe('new-b')
  })

  it('removes keys that are not present in the snapshot', () => {
    const mem = new WorkingMemory<Record<string, string>>()
    mem.set('a', '1')
    mem.set('b', '2')
    mem.restore({ data: { a: '1' }, capturedAt: Date.now() })
    expect(mem.has('a')).toBe(true)
    expect(mem.has('b')).toBe(false)
  })

  it('fires onChange for every key whose value changed', () => {
    const onChange = vi.fn()
    const mem = new WorkingMemory<Record<string, string>>({ onChange })
    mem.set('a', 'old-a')
    mem.set('b', 'old-b')
    onChange.mockClear()
    mem.restore({ data: { a: 'new-a', c: 'c' }, capturedAt: Date.now() })
    const keys = onChange.mock.calls.map(c => c[0]).sort()
    expect(keys).toEqual(['a', 'b', 'c'])
  })

  it('clones snapshot data so external mutations do not affect the store', () => {
    const mem = new WorkingMemory<{ items: number[] }>()
    const data = { items: [1, 2, 3] }
    mem.restore({ data, capturedAt: Date.now() })
    data.items.push(99)
    expect(mem.get('items')).toEqual([1, 2, 3])
  })
})

describe('WorkingMemory — createWorkingMemory factory', () => {
  it('creates an instance with no config', () => {
    const mem = createWorkingMemory<{ k: string }>()
    expect(mem).toBeInstanceOf(WorkingMemory)
    mem.set('k', 'v')
    expect(mem.get('k')).toBe('v')
  })

  it('passes config through to the constructor', () => {
    const onChange = vi.fn()
    const mem = createWorkingMemory<{ k: string }>({ onChange, maxKeys: 5 })
    mem.set('k', 'v')
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})

describe('WorkingMemory — concurrent set operations', () => {
  it('handles 10 parallel sets with distinct keys', async () => {
    const mem = new WorkingMemory<Record<string, number>>()
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => Promise.resolve().then(() => mem.set(`k${i}`, i))),
    )
    expect(mem.size).toBe(10)
    for (let i = 0; i < 10; i++) {
      expect(mem.get(`k${i}`)).toBe(i)
    }
  })

  it('handles 10 parallel sets to the same key — last write wins-style consistency', async () => {
    const mem = new WorkingMemory<{ k: number }>()
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => Promise.resolve().then(() => mem.set('k', i))),
    )
    expect(mem.size).toBe(1)
    const v = mem.get('k')
    expect(typeof v).toBe('number')
    expect(v).toBeGreaterThanOrEqual(0)
    expect(v).toBeLessThan(10)
  })

  it('parallel mix of set + get does not corrupt the store', async () => {
    const mem = new WorkingMemory<Record<string, number>>()
    const ops: Promise<unknown>[] = []
    for (let i = 0; i < 20; i++) {
      ops.push(Promise.resolve().then(() => mem.set(`k${i % 5}`, i)))
      ops.push(Promise.resolve().then(() => mem.get(`k${i % 5}`)))
    }
    await Promise.all(ops)
    expect(mem.size).toBeLessThanOrEqual(5)
    for (const k of mem.keys()) {
      expect(mem.has(k)).toBe(true)
    }
  })
})

describe('WorkingMemory — JSON round-trip', () => {
  it('snapshot data survives JSON.stringify/parse and restore reproduces state', () => {
    const mem = new WorkingMemory<SessionState>()
    mem.set('taskId', 'tid')
    mem.set('attempts', 4)
    mem.set('metadata', { user: 'bob', tags: ['x', 'y'] })
    mem.set('flag', true)

    const snap = mem.snapshot()
    const json = JSON.stringify(snap.data)
    const parsed = JSON.parse(json) as SessionState

    const restored = new WorkingMemory<SessionState>()
    restored.restore({ data: parsed, capturedAt: Date.now() })

    expect(restored.get('taskId')).toBe('tid')
    expect(restored.get('attempts')).toBe(4)
    expect(restored.get('metadata')).toEqual({ user: 'bob', tags: ['x', 'y'] })
    expect(restored.get('flag')).toBe(true)
  })

  it('round-trip preserves nested object structure', () => {
    interface Deep extends Record<string, unknown> {
      nested: { a: { b: { c: number[] } } }
    }
    const mem = new WorkingMemory<Deep>()
    mem.set('nested', { a: { b: { c: [1, 2, 3] } } })
    const json = JSON.stringify(mem.snapshot().data)
    const parsed = JSON.parse(json) as Deep
    const restored = new WorkingMemory<Deep>()
    restored.restore({ data: parsed, capturedAt: Date.now() })
    expect(restored.get('nested')).toEqual({ a: { b: { c: [1, 2, 3] } } })
  })

  it('round-trip preserves keys() listing', () => {
    const mem = new WorkingMemory<Record<string, number>>()
    mem.set('a', 1)
    mem.set('b', 2)
    mem.set('c', 3)
    const json = JSON.stringify(mem.snapshot().data)
    const parsed = JSON.parse(json) as Record<string, number>
    const restored = new WorkingMemory<Record<string, number>>()
    restored.restore({ data: parsed, capturedAt: Date.now() })
    expect(restored.keys().sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('WorkingMemory — edge cases', () => {
  it('clear() on an empty store is a no-op', () => {
    const mem = new WorkingMemory()
    expect(() => mem.clear()).not.toThrow()
    expect(mem.size).toBe(0)
  })

  it('keys() on an empty store returns []', () => {
    const mem = new WorkingMemory()
    expect(mem.keys()).toEqual([])
  })

  it('size on an empty store is 0', () => {
    const mem = new WorkingMemory()
    expect(mem.size).toBe(0)
  })

  it('delete of a never-set key returns false and does not throw', () => {
    const mem = new WorkingMemory()
    expect(mem.delete('never')).toBe(false)
  })

  it('restore from an empty snapshot clears the store', () => {
    const mem = new WorkingMemory<Record<string, string>>()
    mem.set('a', '1')
    mem.set('b', '2')
    mem.restore({ data: {}, capturedAt: Date.now() })
    expect(mem.size).toBe(0)
    expect(mem.keys()).toEqual([])
  })
})

describe('WorkingMemory — size accuracy after TTL expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('size reflects expired entries as removed', () => {
    const mem = new WorkingMemory<Record<string, string>>()
    mem.set('a', '1', 100)
    mem.set('b', '2', 1000)
    mem.set('c', '3') // no TTL
    expect(mem.size).toBe(3)
    vi.advanceTimersByTime(200)
    expect(mem.size).toBe(2)
  })

  it('keys() omits expired entries', () => {
    const mem = new WorkingMemory<Record<string, string>>()
    mem.set('short', 'x', 100)
    mem.set('long', 'y', 10_000)
    vi.advanceTimersByTime(500)
    expect(mem.keys()).toEqual(['long'])
  })

  it('snapshot omits expired entries', () => {
    const mem = new WorkingMemory<Record<string, string>>()
    mem.set('short', 'x', 100)
    mem.set('long', 'y')
    vi.advanceTimersByTime(500)
    const snap = mem.snapshot()
    expect(snap.data).toEqual({ long: 'y' })
  })
})

describe('WorkingMemory — additional config validation', () => {
  it('throws on invalid defaultTtlMs', () => {
    expect(() => new WorkingMemory({ defaultTtlMs: 0 })).toThrow()
    expect(() => new WorkingMemory({ defaultTtlMs: -100 })).toThrow()
    expect(() => new WorkingMemory({ defaultTtlMs: Number.NaN })).toThrow()
  })

  it('does NOT throw when onChange listener throws — best-effort isolation', () => {
    const mem = new WorkingMemory<{ k: string }>({
      onChange: () => {
        throw new Error('boom')
      },
    })
    expect(() => mem.set('k', 'v')).not.toThrow()
    expect(mem.get('k')).toBe('v')
  })
})
