/**
 * Lifecycle (shutdown) helpers for memory backing stores.
 *
 * Deliberately dependency-free: `MemoryService` imports this, and importing
 * `store-factory.ts` instead would pull the Postgres driver into every
 * consumer that only ever uses an in-memory store.
 */
/**
 * Shutdown methods a backing store may expose, in the order we try them.
 *
 * `BaseStore` declares no lifecycle at all, yet `createStore('postgres')`
 * hands back a `PostgresStore` that owns a connection pool. Callers therefore
 * had no way to release it (SHARED-KIT-AGENT-M-71): in tests, serverless
 * handlers, and any create-per-request composition the pool leaked until it
 * saturated. Duck-typing rather than narrowing to `PostgresStore` keeps this
 * working for stores injected by consumers, which is the common case.
 */
const STORE_CLOSE_METHODS = ['stop', 'close', 'end', 'disconnect'] as const

/**
 * Release the resources held by a store, if it holds any.
 *
 * Resolves to `true` when a shutdown method was found and completed, `false`
 * when the store exposes none (the in-memory store, and any plain object
 * implementing `BaseStore`) — that is a successful no-op, not a failure.
 *
 * Non-fatal by design: a store that throws on shutdown is logged and reported
 * as `false` rather than propagating, so a `finally`-block close can never
 * mask the real error a caller is already unwinding from.
 */
export async function closeMemoryStore(store: unknown): Promise<boolean> {
  if (store == null || typeof store !== 'object') return false

  const candidate = store as Record<string, unknown>

  for (const method of STORE_CLOSE_METHODS) {
    const fn = candidate[method]
    if (typeof fn === 'function') {
      try {
        await (fn as () => unknown).call(store)
        return true
      } catch (err: unknown) {
        console.error('[memory] store close failed', {
          method,
          error: err instanceof Error ? err.message : String(err),
        })
        return false
      }
    }
  }

  // `await using` disposables, for stores that only implement the protocol.
  const asyncDispose = (candidate as { [Symbol.asyncDispose]?: unknown })[
    Symbol.asyncDispose
  ]
  if (typeof asyncDispose === 'function') {
    try {
      await (asyncDispose as () => unknown).call(store)
      return true
    } catch (err: unknown) {
      console.error('[memory] store close failed', {
        method: 'Symbol.asyncDispose',
        error: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }

  return false
}
