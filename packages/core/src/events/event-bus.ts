import type { DzupEvent, DzupEventOf } from './event-types.js'
import { defaultLogger, type FrameworkLogger } from '../utils/logger.js'

/**
 * Handler returns are declared as plain `void`, deliberately — not
 * `void | Promise<void>`.
 *
 * TypeScript's void-returning-function leniency lets a callback that returns a
 * value satisfy a `=> void` parameter, so `bus.onAny((e) => seen.push(e))`
 * type-checks even though `push` returns `number`. That leniency does not
 * survive a union: under `=> void | Promise<void>` the same expression is
 * rejected with TS2322 ("Type 'number' is not assignable to type
 * 'void | Promise<void>'"), which is why expression-bodied handlers across the
 * workspace had to be rewritten with block bodies.
 *
 * `void` still accepts `async` handlers — a `Promise<void>` return is
 * assignable to a `void` return position — and `runHandlers` inspects the value
 * a handler actually returned, so async rejections are still caught.
 */
type Handler<T extends DzupEvent['type']> = (event: DzupEventOf<T>) => void
type AnyHandler = (event: DzupEvent) => void

/**
 * How handlers are stored and invoked internally.
 *
 * The public types above say `void` for the leniency described there; this one
 * says `unknown` because `runHandlers` has to inspect what a handler actually
 * returned, and an expression of type `void` cannot be tested for truthiness
 * (TS1345).
 */
type StoredHandler = (event: DzupEvent) => unknown

/**
 * Typed, in-process event bus for DzupAgent.
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
export interface DzupEventBus {
  /** Emit an event. Handlers run asynchronously; errors are caught. */
  emit(event: DzupEvent): void

  /** Subscribe to a specific event type. Returns unsubscribe function. */
  on<T extends DzupEvent['type']>(type: T, handler: Handler<T>): () => void

  /** Subscribe once — auto-unsubscribes after first invocation. */
  once<T extends DzupEvent['type']>(type: T, handler: Handler<T>): () => void

  /** Subscribe to ALL events (wildcard). Returns unsubscribe function. */
  onAny(handler: AnyHandler): () => void
}

export function createEventBus(): DzupEventBus {
  const logger: FrameworkLogger = defaultLogger
  const handlers = new Map<string, Set<StoredHandler>>()
  const wildcards = new Set<StoredHandler>()

  function getSet(type: string): Set<StoredHandler> {
    let set = handlers.get(type)
    if (!set) {
      set = new Set()
      handlers.set(type, set)
    }
    return set
  }

  function runHandlers(list: Iterable<StoredHandler>, event: DzupEvent): void {
    for (const handler of list) {
      try {
        const result: unknown = handler(event)
        // Catch async handler errors
        if (result && typeof result === 'object' && 'catch' in result) {
          ;(result as Promise<void>).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err)
             
            logger.error(`[DzupEventBus] handler error for "${event.type}": ${msg}`)
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
         
        logger.error(`[DzupEventBus] handler error for "${event.type}": ${msg}`)
      }
    }
  }

  return {
    emit(event: DzupEvent): void {
      const set = handlers.get(event.type)
      if (set && set.size > 0) runHandlers(set, event)
      if (wildcards.size > 0) runHandlers(wildcards, event)
    },

    on<T extends DzupEvent['type']>(type: T, handler: Handler<T>): () => void {
      const set = getSet(type)
      const wrapped = handler as StoredHandler
      set.add(wrapped)
      return () => { set.delete(wrapped) }
    },

    once<T extends DzupEvent['type']>(type: T, handler: Handler<T>): () => void {
      const set = getSet(type)
      const wrapped: StoredHandler = (event) => {
        set.delete(wrapped)
        return (handler as StoredHandler)(event)
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

/**
 * Typed emit helper that preserves the discriminated-union type checking at
 * the call site without forcing callers to add an `as never` cast.
 *
 * Spread expressions of the form `{ type: '...', ...rest }` defeat TS's
 * narrowing: the inferred shape is too wide to satisfy any single union
 * member, so `bus.emit(...)` requires `as never`. This helper accepts
 * `DzupEvent` exactly, so the call site builds a complete object literal
 * that the compiler can match to the correct union member.
 *
 * Also accepts an optional bus, so callers can guard `bus?.emit(...)` style
 * fire-and-forget dispatch with a single function call.
 *
 * @example
 * ```ts
 * typedEmit(bus, {
 *   type: 'agent:rate_limited',
 *   agentId: 'a1',
 *   reason: 'Quota exceeded',
 * })
 * ```
 */
export function typedEmit(bus: DzupEventBus | undefined, event: DzupEvent): void {
  bus?.emit(event)
}
