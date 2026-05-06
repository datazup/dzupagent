import { describe, expect, it, vi } from 'vitest'
import { runAllConcurrently, runConcurrently } from '../orchestration/concurrency-runner.js'

const delay = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms)
})

describe('concurrency-runner', () => {
  it('preserves input order for allSettled results when tasks resolve out of order', async () => {
    const results = await runConcurrently([
      async () => {
        await delay(20)
        return 'first'
      },
      async () => {
        await delay(1)
        return 'second'
      },
      async () => 'third',
    ], 2)

    expect(results).toEqual([
      { status: 'fulfilled', value: 'first' },
      { status: 'fulfilled', value: 'second' },
      { status: 'fulfilled', value: 'third' },
    ])
  })

  it('respects maxConcurrency for allSettled execution', async () => {
    let active = 0
    let peak = 0
    const createTask = () => async () => {
      active++
      peak = Math.max(peak, active)
      await delay(5)
      active--
      return peak
    }

    await runConcurrently([createTask(), createTask(), createTask(), createTask()], 2)

    expect(peak).toBe(2)
  })

  it('preserves input order for Promise.all-style results', async () => {
    const results = await runAllConcurrently([
      async () => {
        await delay(20)
        return 'first'
      },
      async () => {
        await delay(1)
        return 'second'
      },
      async () => 'third',
    ], 2)

    expect(results).toEqual(['first', 'second', 'third'])
  })

  it('rejects on the first observed failure and does not start queued tasks', async () => {
    const started: string[] = []
    const neverStarted = vi.fn(async () => 'late')

    await expect(runAllConcurrently([
      async () => {
        started.push('bad')
        throw new Error('first failure')
      },
      async () => {
        started.push('queued')
        return neverStarted()
      },
    ], 1)).rejects.toThrow('first failure')

    expect(started).toEqual(['bad'])
    expect(neverStarted).not.toHaveBeenCalled()
  })
})
