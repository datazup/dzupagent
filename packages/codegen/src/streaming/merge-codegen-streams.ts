/**
 * Fan-in utility that merges multiple async iterables of
 * CodegenStreamEvent into a single async generator.
 *
 * Events from all sources are interleaved in arrival order.
 * If one source throws, the error event is yielded and remaining
 * sources continue to drain.
 */

import type { CodegenStreamEvent } from './codegen-stream-event.js'

/**
 * Merge multiple `AsyncIterable<CodegenStreamEvent>` sources into one.
 *
 * Events are yielded as soon as any source produces them, preserving
 * temporal ordering across sources. If a source throws, a
 * `codegen:error` event is emitted and the remaining sources continue.
 */
export async function* mergeCodegenStreams(
  ...iterables: AsyncIterable<CodegenStreamEvent>[]
): AsyncGenerator<CodegenStreamEvent> {
  if (iterables.length === 0) return

  // Each source is wrapped in a "racer" that resolves a shared promise
  // every time a value is available.

  type QueueItem =
    | { done: false; value: CodegenStreamEvent; sourceIndex: number }
    | { done: true; sourceIndex: number }
    | { error: true; sourceIndex: number; err: unknown }

  const queue: QueueItem[] = []
  let resolve: (() => void) | null = null
  let pending = iterables.length

  function notify(): void {
    if (resolve) {
      const r = resolve
      resolve = null
      r()
    }
  }

  function waitForItem(): Promise<void> {
    return new Promise<void>((r) => {
      resolve = r
    })
  }

  // Start draining each iterable concurrently
  for (let i = 0; i < iterables.length; i++) {
    const sourceIndex = i
    void (async () => {
      try {
        for await (const value of iterables[sourceIndex]!) {
          queue.push({ done: false, value, sourceIndex })
          notify()
        }
        queue.push({ done: true, sourceIndex })
      } catch (err: unknown) {
        queue.push({ error: true, sourceIndex, err })
      }
      notify()
    })()
  }

  while (pending > 0) {
    if (queue.length === 0) {
      await waitForItem()
    }

    while (queue.length > 0) {
      const item = queue.shift()!
      if ('error' in item && item.error) {
        pending--
        const message = item.err instanceof Error ? item.err.message : String(item.err)
        yield { type: 'codegen:error', message } as CodegenStreamEvent
      } else if ('done' in item && item.done === true && !('error' in item)) {
        pending--
      } else if ('value' in item) {
        yield item.value
      }
    }
  }
}
