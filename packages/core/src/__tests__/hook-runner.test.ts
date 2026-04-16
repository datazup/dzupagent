import { describe, it, expect, vi } from 'vitest'
import { runHooks, runModifierHook, mergeHooks } from '../hooks/hook-runner.js'
import { createEventBus } from '../events/event-bus.js'
import type { DzupEvent } from '../events/event-types.js'

describe('runHooks', () => {
  it('runs all hooks in order', async () => {
    const order: number[] = []
    const hooks = [
      vi.fn(async () => { order.push(1) }),
      vi.fn(async () => { order.push(2) }),
      vi.fn(async () => { order.push(3) }),
    ]

    await runHooks(hooks, undefined, 'test')
    expect(order).toEqual([1, 2, 3])
  })

  it('skips undefined entries in the hooks array', async () => {
    const fn = vi.fn(async () => {})
    const hooks = [undefined, fn, undefined]

    await runHooks(hooks, undefined, 'test')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('returns immediately when hooks is undefined', async () => {
    // Should not throw
    await runHooks(undefined, undefined, 'test')
  })

  it('continues after a hook throws', async () => {
    const first = vi.fn(async () => { throw new Error('hook failed') })
    const second = vi.fn(async () => {})
    const hooks = [first, second]

    await runHooks(hooks, undefined, 'test')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('emits hook:error event when a hook throws and eventBus is provided', async () => {
    const bus = createEventBus()
    const events: DzupEvent[] = []
    bus.onAny((event) => { events.push(event) })

    const hooks = [vi.fn(async () => { throw new Error('boom') })]

    await runHooks(hooks, bus, 'myHook')
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('hook:error')
    const hookError = events[0] as Extract<DzupEvent, { type: 'hook:error' }>
    expect(hookError.hookName).toBe('myHook')
    expect(hookError.message).toBe('boom')
  })

  it('handles non-Error throws', async () => {
    const bus = createEventBus()
    const events: DzupEvent[] = []
    bus.onAny((event) => { events.push(event) })

    const hooks = [vi.fn(async () => { throw 'string error' })]

    await runHooks(hooks, bus, 'hook1')
    const hookError = events[0] as Extract<DzupEvent, { type: 'hook:error' }>
    expect(hookError.message).toBe('string error')
  })
})

describe('runModifierHook', () => {
  it('returns current value when hook is undefined', async () => {
    const result = await runModifierHook(undefined, undefined, 'test', 'original')
    expect(result).toBe('original')
  })

  it('returns transformed value from hook', async () => {
    const hook = vi.fn(async () => 'modified')
    const result = await runModifierHook(hook, undefined, 'test', 'original')
    expect(result).toBe('modified')
  })

  it('passes through original value when hook returns undefined', async () => {
    const hook = vi.fn(async () => undefined)
    const result = await runModifierHook(hook, undefined, 'test', 'original')
    expect(result).toBe('original')
  })

  it('passes through original value when hook throws', async () => {
    const hook = vi.fn(async () => { throw new Error('hook broke') })
    const result = await runModifierHook(hook, undefined, 'test', 'original')
    expect(result).toBe('original')
  })

  it('emits hook:error on throw when eventBus is provided', async () => {
    const bus = createEventBus()
    const events: DzupEvent[] = []
    bus.onAny((event) => { events.push(event) })

    const hook = vi.fn(async () => { throw new Error('modifier failed') })
    await runModifierHook(hook, bus, 'beforeTool', 42)

    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('hook:error')
  })

  it('works with complex types', async () => {
    const hook = vi.fn(async () => ({ name: 'modified', value: 99 }))
    const result = await runModifierHook(
      hook,
      undefined,
      'test',
      { name: 'original', value: 0 },
    )
    expect(result).toEqual({ name: 'modified', value: 99 })
  })
})

describe('mergeHooks', () => {
  it('merges multiple hook sets into arrays', () => {
    const hookA = async () => {}
    const hookB = async () => {}

    type Hooks = {
      beforeRun: () => Promise<void>
      afterRun: () => Promise<void>
    }

    const merged = mergeHooks<Hooks>(
      { beforeRun: hookA },
      { beforeRun: hookB, afterRun: hookA },
    )

    expect(merged.beforeRun).toHaveLength(2)
    expect(merged.afterRun).toHaveLength(1)
  })

  it('skips undefined hook sets', () => {
    const hookA = async () => {}

    type Hooks = { beforeRun: () => Promise<void> }

    const merged = mergeHooks<Hooks>(undefined, { beforeRun: hookA }, undefined)
    expect(merged.beforeRun).toHaveLength(1)
  })

  it('skips non-function values in hook sets', () => {
    type Hooks = { beforeRun: () => Promise<void> }

    const merged = mergeHooks<Hooks>(
      { beforeRun: undefined },
    )
    // beforeRun should not exist since the value was undefined
    expect(merged.beforeRun).toBeUndefined()
  })

  it('returns empty object when no hooks provided', () => {
    type Hooks = { beforeRun: () => Promise<void> }

    const merged = mergeHooks<Hooks>()
    expect(Object.keys(merged)).toHaveLength(0)
  })
})
