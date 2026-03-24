/**
 * A2A Task lifecycle — submit, poll, cancel.
 *
 * Provides a store interface and an in-memory implementation for development.
 */

export type A2ATaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface A2ATask {
  id: string
  state: A2ATaskState
  input: unknown
  output?: unknown
  agentName: string
  createdAt: string
  updatedAt: string
  error?: string
  metadata?: Record<string, unknown>
}

export interface A2ATaskStore {
  create(task: Omit<A2ATask, 'id' | 'createdAt' | 'updatedAt'>): Promise<A2ATask>
  get(id: string): Promise<A2ATask | null>
  update(id: string, updates: Partial<Pick<A2ATask, 'state' | 'output' | 'error' | 'metadata'>>): Promise<A2ATask | null>
  list(filter?: { agentName?: string; state?: A2ATaskState }): Promise<A2ATask[]>
}

/**
 * In-memory A2A task store for development and testing.
 *
 * Tasks are stored in a `Map` and lost on process restart.
 */
export class InMemoryA2ATaskStore implements A2ATaskStore {
  private readonly tasks = new Map<string, A2ATask>()
  private counter = 0

  async create(
    task: Omit<A2ATask, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<A2ATask> {
    this.counter += 1
    const now = new Date().toISOString()
    const record: A2ATask = {
      ...task,
      id: `a2a-task-${this.counter}`,
      createdAt: now,
      updatedAt: now,
    }
    this.tasks.set(record.id, record)
    return record
  }

  async get(id: string): Promise<A2ATask | null> {
    return this.tasks.get(id) ?? null
  }

  async update(
    id: string,
    updates: Partial<Pick<A2ATask, 'state' | 'output' | 'error' | 'metadata'>>,
  ): Promise<A2ATask | null> {
    const existing = this.tasks.get(id)
    if (!existing) return null

    const updated: A2ATask = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    }
    this.tasks.set(id, updated)
    return updated
  }

  async list(filter?: { agentName?: string; state?: A2ATaskState }): Promise<A2ATask[]> {
    let results = Array.from(this.tasks.values())

    if (filter?.agentName) {
      results = results.filter((t) => t.agentName === filter.agentName)
    }
    if (filter?.state) {
      results = results.filter((t) => t.state === filter.state)
    }

    return results.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
  }
}
