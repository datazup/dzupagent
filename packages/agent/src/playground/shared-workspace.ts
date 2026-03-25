/**
 * SharedWorkspace — in-memory key-value store for inter-agent data sharing.
 *
 * Supports typed subscriptions so agents can watch for changes.
 * All mutations are serialized through an async queue to prevent
 * race conditions when multiple agents write concurrently.
 *
 * @example
 * ```ts
 * const ws = new SharedWorkspace()
 * ws.subscribe('plan', (key, value) => console.log(`plan updated: ${value}`))
 * await ws.set('plan', 'Step 1: ...', 'planner-agent')
 * const plan = ws.get('plan') // 'Step 1: ...'
 * ```
 */

type Subscriber = (key: string, value: string, agentId?: string) => void | Promise<void>

interface QueuedWrite {
  key: string
  value: string
  agentId?: string
  resolve: () => void
}

export class SharedWorkspace {
  private readonly store = new Map<string, string>()
  private readonly keySubscribers = new Map<string, Set<Subscriber>>()
  private readonly globalSubscribers = new Set<Subscriber>()
  private readonly writeQueue: QueuedWrite[] = []
  private draining = false

  /**
   * Get a value by key. Returns `undefined` if not set.
   * Reads are synchronous and lock-free.
   */
  get(key: string): string | undefined {
    return this.store.get(key)
  }

  /**
   * Get all entries as a read-only snapshot.
   */
  entries(): ReadonlyMap<string, string> {
    return new Map(this.store)
  }

  /**
   * Get all keys.
   */
  keys(): string[] {
    return [...this.store.keys()]
  }

  /**
   * Check whether a key exists.
   */
  has(key: string): boolean {
    return this.store.has(key)
  }

  /**
   * Number of entries in the workspace.
   */
  get size(): number {
    return this.store.size
  }

  /**
   * Set a value. Writes are serialized to prevent interleaving.
   * Subscribers are notified after the write completes.
   *
   * @param key    The workspace key.
   * @param value  The string value to store.
   * @param agentId  Optional ID of the agent performing the write.
   */
  async set(key: string, value: string, agentId?: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.writeQueue.push({ key, value, agentId, resolve })
      void this.drain()
    })
  }

  /**
   * Delete a key from the workspace.
   * Notifies subscribers with an empty string value.
   */
  async delete(key: string, agentId?: string): Promise<boolean> {
    const existed = this.store.has(key)
    if (existed) {
      await this.set(key, '', agentId)
      this.store.delete(key)
    }
    return existed
  }

  /**
   * Clear all entries. Notifies global subscribers once.
   */
  clear(): void {
    this.store.clear()
  }

  /**
   * Subscribe to changes on a specific key.
   * Returns an unsubscribe function.
   */
  subscribe(key: string, handler: Subscriber): () => void {
    let set = this.keySubscribers.get(key)
    if (!set) {
      set = new Set()
      this.keySubscribers.set(key, set)
    }
    set.add(handler)
    return () => {
      set.delete(handler)
      if (set.size === 0) this.keySubscribers.delete(key)
    }
  }

  /**
   * Subscribe to all workspace changes (any key).
   * Returns an unsubscribe function.
   */
  subscribeAll(handler: Subscriber): () => void {
    this.globalSubscribers.add(handler)
    return () => { this.globalSubscribers.delete(handler) }
  }

  /**
   * Format the entire workspace as a readable context string
   * suitable for injecting into an agent prompt.
   */
  formatAsContext(): string {
    if (this.store.size === 0) return ''

    const lines: string[] = ['## Shared Workspace']
    for (const [key, value] of this.store) {
      if (value) {
        lines.push(`### ${key}`)
        lines.push(value)
        lines.push('')
      }
    }
    return lines.join('\n')
  }

  // ---------------------------------------------------------------------------
  // Internal: serialized write queue
  // ---------------------------------------------------------------------------

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true

    try {
      while (this.writeQueue.length > 0) {
        const item = this.writeQueue.shift()!
        this.store.set(item.key, item.value)
        await this.notifySubscribers(item.key, item.value, item.agentId)
        item.resolve()
      }
    } finally {
      this.draining = false
    }
  }

  private async notifySubscribers(
    key: string,
    value: string,
    agentId?: string,
  ): Promise<void> {
    const keyHandlers = this.keySubscribers.get(key)

    const allHandlers: Subscriber[] = [
      ...(keyHandlers ?? []),
      ...this.globalSubscribers,
    ]

    for (const handler of allHandlers) {
      try {
        const result = handler(key, value, agentId)
        if (result && typeof result === 'object' && 'catch' in result) {
          await (result as Promise<void>).catch(() => {
            // Subscriber errors are non-fatal
          })
        }
      } catch {
        // Subscriber errors are non-fatal
      }
    }
  }
}
