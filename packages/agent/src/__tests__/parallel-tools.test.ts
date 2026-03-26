import { describe, it, expect, vi } from 'vitest'
import {
  executeToolsParallel,
  type ParallelToolCall,
  type ToolLookup,
  type ToolExecutionResult,
} from '../agent/parallel-executor.js'

// ---------- Helpers ----------

/** Build a ToolLookup from a plain map of name -> handler. */
function buildRegistry(
  handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
): ToolLookup {
  const map = new Map(
    Object.entries(handlers).map(([name, fn]) => [name, { invoke: fn }]),
  )
  return {
    get: (name: string) => map.get(name),
    keys: () => map.keys(),
  }
}

/** Create a handler that delays for `ms` then returns `value`. */
function delayedHandler(value: string, ms: number) {
  return vi.fn(async () => {
    await new Promise((r) => setTimeout(r, ms))
    return value
  })
}

/** Create a handler that throws after an optional delay. */
function failingHandler(errorMsg: string, ms = 0) {
  return vi.fn(async () => {
    if (ms > 0) await new Promise((r) => setTimeout(r, ms))
    throw new Error(errorMsg)
  })
}

// ---------- Tests ----------

describe('executeToolsParallel', () => {
  it('returns empty array for empty calls', async () => {
    const registry = buildRegistry({})
    const results = await executeToolsParallel([], registry, { maxConcurrency: 5 })
    expect(results).toEqual([])
  })

  it('executes a single tool call', async () => {
    const handler = vi.fn(async () => 'hello')
    const registry = buildRegistry({ greet: handler })

    const results = await executeToolsParallel(
      [{ id: 'c1', name: 'greet', args: { who: 'world' } }],
      registry,
      { maxConcurrency: 5 },
    )

    expect(results).toHaveLength(1)
    expect(results[0]!.toolName).toBe('greet')
    expect(results[0]!.result).toBe('hello')
    expect(results[0]!.error).toBeUndefined()
    expect(results[0]!.durationMs).toBeGreaterThanOrEqual(0)
    expect(handler).toHaveBeenCalledWith({ who: 'world' })
  })

  it('executes tools concurrently (parallel is faster than sequential)', async () => {
    const delay = 40
    const registry = buildRegistry({
      a: delayedHandler('ra', delay),
      b: delayedHandler('rb', delay),
      c: delayedHandler('rc', delay),
    })

    const calls: ParallelToolCall[] = [
      { id: 'c0', name: 'a', args: {} },
      { id: 'c1', name: 'b', args: {} },
      { id: 'c2', name: 'c', args: {} },
    ]

    const start = performance.now()
    const results = await executeToolsParallel(calls, registry, { maxConcurrency: 5 })
    const elapsed = performance.now() - start

    expect(results).toHaveLength(3)
    // With 3 tools of 40ms each running in parallel, total should be ~40ms not ~120ms
    // Use generous margin for CI variance
    expect(elapsed).toBeLessThan(delay * 2.5)

    // Results should be in order
    expect(results[0]!.toolName).toBe('a')
    expect(results[1]!.toolName).toBe('b')
    expect(results[2]!.toolName).toBe('c')
  })

  it('respects concurrency limit (semaphore pattern)', async () => {
    const delay = 30
    let peakConcurrency = 0
    let currentConcurrency = 0

    const trackingHandler = (value: string) => vi.fn(async () => {
      currentConcurrency++
      if (currentConcurrency > peakConcurrency) {
        peakConcurrency = currentConcurrency
      }
      await new Promise((r) => setTimeout(r, delay))
      currentConcurrency--
      return value
    })

    const registry = buildRegistry({
      t0: trackingHandler('r0'),
      t1: trackingHandler('r1'),
      t2: trackingHandler('r2'),
      t3: trackingHandler('r3'),
      t4: trackingHandler('r4'),
    })

    const calls: ParallelToolCall[] = Array.from({ length: 5 }, (_, i) => ({
      id: `c${i}`,
      name: `t${i}`,
      args: {},
    }))

    const results = await executeToolsParallel(calls, registry, { maxConcurrency: 2 })

    expect(results).toHaveLength(5)
    // Peak concurrency should never exceed the limit
    expect(peakConcurrency).toBeLessThanOrEqual(2)
    // But it should actually USE the concurrency (at least 2 ran together)
    expect(peakConcurrency).toBe(2)
  })

  it('handles partial failures without crashing other tools', async () => {
    const registry = buildRegistry({
      good1: delayedHandler('ok1', 10),
      bad: failingHandler('tool crashed', 10),
      good2: delayedHandler('ok2', 10),
    })

    const calls: ParallelToolCall[] = [
      { id: 'c0', name: 'good1', args: {} },
      { id: 'c1', name: 'bad', args: {} },
      { id: 'c2', name: 'good2', args: {} },
    ]

    const results = await executeToolsParallel(calls, registry, { maxConcurrency: 5 })

    expect(results).toHaveLength(3)

    // First tool succeeded
    expect(results[0]!.result).toBe('ok1')
    expect(results[0]!.error).toBeUndefined()

    // Second tool failed
    expect(results[1]!.error).toBe('tool crashed')
    expect(results[1]!.result).toBeUndefined()

    // Third tool still succeeded
    expect(results[2]!.result).toBe('ok2')
    expect(results[2]!.error).toBeUndefined()
  })

  it('returns error for missing tools', async () => {
    const registry = buildRegistry({
      exists: vi.fn(async () => 'yes'),
    })

    const results = await executeToolsParallel(
      [{ id: 'c0', name: 'nonexistent', args: {} }],
      registry,
      { maxConcurrency: 5 },
    )

    expect(results).toHaveLength(1)
    expect(results[0]!.error).toContain('not found')
    expect(results[0]!.error).toContain('exists') // lists available tools
  })

  it('respects AbortSignal cancellation', async () => {
    const controller = new AbortController()
    const handler = delayedHandler('slow', 500)
    const registry = buildRegistry({ slow: handler })

    // Abort before execution can finish
    setTimeout(() => controller.abort(), 5)

    const results = await executeToolsParallel(
      [
        { id: 'c0', name: 'slow', args: {} },
        { id: 'c1', name: 'slow', args: {} },
      ],
      registry,
      { maxConcurrency: 1, signal: controller.signal },
    )

    expect(results).toHaveLength(2)
    // At least the second call should be aborted (first may have started)
    const abortedResults = results.filter(r => r.error === 'Aborted')
    expect(abortedResults.length).toBeGreaterThanOrEqual(1)
  })

  it('preserves result order regardless of completion order', async () => {
    // Tool 'slow' takes longer than 'fast', but slow is called first
    const registry = buildRegistry({
      slow: delayedHandler('slow-result', 50),
      fast: delayedHandler('fast-result', 5),
    })

    const calls: ParallelToolCall[] = [
      { id: 'c0', name: 'slow', args: {} },
      { id: 'c1', name: 'fast', args: {} },
    ]

    const results = await executeToolsParallel(calls, registry, { maxConcurrency: 5 })

    expect(results).toHaveLength(2)
    // Order matches input, not completion order
    expect(results[0]!.toolName).toBe('slow')
    expect(results[0]!.result).toBe('slow-result')
    expect(results[1]!.toolName).toBe('fast')
    expect(results[1]!.result).toBe('fast-result')
  })

  it('tracks per-tool timing accurately', async () => {
    const delay = 30
    const registry = buildRegistry({
      timed: delayedHandler('ok', delay),
    })

    const results = await executeToolsParallel(
      [{ id: 'c0', name: 'timed', args: {} }],
      registry,
      { maxConcurrency: 5 },
    )

    expect(results).toHaveLength(1)
    // Duration should be at least the delay (with margin for scheduling)
    expect(results[0]!.durationMs).toBeGreaterThanOrEqual(delay - 5)
    // But not absurdly large
    expect(results[0]!.durationMs).toBeLessThan(delay * 5)
  })

  it('calls onToolStart and onToolEnd callbacks', async () => {
    const onToolStart = vi.fn()
    const onToolEnd = vi.fn()
    const registry = buildRegistry({
      a: vi.fn(async () => 'result-a'),
    })

    await executeToolsParallel(
      [{ id: 'c0', name: 'a', args: { x: 1 } }],
      registry,
      { maxConcurrency: 5, onToolStart, onToolEnd },
    )

    expect(onToolStart).toHaveBeenCalledWith('a', { x: 1 })
    expect(onToolEnd).toHaveBeenCalledWith('a', expect.any(Number))
    // No error arg when successful
    expect(onToolEnd).toHaveBeenCalledWith('a', expect.any(Number))
  })

  it('calls onToolEnd with error for failed tools', async () => {
    const onToolEnd = vi.fn()
    const registry = buildRegistry({
      broken: failingHandler('oops'),
    })

    await executeToolsParallel(
      [{ id: 'c0', name: 'broken', args: {} }],
      registry,
      { maxConcurrency: 5, onToolEnd },
    )

    expect(onToolEnd).toHaveBeenCalledWith('broken', expect.any(Number), 'oops')
  })

  it('generates tool call IDs when not provided', async () => {
    const registry = buildRegistry({
      a: vi.fn(async () => 'ok'),
    })

    const results = await executeToolsParallel(
      [{ name: 'a', args: {} }], // no id
      registry,
      { maxConcurrency: 5 },
    )

    expect(results[0]!.toolCallId).toMatch(/^call_/)
  })

  it('handles maxConcurrency of 1 (sequential execution)', async () => {
    const delay = 20
    const times: number[] = []

    const trackingHandler = vi.fn(async () => {
      times.push(performance.now())
      await new Promise((r) => setTimeout(r, delay))
      return 'done'
    })

    const registry = buildRegistry({
      a: trackingHandler,
      b: trackingHandler,
      c: trackingHandler,
    })

    const calls: ParallelToolCall[] = [
      { id: 'c0', name: 'a', args: {} },
      { id: 'c1', name: 'b', args: {} },
      { id: 'c2', name: 'c', args: {} },
    ]

    const start = performance.now()
    await executeToolsParallel(calls, registry, { maxConcurrency: 1 })
    const elapsed = performance.now() - start

    // With concurrency 1, total time should be >= 3 * delay
    expect(elapsed).toBeGreaterThanOrEqual(delay * 2.5)

    // Each call should start after the previous finished
    expect(times).toHaveLength(3)
    for (let i = 1; i < times.length; i++) {
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(delay - 5)
    }
  })

  it('serializes non-string results to JSON', async () => {
    const registry = buildRegistry({
      obj: vi.fn(async () => ({ key: 'value', num: 42 })),
    })

    const results = await executeToolsParallel(
      [{ id: 'c0', name: 'obj', args: {} }],
      registry,
      { maxConcurrency: 5 },
    )

    expect(results[0]!.result).toBe('{"key":"value","num":42}')
  })
})
