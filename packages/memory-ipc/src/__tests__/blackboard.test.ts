import { describe, it, expect } from 'vitest'
import { tableFromArrays } from 'apache-arrow'

import { ArrowBlackboard } from '../blackboard.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSimpleTable(ids: string[]) {
  return tableFromArrays({
    id: ids,
    value: ids.map((_, i) => `val-${i}`),
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ArrowBlackboard', () => {
  const config = {
    tables: {
      plan: { writer: 'agent://planner' },
      results: { writer: 'agent://executor' },
    },
  }

  describe('append + read', () => {
    it('writes and reads back data', () => {
      const bb = new ArrowBlackboard(config)
      const table = makeSimpleTable(['a', 'b'])

      bb.append('plan', 'agent://planner', table)

      const snapshot = bb.read('plan')
      expect(snapshot).not.toBeNull()
      expect(snapshot!.table.numRows).toBe(2)
      expect(snapshot!.writeSeq).toBe(1)

      const idCol = snapshot!.table.getChild('id')
      expect(idCol?.get(0)).toBe('a')
      expect(idCol?.get(1)).toBe('b')
    })

    it('concatenates on successive appends', () => {
      const bb = new ArrowBlackboard(config)

      bb.append('plan', 'agent://planner', makeSimpleTable(['a']))
      bb.append('plan', 'agent://planner', makeSimpleTable(['b', 'c']))

      const snapshot = bb.read('plan')
      expect(snapshot!.table.numRows).toBe(3)
      expect(snapshot!.writeSeq).toBe(2)

      const idCol = snapshot!.table.getChild('id')
      expect(idCol?.get(0)).toBe('a')
      expect(idCol?.get(1)).toBe('b')
      expect(idCol?.get(2)).toBe('c')
    })

    it('returns null for unwritten table', () => {
      const bb = new ArrowBlackboard(config)
      expect(bb.read('plan')).toBeNull()
    })
  })

  describe('writer authorization', () => {
    it('throws when non-designated writer attempts append', () => {
      const bb = new ArrowBlackboard(config)
      const table = makeSimpleTable(['x'])

      expect(() => {
        bb.append('plan', 'agent://executor', table)
      }).toThrow(/not authorized/)
    })

    it('throws for undefined table name', () => {
      const bb = new ArrowBlackboard(config)
      const table = makeSimpleTable(['x'])

      expect(() => {
        bb.append('nonexistent', 'agent://planner', table)
      }).toThrow(/not defined/)
    })

    it('allows correct writer', () => {
      const bb = new ArrowBlackboard(config)
      const table = makeSimpleTable(['x'])

      expect(() => {
        bb.append('results', 'agent://executor', table)
      }).not.toThrow()
    })
  })

  describe('hasUpdates', () => {
    it('returns false before any writes', () => {
      const bb = new ArrowBlackboard(config)
      expect(bb.hasUpdates('plan', 0)).toBe(false)
    })

    it('returns true after write when lastSeenSeq is 0', () => {
      const bb = new ArrowBlackboard(config)
      bb.append('plan', 'agent://planner', makeSimpleTable(['a']))

      expect(bb.hasUpdates('plan', 0)).toBe(true)
    })

    it('returns false when lastSeenSeq matches current', () => {
      const bb = new ArrowBlackboard(config)
      bb.append('plan', 'agent://planner', makeSimpleTable(['a']))

      expect(bb.hasUpdates('plan', 1)).toBe(false)
    })

    it('returns true after new write', () => {
      const bb = new ArrowBlackboard(config)
      bb.append('plan', 'agent://planner', makeSimpleTable(['a']))
      bb.append('plan', 'agent://planner', makeSimpleTable(['b']))

      expect(bb.hasUpdates('plan', 1)).toBe(true)
      expect(bb.hasUpdates('plan', 2)).toBe(false)
    })
  })

  describe('getWriteSeq', () => {
    it('returns 0 for unwritten table', () => {
      const bb = new ArrowBlackboard(config)
      expect(bb.getWriteSeq('plan')).toBe(0)
    })

    it('increments on each append', () => {
      const bb = new ArrowBlackboard(config)

      bb.append('plan', 'agent://planner', makeSimpleTable(['a']))
      expect(bb.getWriteSeq('plan')).toBe(1)

      bb.append('plan', 'agent://planner', makeSimpleTable(['b']))
      expect(bb.getWriteSeq('plan')).toBe(2)

      bb.append('plan', 'agent://planner', makeSimpleTable(['c']))
      expect(bb.getWriteSeq('plan')).toBe(3)
    })

    it('tracks sequences per table independently', () => {
      const bb = new ArrowBlackboard(config)

      bb.append('plan', 'agent://planner', makeSimpleTable(['a']))
      bb.append('plan', 'agent://planner', makeSimpleTable(['b']))
      bb.append('results', 'agent://executor', makeSimpleTable(['x']))

      expect(bb.getWriteSeq('plan')).toBe(2)
      expect(bb.getWriteSeq('results')).toBe(1)
    })
  })

  describe('dispose', () => {
    it('clears all data', () => {
      const bb = new ArrowBlackboard(config)
      bb.append('plan', 'agent://planner', makeSimpleTable(['a']))
      bb.append('results', 'agent://executor', makeSimpleTable(['x']))

      bb.dispose()

      expect(bb.read('plan')).toBeNull()
      expect(bb.read('results')).toBeNull()
      expect(bb.getWriteSeq('plan')).toBe(0)
      expect(bb.getWriteSeq('results')).toBe(0)
    })

    it('allows writing again after dispose', () => {
      const bb = new ArrowBlackboard(config)
      bb.append('plan', 'agent://planner', makeSimpleTable(['a']))
      bb.dispose()

      bb.append('plan', 'agent://planner', makeSimpleTable(['b']))
      const snapshot = bb.read('plan')
      expect(snapshot!.table.numRows).toBe(1)
      expect(snapshot!.writeSeq).toBe(1)
    })
  })
})
