import { describe, it, expect, vi } from 'vitest'
import { buildFrozenSnapshot, FrozenSnapshot } from '../index.js'
import type { MemoryServiceLike } from '../snapshot-builder.js'

/**
 * Build an in-memory `MemoryServiceLike` double backed by a flat map keyed on
 * `${namespace}::${scopeJson}` so tests can verify namespace/scope routing.
 */
function makeMemory(
  partitions: Record<string, Record<string, unknown>[]>,
): MemoryServiceLike & { get: ReturnType<typeof vi.fn> } {
  const get = vi.fn(async (namespace: string, scope: Record<string, string>) => {
    const key = `${namespace}::${JSON.stringify(scope)}`
    return partitions[key] ?? []
  })
  return { get }
}

describe('buildFrozenSnapshot', () => {
  it('returns a FrozenSnapshot with all records embedded in the context', async () => {
    const records = [
      { text: 'first observation' },
      { text: 'second observation' },
      { text: 'third observation' },
    ]
    const memory = makeMemory({
      'lessons::{"tenantId":"t1"}': records,
    })

    const snapshot = await buildFrozenSnapshot(memory, 'lessons', { tenantId: 't1' })

    expect(snapshot).toBeInstanceOf(FrozenSnapshot)
    expect(snapshot.isActive()).toBe(true)

    const context = snapshot.get()
    expect(context).not.toBeNull()
    expect(context).toContain('first observation')
    expect(context).toContain('second observation')
    expect(context).toContain('third observation')
  })

  it('passes through the namespace and scope to the memory service', async () => {
    const memory = makeMemory({})

    await buildFrozenSnapshot(memory, 'decisions', { tenantId: 't7', projectId: 'p9' })

    expect(memory.get).toHaveBeenCalledTimes(1)
    expect(memory.get).toHaveBeenCalledWith('decisions', {
      tenantId: 't7',
      projectId: 'p9',
    })
  })

  it('namespace filtering — only records from the requested namespace are embedded', async () => {
    const memory = makeMemory({
      'lessons::{"tenantId":"t1"}': [{ text: 'keep me — lesson A' }],
      'decisions::{"tenantId":"t1"}': [{ text: 'do not leak — decision A' }],
    })

    const snapshot = await buildFrozenSnapshot(memory, 'lessons', { tenantId: 't1' })
    const context = snapshot.get() ?? ''

    expect(context).toContain('keep me — lesson A')
    expect(context).not.toContain('decision A')
  })

  it('defaults scope to {} when omitted', async () => {
    const memory = makeMemory({
      'global::{}': [{ text: 'global record' }],
    })

    const snapshot = await buildFrozenSnapshot(memory, 'global')

    expect(memory.get).toHaveBeenCalledWith('global', {})
    expect(snapshot.get()).toContain('global record')
  })

  it('serializes non-text records as JSON', async () => {
    const memory = makeMemory({
      'lessons::{"tenantId":"t1"}': [{ foo: 'bar', score: 42 }],
    })

    const snapshot = await buildFrozenSnapshot(memory, 'lessons', { tenantId: 't1' })
    const context = snapshot.get() ?? ''

    expect(context).toContain('"foo":"bar"')
    expect(context).toContain('"score":42')
  })

  it('truncates long records per maxCharsPerRecord', async () => {
    const longText = 'x'.repeat(5000)
    const memory = makeMemory({
      'lessons::{"tenantId":"t1"}': [{ text: longText }],
    })

    const snapshot = await buildFrozenSnapshot(
      memory,
      'lessons',
      { tenantId: 't1' },
      { maxCharsPerRecord: 100 },
    )
    const context = snapshot.get() ?? ''

    expect(context).toContain('...')
    // Header (~20 chars) + truncated body (~103 chars). Well below 5000.
    expect(context.length).toBeLessThan(500)
  })

  it('applies maxRecords to cap the number of embedded records', async () => {
    const memory = makeMemory({
      'lessons::{"tenantId":"t1"}': [
        { text: 'one' },
        { text: 'two' },
        { text: 'three' },
        { text: 'four' },
      ],
    })

    const snapshot = await buildFrozenSnapshot(
      memory,
      'lessons',
      { tenantId: 't1' },
      { maxRecords: 2 },
    )
    const context = snapshot.get() ?? ''

    expect(context).toContain('one')
    expect(context).toContain('two')
    expect(context).not.toContain('three')
    expect(context).not.toContain('four')
  })

  it('is non-fatal when the memory service throws — returns an active, header-only snapshot', async () => {
    const memory: MemoryServiceLike = {
      get: vi.fn().mockRejectedValue(new Error('boom')),
    }

    const snapshot = await buildFrozenSnapshot(memory, 'lessons', { tenantId: 't1' })

    expect(snapshot.isActive()).toBe(true)
    expect(snapshot.get()).toBe('## Memory Snapshot')
  })

  describe('memory decay / TTL filtering (P10 Track C)', () => {
    it('filters out expired records (expiresAt < Date.now())', async () => {
      const past = Date.now() - 10_000
      const memory = makeMemory({
        'lessons::{"tenantId":"t1"}': [
          { text: 'expired entry', expiresAt: past },
          { text: 'fresh entry' },
        ],
      })

      const snapshot = await buildFrozenSnapshot(memory, 'lessons', { tenantId: 't1' })
      const context = snapshot.get() ?? ''

      expect(context).not.toContain('expired entry')
      expect(context).toContain('fresh entry')
    })

    it('includes records whose expiresAt is still in the future', async () => {
      const future = Date.now() + 60_000
      const memory = makeMemory({
        'lessons::{"tenantId":"t1"}': [
          { text: 'still alive', expiresAt: future },
        ],
      })

      const snapshot = await buildFrozenSnapshot(memory, 'lessons', { tenantId: 't1' })
      const context = snapshot.get() ?? ''

      expect(context).toContain('still alive')
    })

    it('includes records with no expiresAt field (never expire)', async () => {
      const memory = makeMemory({
        'lessons::{"tenantId":"t1"}': [
          { text: 'eternal lesson' },
          { text: 'also eternal', agentId: 'a1', timestamp: 123 },
        ],
      })

      const snapshot = await buildFrozenSnapshot(memory, 'lessons', { tenantId: 't1' })
      const context = snapshot.get() ?? ''

      expect(context).toContain('eternal lesson')
      expect(context).toContain('also eternal')
    })

    it('treats expiresAt exactly equal to now as still live (boundary)', async () => {
      const now = Date.now()
      const originalNow = Date.now
      Date.now = () => now
      try {
        const memory = makeMemory({
          'lessons::{"tenantId":"t1"}': [
            { text: 'boundary record', expiresAt: now },
          ],
        })

        const snapshot = await buildFrozenSnapshot(memory, 'lessons', { tenantId: 't1' })
        const context = snapshot.get() ?? ''

        expect(context).toContain('boundary record')
      } finally {
        Date.now = originalNow
      }
    })

    it('ignores non-numeric expiresAt values and keeps those records', async () => {
      const memory = makeMemory({
        'lessons::{"tenantId":"t1"}': [
          { text: 'string expiresAt', expiresAt: 'not-a-number' },
          { text: 'null expiresAt', expiresAt: null },
        ],
      })

      const snapshot = await buildFrozenSnapshot(memory, 'lessons', { tenantId: 't1' })
      const context = snapshot.get() ?? ''

      expect(context).toContain('string expiresAt')
      expect(context).toContain('null expiresAt')
    })

    it('applies maxRecords after expiry filtering so live records fill the budget', async () => {
      const past = Date.now() - 10_000
      const memory = makeMemory({
        'lessons::{"tenantId":"t1"}': [
          { text: 'stale-1', expiresAt: past },
          { text: 'stale-2', expiresAt: past },
          { text: 'live-1' },
          { text: 'live-2' },
          { text: 'live-3' },
        ],
      })

      const snapshot = await buildFrozenSnapshot(
        memory,
        'lessons',
        { tenantId: 't1' },
        { maxRecords: 2 },
      )
      const context = snapshot.get() ?? ''

      expect(context).not.toContain('stale-1')
      expect(context).not.toContain('stale-2')
      expect(context).toContain('live-1')
      expect(context).toContain('live-2')
      expect(context).not.toContain('live-3')
    })
  })

  it('honors a custom header', async () => {
    const memory = makeMemory({
      'lessons::{"tenantId":"t1"}': [{ text: 'lesson one' }],
    })

    const snapshot = await buildFrozenSnapshot(
      memory,
      'lessons',
      { tenantId: 't1' },
      { header: '## Custom Header' },
    )
    const context = snapshot.get() ?? ''

    expect(context.startsWith('## Custom Header')).toBe(true)
    expect(context).toContain('lesson one')
  })
})
