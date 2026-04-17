import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HLC } from '../crdt/hlc.js'
import type { HLCTimestamp } from '../crdt/types.js'

describe('HLC', () => {
  describe('now()', () => {
    it('returns a timestamp with the node id', () => {
      const h = new HLC('node-a')
      const ts = h.now()
      expect(ts.nodeId).toBe('node-a')
      expect(typeof ts.wallMs).toBe('number')
      expect(typeof ts.counter).toBe('number')
    })

    it('is monotonically increasing within one node', () => {
      const h = new HLC('n1')
      const ts1 = h.now()
      const ts2 = h.now()
      expect(HLC.compare(ts1, ts2)).toBe(-1)
    })

    it('increments counter when Date.now() is unchanged', () => {
      const spy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
      try {
        const h = new HLC('n1')
        const a = h.now()
        const b = h.now()
        expect(a.wallMs).toBe(1_000_000)
        expect(b.wallMs).toBe(1_000_000)
        expect(b.counter).toBe(a.counter + 1)
      } finally {
        spy.mockRestore()
      }
    })

    it('resets counter to 0 when wallMs advances', () => {
      const spy = vi.spyOn(Date, 'now')
      try {
        spy.mockReturnValue(1000)
        const h = new HLC('n1')
        h.now() // counter 0
        h.now() // counter 1
        spy.mockReturnValue(2000)
        const later = h.now()
        expect(later.wallMs).toBe(2000)
        expect(later.counter).toBe(0)
      } finally {
        spy.mockRestore()
      }
    })

    it('freezes wallMs to lastWallMs when physical clock goes backward', () => {
      const spy = vi.spyOn(Date, 'now')
      try {
        spy.mockReturnValue(5000)
        const h = new HLC('n1')
        const a = h.now()
        expect(a.wallMs).toBe(5000)
        // physical clock regresses
        spy.mockReturnValue(3000)
        const b = h.now()
        // Should stay at 5000 (max(physical=3000, last=5000))
        expect(b.wallMs).toBe(5000)
        expect(b.counter).toBe(a.counter + 1)
      } finally {
        spy.mockRestore()
      }
    })
  })

  describe('receive()', () => {
    let restoreSpy: (() => void) | undefined
    beforeEach(() => {
      const spy = vi.spyOn(Date, 'now').mockReturnValue(1000)
      restoreSpy = () => spy.mockRestore()
    })
    afterEach(() => {
      restoreSpy?.()
    })

    it('advances to remote.wallMs when remote is newer (increments remote counter on wallMs tie)', () => {
      const h = new HLC('n1')
      const remote: HLCTimestamp = { wallMs: 5000, counter: 0, nodeId: 'other' }
      const ts = h.receive(remote)
      // Because the chosen wallMs === remote.wallMs, counter = remote.counter + 1
      expect(ts.wallMs).toBe(5000)
      expect(ts.counter).toBe(1)
    })

    it('ties on remote only -> increments remote counter', () => {
      const h = new HLC('n1')
      const remote: HLCTimestamp = { wallMs: 5000, counter: 3, nodeId: 'other' }
      const ts = h.receive(remote)
      expect(ts.wallMs).toBe(5000)
      expect(ts.counter).toBe(4)
    })

    it('all three tie -> max(local, remote) + 1', () => {
      const spy = vi.spyOn(Date, 'now')
      spy.mockReturnValue(1000)
      const h = new HLC('n1')
      h.now() // local wall 1000 counter 0
      h.now() // local wall 1000 counter 1
      const remote: HLCTimestamp = { wallMs: 1000, counter: 5, nodeId: 'other' }
      const ts = h.receive(remote)
      expect(ts.wallMs).toBe(1000)
      expect(ts.counter).toBe(6) // max(1, 5) + 1
      spy.mockRestore()
    })

    it('ties with local only -> increments local counter', () => {
      const spy = vi.spyOn(Date, 'now').mockReturnValue(2000)
      const h = new HLC('n1')
      h.now() // wall 2000 counter 0
      h.now() // wall 2000 counter 1
      const remote: HLCTimestamp = { wallMs: 1000, counter: 99, nodeId: 'other' }
      const ts = h.receive(remote)
      expect(ts.wallMs).toBe(2000)
      expect(ts.counter).toBe(2)
      spy.mockRestore()
    })
  })

  describe('compare()', () => {
    it('returns 0 for identical timestamps', () => {
      const t: HLCTimestamp = { wallMs: 1, counter: 2, nodeId: 'a' }
      const t2: HLCTimestamp = { wallMs: 1, counter: 2, nodeId: 'a' }
      expect(HLC.compare(t, t2)).toBe(0)
    })

    it('compares by wallMs first', () => {
      const a: HLCTimestamp = { wallMs: 1, counter: 999, nodeId: 'z' }
      const b: HLCTimestamp = { wallMs: 2, counter: 0, nodeId: 'a' }
      expect(HLC.compare(a, b)).toBe(-1)
      expect(HLC.compare(b, a)).toBe(1)
    })

    it('compares by counter when wallMs ties', () => {
      const a: HLCTimestamp = { wallMs: 10, counter: 1, nodeId: 'z' }
      const b: HLCTimestamp = { wallMs: 10, counter: 2, nodeId: 'a' }
      expect(HLC.compare(a, b)).toBe(-1)
    })

    it('compares by nodeId when wallMs and counter tie', () => {
      const a: HLCTimestamp = { wallMs: 10, counter: 1, nodeId: 'aaa' }
      const b: HLCTimestamp = { wallMs: 10, counter: 1, nodeId: 'bbb' }
      expect(HLC.compare(a, b)).toBe(-1)
      expect(HLC.compare(b, a)).toBe(1)
    })

    it('gives strict total ordering (no ties across differing ids)', () => {
      const a: HLCTimestamp = { wallMs: 1, counter: 1, nodeId: 'x' }
      const b: HLCTimestamp = { wallMs: 1, counter: 1, nodeId: 'y' }
      expect(HLC.compare(a, b)).not.toBe(0)
    })
  })

  describe('cross-node interaction', () => {
    it('two nodes receiving each other stay causally ordered', () => {
      const spy = vi.spyOn(Date, 'now').mockReturnValue(1000)
      try {
        const a = new HLC('A')
        const b = new HLC('B')

        const aTs = a.now() // 1000, 0, A
        const bAfterA = b.receive(aTs) // >= 1000, counter+1, B
        const aAfterB = a.receive(bAfterA)

        expect(HLC.compare(aTs, bAfterA)).toBe(-1)
        expect(HLC.compare(bAfterA, aAfterB)).toBe(-1)
      } finally {
        spy.mockRestore()
      }
    })
  })
})
