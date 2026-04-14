import type { DzupEventBus } from '../events/event-bus.js'

/**
 * Run a list of hook functions sequentially with error isolation.
 *
 * Each hook is called in order. If a hook throws, the error is caught
 * and emitted via the event bus (if provided). Subsequent hooks still run.
 *
 * For hooks that can modify values (beforeToolCall, afterToolCall),
 * use `runModifierHook()` instead.
 */
export async function runHooks(
  hooks: Array<((...args: never[]) => Promise<void>) | undefined> | undefined,
  eventBus: DzupEventBus | undefined,
  hookName: string,
  ...args: unknown[]
): Promise<void> {
  if (!hooks) return
  for (const hook of hooks) {
    if (!hook) continue
    try {
      await (hook as (...a: unknown[]) => Promise<void>)(...args)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      eventBus?.emit({ type: 'hook:error', hookName, message })
    }
  }
}

/**
 * Run a single modifier hook that can transform a value.
 *
 * If the hook returns a non-undefined value, it replaces the input.
 * If the hook returns undefined/void, the original value passes through.
 * If the hook throws, the original value passes through and the error is logged.
 */
export async function runModifierHook<T>(
  hook: ((...args: never[]) => Promise<T | void>) | undefined,
  eventBus: DzupEventBus | undefined,
  hookName: string,
  currentValue: T,
  ...args: unknown[]
): Promise<T> {
  if (!hook) return currentValue
  try {
    const result = await (hook as (...a: unknown[]) => Promise<T | void>)(...args)
    return result !== undefined ? result : currentValue
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    eventBus?.emit({ type: 'hook:error', hookName, message })
    return currentValue
  }
}

/**
 * Merge multiple AgentHooks objects into one.
 * Each hook key becomes an array; `runHooks` iterates them all.
 */
export function mergeHooks<T extends Record<string, ((...args: never[]) => Promise<unknown>) | undefined>>(
  ...hookSets: (Partial<T> | undefined)[]
): Partial<Record<keyof T, Array<(...args: never[]) => Promise<unknown>>>> {
  const merged: Record<string, Array<(...args: never[]) => Promise<unknown>>> = {}

  for (const hooks of hookSets) {
    if (!hooks) continue
    for (const [key, fn] of Object.entries(hooks)) {
      if (typeof fn !== 'function') continue
      if (!merged[key]) merged[key] = []
      merged[key].push(fn as (...args: never[]) => Promise<unknown>)
    }
  }

  return merged as Partial<Record<keyof T, Array<(...args: never[]) => Promise<unknown>>>>
}
