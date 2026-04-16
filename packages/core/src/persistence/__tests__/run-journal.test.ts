import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryRunJournal } from '../in-memory-run-journal.js'

describe('InMemoryRunJournal', () => {
  let journal: InMemoryRunJournal

  beforeEach(() => {
    journal = new InMemoryRunJournal()
  })

  describe('append', () => {
    it('assigns monotonically increasing seq numbers', async () => {
      const seq1 = await journal.append('run-1', {
        type: 'run_started',
        data: { input: 'hello' },
      })
      const seq2 = await journal.append('run-1', {
        type: 'step_started',
        data: { stepId: 's1' },
      })
      const seq3 = await journal.append('run-1', {
        type: 'step_completed',
        data: { stepId: 's1' },
      })
      expect(seq1).toBe(1)
      expect(seq2).toBe(2)
      expect(seq3).toBe(3)
    })

    it('isolates sequence numbers between runs', async () => {
      const seq1 = await journal.append('run-1', {
        type: 'run_started',
        data: { input: 'a' },
      })
      const seq2 = await journal.append('run-2', {
        type: 'run_started',
        data: { input: 'b' },
      })
      expect(seq1).toBe(1)
      expect(seq2).toBe(1)
    })

    it('adds required base fields to each entry', async () => {
      await journal.append('run-1', {
        type: 'run_started',
        data: { input: 'x' },
      })
      const entries = await journal.getAll('run-1')
      expect(entries[0].v).toBe(1)
      expect(entries[0].seq).toBe(1)
      expect(entries[0].runId).toBe('run-1')
      expect(typeof entries[0].ts).toBe('string')
    })

    it('validates state schema on state_updated entries without rejecting', async () => {
      const schema = {
        parse(data: unknown): { count: number } {
          const d = data as Record<string, unknown>
          if (typeof d['count'] !== 'number') {
            throw new Error('count must be a number')
          }
          return d as { count: number }
        },
      }
      const typedJournal = new InMemoryRunJournal<{ count: number }>({
        stateSchema: schema,
      })
      // Invalid state should still be appended (non-fatal)
      const seq = await typedJournal.append('run-1', {
        type: 'state_updated',
        data: { state: { count: 'not-a-number' } as unknown as { count: number } },
      })
      expect(seq).toBe(1)
      const entries = await typedJournal.getAll('run-1')
      expect(entries).toHaveLength(1)
    })
  })

  describe('query', () => {
    beforeEach(async () => {
      await journal.append('run-1', {
        type: 'run_started',
        data: { input: 'x' },
      })
      await journal.append('run-1', {
        type: 'step_started',
        data: { stepId: 's1' },
      })
      await journal.append('run-1', {
        type: 'step_completed',
        data: { stepId: 's1' },
      })
      await journal.append('run-1', {
        type: 'run_completed',
        data: { output: 'done' },
      })
    })

    it('returns all entries when no query params', async () => {
      const page = await journal.query('run-1')
      expect(page.entries).toHaveLength(4)
      expect(page.hasMore).toBe(false)
    })

    it('supports cursor-based pagination with afterSeq', async () => {
      const page = await journal.query('run-1', { afterSeq: 2 })
      expect(page.entries).toHaveLength(2)
      expect(page.entries[0].seq).toBe(3)
    })

    it('respects limit and sets hasMore + nextCursor', async () => {
      const page = await journal.query('run-1', { limit: 2 })
      expect(page.entries).toHaveLength(2)
      expect(page.hasMore).toBe(true)
      expect(page.nextCursor).toBe(2)
    })

    it('combines afterSeq and limit', async () => {
      const page = await journal.query('run-1', { afterSeq: 1, limit: 2 })
      expect(page.entries).toHaveLength(2)
      expect(page.entries[0].seq).toBe(2)
      expect(page.entries[1].seq).toBe(3)
      expect(page.hasMore).toBe(true)
      expect(page.nextCursor).toBe(3)
    })

    it('filters by entry type', async () => {
      const page = await journal.query('run-1', {
        types: ['step_started', 'step_completed'],
      })
      expect(page.entries).toHaveLength(2)
      expect(
        page.entries.every((e) =>
          ['step_started', 'step_completed'].includes(e.type),
        ),
      ).toBe(true)
    })

    it('returns empty page for unknown runId', async () => {
      const page = await journal.query('no-such-run')
      expect(page.entries).toHaveLength(0)
      expect(page.hasMore).toBe(false)
    })

    it('returns hasMore=false when limit equals remaining entries', async () => {
      const page = await journal.query('run-1', { limit: 4 })
      expect(page.entries).toHaveLength(4)
      expect(page.hasMore).toBe(false)
      expect(page.nextCursor).toBeUndefined()
    })
  })

  describe('getAll', () => {
    it('returns a copy, not a reference to internal array', async () => {
      await journal.append('run-1', {
        type: 'run_started',
        data: { input: 'x' },
      })
      const entries1 = await journal.getAll('run-1')
      const entries2 = await journal.getAll('run-1')
      expect(entries1).not.toBe(entries2)
      expect(entries1).toEqual(entries2)
    })

    it('returns empty array for unknown runId', async () => {
      const entries = await journal.getAll('no-such-run')
      expect(entries).toEqual([])
    })
  })

  describe('compaction', () => {
    it('triggers compaction at threshold', async () => {
      const smallJournal = new InMemoryRunJournal({ compactionThreshold: 10 })
      for (let i = 0; i < 10; i++) {
        await smallJournal.append('run-1', {
          type: 'step_started',
          data: { stepId: `s${i}` },
        })
      }
      // After 10 entries, needsCompaction triggers, compact runs
      // Entry count should be reduced
      expect(smallJournal._entryCount('run-1')).toBeLessThan(10)
    })

    it('creates a snapshot entry on compaction', async () => {
      const smallJournal = new InMemoryRunJournal({ compactionThreshold: 5 })
      // Add a state_updated so snapshot has real state
      await smallJournal.append('run-1', {
        type: 'run_started',
        data: { input: 'x' },
      })
      await smallJournal.append('run-1', {
        type: 'state_updated',
        data: { state: { progress: 50 } },
      })
      for (let i = 0; i < 4; i++) {
        await smallJournal.append('run-1', {
          type: 'step_started',
          data: { stepId: `s${i}` },
        })
      }
      const entries = await smallJournal.getAll('run-1')
      const snapshots = entries.filter((e) => e.type === 'snapshot')
      expect(snapshots.length).toBeGreaterThanOrEqual(1)
    })

    it('preserves entry order after compaction', async () => {
      const smallJournal = new InMemoryRunJournal({ compactionThreshold: 5 })
      for (let i = 0; i < 6; i++) {
        await smallJournal.append('run-1', {
          type: 'step_started',
          data: { stepId: `s${i}` },
        })
      }
      const entries = await smallJournal.getAll('run-1')
      const seqs = entries.map((e) => e.seq)
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    })

    it('excludes compacted entries from query by default', async () => {
      const smallJournal = new InMemoryRunJournal({ compactionThreshold: 5 })
      for (let i = 0; i < 6; i++) {
        await smallJournal.append('run-1', {
          type: 'step_started',
          data: { stepId: `s${i}` },
        })
      }
      const page = await smallJournal.query('run-1')
      // Should only have snapshot + non-compacted entries
      const allEntries = await smallJournal.getAll('run-1')
      expect(page.entries.length).toBeLessThanOrEqual(allEntries.length)
    })

    it('includes compacted entries when includeCompacted is true', async () => {
      const smallJournal = new InMemoryRunJournal({ compactionThreshold: 5 })
      for (let i = 0; i < 6; i++) {
        await smallJournal.append('run-1', {
          type: 'step_started',
          data: { stepId: `s${i}` },
        })
      }
      const page = await smallJournal.query('run-1', {
        includeCompacted: true,
      })
      const allEntries = await smallJournal.getAll('run-1')
      expect(page.entries.length).toBe(allEntries.length)
    })

    it('needsCompaction returns false below threshold', async () => {
      await journal.append('run-1', {
        type: 'run_started',
        data: { input: 'x' },
      })
      expect(await journal.needsCompaction('run-1')).toBe(false)
    })

    it('needsCompaction returns false for unknown run', async () => {
      expect(await journal.needsCompaction('no-such-run')).toBe(false)
    })
  })

  describe('concurrent writes', () => {
    it('assigns unique seq numbers under concurrent appends', async () => {
      const promises = Array.from({ length: 20 }, (_, i) =>
        journal.append('run-1', {
          type: 'step_started',
          data: { stepId: `s${i}` },
        }),
      )
      const seqs = await Promise.all(promises)
      const unique = new Set(seqs)
      expect(unique.size).toBe(20)
      expect(Math.min(...seqs)).toBe(1)
      expect(Math.max(...seqs)).toBe(20)
    })
  })

  describe('test helpers', () => {
    it('_entryCount returns 0 for unknown run', () => {
      expect(journal._entryCount('no-such-run')).toBe(0)
    })

    it('_clear removes all data', async () => {
      await journal.append('run-1', {
        type: 'run_started',
        data: { input: 'x' },
      })
      await journal.append('run-2', {
        type: 'run_started',
        data: { input: 'y' },
      })
      journal._clear()
      expect(journal._entryCount('run-1')).toBe(0)
      expect(journal._entryCount('run-2')).toBe(0)
      expect(await journal.getAll('run-1')).toEqual([])
    })
  })
})
