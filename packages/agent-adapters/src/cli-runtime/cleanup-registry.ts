/**
 * Cleanup actions are declared as returning plain `void`, deliberately — not
 * `void | Promise<void>`.
 *
 * TypeScript's void-returning-function leniency lets a callback that returns a
 * value satisfy a `=> void` parameter, so `registry.add(() => paths.pop())`
 * type-checks even though `pop` returns a value. That leniency does not survive
 * a union: under `=> void | Promise<void>` the same expression is rejected with
 * TS2322 ("Type 'number' is not assignable to type 'void | Promise<void>'"),
 * so the union that reads as the more permissive signature is in fact the
 * stricter one for every caller.
 *
 * `void` still accepts `async` actions — a `Promise<void>` return is assignable
 * to a `void` return position — and {@link CleanupRegistry.cleanup} awaits the
 * value an action actually returned, so async cleanup still completes before
 * the registry resolves.
 */
export type CleanupAction = () => void

/**
 * How actions are stored and invoked internally.
 *
 * The public type above says `void` for the leniency described there; this one
 * says `unknown` because `cleanup()` has to await what an action actually
 * returned, and `await` on an expression declared `void` misreports the
 * runtime contract.
 */
type StoredCleanupAction = () => unknown

/** Idempotent LIFO cleanup for execution-local files and resources. */
export class CleanupRegistry {
  private actions: StoredCleanupAction[] = []
  private cleanupPromise: Promise<void> | null = null

  add(action: CleanupAction): void {
    if (this.cleanupPromise) throw new Error('Cannot register cleanup after cleanup has started')
    this.actions.push(action)
  }

  cleanup(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise
    this.cleanupPromise = (async () => {
      const failures: unknown[] = []
      for (const action of this.actions.reverse()) {
        try {
          await action()
        } catch (error) {
          failures.push(error)
        }
      }
      this.actions = []
      if (failures.length > 0) {
        throw new AggregateError(failures, 'One or more CLI runtime cleanup actions failed')
      }
    })()
    return this.cleanupPromise
  }
}

