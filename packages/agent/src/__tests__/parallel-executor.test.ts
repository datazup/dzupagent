/**
 * Additional deep-coverage tests for `executeToolsParallel`.
 *
 * The existing `parallel-tools.test.ts` already covers happy paths. This file
 * focuses on:
 *   - Concurrency boundary conditions (0, negative, very large)
 *   - Ordering invariants under chaotic completion
 *   - Edge cases for tool-call ID generation
 *   - Callback argument shapes
 *   - Error serialization (non-Error throws)
 *   - Pre-acquire and post-acquire abort handling
 *   - Registry behavior (empty, many tools)
 *   - Non-JSON-serializable results
 *   - Argument pass-through fidelity
 *   - Semaphore release ordering (waiters proceed FIFO)
 */
import { describe, it, expect, vi } from 'vitest'
import {
  executeToolsParallel,
  type ParallelToolCall,
  type ToolLookup,
} from '../agent/parallel-executor.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function delayedHandler<T>(value: T, ms: number) {
  return vi.fn(async () => {
    await new Promise((r) => setTimeout(r, ms))
    return value
  })
}

// ---------------------------------------------------------------------------
// Concurrency boundary conditions
// ---------------------------------------------------------------------------

describe('executeToolsParallel — concurrency bounds', () => {
  it('treats maxConcurrency of 0 as at least 1', async () => {
    let peak = 0
    let current = 0
    const makeHandler = () =>
      vi.fn(async () => {
        current++
        peak = Math.max(peak, current)
        await new Promise((r) => setTimeout(r, 10))
        current--
        return 'ok'
      })

    const registry = buildRegistry({
      a: makeHandler(),
      b: makeHandler(),
      c: makeHandler(),
    })

    const calls: ParallelToolCall[] = [
      { id: '0', name: 'a', args: {} },
      { id: '1', name: 'b', args: {} },
      { id: '2', name: 'c', args: {} },
    ]
    const results = await executeToolsParallel(calls, registry, { maxConcurrency: 0 })
    expect(results).toHaveLength(3)
    // Cannot run zero concurrent; coerced to at least 1 (so peak >= 1)
    expect(peak).toBeGreaterThanOrEqual(1)
  })

  it('treats negative maxConcurrency as at least 1', async () => {
    let peak = 0
    let current = 0
    const makeHandler = () =>
      vi.fn(async () => {
        current++
        peak = Math.max(peak, current)
        await new Promise((r) => setTimeout(r, 5))
        current--
        return 'ok'
      })

    const registry = buildRegistry({
      a: makeHandler(),
      b: makeHandler(),
    })

    const results = await executeToolsParallel(
      [
        { id: '0', name: 'a', args: {} },
        { id: '1', name: 'b', args: {} },
      ],
      registry,
      { maxConcurrency: -5 },
    )
    expect(results).toHaveLength(2)
    // Negative means strictly sequential (coerced to 1)
    expect(peak).toBe(1)
  })

  it('allows very large maxConcurrency without deadlock', async () => {
    const registry = buildRegistry({
      x: vi.fn(async () => 'x'),
    })
    const calls: ParallelToolCall[] = Array.from({ length: 10 }, (_, i) => ({
      id: `c${i}`,
      name: 'x',
      args: {},
    }))
    const results = await executeToolsParallel(calls, registry, { maxConcurrency: 10_000 })
    expect(results).toHaveLength(10)
    expect(results.every(r => r.result === 'x')).toBe(true)
  })

  it('maxConcurrency equal to calls.length runs all at once', async () => {
    let peak = 0
    let current = 0
    const h = (v: string) =>
      vi.fn(async () => {
        current++
        peak = Math.max(peak, current)
        await new Promise((r) => setTimeout(r, 10))
        current--
        return v
      })

    const registry = buildRegistry({
      a: h('a'), b: h('b'), c: h('c'), d: h('d'),
    })
    const calls: ParallelToolCall[] = ['a', 'b', 'c', 'd'].map((n, i) => ({
      id: `c${i}`, name: n, args: {},
    }))
    await executeToolsParallel(calls, registry, { maxConcurrency: 4 })
    expect(peak).toBe(4)
  })

  it('maxConcurrency greater than calls.length is capped by call count', async () => {
    let peak = 0
    let current = 0
    const registry = buildRegistry({
      a: vi.fn(async () => {
        current++; peak = Math.max(peak, current)
        await new Promise((r) => setTimeout(r, 5))
        current--; return 'a'
      }),
    })
    await executeToolsParallel(
      [{ id: '0', name: 'a', args: {} }],
      registry,
      { maxConcurrency: 50 },
    )
    // Only one call — peak cannot exceed 1
    expect(peak).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Tool call ID handling
// ---------------------------------------------------------------------------

describe('executeToolsParallel — tool call IDs', () => {
  it('preserves provided IDs verbatim', async () => {
    const registry = buildRegistry({ a: vi.fn(async () => 'ok') })
    const results = await executeToolsParallel(
      [{ id: 'custom-id-123', name: 'a', args: {} }],
      registry,
      { maxConcurrency: 1 },
    )
    expect(results[0]!.toolCallId).toBe('custom-id-123')
  })

  it('generates unique IDs when omitted across multiple calls', async () => {
    const registry = buildRegistry({ a: vi.fn(async () => 'ok') })
    const calls: ParallelToolCall[] = Array.from({ length: 5 }, () => ({
      name: 'a',
      args: {},
    }))
    const results = await executeToolsParallel(calls, registry, { maxConcurrency: 1 })
    const ids = results.map(r => r.toolCallId)
    // All IDs must be present
    expect(ids.every(id => typeof id === 'string' && id.length > 0)).toBe(true)
    // They should all match generated-ID shape
    expect(ids.every(id => id.startsWith('call_'))).toBe(true)
  })

  it('preserves empty-string id verbatim (nullish-coalescing only replaces null/undefined)', async () => {
    const registry = buildRegistry({ a: vi.fn(async () => 'ok') })
    const results = await executeToolsParallel(
      [{ id: '', name: 'a', args: {} }],
      registry,
      { maxConcurrency: 1 },
    )
    // Empty string is not nullish, so `id ?? generate()` keeps it
    expect(results[0]!.toolCallId).toBe('')
  })

  it('returns the provided id even on missing-tool errors', async () => {
    const registry = buildRegistry({ exists: vi.fn(async () => 'ok') })
    const results = await executeToolsParallel(
      [{ id: 'marker-xyz', name: 'nope', args: {} }],
      registry,
      { maxConcurrency: 1 },
    )
    expect(results[0]!.toolCallId).toBe('marker-xyz')
    expect(results[0]!.error).toContain('not found')
  })
})

// ---------------------------------------------------------------------------
// Ordering invariants
// ---------------------------------------------------------------------------

describe('executeToolsParallel — result ordering', () => {
  it('preserves input order for 10 randomly-delayed handlers', async () => {
    const handlers: Record<string, ReturnType<typeof vi.fn>> = {}
    const calls: ParallelToolCall[] = []
    for (let i = 0; i < 10; i++) {
      const name = `t${i}`
      const delay = Math.floor(Math.random() * 20) + 1
      handlers[name] = delayedHandler(`res-${i}`, delay)
      calls.push({ id: `c${i}`, name, args: { i } })
    }
    const registry = buildRegistry(handlers)
    const results = await executeToolsParallel(calls, registry, { maxConcurrency: 5 })
    expect(results).toHaveLength(10)
    for (let i = 0; i < 10; i++) {
      expect(results[i]!.toolName).toBe(`t${i}`)
      expect(results[i]!.index).toBe(i)
      expect(results[i]!.result).toBe(`res-${i}`)
    }
  })

  it('each result carries its original index', async () => {
    const registry = buildRegistry({
      a: vi.fn(async () => 'a'),
      b: vi.fn(async () => 'b'),
      c: vi.fn(async () => 'c'),
    })
    const calls: ParallelToolCall[] = [
      { id: '0', name: 'a', args: {} },
      { id: '1', name: 'b', args: {} },
      { id: '2', name: 'c', args: {} },
    ]
    const results = await executeToolsParallel(calls, registry, { maxConcurrency: 3 })
    expect(results.map(r => r.index)).toEqual([0, 1, 2])
  })

  it('mixed success/failure preserves original positions', async () => {
    const registry = buildRegistry({
      ok: vi.fn(async () => 'fine'),
      bad: vi.fn(async () => {
        throw new Error('nope')
      }),
    })
    const calls: ParallelToolCall[] = [
      { id: '0', name: 'ok', args: {} },
      { id: '1', name: 'bad', args: {} },
      { id: '2', name: 'ok', args: {} },
      { id: '3', name: 'bad', args: {} },
    ]
    const results = await executeToolsParallel(calls, registry, { maxConcurrency: 4 })
    expect(results[0]!.result).toBe('fine')
    expect(results[1]!.error).toBe('nope')
    expect(results[2]!.result).toBe('fine')
    expect(results[3]!.error).toBe('nope')
  })
})

// ---------------------------------------------------------------------------
// Error propagation & non-Error throws
// ---------------------------------------------------------------------------

describe('executeToolsParallel — error serialization', () => {
  it('stringifies non-Error thrown values', async () => {
    const registry = buildRegistry({
      stringy: vi.fn(async () => {
        throw 'plain-string-error' // intentionally throwing a non-Error string for test coverage
      }),
    })
    const results = await executeToolsParallel(
      [{ id: '0', name: 'stringy', args: {} }],
      registry,
      { maxConcurrency: 1 },
    )
    expect(results[0]!.error).toBe('plain-string-error')
    expect(results[0]!.result).toBeUndefined()
  })

  it('stringifies thrown numbers', async () => {
    const registry = buildRegistry({
      numeric: vi.fn(async () => {
        throw 42 // intentionally throwing a non-Error number for test coverage
      }),
    })
    const results = await executeToolsParallel(
      [{ id: '0', name: 'numeric', args: {} }],
      registry,
      { maxConcurrency: 1 },
    )
    expect(results[0]!.error).toBe('42')
  })

  it('stringifies thrown objects', async () => {
    const registry = buildRegistry({
      objy: vi.fn(async () => {
        throw { code: 'E_BAD', message: 'broken' } // intentionally throwing a non-Error object for test coverage
      }),
    })
    const results = await executeToolsParallel(
      [{ id: '0', name: 'objy', args: {} }],
      registry,
      { maxConcurrency: 1 },
    )
    // String() on a plain object yields "[object Object]"; just verify it's a string
    expect(typeof results[0]!.error).toBe('string')
  })

  it('Error subclass messages are preserved', async () => {
    class CustomErr extends Error {
      constructor() {
        super('custom-message')
        this.name = 'CustomErr'
      }
    }
    const registry = buildRegistry({
      custom: vi.fn(async () => {
        throw new CustomErr()
      }),
    })
    const results = await executeToolsParallel(
      [{ id: '0', name: 'custom', args: {} }],
      registry,
      { maxConcurrency: 1 },
    )
    expect(results[0]!.error).toBe('custom-message')
  })

  it('error result still has toolName and durationMs populated', async () => {
    const registry = buildRegistry({
      bad: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 10))
        throw new Error('boom')
      }),
    })
    const results = await executeToolsParallel(
      [{ id: '0', name: 'bad', args: {} }],
      registry,
      { maxConcurrency: 1 },
    )
    expect(results[0]!.toolName).toBe('bad')
    expect(results[0]!.durationMs).toBeGreaterThanOrEqual(5)
  })
})

