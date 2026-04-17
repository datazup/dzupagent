/**
 * Coverage tests for blackboard.ts — concat with different schemas,
 * edge cases in hasUpdates, getWriteSeq, dispose, and error paths.
 */

import { describe, it, expect } from 'vitest'
import { tableFromArrays } from 'apache-arrow'
import { ArrowBlackboard } from '../blackboard.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTable(data: Record<string, unknown[]>) {
  return tableFromArrays(data)
}

const config = {
  tables: {
    plan: { writer: 'agent://planner' },
    results: { writer: 'agent://executor' },
    logs: { writer: 'agent://logger' },
  },
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ArrowBlackboard — coverage', () => {
  describe('concat with different schemas', () => {
    it('concatenates tables where B has extra columns not in A', () => {
      const bb = new ArrowBlackboard(config)

      const tableA = makeTable({ id: ['a1'], name: ['Alice'] })
      const tableB = makeTable({ id: ['b1'], name: ['Bob'], extra: ['bonus'] })

      bb.append('plan', 'agent://planner', tableA)
      bb.append('plan', 'agent://planner', tableB)

      const snapshot = bb.read('plan')
      expect(snapshot).not.toBeNull()
      expect(snapshot!.table.numRows).toBe(2)
      expect(snapshot!.writeSeq).toBe(2)
    })

    it('concatenates tables where A has columns not in B', () => {
      const bb = new ArrowBlackboard(config)

      const tableA = makeTable({ id: ['a1'], color: ['red'] })
      const tableB = makeTable({ id: ['b1'] })

      bb.append('plan', 'agent://planner', tableA)
      bb.append('plan', 'agent://planner', tableB)

      const snapshot = bb.read('plan')
      expect(snapshot!.table.numRows).toBe(2)
    })

    it('concatenates when first table is empty', () => {
      const bb = new ArrowBlackboard(config)

      const empty = makeTable({ id: [] as string[] })
      const data = makeTable({ id: ['x1', 'x2'] })

      bb.append('plan', 'agent://planner', empty)
      bb.append('plan', 'agent://planner', data)

      const snapshot = bb.read('plan')
      // empty table concat returns the non-empty one
      expect(snapshot!.table.numRows).toBe(2)
    })

    it('concatenates when second table is empty', () => {
      const bb = new ArrowBlackboard(config)

      const data = makeTable({ id: ['x1'] })
      const empty = makeTable({ id: [] as string[] })

      bb.append('plan', 'agent://planner', data)
      bb.append('plan', 'agent://planner', empty)

      const snapshot = bb.read('plan')
      expect(snapshot!.table.numRows).toBe(1)
    })
  })

  describe('hasUpdates', () => {
    it('returns false for a table that has not been written', () => {
      const bb = new ArrowBlackboard(config)
      expect(bb.hasUpdates('plan', 0)).toBe(false)
    })

    it('returns true when writeSeq exceeds lastSeenSeq', () => {
      const bb = new ArrowBlackboard(config)
      bb.append('plan', 'agent://planner', makeTable({ id: ['a'] }))

      expect(bb.hasUpdates('plan', 0)).toBe(true)
      expect(bb.hasUpdates('plan', 1)).toBe(false)
    })

    it('returns false when up to date', () => {
      const bb = new ArrowBlackboard(config)
      bb.append('plan', 'agent://planner', makeTable({ id: ['a'] }))

      expect(bb.hasUpdates('plan', 1)).toBe(false)
      expect(bb.hasUpdates('plan', 999)).toBe(false)
    })
  })

  describe('getWriteSeq', () => {
    it('returns 0 for never-written table', () => {
      const bb = new ArrowBlackboard(config)
      expect(bb.getWriteSeq('plan')).toBe(0)
    })

    it('returns 0 for undefined table name', () => {
      const bb = new ArrowBlackboard(config)
      expect(bb.getWriteSeq('nonexistent')).toBe(0)
    })

    it('increments with each append', () => {
      const bb = new ArrowBlackboard(config)
      bb.append('plan', 'agent://planner', makeTable({ id: ['a'] }))
      expect(bb.getWriteSeq('plan')).toBe(1)

      bb.append('plan', 'agent://planner', makeTable({ id: ['b'] }))
      expect(bb.getWriteSeq('plan')).toBe(2)

      bb.append('plan', 'agent://planner', makeTable({ id: ['c'] }))
      expect(bb.getWriteSeq('plan')).toBe(3)
    })
  })

  describe('read', () => {
    it('returns null for a table that has not been written', () => {
      const bb = new ArrowBlackboard(config)
      expect(bb.read('plan')).toBeNull()
    })

    it('returns null for an undefined table name', () => {
      const bb = new ArrowBlackboard(config)
      expect(bb.read('nonexistent')).toBeNull()
    })

    it('includes lastWriteAt timestamp', () => {
      const bb = new ArrowBlackboard(config)
      const before = Date.now()
      bb.append('plan', 'agent://planner', makeTable({ id: ['a'] }))
      const after = Date.now()

      const snapshot = bb.read('plan')
      expect(snapshot!.lastWriteAt).toBeGreaterThanOrEqual(before)
      expect(snapshot!.lastWriteAt).toBeLessThanOrEqual(after)
    })
  })

  describe('append error paths', () => {
    it('throws when table name is not defined', () => {
      const bb = new ArrowBlackboard(config)
      expect(() =>
        bb.append('undefined_table', 'agent://planner', makeTable({ id: ['a'] })),
      ).toThrow('not defined in config')
    })

    it('throws when wrong writer tries to write', () => {
      const bb = new ArrowBlackboard(config)
      expect(() =>
        bb.append('plan', 'agent://executor', makeTable({ id: ['a'] })),
      ).toThrow('not authorized to write')
    })
  })

  describe('dispose', () => {
    it('clears all stored data', () => {
      const bb = new ArrowBlackboard(config)
      bb.append('plan', 'agent://planner', makeTable({ id: ['a'] }))
      bb.append('results', 'agent://executor', makeTable({ id: ['b'] }))

      bb.dispose()

      expect(bb.read('plan')).toBeNull()
      expect(bb.read('results')).toBeNull()
      expect(bb.getWriteSeq('plan')).toBe(0)
      expect(bb.getWriteSeq('results')).toBe(0)
    })

    it('allows writing again after dispose', () => {
      const bb = new ArrowBlackboard(config)
      bb.append('plan', 'agent://planner', makeTable({ id: ['a'] }))
      bb.dispose()

      bb.append('plan', 'agent://planner', makeTable({ id: ['new'] }))
      const snapshot = bb.read('plan')
      expect(snapshot!.table.numRows).toBe(1)
      expect(snapshot!.writeSeq).toBe(1)
    })
  })

  describe('multiple tables independence', () => {
    it('writes to different tables independently', () => {
      const bb = new ArrowBlackboard(config)
      bb.append('plan', 'agent://planner', makeTable({ id: ['p1', 'p2'] }))
      bb.append('results', 'agent://executor', makeTable({ id: ['r1'] }))

      expect(bb.read('plan')!.table.numRows).toBe(2)
      expect(bb.read('results')!.table.numRows).toBe(1)
      expect(bb.getWriteSeq('plan')).toBe(1)
      expect(bb.getWriteSeq('results')).toBe(1)
    })
  })
})
