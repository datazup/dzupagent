import { describe, it, expect } from 'vitest'
import { ConcurrencyPool } from '../concurrency/pool.js'

describe('ConcurrencyPool.drain()', () => {
  it('resolves immediately when pool is empty', async () => {
    const pool = new ConcurrencyPool({ maxConcurrent: 5 })
    await pool.drain() // Should not hang
  })

  it('waits for active tasks to complete', async () => {
    const pool = new ConcurrencyPool({ maxConcurrent: 2 })
    let completed = false

    pool.execute('test', async () => {
      await new Promise((r) => setTimeout(r, 50))
      completed = true
    })

    await pool.drain()
    expect(completed).toBe(true)
  })

  it('waits for queued tasks', async () => {
    const pool = new ConcurrencyPool({ maxConcurrent: 1 })
    const results: number[] = []

    pool.execute('a', async () => {
      await new Promise((r) => setTimeout(r, 20))
      results.push(1)
    })
    pool.execute('b', async () => {
      await new Promise((r) => setTimeout(r, 20))
      results.push(2)
    })

    await pool.drain()
    expect(results).toEqual([1, 2])
  })

  it('supports multiple concurrent drain() callers', async () => {
    const pool = new ConcurrencyPool({ maxConcurrent: 1 })
    let done = false

    pool.execute('task', async () => {
      await new Promise((r) => setTimeout(r, 30))
      done = true
    })

    await Promise.all([pool.drain(), pool.drain()])
    expect(done).toBe(true)
  })
})