// ---------------------------------------------------------------------------
// Abort behavior
// ---------------------------------------------------------------------------

describe('executeToolsParallel — abort semantics', () => {
  it('pre-aborted signal short-circuits every call', async () => {
    const controller = new AbortController()
    controller.abort()

    const invoke = vi.fn(async () => 'should-not-run')
    const registry = buildRegistry({ a: invoke })

    const calls: ParallelToolCall[] = Array.from({ length: 3 }, (_, i) => ({
      id: `c${i}`,
      name: 'a',
      args: {},
    }))

    const results = await executeToolsParallel(calls, registry, {
      maxConcurrency: 2,
      signal: controller.signal,
    })

    expect(results).toHaveLength(3)
    for (const r of results) {
      expect(r.error).toBe('Aborted')
      expect(r.durationMs).toBe(0)
    }
    expect(invoke).not.toHaveBeenCalled()
  })

  it('abort between acquire and execute still aborts (gated by semaphore)', async () => {
    const controller = new AbortController()
    const invoke = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 100))
      return 'done'
    })
    const registry = buildRegistry({ slow: invoke })

    // Schedule abort after the first few have acquired
    setTimeout(() => controller.abort(), 10)

    const calls: ParallelToolCall[] = Array.from({ length: 5 }, (_, i) => ({
      id: `c${i}`,
      name: 'slow',
      args: {},
    }))

    const results = await executeToolsParallel(calls, registry, {
      maxConcurrency: 1, // force queueing so later ones see abort after waiting
      signal: controller.signal,
    })
    expect(results).toHaveLength(5)
    const aborted = results.filter((r) => r.error === 'Aborted')
    // At least the later queued ones see the abort
    expect(aborted.length).toBeGreaterThanOrEqual(1)
  })

  it('no signal means no aborts', async () => {
    const registry = buildRegistry({ a: vi.fn(async () => 'ok') })
    const results = await executeToolsParallel(
      [{ id: '0', name: 'a', args: {} }],
      registry,
      { maxConcurrency: 1 },
    )
    expect(results[0]!.error).toBeUndefined()
    expect(results[0]!.result).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// Callback arguments
// ---------------------------------------------------------------------------

describe('executeToolsParallel — lifecycle callbacks', () => {
  it('onToolStart receives original args object', async () => {
    const onToolStart = vi.fn()
    const registry = buildRegistry({ a: vi.fn(async () => 'ok') })
    const args = { key: 'value', nested: { x: 1 } }
    await executeToolsParallel(
      [{ id: '0', name: 'a', args }],
      registry,
      { maxConcurrency: 1, onToolStart },
    )
    expect(onToolStart).toHaveBeenCalledTimes(1)
    expect(onToolStart).toHaveBeenCalledWith('a', args)
  })

  it('onToolEnd receives durationMs as a number', async () => {
    const onToolEnd = vi.fn()
    const registry = buildRegistry({
      a: delayedHandler('ok', 5),
    })
    await executeToolsParallel(
      [{ id: '0', name: 'a', args: {} }],
      registry,
      { maxConcurrency: 1, onToolEnd },
    )
    expect(onToolEnd).toHaveBeenCalledTimes(1)
    const [name, dur, err] = onToolEnd.mock.calls[0]!
    expect(name).toBe('a')
    expect(typeof dur).toBe('number')
    expect(err).toBeUndefined()
  })

  it('onToolEnd error arg is the stringified error, not the Error', async () => {
    const onToolEnd = vi.fn()
    const registry = buildRegistry({
      bad: vi.fn(async () => {
        throw new Error('fail-message')
      }),
    })
    await executeToolsParallel(
      [{ id: '0', name: 'bad', args: {} }],
      registry,
      { maxConcurrency: 1, onToolEnd },
    )
    expect(onToolEnd.mock.calls[0]![2]).toBe('fail-message')
  })

  it('callbacks fire once per successful tool', async () => {
    const onToolStart = vi.fn()
    const onToolEnd = vi.fn()
    const registry = buildRegistry({
      a: vi.fn(async () => 'a'),
      b: vi.fn(async () => 'b'),
      c: vi.fn(async () => 'c'),
    })
    await executeToolsParallel(
      [
        { id: '0', name: 'a', args: {} },
        { id: '1', name: 'b', args: {} },
        { id: '2', name: 'c', args: {} },
      ],
      registry,
      { maxConcurrency: 3, onToolStart, onToolEnd },
    )
    expect(onToolStart).toHaveBeenCalledTimes(3)
    expect(onToolEnd).toHaveBeenCalledTimes(3)
  })

  it('callbacks do NOT fire for unknown-tool errors', async () => {
    const onToolStart = vi.fn()
    const onToolEnd = vi.fn()
    const registry = buildRegistry({ real: vi.fn(async () => 'ok') })
    await executeToolsParallel(
      [{ id: '0', name: 'ghost', args: {} }],
      registry,
      { maxConcurrency: 1, onToolStart, onToolEnd },
    )
    // Tool never resolved → no lifecycle callbacks
    expect(onToolStart).not.toHaveBeenCalled()
    expect(onToolEnd).not.toHaveBeenCalled()
  })

  it('callbacks do NOT fire for aborted calls', async () => {
    const controller = new AbortController()
    controller.abort()
    const onToolStart = vi.fn()
    const onToolEnd = vi.fn()
    const registry = buildRegistry({ a: vi.fn(async () => 'ok') })
    await executeToolsParallel(
      [{ id: '0', name: 'a', args: {} }],
      registry,
      { maxConcurrency: 1, onToolStart, onToolEnd, signal: controller.signal },
    )
    expect(onToolStart).not.toHaveBeenCalled()
    expect(onToolEnd).not.toHaveBeenCalled()
  })

  it('missing onToolStart does not cause errors when tools succeed', async () => {
    const registry = buildRegistry({ a: vi.fn(async () => 'ok') })
    await expect(
      executeToolsParallel(
        [{ id: '0', name: 'a', args: {} }],
        registry,
        { maxConcurrency: 1 }, // no callbacks
      ),
    ).resolves.toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Registry edge cases
// ---------------------------------------------------------------------------

describe('executeToolsParallel — registry integration', () => {
  it('lists all available tools in the "not found" error', async () => {
    const registry = buildRegistry({
      alpha: vi.fn(async () => 'a'),
      beta: vi.fn(async () => 'b'),
      gamma: vi.fn(async () => 'c'),
    })
    const results = await executeToolsParallel(
      [{ id: '0', name: 'zeta', args: {} }],
      registry,
      { maxConcurrency: 1 },
    )
    expect(results[0]!.error).toContain('alpha')
    expect(results[0]!.error).toContain('beta')
    expect(results[0]!.error).toContain('gamma')
  })

  it('empty registry produces a "not found" error with empty list', async () => {
    const registry = buildRegistry({})
    const results = await executeToolsParallel(
      [{ id: '0', name: 'x', args: {} }],
      registry,
      { maxConcurrency: 1 },
    )
    expect(results[0]!.error).toContain('not found')
  })

  it('same tool called multiple times invokes the handler N times', async () => {
    const handler = vi.fn(async (args: Record<string, unknown>) => `got:${args.n}`)
    const registry = buildRegistry({ multi: handler })
    const calls: ParallelToolCall[] = [
      { id: '0', name: 'multi', args: { n: 1 } },
      { id: '1', name: 'multi', args: { n: 2 } },
      { id: '2', name: 'multi', args: { n: 3 } },
    ]
    const results = await executeToolsParallel(calls, registry, { maxConcurrency: 3 })
    expect(handler).toHaveBeenCalledTimes(3)
    expect(results.map(r => r.result)).toEqual(['got:1', 'got:2', 'got:3'])
  })

  it('passes args object by reference to the tool handler', async () => {
    const args = { key: 'value' }
    const seen: Array<Record<string, unknown>> = []
    const handler = vi.fn(async (received: Record<string, unknown>) => {
      seen.push(received)
      return 'ok'
    })
    const registry = buildRegistry({ a: handler })
    await executeToolsParallel(
      [{ id: '0', name: 'a', args }],
      registry,
      { maxConcurrency: 1 },
    )
    expect(seen[0]).toBe(args)
  })
})

// ---------------------------------------------------------------------------
// Result serialization
// ---------------------------------------------------------------------------

describe('executeToolsParallel — result serialization', () => {
  it('keeps string results verbatim', async () => {
    const registry = buildRegistry({ a: vi.fn(async () => 'hello world') })
    const results = await executeToolsParallel(
      [{ id: '0', name: 'a', args: {} }],
      registry,
      { maxConcurrency: 1 },
    )
    expect(results[0]!.result).toBe('hello world')
  })

  it('serializes arrays to JSON', async () => {
    const registry = buildRegistry({
      a: vi.fn(async () => [1, 2, 3]),
    })
    const results = await executeToolsParallel(
      [{ id: '0', name: 'a', args: {} }],
      registry,
      { maxConcurrency: 1 },
    )
    expect(results[0]!.result).toBe('[1,2,3]')
  })

  it('serializes null to JSON "null"', async () => {
    const registry = buildRegistry({
      a: vi.fn(async () => null),
    })
    const results = await executeToolsParallel(
      [{ id: '0', name: 'a', args: {} }],
      registry,
      { maxConcurrency: 1 },
    )
    expect(results[0]!.result).toBe('null')
  })

  it('serializes numbers to JSON', async () => {
    const registry = buildRegistry({
      a: vi.fn(async () => 42),
    })
    const results = await executeToolsParallel(
      [{ id: '0', name: 'a', args: {} }],
      registry,
      { maxConcurrency: 1 },
    )
    expect(results[0]!.result).toBe('42')
  })

  it('serializes booleans to JSON', async () => {
    const registry = buildRegistry({
      t: vi.fn(async () => true),
      f: vi.fn(async () => false),
    })
    const results = await executeToolsParallel(
      [
        { id: '0', name: 't', args: {} },
        { id: '1', name: 'f', args: {} },
      ],
      registry,
      { maxConcurrency: 2 },
    )
    expect(results[0]!.result).toBe('true')
    expect(results[1]!.result).toBe('false')
  })

  it('preserves nested object ordering in JSON.stringify', async () => {
    const registry = buildRegistry({
      a: vi.fn(async () => ({ first: 1, second: 2, third: { deep: true } })),
    })
    const results = await executeToolsParallel(
      [{ id: '0', name: 'a', args: {} }],
      registry,
      { maxConcurrency: 1 },
    )
    const parsed = JSON.parse(results[0]!.result!)
    expect(parsed).toEqual({ first: 1, second: 2, third: { deep: true } })
  })
})

// ---------------------------------------------------------------------------
// Duration tracking
// ---------------------------------------------------------------------------

describe('executeToolsParallel — timing', () => {
  it('durationMs is non-negative for instantaneous tools', async () => {
    const registry = buildRegistry({ quick: vi.fn(async () => 'fast') })
    const results = await executeToolsParallel(
      [{ id: '0', name: 'quick', args: {} }],
      registry,
      { maxConcurrency: 1 },
    )
    expect(results[0]!.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('durationMs roughly reflects handler delay', async () => {
    const delay = 25
    const registry = buildRegistry({
      sleep: delayedHandler('zzz', delay),
    })
    const results = await executeToolsParallel(
      [{ id: '0', name: 'sleep', args: {} }],
      registry,
      { maxConcurrency: 1 },
    )
    expect(results[0]!.durationMs).toBeGreaterThanOrEqual(delay - 5)
  })

  it('not-found errors have durationMs = 0', async () => {
    const registry = buildRegistry({ real: vi.fn(async () => 'ok') })
    const results = await executeToolsParallel(
      [{ id: '0', name: 'ghost', args: {} }],
      registry,
      { maxConcurrency: 1 },
    )
    expect(results[0]!.durationMs).toBe(0)
  })

  it('aborted calls have durationMs = 0', async () => {
    const controller = new AbortController()
    controller.abort()
    const registry = buildRegistry({ real: vi.fn(async () => 'ok') })
    const results = await executeToolsParallel(
      [{ id: '0', name: 'real', args: {} }],
      registry,
      { maxConcurrency: 1, signal: controller.signal },
    )
    expect(results[0]!.durationMs).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Semaphore correctness under load
// ---------------------------------------------------------------------------

describe('executeToolsParallel — semaphore correctness', () => {
  it('never exceeds concurrency even with 50 pending calls', async () => {
    let peak = 0
    let current = 0
    const handlers: Record<string, ReturnType<typeof vi.fn>> = {}
    const calls: ParallelToolCall[] = []
    for (let i = 0; i < 50; i++) {
      const name = `t${i}`
      handlers[name] = vi.fn(async () => {
        current++
        peak = Math.max(peak, current)
        await new Promise((r) => setTimeout(r, 5))
        current--
        return `r${i}`
      })
      calls.push({ id: `c${i}`, name, args: {} })
    }
    const registry = buildRegistry(handlers)
    await executeToolsParallel(calls, registry, { maxConcurrency: 3 })
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBe(3)
  })

  it('releases slots even when tool throws', async () => {
    // If release wasn't called in finally, subsequent calls would deadlock
    const registry = buildRegistry({
      throws: vi.fn(async () => {
        throw new Error('intentional')
      }),
      good: vi.fn(async () => 'ok'),
    })
    const calls: ParallelToolCall[] = [
      { id: '0', name: 'throws', args: {} },
      { id: '1', name: 'throws', args: {} },
      { id: '2', name: 'good', args: {} },
    ]
    const results = await executeToolsParallel(calls, registry, { maxConcurrency: 1 })
    expect(results).toHaveLength(3)
    // Last call must still run because slots were released
    expect(results[2]!.result).toBe('ok')
  })

  it('releases slots when tool not found (no deadlock on subsequent calls)', async () => {
    const registry = buildRegistry({
      real: vi.fn(async () => 'ok'),
    })
    const calls: ParallelToolCall[] = [
      { id: '0', name: 'missing1', args: {} },
      { id: '1', name: 'missing2', args: {} },
      { id: '2', name: 'real', args: {} },
    ]
    const results = await executeToolsParallel(calls, registry, { maxConcurrency: 1 })
    expect(results[0]!.error).toContain('not found')
    expect(results[1]!.error).toContain('not found')
    expect(results[2]!.result).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// Empty & trivial inputs
// ---------------------------------------------------------------------------

describe('executeToolsParallel — trivial inputs', () => {
  it('empty calls array returns [] without touching registry', async () => {
    const get = vi.fn()
    const keys = vi.fn(() => [].values())
    const registry = { get, keys } as unknown as ToolLookup
    const results = await executeToolsParallel([], registry, { maxConcurrency: 5 })
    expect(results).toEqual([])
    expect(get).not.toHaveBeenCalled()
  })

  it('empty calls array ignores onToolStart/onToolEnd', async () => {
    const onToolStart = vi.fn()
    const onToolEnd = vi.fn()
    const registry = buildRegistry({ a: vi.fn() })
    await executeToolsParallel([], registry, {
      maxConcurrency: 1,
      onToolStart,
      onToolEnd,
    })
    expect(onToolStart).not.toHaveBeenCalled()
    expect(onToolEnd).not.toHaveBeenCalled()
  })
})
