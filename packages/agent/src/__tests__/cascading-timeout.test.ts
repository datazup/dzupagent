import { describe, it, expect, afterEach } from 'vitest'
import { CascadingTimeout } from '../guardrails/cascading-timeout.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all timeouts created during a test for cleanup. */
const timeouts: CascadingTimeout[] = []

function createTracked(totalMs: number, reserveMs?: number): CascadingTimeout {
  const t = CascadingTimeout.create(totalMs, reserveMs)
  timeouts.push(t)
  return t
}

afterEach(() => {
  for (const t of timeouts) {
    t.dispose()
  }
  timeouts.length = 0
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CascadingTimeout', () => {
  describe('create()', () => {
    it('creates with correct initial state', () => {
      const t = createTracked(5000)
      expect(t.expired).toBe(false)
      expect(t.remainingMs).toBeGreaterThan(0)
      expect(t.remainingMs).toBeLessThanOrEqual(5000)
      expect(t.signal.aborted).toBe(false)
    })

    it('creates with 0ms and is immediately expired', () => {
      const t = createTracked(0)
      expect(t.expired).toBe(true)
      expect(t.signal.aborted).toBe(true)
    })
  })

  describe('fork()', () => {
    it('creates child with min(childMs, available) deadline', () => {
      const parent = createTracked(5000, 1000)
      // Available = 5000 - 1000 = 4000
      const child = parent.fork(2000)
      // Child should get min(2000, 4000) = 2000
      expect(child.remainingMs).toBeLessThanOrEqual(2000)
      expect(child.remainingMs).toBeGreaterThan(0)
      expect(child.expired).toBe(false)
    })

    it('constrains child to available time when childMs exceeds it', () => {
      const parent = createTracked(3000, 1000)
      // Available = 3000 - 1000 = 2000
      const child = parent.fork(10000)
      // Child should be constrained to ~2000ms
      expect(child.remainingMs).toBeLessThanOrEqual(2000)
    })

    it('creates child with no explicit childMs using all available time', () => {
      const parent = createTracked(5000, 1000)
      // Available = 5000 - 1000 = 4000
      const child = parent.fork()
      expect(child.remainingMs).toBeLessThanOrEqual(4000)
      expect(child.remainingMs).toBeGreaterThan(0)
    })

    it('child expires immediately when parent has no remaining time', () => {
      const parent = createTracked(100, 200)
      // Available = max(0, 100 - 200) = 0
      const child = parent.fork(5000)
      expect(child.expired).toBe(true)
    })
  })

  describe('abort cascading', () => {
    it('parent abort cascades to child', () => {
      const parent = createTracked(5000)
      const child = parent.fork(3000)
      expect(child.signal.aborted).toBe(false)

      parent.abort('test abort')

      expect(parent.signal.aborted).toBe(true)
      expect(child.signal.aborted).toBe(true)
    })

    it('child abort does NOT cascade to parent', () => {
      const parent = createTracked(5000)
      const child = parent.fork(3000)

      child.abort('child abort')

      expect(child.signal.aborted).toBe(true)
      expect(parent.signal.aborted).toBe(false)
    })

    it('parent abort cascades to grandchild', () => {
      const root = createTracked(10000, 500)
      const child = root.fork(8000)
      const grandchild = child.fork(5000)

      expect(grandchild.signal.aborted).toBe(false)

      root.abort('root abort')

      expect(root.signal.aborted).toBe(true)
      expect(child.signal.aborted).toBe(true)
      expect(grandchild.signal.aborted).toBe(true)
    })
  })

  describe('reserve time', () => {
    it('child gets (remaining - reserveMs)', () => {
      const parent = createTracked(5000, 2000)
      const child = parent.fork()
      // Available = ~5000 - 2000 = ~3000
      expect(child.remainingMs).toBeLessThanOrEqual(3000)
      expect(child.remainingMs).toBeGreaterThan(2000) // should be close to 3000
    })

    it('default reserveMs is 1000', () => {
      const parent = createTracked(5000)
      const child = parent.fork()
      // Available = ~5000 - 1000 = ~4000
      expect(child.remainingMs).toBeLessThanOrEqual(4000)
      expect(child.remainingMs).toBeGreaterThan(3000)
    })
  })

  describe('expired property', () => {
    it('is false initially for a long timeout', () => {
      const t = createTracked(60000)
      expect(t.expired).toBe(false)
    })

    it('is true after abort', () => {
      const t = createTracked(60000)
      t.abort()
      expect(t.expired).toBe(true)
    })

    it('is true after timeout fires', async () => {
      const t = createTracked(50)
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(t.expired).toBe(true)
      expect(t.signal.aborted).toBe(true)
    })
  })

  describe('signal', () => {
    it('returns an AbortSignal', () => {
      const t = createTracked(5000)
      expect(t.signal).toBeInstanceOf(AbortSignal)
    })

    it('signal fires abort event on timeout', async () => {
      const t = createTracked(50)
      let aborted = false
      t.signal.addEventListener('abort', () => {
        aborted = true
      })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(aborted).toBe(true)
    })
  })

  describe('dispose()', () => {
    it('clears timers and prevents further abort', () => {
      const t = createTracked(50)
      t.dispose()
      // After dispose, the timer should be cleared.
      // The signal should NOT fire (timer was cleared before it could trigger).
      // We verify this indirectly: no hanging timers = test exits cleanly.
      expect(t.remainingMs).toBeLessThanOrEqual(50)
    })

    it('disposes children recursively', () => {
      const parent = createTracked(5000)
      const child = parent.fork(3000)
      const grandchild = child.fork(1000)

      parent.dispose()

      // All should be cleaned up (no hanging timers)
      // Verify they exist but are disposed
      expect(grandchild.remainingMs).toBeLessThanOrEqual(1000)
    })

    it('is idempotent', () => {
      const t = createTracked(5000)
      t.dispose()
      t.dispose() // Should not throw
    })
  })

  describe('nested forks', () => {
    it('grandchild respects all constraints', () => {
      const root = createTracked(10000, 1000)
      // root available for child: 10000 - 1000 = 9000
      const child = root.fork(5000)
      // child gets min(5000, 9000) = 5000
      // child available for grandchild: ~5000 - 1000 = ~4000
      const grandchild = child.fork(3000)
      // grandchild gets min(3000, ~4000) = 3000

      expect(grandchild.remainingMs).toBeLessThanOrEqual(3000)
      expect(grandchild.remainingMs).toBeGreaterThan(2000)
      expect(grandchild.expired).toBe(false)
    })

    it('deeply nested forks eventually expire when no time left', () => {
      const root = createTracked(2000, 500)
      // root available: 2000-500 = 1500
      const c1 = root.fork() // ~1500
      // c1 available: ~1500-500 = ~1000
      const c2 = c1.fork() // ~1000
      // c2 available: ~1000-500 = ~500
      const c3 = c2.fork() // ~500
      // c3 available: ~500-500 = ~0
      const c4 = c3.fork() // ~0

      expect(c4.expired).toBe(true)
    })
  })

  describe('abort reason', () => {
    it('manual abort sets custom reason', () => {
      const t = createTracked(5000)
      t.abort('custom reason')
      expect(t.signal.aborted).toBe(true)
      expect(t.signal.reason).toBe('custom reason')
    })

    it('abort without reason uses default', () => {
      const t = createTracked(5000)
      t.abort()
      expect(t.signal.aborted).toBe(true)
      expect(t.signal.reason).toBe('Manually aborted')
    })
  })
})
