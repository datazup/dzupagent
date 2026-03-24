import { describe, it, expect } from 'vitest'
import { Semaphore } from '../concurrency/semaphore.js'
import { ConcurrencyPool } from '../concurrency/pool.js'

// --------------- Semaphore ---------------

describe('Semaphore', () => {
  it('initializes with correct available permits', () => {
    const sem = new Semaphore(3)
    expect(sem.available).toBe(3)
    expect(sem.queueLength).toBe(0)
  })

  it('throws on invalid maxPermits', () => {
    expect(() => new Semaphore(0)).toThrow('maxPermits must be >= 1')
    expect(() => new Semaphore(-1)).toThrow('maxPermits must be >= 1')
  })

  it('acquire decrements and release increments permits', async () => {
    const sem = new Semaphore(2)
    await sem.acquire()
    expect(sem.available).toBe(1)
    await sem.acquire()
    expect(sem.available).toBe(0)
    sem.release()
    expect(sem.available).toBe(1)
    sem.release()
    expect(sem.available).toBe(2)
  })

  it('throws when releasing more than acquired', async () => {
    const sem = new Semaphore(1)
    expect(() => sem.release()).toThrow('released more times than acquired')
  })

  it('blocks when no permits available and unblocks on release', async () => {
    const sem = new Semaphore(1)
    await sem.acquire()
    expect(sem.available).toBe(0)

    let acquired = false
    const pending = sem.acquire().then(() => {
      acquired = true
    })
    expect(sem.queueLength).toBe(1)
    expect(acquired).toBe(false)

    sem.release()
    await pending
    expect(acquired).toBe(true)
    expect(sem.queueLength).toBe(0)
  })

  it('run() acquires and releases automatically', async () => {
    const sem = new Semaphore(1)
    const result = await sem.run(async () => {
      expect(sem.available).toBe(0)
      return 42
    })
    expect(result).toBe(42)
    expect(sem.available).toBe(1)
  })

  it('run() releases on error', async () => {
    const sem = new Semaphore(1)
    await expect(
      sem.run(async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(sem.available).toBe(1)
  })

  it('limits concurrency correctly', async () => {
    const sem = new Semaphore(2)
    let concurrent = 0
    let maxConcurrent = 0

    const task = async () => {
      await sem.acquire()
      concurrent++
      if (concurrent > maxConcurrent) maxConcurrent = concurrent
      await new Promise((r) => setTimeout(r, 20))
      concurrent--
      sem.release()
    }

    await Promise.all([task(), task(), task(), task(), task()])
    expect(maxConcurrent).toBe(2)
  })
})

// --------------- ConcurrencyPool ---------------

describe('ConcurrencyPool', () => {
  it('defaults to maxConcurrent=10', () => {
    const pool = new ConcurrencyPool()
    const s = pool.stats()
    expect(s.active).toBe(0)
    expect(s.queued).toBe(0)
    expect(s.completed).toBe(0)
    expect(s.failed).toBe(0)
    expect(s.activeKeys).toEqual([])
  })

  it('executes and returns result', async () => {
    const pool = new ConcurrencyPool({ maxConcurrent: 2 })
    const result = await pool.execute('a', async () => 'hello')
    expect(result).toBe('hello')
    expect(pool.stats().completed).toBe(1)
  })

  it('tracks failures', async () => {
    const pool = new ConcurrencyPool({ maxConcurrent: 2 })
    await expect(
      pool.execute('a', async () => {
        throw new Error('fail')
      }),
    ).rejects.toThrow('fail')
    expect(pool.stats().failed).toBe(1)
    expect(pool.stats().completed).toBe(0)
  })

  it('limits global concurrency', async () => {
    const pool = new ConcurrencyPool({ maxConcurrent: 2 })
    let concurrent = 0
    let maxConcurrent = 0

    const task = (key: string) =>
      pool.execute(key, async () => {
        concurrent++
        if (concurrent > maxConcurrent) maxConcurrent = concurrent
        await new Promise((r) => setTimeout(r, 30))
        concurrent--
      })

    await Promise.all([task('a'), task('b'), task('c'), task('d')])
    expect(maxConcurrent).toBe(2)
    expect(pool.stats().completed).toBe(4)
  })

  it('limits per-key concurrency', async () => {
    const pool = new ConcurrencyPool({ maxConcurrent: 10, maxPerKey: 1 })
    let concurrentA = 0
    let maxConcurrentA = 0

    const task = (key: string) =>
      pool.execute(key, async () => {
        if (key === 'a') {
          concurrentA++
          if (concurrentA > maxConcurrentA) maxConcurrentA = concurrentA
        }
        await new Promise((r) => setTimeout(r, 20))
        if (key === 'a') concurrentA--
      })

    await Promise.all([task('a'), task('a'), task('a'), task('b'), task('b')])
    expect(maxConcurrentA).toBe(1)
    expect(pool.stats().completed).toBe(5)
  })

  it('reports activeKeys during execution', async () => {
    const pool = new ConcurrencyPool({ maxConcurrent: 10 })
    let captured: string[] = []

    await pool.execute('agent-x', async () => {
      captured = pool.stats().activeKeys
    })
    expect(captured).toContain('agent-x')
    // After completion, key should be gone
    expect(pool.stats().activeKeys).not.toContain('agent-x')
  })

  it('drain() waits for active operations', async () => {
    const pool = new ConcurrencyPool({ maxConcurrent: 2 })
    const results: number[] = []

    // Fire and forget
    void pool.execute('a', async () => {
      await new Promise((r) => setTimeout(r, 50))
      results.push(1)
    })
    void pool.execute('b', async () => {
      await new Promise((r) => setTimeout(r, 30))
      results.push(2)
    })

    await pool.drain()
    expect(results).toContain(1)
    expect(results).toContain(2)
    expect(pool.stats().active).toBe(0)
  })
})
