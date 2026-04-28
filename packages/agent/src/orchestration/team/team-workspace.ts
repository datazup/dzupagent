/**
 * Shared team workspace and execution result contracts.
 *
 * These contracts are owned by orchestration because they are used by the
 * production `TeamRuntime`. Playground modules re-export them for compatibility.
 */
import type { DzupAgent } from '../../agent/dzip-agent.js'

export type WorkspaceSubscriber = (
  key: string,
  value: string,
  agentId?: string,
) => void | Promise<void>

interface QueuedWrite {
  key: string
  value: string
  agentId?: string
  resolve: () => void
}

/**
 * In-memory key-value store for inter-agent data sharing.
 *
 * Supports typed subscriptions so agents can watch for changes. All mutations
 * are serialized through an async queue to prevent race conditions when
 * multiple agents write concurrently.
 */
export class SharedWorkspace {
  private readonly store = new Map<string, string>()
  private readonly keySubscribers = new Map<string, Set<WorkspaceSubscriber>>()
  private readonly globalSubscribers = new Set<WorkspaceSubscriber>()
  private readonly writeQueue: QueuedWrite[] = []
  private draining = false

  /** Get a value by key. Returns `undefined` if not set. */
  get(key: string): string | undefined {
    return this.store.get(key)
  }

  /** Get all entries as a read-only snapshot. */
  entries(): ReadonlyMap<string, string> {
    return new Map(this.store)
  }

  /** Get all keys. */
  keys(): string[] {
    return [...this.store.keys()]
  }

  /** Check whether a key exists. */
  has(key: string): boolean {
    return this.store.has(key)
  }

  /** Number of entries in the workspace. */
  get size(): number {
    return this.store.size
  }

  /**
   * Set a value. Writes are serialized to prevent interleaving.
   * Subscribers are notified after the write completes.
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

  /** Clear all entries. */
  clear(): void {
    this.store.clear()
  }

  /** Subscribe to changes on a specific key. */
  subscribe(key: string, handler: WorkspaceSubscriber): () => void {
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

  /** Subscribe to all workspace changes. */
  subscribeAll(handler: WorkspaceSubscriber): () => void {
    this.globalSubscribers.add(handler)
    return () => {
      this.globalSubscribers.delete(handler)
    }
  }

  /** Format the entire workspace as context suitable for an agent prompt. */
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
    const allHandlers: WorkspaceSubscriber[] = [
      ...(keyHandlers ?? []),
      ...this.globalSubscribers,
    ]

    for (const handler of allHandlers) {
      try {
        const result = handler(key, value, agentId)
        if (result && typeof result === 'object' && 'catch' in result) {
          await (result as Promise<void>).catch(() => {
            // Subscriber errors are non-fatal.
          })
        }
      } catch {
        // Subscriber errors are non-fatal.
      }
    }
  }
}

export type TeamAgentRole =
  | 'supervisor'
  | 'worker'
  | 'reviewer'
  | 'planner'
  | 'specialist'
  | 'custom'

export type TeamAgentStatus =
  | 'idle'
  | 'running'
  | 'completed'
  | 'failed'
  | 'shutdown'

export interface TeamSpawnedAgent {
  /** The underlying DzupAgent instance. */
  agent: DzupAgent
  /** Current lifecycle state. */
  status: TeamAgentStatus
  /** Role assigned at spawn time. */
  role: TeamAgentRole
  /** Tags for filtering. */
  tags: string[]
  /** When the agent was spawned. */
  spawnedAt: number
  /** Last task result, if any. */
  lastResult?: string
  /** Last error message, if any. */
  lastError?: string
}

export interface TeamAgentRunResult {
  agentId: string
  role: TeamAgentRole
  content: string
  success: boolean
  error?: string
  durationMs: number
}

/** Result of running a coordinated team task. */
export interface TeamRunResult {
  /** Merged/final output from the team. */
  content: string
  /** Per-agent results. */
  agentResults: TeamAgentRunResult[]
  /** Total duration in milliseconds. */
  durationMs: number
  /** The coordination pattern used. */
  pattern: 'supervisor' | 'peer-to-peer' | 'blackboard'
}
