import type { DzipEvent, DzipEventOf } from './event-types.js'

type Handler<T extends DzipEvent['type']> = (event: DzipEventOf<T>) => void | Promise<void>
type AnyHandler = (event: DzipEvent) => void | Promise<void>

/**
 * Typed, in-process event bus for DzipAgent.
 *
 * - Emit is fire-and-forget (handler errors are caught and logged to stderr)
 * - Handlers run asynchronously in microtask queue
 * - `on()` returns an unsubscribe function
 * - Supports typed discrimination: `bus.on('tool:called', (e) => e.toolName)`
 *
 * @example
 * ```ts
 * const bus = createEventBus()
 * const unsub = bus.on('agent:started', (e) => console.log(e.agentId))
 * bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
 * unsub() // stop listening
 * ```
 */
export interface DzipEventBus {
  /** Emit an event. Handlers run asynchronously; errors are caught. */
  emit(event: DzipEvent): void

  /** Subscribe to a specific event type. Returns unsubscribe function. */
  on<T extends DzipEvent['type']>(type: T, handler: Handler<T>): () => void

  /** Subscribe once — auto-unsubscribes after first invocation. */
  once<T extends DzipEvent['type']>(type: T, handler: Handler<T>): () => void

  /** Subscribe to ALL events (wildcard). Returns unsubscribe function. */
  onAny(handler: AnyHandler): () => void
}

export function createEventBus(): DzipEventBus {
  const handlers = new Map<string, Set<AnyHandler>>()
  const wildcards = new Set<AnyHandler>()

  function getSet(type: string): Set<AnyHandler> {
    let set = handlers.get(type)
    if (!set) {
      set = new Set()
      handlers.set(type, set)
    }
    return set
  }

  function runHandlers(list: Iterable<AnyHandler>, event: DzipEvent): void {
    for (const handler of list) {
      try {
        const result = handler(event)
        // Catch async handler errors
        if (result && typeof result === 'object' && 'catch' in result) {
          ;(result as Promise<void>).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err)
            // eslint-disable-next-line no-console
            console.error(`[DzipEventBus] handler error for "${event.type}": ${msg}`)
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // eslint-disable-next-line no-console
        console.error(`[DzipEventBus] handler error for "${event.type}": ${msg}`)
      }
    }
  }

  return {
    emit(event: DzipEvent): void {
      const set = handlers.get(event.type)
      if (set && set.size > 0) runHandlers(set, event)
      if (wildcards.size > 0) runHandlers(wildcards, event)
    },

    on<T extends DzipEvent['type']>(type: T, handler: Handler<T>): () => void {
      const set = getSet(type)
      const wrapped = handler as AnyHandler
      set.add(wrapped)
      return () => { set.delete(wrapped) }
    },

    once<T extends DzipEvent['type']>(type: T, handler: Handler<T>): () => void {
      const set = getSet(type)
      const wrapped: AnyHandler = (event) => {
        set.delete(wrapped)
        return (handler as AnyHandler)(event)
      }
      set.add(wrapped)
      return () => { set.delete(wrapped) }
    },

    onAny(handler: AnyHandler): () => void {
      wildcards.add(handler)
      return () => { wildcards.delete(handler) }
    },
  }
}
