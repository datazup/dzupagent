export type CleanupAction = () => void | Promise<void>

/** Idempotent LIFO cleanup for execution-local files and resources. */
export class CleanupRegistry {
  private actions: CleanupAction[] = []
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

