/**
 * A2A Task lifecycle — submit, poll, cancel, multi-turn conversations.
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

/** A2A message part (text, data, or file). */
export interface A2AMessagePart {
  type: string
  text?: string
  data?: Record<string, unknown>
}

/** A2A message within a task conversation. */
export interface A2ATaskMessage {
  role: 'user' | 'agent'
  parts: A2AMessagePart[]
}

/** A2A task artifact. */
export interface A2ATaskArtifact {
  parts: A2AMessagePart[]
  name?: string
  index?: number
}

/** Push notification config stored with a task. */
export interface A2ATaskPushConfig {
  url: string
  token?: string
  events?: string[]
}

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
  /** Multi-turn conversation history. */
  messages: A2ATaskMessage[]
  /** Task artifacts (code, files, structured data). */
  artifacts: A2ATaskArtifact[]
  /** Push notification configuration for this task. */
  pushNotificationConfig?: A2ATaskPushConfig
}

export interface A2ATaskStore {
  create(task: Omit<A2ATask, 'id' | 'createdAt' | 'updatedAt' | 'messages' | 'artifacts'>): Promise<A2ATask>
  get(id: string): Promise<A2ATask | null>
  update(id: string, updates: Partial<Pick<A2ATask, 'state' | 'output' | 'error' | 'metadata'>>): Promise<A2ATask | null>
  list(filter?: { agentName?: string; state?: A2ATaskState }): Promise<A2ATask[]>
  /** Append a message to a task's conversation. */
  appendMessage(id: string, message: A2ATaskMessage): Promise<A2ATask | null>
  /** Add an artifact to a task. */
  addArtifact(id: string, artifact: Omit<A2ATaskArtifact, 'index'>): Promise<A2ATask | null>
  /** Set push notification config for a task. */
  setPushConfig(id: string, config: A2ATaskPushConfig): Promise<A2ATask | null>
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
    task: Omit<A2ATask, 'id' | 'createdAt' | 'updatedAt' | 'messages' | 'artifacts'>,
  ): Promise<A2ATask> {
    this.counter += 1
    const now = new Date().toISOString()
    const record: A2ATask = {
      ...task,
      id: `a2a-task-${this.counter}`,
      createdAt: now,
      updatedAt: now,
      messages: [],
      artifacts: [],
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

  async appendMessage(id: string, message: A2ATaskMessage): Promise<A2ATask | null> {
    const existing = this.tasks.get(id)
    if (!existing) return null

    const updated: A2ATask = {
      ...existing,
      messages: [...existing.messages, message],
      updatedAt: new Date().toISOString(),
    }
    this.tasks.set(id, updated)
    return updated
  }

  async addArtifact(id: string, artifact: Omit<A2ATaskArtifact, 'index'>): Promise<A2ATask | null> {
    const existing = this.tasks.get(id)
    if (!existing) return null

    const indexed: A2ATaskArtifact = {
      ...artifact,
      index: existing.artifacts.length,
    }
    const updated: A2ATask = {
      ...existing,
      artifacts: [...existing.artifacts, indexed],
      updatedAt: new Date().toISOString(),
    }
    this.tasks.set(id, updated)
    return updated
  }

  async setPushConfig(id: string, config: A2ATaskPushConfig): Promise<A2ATask | null> {
    const existing = this.tasks.get(id)
    if (!existing) return null

    const updated: A2ATask = {
      ...existing,
      pushNotificationConfig: config,
      updatedAt: new Date().toISOString(),
    }
    this.tasks.set(id, updated)
    return updated
  }
}
